# -*- coding: utf-8 -*-
"""打坦克（tankbattle）后台服务。

一句话：给插件提供「发现队友 / 邀请 / 组队 / 对战 / 积分 / 排行榜」这些能力的 HTTP API。

几条设计上的取舍，写在这里免得以后猜：

* 身份 = 一个字符串。插件宿主半在本机认出「登录的 DeepSeek 账号（稳定账号 UID）」，
  没登录就用一个本机游客号（`guest-` 开头），随请求带上来；服务端据此建用户、存积分。
  纯粹图个乐的服务，不做二次鉴权。
* 在线 = 心跳。客户端在大厅每 5 秒 POST 一次 /api/heartbeat，超过 window 秒没心跳就算下线，
  所以不需要 Redis 也不会有「幽灵在线」。
* 房间 = 房主权威。房主跑真正的游戏引擎，每帧把整段画面快照 POST 给服务端；客人只读快照渲染，
  自己的按键 POST 成输入。这样场上永远只有一份真值，两边不会各跑各的跑偏。
* 积分只在服务端累加。客户端只上报「这一局的结果」，算多少分由服务端说了算。
"""

import os
import secrets
from datetime import datetime

from flask import Flask, jsonify, request

import db

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024  # 画面快照几 KB，给 256KB 足够
app.config["JSON_AS_ASCII"] = False

# 在线判定窗口（秒）。心跳间隔的若干倍，容得下丢一两次心跳。
ONLINE_WINDOW = int(os.environ.get("TANK_ONLINE_WINDOW", "30"))
# 邀请多久没人理就算过期。
INVITE_TTL = int(os.environ.get("TANK_INVITE_TTL", "120"))

AI_LEVELS = ("rookie", "veteran", "hunter", "ace")
MODES = ("coop", "pvp")


# ------------------------------------------------------------------ 小工具


def new_id(prefix=""):
    return prefix + secrets.token_hex(6)


def body():
    return request.get_json(silent=True) or {}


def text(value, limit=64):
    return str("" if value is None else value).strip()[:limit]


def whole(value, default=0, low=None, high=None):
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        number = default
    if low is not None:
        number = max(low, number)
    if high is not None:
        number = min(high, number)
    return number


def ok(**payload):
    return jsonify({"ok": True, **payload})


def fail(message, status=200):
    # 统一 200 返回、用 ok 字段表达结果：前端只要看 ok，不用区分网络错误和业务错误。
    return jsonify({"ok": False, "message": str(message)}), status


@app.after_request
def allow_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/<path:_any>", methods=["OPTIONS"])
def preflight(_any):
    return ("", 204)


def ensure_user(username, nickname=""):
    """第一次见到这个身份就建一行，之后只补昵称。"""
    db.execute(
        "INSERT INTO users (username, nickname) VALUES (%s, %s) "
        "ON DUPLICATE KEY UPDATE nickname = IF(VALUES(nickname) <> '', VALUES(nickname), nickname)",
        (username, nickname),
    )
    return db.query_one("SELECT * FROM users WHERE username = %s", (username,))


def touch_presence(username, nickname="", status=None, room=None):
    row = db.query_one("SELECT status, room_id FROM presence WHERE username = %s", (username,))
    next_status = status if status is not None else (row["status"] if row else "lobby")
    next_room = room if room is not None else (row["room_id"] if row else "")
    db.execute(
        "INSERT INTO presence (username, nickname, status, room_id, last_seen) "
        "VALUES (%s, %s, %s, %s, NOW()) "
        "ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), status = VALUES(status), "
        "room_id = VALUES(room_id), last_seen = NOW()",
        (username, nickname, next_status, next_room),
    )


def online_users(except_user=""):
    rows = db.query(
        "SELECT username, nickname, status, room_id, "
        "       TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS idle_seconds "
        "FROM presence WHERE last_seen > (NOW() - INTERVAL %s SECOND) "
        "ORDER BY status = 'idle', last_seen DESC LIMIT 200",
        (ONLINE_WINDOW,),
    )
    return [row for row in rows if row["username"] != except_user]


