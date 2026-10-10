# -*- coding: utf-8 -*-
"""按「插件前端半的确切调用契约」打一遍后台服务。

smoke.py 验的是服务端自己那一侧（建库、算分、房间生命周期）。这一份验的是另一件事：
**插件真正发出来的那些请求**——路径、查询参数、请求体字段名、以及前端读的响应字段名——
一个都不能改名，否则页面会静默地什么都不显示。

所以这里的字段名是从 client.js 里抄过来的，改插件时如果改了契约，这一份会先红。

跑法：
    python3 test/client_contract.py [服务地址]
默认打 http://127.0.0.1:9010（在服务器上直接跑）；从别的机器跑就带上地址，例如
    python3 test/client_contract.py http://10.0.0.5:9010
只用标准库，不需要装东西。
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9010").rstrip("/")

passed = 0
failed = 0


def check(label, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("ok   %s" % label)
        return
    failed += 1
    print("FAIL %s%s" % (label, ("  →  %s" % detail) if detail else ""))


def call(method, path, body=None, query=None):
    """按前端 callApi 的样子发请求：GET 带查询串，POST 带 JSON 体，一律返回解析后的 JSON。"""
    url = BASE + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = None
    headers = {"accept": "application/json"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read().decode("utf-8")
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8")
        status = error.code
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {"ok": False, "message": "响应不是 JSON：%s" % raw[:200]}


SUFFIX = str(int(time.time()))[-6:]
A = "contract_a_%s" % SUFFIX
B = "contract_b_%s" % SUFFIX

print("== 健康检查 ==")
status, health = call("GET", "/api/health")
check("服务活着", status == 200 and health.get("ok") is True, str(health)[:160])
check("数据库连通", bool(health.get("database", {}).get("ok")), str(health.get("database"))[:160])

print("\n== 心跳与在线发现（前端每 5 秒一次）==")
status, beat = call("POST", "/api/heartbeat", {"username": A, "nickname": "联调甲", "status": "lobby", "room": ""})
check("A 的心跳被收下", status == 200 and beat.get("ok") is True, str(beat)[:160])
call("POST", "/api/heartbeat", {"username": B, "nickname": "联调乙", "status": "lobby", "room": ""})

status, online = call("GET", "/api/online", query={"user": A})
check("前端读的就是 online 字段", isinstance(online.get("online"), list), str(online)[:160])
names = [row.get("username") for row in online.get("online", [])]
check("在线名单里有 B", B in names, str(names))
check("在线名单把自己排掉了", A not in names, str(names))
row = next((r for r in online.get("online", []) if r.get("username") == B), {})
check("在线行带 nickname（大厅要显示）", row.get("nickname") == "联调乙", str(row))
check("在线行带 status（大厅要显示「对局中」）", "status" in row, str(row))

print("\n== 邀请 ==")
status, sent = call("POST", "/api/invite", {
    "from": A, "fromName": "联调甲", "to": B, "mode": "coop", "aiCount": 20, "aiLevel": "veteran",
})
check("邀请发出去了", status == 200 and sent.get("ok") is True, str(sent)[:160])

status, inbox = call("GET", "/api/invites", query={"user": B})
check("前端读的就是 invites 字段", isinstance(inbox.get("invites"), list), str(inbox)[:200])
invite = next((one for one in inbox.get("invites", []) if one.get("from") == A), None)
check("B 收到了这条邀请", invite is not None, str(inbox)[:200])
if invite:
    check("邀请带 fromName（大厅要显示谁邀的）", invite.get("fromName") == "联调甲", str(invite))
    check("邀请带 mode", invite.get("mode") == "coop", str(invite))
    check("邀请带 id", bool(invite.get("id")), str(invite))

print("\n== 接受邀请 → 成房 ==")
status, accepted = call("POST", "/api/invite/respond", {
    "id": invite.get("id") if invite else "", "user": B, "nickname": "联调乙", "accept": True,
})
check("接受成功", status == 200 and accepted.get("ok") is True, str(accepted)[:200])
check("前端读的就是 accepted 字段", accepted.get("accepted") is True, str(accepted)[:200])
room = accepted.get("room") or {}
check("前端读的就是 room 字段", bool(room.get("id")), str(accepted)[:200])
check("room 带 host（前端靠它判是不是房主）", room.get("host") == A, str(room)[:200])
check("room 带 mode", room.get("mode") == "coop", str(room)[:200])
check("room 带 aiCount", isinstance(room.get("aiCount"), int), str(room)[:200])
check("room 带 aiLevel", bool(room.get("aiLevel")), str(room)[:200])
members = room.get("members") or []
check("room 带 members（前端靠它排座位）", len(members) == 2, str(members))
check("成员排座位 0 的是房主", members[0].get("username") == A if members else False, str(members))
check("成员带 team", all("team" in one for one in members), str(members))
check("成员带 nickname", all("nickname" in one for one in members), str(members))

room_id = room.get("id", "")

status, listed = call("GET", "/api/rooms")
check("前端读的就是 rooms 字段", isinstance(listed.get("rooms"), list), str(listed)[:200])
mine = next((one for one in listed.get("rooms", []) if one.get("id") == room_id), None)
check("公开房间列表里有这间房", mine is not None, str(listed)[:200])
if mine:
    check("房间行带 host（大厅要显示谁开的）", bool(mine.get("host")), str(mine))
    check("房间行带 members 人数（大厅要判满没满）", isinstance(mine.get("members"), int), str(mine))

print("\n== 房主权威的画面同步 ==")
snapshot = {
    "v": 2, "mode": "coop", "status": "playing", "stage": 1, "clock": 1234,
    "score": 300, "scoreA": 300, "scoreB": 0, "lives": [3, 3], "levels": [0, 0],
    "freeze": 0, "shovel": 0, "tiles": "0" * (13 * 13), "bases": [{"team": "A", "c": 6, "r": 12, "alive": True}],
    "players": [], "enemies": [], "bullets": [], "powerups": [], "effects": [],
    "spawnIndex": 0, "queue": 0, "remaining": 0,
}
status, pushed = call("POST", "/api/room/state", {
    "room": room_id, "user": A, "state": snapshot, "gameStatus": "playing",
})
check("房主推画面成功", status == 200 and pushed.get("ok") is True, str(pushed)[:200])
check("推画面回一个递增的 seq", isinstance(pushed.get("seq"), int) and pushed["seq"] >= 1, str(pushed)[:200])

status, pulled = call("GET", "/api/room/state", query={"room": room_id, "since": 0})
check("客人读画面成功", status == 200 and pulled.get("ok") is True, str(pulled)[:200])
check("客人读到的 seq 与推上去的一致", pulled.get("seq") == pushed.get("seq"), "%s vs %s" % (pulled.get("seq"), pushed.get("seq")))
check("客人读到的 state 原样回来了", pulled.get("state", {}).get("score") == 300, str(pulled.get("state"))[:200])

status, stale = call("GET", "/api/room/state", query={"room": room_id, "since": pushed.get("seq", 1)})
check("没有新画面时回 stale（客人不必重画）", stale.get("stale") is True, str(stale)[:200])

status, sent_input = call("POST", "/api/room/input", {"room": room_id, "user": B, "dirs": "UR", "fire": True})
check("客人的按键被收下", status == 200 and sent_input.get("ok") is True, str(sent_input)[:200])

status, got_inputs = call("GET", "/api/room/inputs", query={"room": room_id})
check("前端读的就是 inputs 字段", isinstance(got_inputs.get("inputs"), dict), str(got_inputs)[:200])
check("按键按座位号做键（房主要能对上）", "1" in (got_inputs.get("inputs") or {}), str(got_inputs)[:200])
seat1 = (got_inputs.get("inputs") or {}).get("1") or {}
check("方向串原样回来了", seat1.get("dirs") == "UR", str(seat1))
check("开火标志原样回来了", seat1.get("fire") is True, str(seat1))

print("\n== 结算与积分（服务端算分）==")
status, reported = call("POST", "/api/match/report", {
    "room": room_id, "mode": "coop", "outcome": "win",
    "results": [
        {"username": A, "nickname": "联调甲", "team": "A", "score": 3000, "kills": 12, "outcome": "win"},
        {"username": B, "nickname": "联调乙", "team": "A", "score": 2500, "kills": 8, "outcome": "win"},
    ],
})
check("上报成功", status == 200 and reported.get("ok") is True, str(reported)[:200])
deltas = reported.get("deltas") or {}
check("前端读的就是 deltas 字段", isinstance(deltas, dict), str(reported)[:200])
check("两个人都算到了分", A in deltas and B in deltas, str(list(deltas)))
check("前端读的就是 delta 字段", isinstance((deltas.get(A) or {}).get("delta"), int), str(deltas.get(A)))
check("前端读的就是 user.score 字段", ((deltas.get(A) or {}).get("user") or {}).get("score", 0) > 0, str(deltas.get(A)))
check("前端读的就是 rank 字段", isinstance((deltas.get(A) or {}).get("rank"), int), str(deltas.get(A)))

status, board = call("GET", "/api/leaderboard", query={"limit": 10})
check("前端读的就是 rows 字段", isinstance(board.get("rows"), list), str(board)[:200])
row_a = next((one for one in board.get("rows", []) if one.get("username") == A), None)
check("刚打的人出现在排行榜里", row_a is not None, str(board)[:200])
if row_a:
    check("排行榜行带 rank", isinstance(row_a.get("rank"), int), str(row_a))
    check("排行榜行带 nickname", bool(row_a.get("nickname")), str(row_a))
    check("排行榜行带 score", isinstance(row_a.get("score"), int), str(row_a))

print("\n== 退房 ==")
status, left = call("POST", "/api/room/leave", {"room": room_id, "user": A})
check("退房成功", status == 200 and left.get("ok") is True, str(left)[:160])
status, listed2 = call("GET", "/api/rooms")
still = [one for one in listed2.get("rooms", []) if one.get("id") == room_id]
check("房主走了房间不再公开挂着", still == [], str(still)[:200])

print("\n合计 %d 项通过，%d 项失败。" % (passed, failed))
sys.exit(1 if failed else 0)
