# -*- coding: utf-8 -*-
"""容量压测：造 N 个真房间，按插件的真实节奏驱动，看服务器从几桌开始跟不上。

为什么要有这个：这套联机是**轮询**的，成本跟「同时进行多少桌」成正比，而不是跟「多少用户
注册过」成正比。一桌 2 人在打的时候，每秒固定要打这些请求：

    房主  每 60ms 一拍 × 2 个请求（读客人按键 + 推画面快照）= 33.3 req/s
    客人  每 50ms 一拍 × 2 个请求（推自己按键 + 拉画面快照）= 40.0 req/s
                                               合计约 73 req/s/桌

所以「能同时开多少桌」是可以量出来的，不用猜。这个脚本就是干这个的：真的按上面的节奏
发请求，看哪一档开始出现「拍子追不上」（达成率掉下来）。

它会**写真实数据**（建用户、建房间），跑完会把房间退掉；剩下的压测用户在库里，
自己删干净：

    DELETE FROM presence WHERE username LIKE 'loadtest\\_%';
    DELETE FROM users    WHERE username LIKE 'loadtest\\_%';

跑法（就在服务器上对本机跑，别隔着办公网跑 —— 那样量到的是网线不是服务）：

    /opt/tankbattle/venv/bin/python test/scale.py http://127.0.0.1:9010

默认只允许打本机 / 局域网地址。要故意打别的地址得加 --force，免得手一滑把线上打崩。
"""

import json
import statistics
import sys
import threading
import time
import urllib.request

HOST_USER = "loadtest_host"
GUEST_USER = "loadtest_guest"
GUEST_NAME = "压测客"
LEVELS = [10, 25, 50, 80]
DURATION = 8.0

# 跟真 serializeGame 一个量级（实测 12 个敌兵时 1.0KB，60 个时 1.2KB；这里凑到 1.3KB 左右）
SNAPSHOT = {
    "tanks": [{"i": i, "x": (i * 7) % 224, "y": (i * 11) % 208, "d": i % 4,
               "tm": i % 2, "k": i, "lv": i % 3} for i in range(17)],
    "bullets": [{"x": i, "y": i, "d": i % 4} for i in range(6)],
    "seq": 0,
}


def post(base, path, payload, timeout=20):
    request = urllib.request.Request(
        base + path, data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def get(base, path, timeout=20):
    request = urllib.request.Request(base + path, headers={"accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def make_rooms(base, count):
    """造 count 个房间，每个都让压测客人进去（客人得是成员才推得动按键）。"""
    rooms = []
    for _ in range(count):
        room = post(base, "/api/room", {"host": HOST_USER, "mode": "pvp",
                                        "aiCount": 20, "aiLevel": "veteran"})["room"]["id"]
        post(base, "/api/room/join", {"room": room, "user": GUEST_USER, "nickname": GUEST_NAME})
        rooms.append(room)
    return rooms


def drive(base, rooms, duration):
    """每桌两个线程，各自按真节奏打；返回这一档的成绩。"""
    lock = threading.Lock()
    latencies = []
    ticks = {"host": 0, "guest": 0}
    errors = {"n": 0}
    stop = time.time() + duration
    snapshot = json.dumps(SNAPSHOT)
    size = len(snapshot.encode("utf-8"))

    def note(latency):
        with lock:
            latencies.append(latency)

    def host(room):
        while time.time() < stop:
            started = time.time()
            try:
                note(_timed(lambda: get(base, "/api/room/inputs?room=" + room)))
                note(_timed(lambda: post(base, "/api/room/state",
                                         {"room": room, "user": HOST_USER,
                                          "state": SNAPSHOT, "gameStatus": "playing"})))
                with lock:
                    ticks["host"] += 1
            except Exception:
                with lock:
                    errors["n"] += 1
            rest = 0.060 - (time.time() - started)
            if rest > 0:
                time.sleep(rest)

    def guest(room):
        while time.time() < stop:
            started = time.time()
            try:
                note(_timed(lambda: post(base, "/api/room/input",
                                         {"room": room, "user": GUEST_USER,
                                          "dirs": "UDL", "fire": True})))
                note(_timed(lambda: get(base, "/api/room/state?room=" + room + "&since=-1")))
                with lock:
                    ticks["guest"] += 1
            except Exception:
                with lock:
                    errors["n"] += 1
            rest = 0.050 - (time.time() - started)
            if rest > 0:
                time.sleep(rest)

    threads = []
    for room in rooms:
        threads.append(threading.Thread(target=host, args=(room,)))
        threads.append(threading.Thread(target=guest, args=(room,)))
    started = time.time()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    elapsed = time.time() - started

    ordered = sorted(latencies)
    return {
        "rooms": len(rooms),
        "requests": len(latencies),
        "rps": len(latencies) / elapsed,
        "bytes": size,
        "p50": statistics.median(ordered) if ordered else 0.0,
        "p95": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))] if ordered else 0.0,
        # 达成率：实际拍数 / 这一档「本该」有的拍数。掉到 90% 以下就是追不上了。
        "host_keep": ticks["host"] / (elapsed / 0.060 * len(rooms)) * 100,
        "guest_keep": ticks["guest"] / (elapsed / 0.050 * len(rooms)) * 100,
        "errors": errors["n"],
    }


def _timed(fn):
    started = time.time()
    fn()
    return (time.time() - started) * 1000


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    base = (args[0] if args else "http://127.0.0.1:9010").rstrip("/")
    levels = [int(x) for x in args[1:]] or LEVELS

    if not force and not any(base.startswith(prefix) for prefix in
                            ("http://127.0.0.1", "http://localhost", "http://10.", "http://192.168.")):
        print("拒绝压测非本机 / 局域网地址 %s（确实要打就加 --force）" % base)
        return 1

    post(base, "/api/login", {"username": HOST_USER, "nickname": "压测房主"})
    post(base, "/api/login", {"username": GUEST_USER, "nickname": GUEST_NAME})
    print("目标 %s" % base)
    print("每桌节奏：房主 16.7 拍/秒 × 2 请求 + 客人 20 拍/秒 × 2 请求 ≈ 73 请求/秒/桌\n")
    print(" 桌数   达成 req/s   快照   p50ms  p95ms   房主节拍达成   客人节拍达成   失败")
    for level in levels:
        rooms = make_rooms(base, level)
        row = drive(base, rooms, DURATION)
        print("%5d  %11.0f  %4dB  %6.1f  %6.1f  %11.0f%%  %11.0f%%  %6d" % (
            row["rooms"], row["rps"], row["bytes"], row["p50"], row["p95"],
            row["host_keep"], row["guest_keep"], row["errors"]))
        for room in rooms:
            try:
                post(base, "/api/room/leave", {"room": room, "user": HOST_USER})
            except Exception:
                pass
    print("\n房已退掉。库里还剩两个压测用户，清掉：")
    print("  DELETE FROM presence WHERE username LIKE 'loadtest\\_%';")
    print("  DELETE FROM users    WHERE username LIKE 'loadtest\\_%';")
    return 0


if __name__ == "__main__":
    sys.exit(main())