def user_public(row):
    if not row:
        return None
    return {
        "username": row.get("username", ""),
        "nickname": row.get("nickname") or row.get("username", ""),
        "score": int(row.get("score") or 0),
        "plays": int(row.get("plays") or 0),
        "wins": int(row.get("wins") or 0),
        "bestScore": int(row.get("best_score") or 0),
        "kills": int(row.get("kills") or 0),
    }


def rank_of(score):
    row = db.query_one("SELECT COUNT(*) + 1 AS r FROM users WHERE score > %s", (int(score),))
    return int(row["r"]) if row else 1


def clean_expired():
    db.execute(
        "UPDATE invites SET status = 'expired' "
        "WHERE status = 'pending' AND updated_at < (NOW() - INTERVAL %s SECOND)",
        (INVITE_TTL,),
    )


def load_room(room_id):
    room = db.query_one("SELECT * FROM rooms WHERE id = %s", (room_id,))
    if not room:
        return None, []
    members = db.query(
        "SELECT username, nickname, team, seat, ready FROM room_members "
        "WHERE room_id = %s ORDER BY seat ASC",
        (room_id,),
    )
    return room, members


def room_public(room, members):
    return {
        "id": room["id"],
        "host": room["host"],
        "mode": room["mode"],
        "aiCount": int(room["ai_count"]),
        "aiLevel": room["ai_level"],
        "status": room["status"],
        "seq": int(room["state_seq"]),
        "createdAt": str(room["created_at"]),
        "members": [
            {
                "username": m["username"],
                "nickname": m["nickname"] or m["username"],
                "team": m["team"],
                "seat": int(m["seat"]),
                "ready": bool(m["ready"]),
            }
            for m in members
        ],
    }


def create_room(host, host_name, mode, ai_count, ai_level, guest="", guest_name=""):
    room_id = new_id("r")
    db.execute(
        "INSERT INTO rooms (id, host, mode, ai_count, ai_level, status) VALUES (%s, %s, %s, %s, %s, 'lobby')",
        (room_id, host, mode, ai_count, ai_level),
    )
    db.execute(
        "INSERT INTO room_members (room_id, username, nickname, team, seat) VALUES (%s, %s, %s, 'A', 0)",
        (room_id, host, host_name),
    )
    if guest:
        guest_team = "A" if mode == "coop" else "B"
        db.execute(
            "INSERT INTO room_members (room_id, username, nickname, team, seat) VALUES (%s, %s, %s, %s, 1)",
            (room_id, guest, guest_name, guest_team),
        )
        touch_presence(host, host_name, "lobby", room_id)
        touch_presence(guest, guest_name, "lobby", room_id)
    return room_id


# ------------------------------------------------------------------ 健康与身份


@app.get("/api/health")
def api_health():
    return jsonify({"ok": True, "service": "tankbattle", "database": db.health(),
                    "onlineWindow": ONLINE_WINDOW, "serverTime": datetime.now().isoformat()})


@app.post("/api/login")
def api_login():
    """插件进来第一件事：拿本机身份换一份用户档案（含积分、排名）。"""
    data = body()
    username = text(data.get("username"))
    if not username:
        return fail("缺少 username（本机身份串）")
    user = ensure_user(username, text(data.get("nickname"), 64))
    touch_presence(username, user["nickname"] or username, status="lobby", room="")
    return ok(user=user_public(user), rank=rank_of(user["score"]), online=online_users(username))


# ------------------------------------------------------------------ 在线发现


@app.post("/api/heartbeat")
def api_heartbeat():
    data = body()
    username = text(data.get("username"))
    if not username:
        return fail("缺少 username")
    nickname = text(data.get("nickname"), 64) or username
    ensure_user(username, nickname)
    touch_presence(username, nickname, status=text(data.get("status"), 16) or None,
                   room=text(data.get("room"), 32) if data.get("room") is not None else None)
    return ok(online=online_users(username))


