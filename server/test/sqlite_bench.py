# -*- coding: utf-8 -*-
"""SQLite 能不能顶住打坦克后台的写入节奏——单机多进程压测。

背景：后台服务是 4 个 gunicorn worker（多进程），高频写有两处：
  * POST /api/room/input  -> room_inputs 的 upsert（每个玩家每拍一次）
  * POST /api/room/state  -> rooms.state 的 update（房主每两拍一次）
外加 /api/room/state 的读（每拍一次）。

SQLite 的写是全库串行的（一个写锁），多进程下最容易在这里翻车，
所以这个脚本就照着上面的真实节奏，用 4 个**独立进程**打同一份库，
看节拍能不能达成、有没有 SQLITE_BUSY。

只用标准库，不依赖任何第三方包；库建在临时目录，跑完删掉。

用法：
    python3 sqlite_bench.py [房间数] [进程数] [模式]
      mode: wal-normal(WAL+同步NORMAL，推荐) wal-full(WAL+同步FULL) delete(默认回滚日志)
"""

import json
import os
import shutil
import sqlite3
import statistics
import sys
import tempfile
import time
from multiprocessing import Process, Queue

ROOMS = int(sys.argv[1]) if len(sys.argv) > 1 else 25
PROCS = int(sys.argv[2]) if len(sys.argv) > 2 else 4
MODE = sys.argv[3] if len(sys.argv) > 3 else "wal-normal"

DURATION = 6.0  # 每个进程跑多久（秒）
SEATS_PER_ROOM = 2

SCHEMA = """
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, host TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'coop',
  status TEXT NOT NULL DEFAULT 'lobby', state TEXT, state_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE room_inputs (
  room_id TEXT NOT NULL, seat INTEGER NOT NULL, username TEXT NOT NULL,
  dirs TEXT NOT NULL DEFAULT '', fire INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, seat)
);
"""

PRAGMAS = {
    "wal-normal": ["PRAGMA journal_mode=WAL", "PRAGMA synchronous=NORMAL"],
    "wal-full": ["PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL"],
    "delete": ["PRAGMA journal_mode=DELETE", "PRAGMA synchronous=FULL"],
}


def connect(path, autocommit=True):
    conn = sqlite3.connect(path, timeout=15.0, isolation_level=None, check_same_thread=False)
    for p in PRAGMAS[MODE]:
        conn.execute(p)
    conn.execute("PRAGMA busy_timeout=10000")
    # 和 db.py 一样：每个线程/进程一条长连接
    return conn


def worker(path, rooms, barrier, out: Queue):
    """一个进程 = 一个 gunicorn worker。"""
    conn = connect(path)
    cur = conn.cursor()
    lat = []
    busy = 0
    writes = 0
    reads = 0
    state_blob = json.dumps({"players": [{"x": i, "y": 12, "dir": "U"} for i in range(12)], "seq": 0})

    barrier.wait()
    deadline = time.time() + DURATION
    tick = 0
    while time.time() < deadline:
        t0 = time.perf_counter()
        for room in rooms:
            try:
                # 1) 客人推按键（写）
                cur.execute(
                    "INSERT INTO room_inputs (room_id, seat, username, dirs, fire, seq) "
                    "VALUES (?,?,?,?,?,1) "
                    "ON CONFLICT(room_id, seat) DO UPDATE SET "
                    "dirs=excluded.dirs, fire=excluded.fire, seq=seq+1",
                    (room, tick % SEATS_PER_ROOM, "u-%d" % (tick % 64), "UD", 1),
                )
                writes += 1
                # 2) 房主推画面（写一个大一点的字段）
                cur.execute(
                    "UPDATE rooms SET state=?, state_seq=state_seq+1 WHERE id=?",
                    (state_blob, room),
                )
                writes += 1
                # 3) 客人拉画面（读）
                cur.execute("SELECT state, state_seq FROM rooms WHERE id=?", (room,))
                cur.fetchone()
                reads += 1
            except sqlite3.OperationalError as e:
                if "locked" in str(e) or "busy" in str(e):
                    busy += 1
                else:
                    raise
        lat.append((time.perf_counter() - t0) * 1000)
        tick += 1

    out.put({"lat": lat, "busy": busy, "writes": writes, "reads": reads})
    conn.close()


def main():
    tmp = tempfile.mkdtemp(prefix="sqbench-")
    db = os.path.join(tmp, "tankbattle.db")
    try:
        conn = connect(db)
        conn.executescript(SCHEMA)
        room_ids = ["r%03d" % i for i in range(ROOMS)]
        now = "2026-10-10 11:00:00"
        for r in room_ids:
            conn.execute(
                "INSERT INTO rooms (id, host, mode, status, state, state_seq, updated_at) "
                "VALUES (?,?,?,?,?,0,?)",
                (r, "host-" + r, "coop", "playing", "{}", now),
            )
        for r in room_ids:
            for s in range(SEATS_PER_ROOM):
                conn.execute(
                    "INSERT INTO room_inputs (room_id, seat, username, dirs, fire, seq) VALUES (?,?,?,?,?,0)",
                    (r, s, "u-%d" % s, "", 0),
                )
        conn.close()

        barrier = __import__("multiprocessing").Barrier(PROCS)
        out = Queue()
        procs = [Process(target=worker, args=(db, room_ids, barrier, out)) for _ in range(PROCS)]
        t0 = time.time()
        for p in procs:
            p.start()
        for p in procs:
            p.join()
        wall = time.time() - t0

        lat, busy, writes, reads = [], 0, 0, 0
        for _ in range(PROCS):
            r = out.get()
            lat += r["lat"]
            busy += r["busy"]
            writes += r["writes"]
            reads += r["reads"]

        # 一拍 = 每房间 3 个请求（2 写 1 读），整个"房间"的节拍达成率按最慢进程算
        total_req = writes + reads
        req_s = total_req / wall
        ticks = len(lat)
        p50 = statistics.median(lat) if lat else 0
        p99 = sorted(lat)[int(len(lat) * 0.99)] if lat else 0

        print("模式            : %s" % MODE)
        print("房间数 / 进程数 : %d 房 / %d 进程" % (ROOMS, PROCS))
        print("总请求          : %d（写 %d / 读 %d）" % (total_req, writes, reads))
        print("吞吐            : %.0f req/s" % req_s)
        print("轮次(每进程)    : %d" % (ticks / PROCS))
        print("一拍耗时 p50    : %.2f ms  (房间节拍 = 60ms，超过就追不上)" % p50)
        print("一拍耗时 p99    : %.2f ms" % p99)
        print("SQLITE_BUSY     : %d" % busy)
        verdict = "可用" if p50 < 60 and busy == 0 else "顶不住"
        print("结论            : %s" % verdict)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
