# -*- coding: utf-8 -*-
"""打坦克后台服务的端到端冒烟测试。

只依赖标准库（urllib），不装任何东西，直接对着跑着的服务打一遍整条业务链：
登录 → 心跳/在线发现 → 邀请 → 接受（建房）→ 画面同步 → 操作同步 → 上报战绩 → 排行榜。

跑法：
    python server/test/smoke.py                     # 默认打本机 127.0.0.1:9010
    TANK_API=http://10.0.0.5:9010 python server/test/smoke.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("TANK_API", "http://127.0.0.1:9010").rstrip("/")

passed = 0
failed = 0
failures = []


def call(path, payload=None, method=None):
    url = API + path
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = method or "POST"
    request = urllib.request.Request(url, data=data, headers=headers, method=method or "GET")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:  # 服务端仍然返回 JSON
        try:
            return json.loads(error.read().decode("utf-8"))
        except Exception:
            return {"ok": False, "message": f"HTTP {error.code}"}
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "message": f"连不上服务：{error}"}


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"ok   {name}")
    else:
        failed += 1
        failures.append(name)
        print(f"FAIL {name}  ->  {detail}")


def main():
    # 每个用户带一个随机后缀，免得反复跑测试时和上一次的数据打架。
    tag = str(int(time.time()))[-6:]
    alice = f"smoke_a_{tag}"
    bob = f"smoke_b_{tag}"

    print(f"== 服务地址 {API} ==")
    health = call("/api/health")
    check("探活返回 ok", health.get("ok") is True, json.dumps(health)[:160])
    check("数据库连通", bool(health.get("database", {}).get("ok")), json.dumps(health)[:160])

    print("\n== 登录（本机身份换档案）==")
    login_a = call("/api/login", {"username": alice, "nickname": "甲"})
    check("甲登录成功", login_a.get("ok") is True, json.dumps(login_a)[:160])
    check("登录就带出积分字段", "score" in (login_a.get("user") or {}), json.dumps(login_a)[:160])
    check("登录就带出排名", isinstance(login_a.get("rank"), int), json.dumps(login_a)[:160])
    login_b = call("/api/login", {"username": bob, "nickname": "乙"})
    check("乙登录成功", login_b.get("ok") is True)

    print("\n== 在线发现 ==")
    hb_a = call("/api/heartbeat", {"username": alice, "nickname": "甲", "status": "lobby"})
    check("甲心跳成功", hb_a.get("ok") is True)
    hb_b = call("/api/heartbeat", {"username": bob, "nickname": "乙", "status": "lobby"})
    online = hb_b.get("online") or []
    names = [u["username"] for u in online]
    check("乙能看到甲在线", alice in names, str(names)[:200])
    check("在线列表不带自己", bob not in names, str(names)[:200])
    listed = call(f"/api/online?user={bob}")
    check("GET /api/online 也能查到甲", alice in [u["username"] for u in listed.get("online", [])])

    print("\n== 邀请组队 ==")
    invited = call("/api/invite", {"from": alice, "to": bob, "mode": "coop",
                                   "fromName": "甲", "aiCount": 12, "aiLevel": "hunter"})
    check("甲邀请乙成功", invited.get("ok") is True, json.dumps(invited)[:160])
    inbox = call(f"/api/invites?user={bob}")
    rows = inbox.get("invites") or []
    check("乙收到一条邀请", len(rows) >= 1, json.dumps(inbox)[:200])
    invite_id = rows[0]["id"] if rows else ""
    check("邀请里带上了模式和 AI 档位", rows and rows[0]["mode"] == "coop" and rows[0]["aiLevel"] == "hunter",
          json.dumps(rows[:1])[:200])

    print("\n== 接受邀请（自动建房）==")
    responded = call("/api/invite/respond", {"id": invite_id, "user": bob, "accept": True, "nickname": "乙"})
    check("乙接受成功", responded.get("ok") is True, json.dumps(responded)[:200])
    room = responded.get("room") or {}
    room_id = room.get("id", "")
    check("接受后拿到房间号", bool(room_id), json.dumps(responded)[:200])
    check("房间里两个人", len(room.get("members") or []) == 2, json.dumps(room)[:200])
    teams = {m["username"]: m["team"] for m in room.get("members") or []}
    check("组队模式两人同队（都是 A）", teams.get(alice) == "A" and teams.get(bob) == "A", str(teams))

    print("\n== 对战模式另开一间（分队）==")
    pvp_room = call("/api/room", {"host": alice, "nickname": "甲", "mode": "pvp", "aiCount": 8, "aiLevel": "ace"})
    pvp_id = (pvp_room.get("room") or {}).get("id", "")
    joined = call("/api/room/join", {"room": pvp_id, "user": bob, "nickname": "乙"})
    jteams = {m["username"]: m["team"] for m in (joined.get("room") or {}).get("members") or []}
    check("对战模式各在一队", jteams.get(alice) == "A" and jteams.get(bob) == "B", str(jteams))

    print("\n== 画面同步（房主权威）==")
    snapshot = {"seq": 0, "status": "playing", "stage": 1, "score": 100,
                "tiles": "0" * 169, "tanks": [{"seat": 0, "x": 64, "y": 192, "team": "A"}]}
    pushed = call("/api/room/state", {"room": room_id, "user": alice, "state": snapshot, "gameStatus": "playing"})
    check("房主推画面成功", pushed.get("ok") is True, json.dumps(pushed)[:160])
    fetched = call(f"/api/room/state?room={room_id}&since=0")
    check("客人读到画面", (fetched.get("state") or {}).get("score") == 100, json.dumps(fetched)[:200])
    check("画面序号推进到 1", fetched.get("seq") == 1, json.dumps(fetched)[:160])
    stale = call(f"/api/room/state?room={room_id}&since=1")
    check("没有新画面时告诉客人别重画", stale.get("stale") is True, json.dumps(stale)[:160])
    not_host = call("/api/room/state", {"room": room_id, "user": bob, "state": snapshot})
    check("客人不能推画面", not_host.get("ok") is False, json.dumps(not_host)[:160])

    print("\n== 操作同步 ==")
    sent = call("/api/room/input", {"room": room_id, "user": bob, "dirs": "UL", "fire": True})
    check("客人上传操作成功", sent.get("ok") is True, json.dumps(sent)[:160])
    inputs = call(f"/api/room/inputs?room={room_id}")
    guest_input = (inputs.get("inputs") or {}).get("1") or {}
    check("房主读到客人的操作", guest_input.get("dirs") == "UL" and guest_input.get("fire") is True,
          json.dumps(inputs)[:200])
    bad = call("/api/room/input", {"room": room_id, "user": "outsider_x", "dirs": "U"})
    check("不在房里的人不能上传操作", bad.get("ok") is False, json.dumps(bad)[:160])

    print("\n== 上报战绩与积分 ==")
    reported = call("/api/match/report", {
        "room": room_id, "mode": "coop", "winner": "", "outcome": "win", "detail": "冒烟测试",
        "results": [
            {"username": alice, "nickname": "甲", "team": "A", "score": 2400, "kills": 14, "outcome": "win"},
            {"username": bob, "nickname": "乙", "team": "A", "score": 1800, "kills": 9, "outcome": "win"},
        ],
    })
    check("上报成功", reported.get("ok") is True, json.dumps(reported)[:200])
    deltas = reported.get("deltas") or {}
    check("甲拿到了加分", (deltas.get(alice) or {}).get("delta", 0) > 0, json.dumps(deltas)[:200])
    check("甲的分被记进档案", (deltas.get(alice) or {}).get("user", {}).get("score", 0) > 0, json.dumps(deltas)[:200])

    print("\n== 排行榜与档案 ==")
    board = call("/api/leaderboard?limit=50")
    check("排行榜拿得到", board.get("ok") is True and isinstance(board.get("rows"), list), json.dumps(board)[:160])
    me = call(f"/api/profile?user={alice}")
    check("档案里有这一局", len(me.get("history") or []) >= 1, json.dumps(me)[:200])
    check("档案里积分大于 0", (me.get("user") or {}).get("score", 0) > 0, json.dumps(me)[:200])

    print("\n== 清理（退出房间）==")
    left = call("/api/room/leave", {"room": room_id, "user": bob})
    check("客人退出房间成功", left.get("ok") is True)
    gone = call(f"/api/room?room={room_id}")
    check("客人退出后房里只剩房主", len((gone.get("room") or {}).get("members") or []) <= 1, json.dumps(gone)[:200])

    print(f"\n合计 {passed} 项通过，{failed} 项失败。")
    if failed:
        print("失败项：" + "、".join(failures))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