@app.get("/api/online")
def api_online():
    return ok(online=online_users(text(request.args.get("user"))))


# ------------------------------------------------------------------ 邀请


@app.post("/api/invite")
def api_invite():
    data = body()
    sender = text(data.get("from"))
    target = text(data.get("to"))
    if not sender or not target:
        return fail("缺少 from / to")
    if sender == target:
        return fail("不能邀请自己")
    mode = text(data.get("mode"), 16)
    if mode not in MODES:
        return fail("mode 只能是 coop 或 pvp")
    ai_level = text(data.get("aiLevel"), 16)
    if ai_level not in AI_LEVELS:
        ai_level = "veteran"
    ai_count = whole(data.get("aiCount"), 12, 0, 30)

    clean_expired()
    sender_row = ensure_user(sender, text(data.get("fromName"), 64))
    target_row = db.query_one("SELECT * FROM users WHERE username = %s", (target,))
    if not target_row:
        return fail("对方还没用过打坦克，找不到这个人")

    existing = db.query_one(
        "SELECT * FROM invites WHERE from_user = %s AND to_user = %s AND status = 'pending'",
        (sender, target),
    )
    if existing:
        return ok(invite={"id": existing["id"], "reused": True})

    invite_id = new_id("i")
    db.execute(
        "INSERT INTO invites (id, from_user, from_name, to_user, mode, ai_count, ai_level, status) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, 'pending')",
        (invite_id, sender, sender_row["nickname"] or sender, target, mode, ai_count, ai_level),
    )
    touch_presence(sender, sender_row["nickname"] or sender, status="lobby")
    return ok(invite={"id": invite_id, "to": target, "mode": mode})


@app.get("/api/invites")
def api_invites():
    clean_expired()
    user = text(request.args.get("user"))
    if not user:
        return fail("缺少 user")
    rows = db.query(
        "SELECT * FROM invites WHERE to_user = %s AND status = 'pending' ORDER BY created_at DESC",
        (user,),
    )
    return ok(invites=[
        {
            "id": r["id"],
            "from": r["from_user"],
            "fromName": r["from_name"] or r["from_user"],
            "mode": r["mode"],
            "aiCount": int(r["ai_count"]),
            "aiLevel": r["ai_level"],
            "createdAt": str(r["created_at"]),
        }
        for r in rows
    ])


@app.post("/api/invite/respond")
def api_respond():
    data = body()
    invite_id = text(data.get("id"), 32)
    user = text(data.get("user"))
    accept = bool(data.get("accept"))
    invite = db.query_one("SELECT * FROM invites WHERE id = %s", (invite_id,))
    if not invite:
        return fail("这条邀请已经不存在了")
    if invite["to_user"] != user:
        return fail("这条邀请不是发给你的")
    if invite["status"] != "pending":
        return fail("这条邀请已经处理过了")

    if not accept:
        db.execute("UPDATE invites SET status = 'declined' WHERE id = %s", (invite_id,))
        return ok(accepted=False)

    guest_row = ensure_user(user, text(data.get("nickname"), 64))
    host_row = ensure_user(invite["from_user"], invite["from_name"])
    room_id = create_room(
        invite["from_user"], host_row["nickname"] or invite["from_user"],
        invite["mode"], int(invite["ai_count"]), invite["ai_level"],
        user, guest_row["nickname"] or user,
    )
    db.execute("UPDATE invites SET status = 'accepted', room_id = %s WHERE id = %s", (room_id, invite_id))
    room, members = load_room(room_id)
    return ok(accepted=True, room=room_public(room, members))


# ------------------------------------------------------------------ 房间


@app.post("/api/room")
def api_room_create():
    data = body()
    host = text(data.get("host"))
    if not host:
        return fail("缺少 host")
    mode = text(data.get("mode"), 16)
    if mode not in MODES:
        mode = "coop"
    ai_level = text(data.get("aiLevel"), 16)
    if ai_level not in AI_LEVELS:
        ai_level = "veteran"
    host_row = ensure_user(host, text(data.get("nickname"), 64))
    room_id = create_room(host, host_row["nickname"] or host, mode,
                          whole(data.get("aiCount"), 12, 0, 30), ai_level)
    room, members = load_room(room_id)
    return ok(room=room_public(room, members))


@app.post("/api/room/join")
def api_room_join():
    data = body()
    room_id = text(data.get("room"), 32)
    user = text(data.get("user"))
    room, members = load_room(room_id)
    if not room:
        return fail("房间不存在")
    if len(members) >= 2 and user not in [m["username"] for m in members]:
        return fail("房间已经满了")
    if user not in [m["username"] for m in members]:
        if room["host"] == user:
            seat, team = 0, "A"
        else:
            seat, team = 1, ("A" if room["mode"] == "coop" else "B")
        guest_row = ensure_user(user, text(data.get("nickname"), 64))
        db.execute(
            "INSERT INTO room_members (room_id, username, nickname, team, seat) VALUES (%s, %s, %s, %s, %s)",
            (room_id, user, guest_row["nickname"] or user, team, seat),
        )
    touch_presence(user, text(data.get("nickname"), 64) or user, "lobby", room_id)
    room, members = load_room(room_id)
    return ok(room=room_public(room, members))


@app.get("/api/room")
def api_room_get():
    room_id = text(request.args.get("room"), 32)
    room, members = load_room(room_id)
    if not room:
        return fail("房间不存在")
    return ok(room=room_public(room, members))


@app.get("/api/rooms")
def api_rooms_list():
    """大厅里能直接看到的公开房间。"""
    rows = db.query(
        "SELECT r.*, (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS members "
        "FROM rooms r WHERE r.status IN ('lobby', 'playing') "
        "AND r.updated_at > (NOW() - INTERVAL 300 SECOND) ORDER BY r.created_at DESC LIMIT 50"
    )
    return ok(rooms=[
        {
            "id": r["id"], "host": r["host"], "mode": r["mode"],
            "aiCount": int(r["ai_count"]), "aiLevel": r["ai_level"],
            "status": r["status"], "members": int(r["members"]),
        }
        for r in rows
    ])


@app.post("/api/room/leave")
def api_room_leave():
    data = body()
    room_id = text(data.get("room"), 32)
    user = text(data.get("user"))
    room = db.query_one("SELECT * FROM rooms WHERE id = %s", (room_id,))
    db.execute("DELETE FROM room_members WHERE room_id = %s AND username = %s", (room_id, user))
    db.execute("DELETE FROM room_inputs WHERE room_id = %s AND username = %s", (room_id, user))
    if room and room["host"] == user:
        # 房主走了房间就散了：客人按房间号也进不来，留着只会变成僵尸房。
        db.execute("DELETE FROM room_members WHERE room_id = %s", (room_id,))
        db.execute("DELETE FROM room_inputs WHERE room_id = %s", (room_id,))
        db.execute("UPDATE rooms SET status = 'over', state = NULL WHERE id = %s", (room_id,))
    touch_presence(user, status="lobby", room="")
    return ok()


@app.post("/api/room/status")
def api_room_status():
    data = body()
    room_id = text(data.get("room"), 32)
    status = text(data.get("status"), 16)
    if status not in ("lobby", "playing", "over"):
        return fail("status 不合法")
    db.execute("UPDATE rooms SET status = %s WHERE id = %s", (status, room_id))
    return ok()


# ------------------------------------------------------------------ 画面同步（房主权威）


@app.post("/api/room/state")
def api_room_state():
    """房主每帧把画面快照推上来。"""
    data = body()
    room_id = text(data.get("room"), 32)
    user = text(data.get("user"))
    state = data.get("state")
    if not room_id or state is None:
        return fail("缺少 room / state")
    room = db.query_one("SELECT host, state_seq, status FROM rooms WHERE id = %s", (room_id,))
    if not room:
        return fail("房间不存在")
    if room["host"] != user:
        return fail("只有房主能推画面")
    import json
    seq = int(room["state_seq"]) + 1
    db.execute(
        "UPDATE rooms SET state = %s, state_seq = %s, "
        "status = IF(status = 'over', 'over', IF(%s = 'playing', 'playing', status)) WHERE id = %s",
        (json.dumps(state, ensure_ascii=False, separators=(",", ":")), seq,
         text(data.get("gameStatus"), 16), room_id),
    )
    return ok(seq=seq)


@app.get("/api/room/state")
def api_room_state_get():
    room_id = text(request.args.get("room"), 32)
    since = whole(request.args.get("since"), -1)
    room = db.query_one("SELECT state, state_seq, status FROM rooms WHERE id = %s", (room_id,))
    if not room:
        return fail("房间不存在")
    seq = int(room["state_seq"])
    if seq <= since:
        return ok(stale=True, seq=seq)
    import json
    state = json.loads(room["state"]) if room["state"] else None
    return ok(seq=seq, state=state, status=room["status"])


@app.post("/api/room/input")
def api_room_input():
    """客人把自己的按键推上来。"""
    data = body()
    room_id = text(data.get("room"), 32)
    user = text(data.get("user"))
    if not room_id or not user:
        return fail("缺少 room / user")
    member = db.query_one("SELECT seat FROM room_members WHERE room_id = %s AND username = %s", (room_id, user))
    if not member:
        return fail("你不在这个房间里")
    dirs = "".join(ch for ch in text(data.get("dirs"), 16) if ch in "UDLR")
    db.execute(
        "INSERT INTO room_inputs (room_id, seat, username, dirs, fire, seq) VALUES (%s, %s, %s, %s, %s, "
        "IFNULL((SELECT s FROM (SELECT MAX(seq) + 1 AS s FROM room_inputs WHERE room_id = %s AND seat = %s) t), 1)) "
        "ON DUPLICATE KEY UPDATE dirs = VALUES(dirs), fire = VALUES(fire), seq = seq + 1",
        (room_id, int(member["seat"]), user, dirs, 1 if data.get("fire") else 0, room_id, int(member["seat"])),
    )
    return ok()


@app.get("/api/room/inputs")
def api_room_inputs():
    """房主读房里别人的按键。"""
    room_id = text(request.args.get("room"), 32)
    rows = db.query(
        "SELECT seat, dirs, fire, seq FROM room_inputs WHERE room_id = %s ORDER BY seat ASC",
        (room_id,),
    )
    return ok(inputs={str(r["seat"]): {"dirs": r["dirs"], "fire": bool(r["fire"]), "seq": int(r["seq"])} for r in rows})


# ------------------------------------------------------------------ 积分与排行榜


def score_delta(mode, outcome, score, kills):
    """一局加多少分——服务端说了算。

    底分按当局得分折算；通关额外奖励；对战赢了多给、输了也给点参与分；
    击毁数另计，鼓励多打。
    """
    base = max(0, int(score)) // 10
    bonus = {"win": 300, "draw": 60}.get(outcome, 0)
    if mode == "pvp":
        bonus += {"win": 400, "lose": 100, "draw": 200, "over": 100}.get(outcome, 100)
    return base + bonus + max(0, int(kills)) * 5


@app.post("/api/match/report")
def api_report():
    data = body()
    mode = text(data.get("mode"), 16) or "solo"
    room_id = text(data.get("room"), 32)
    results = data.get("results") or []
    if not isinstance(results, list) or not results:
        return fail("results 不能为空")

    match_id = db.insert(
        "INSERT INTO matches (room_id, mode, winner, outcome, detail) VALUES (%s, %s, %s, %s, %s)",
        (room_id, mode, text(data.get("winner")), text(data.get("outcome"), 16) or "over",
         text(data.get("detail"), 512)),
    )
    deltas = {}
    for item in results[:4]:
        username = text(item.get("username"))
        if not username:
            continue
        nickname = text(item.get("nickname"), 64) or username
        ensure_user(username, nickname)
        outcome = text(item.get("outcome"), 16) or "over"
        score = whole(item.get("score"), 0, 0)
        kills = whole(item.get("kills"), 0, 0)
        delta = score_delta(mode, outcome, score, kills)
        db.execute(
            "UPDATE users SET score = score + %s, plays = plays + 1, "
            "wins = wins + %s, kills = kills + %s, best_score = GREATEST(best_score, %s) "
            "WHERE username = %s",
            (delta, 1 if outcome == "win" else 0, kills, score, username),
        )
        db.execute(
            "INSERT INTO match_players (match_id, username, team, score, kills, delta, outcome) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (match_id, username, text(item.get("team"), 4) or "A", score, kills, delta, outcome),
        )
        db.execute("UPDATE presence SET status = 'lobby', room_id = '' WHERE username = %s", (username,))
        row = db.query_one("SELECT * FROM users WHERE username = %s", (username,))
        deltas[username] = {"delta": delta, "user": user_public(row), "rank": rank_of(row["score"])}
    if room_id:
        db.execute("UPDATE rooms SET status = 'over' WHERE id = %s", (room_id,))
    return ok(deltas=deltas, matchId=match_id)


@app.get("/api/leaderboard")
def api_leaderboard():
    limit = whole(request.args.get("limit"), 20, 1, 100)
    rows = db.query(
        "SELECT username, nickname, score, plays, wins, best_score, kills FROM users "
        "ORDER BY score DESC, best_score DESC LIMIT %s",
        (limit,),
    )
    return ok(rows=[{**user_public(r), "rank": index + 1} for index, r in enumerate(rows)])


@app.get("/api/profile")
def api_profile():
    username = text(request.args.get("user"))
    row = db.query_one("SELECT * FROM users WHERE username = %s", (username,))
    if not row:
        return ok(user=None)
    history = db.query(
        "SELECT m.mode, m.created_at, p.score, p.kills, p.delta, p.outcome "
        "FROM match_players p JOIN matches m ON m.id = p.match_id "
        "WHERE p.username = %s ORDER BY m.id DESC LIMIT 10",
        (username,),
    )
    return ok(user=user_public(row), rank=rank_of(row["score"]), history=[
        {"mode": h["mode"], "at": str(h["created_at"]), "score": int(h["score"]),
         "kills": int(h["kills"]), "delta": int(h["delta"]), "outcome": h["outcome"]}
        for h in history
    ])


# ------------------------------------------------------------------ 首页（自检用）


@app.get("/")
def index():
    info = db.health()
    rows = db.query("SELECT username, nickname, score FROM users ORDER BY score DESC LIMIT 5")
    board = "".join(
        f"<li>{r['nickname'] or r['username']} · {int(r['score'])} 分</li>" for r in rows
    ) or "<li>还没有人打过</li>"
    return (
        "<!doctype html><meta charset='utf-8'><title>打坦克后台服务</title>"
        "<style>body{font:14px/1.7 system-ui;margin:40px;color:#222}"
        "code{background:#f4f4f4;padding:2px 6px;border-radius:4px}</style>"
        "<h1>打坦克 · 后台服务</h1>"
        f"<p>数据库：<code>{info.get('database')}</code> · "
        f"{'连通' if info.get('ok') else '不通：' + str(info.get('message'))}</p>"
        "<p>主要接口：<code>POST /api/login</code>、<code>POST /api/heartbeat</code>、"
        "<code>GET /api/online</code>、<code>POST /api/invite</code>、"
        "<code>POST /api/room</code>、<code>POST /api/room/state</code>、"
        "<code>GET /api/leaderboard</code></p>"
        f"<h3>排行榜（前 5）</h3><ol>{board}</ol>"
    )


if __name__ == "__main__":
    port = int(os.environ.get("TANK_PORT", "9010"))
    host = os.environ.get("TANK_HOST", "0.0.0.0")
    app.run(host=host, port=port, threaded=True, debug=False)
