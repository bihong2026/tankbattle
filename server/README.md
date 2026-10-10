# 打坦克 · 后台服务

给插件提供「发现队友 / 邀请 / 组队 / 对战 / 积分 / 排行榜」这些能力的 HTTP API。

一句话概括：**一份房主权威的联机。**

这是一份**可选的**服务：不装它也能玩，单人和四档 AI 全在浏览器里跑。装它是为了让
「在线发现 / 邀请 / 房间 / 积分榜」这几件事有地方落脚。

## 起一份

本机（开发和自娱自乐用）：

```sh
# 1. 建库建用户（MySQL 8；口令自己换，下面的 tank/tank 要和 db.py 的默认值对上）
mysql -u root -p <<'SQL'
CREATE DATABASE IF NOT EXISTS tankbattle
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER IF NOT EXISTS 'tank'@'%' IDENTIFIED BY 'tank';
GRANT ALL PRIVILEGES ON tankbattle.* TO 'tank'@'%';
FLUSH PRIVILEGES;
SQL

# 2. 建表
mysql -u tank -ptank tankbattle < schema.sql

# 3. 装依赖（建议虚拟环境）
python3 -m venv venv
./venv/bin/pip install -r requirements.txt

# 4. 起服务
./venv/bin/python app.py            # 默认 0.0.0.0:9010

curl http://127.0.0.1:9010/api/health
# {"ok":true,"service":"tankbattle","database":{...},"onlineWindow":30,...}
```

插件的默认 `serverBase` 就是 `http://127.0.0.1:9010`，所以本机这么起起来之后**不用改插件**
就能联机。起在别处就在 `$DSH_HOME/cordis.patch.yml` 里把 `serverBase` 指过去。

生产环境交给 systemd + gunicorn（`deploy/tankserver.service` 是现成的 unit，路径和用户名
按自己的实际情况改）：

```sh
sudo cp deploy/tankserver.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tankserver
systemctl status tankserver
```

## 配置

全部走环境变量，都写在 `deploy/tankserver.service` 的 `Environment=` 里：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TANK_HOST` / `TANK_PORT` | `0.0.0.0` / `9010` | 监听地址（只在 `python app.py` 直跑时用） |
| `TANK_DB_HOST` / `TANK_DB_PORT` | `127.0.0.1` / `3306` | MySQL 地址 |
| `TANK_DB_USER` / `TANK_DB_PASSWORD` | `tank` / `tank` | MySQL 账号 —— **生产务必改掉** |
| `TANK_DB_NAME` | `tankbattle` | 库名 |
| `TANK_ONLINE_WINDOW` | `30` | 多少秒没心跳就算下线 |
| `TANK_INVITE_TTL` | `120` | 邀请多久没人理就算过期 |

## 几条设计取舍

- **身份 = 一个字符串。** 插件宿主半在本机认出「登录的 DeepSeek 账号 UID」，没登录就用一个
  本机游客号（`guest-` 开头），随请求带上来，服务端据此建用户、存积分。纯粹图个乐的服务，
  不做二次鉴权 —— 别拿它当有权限边界的系统用。
- **在线 = 心跳。** 客户端在大厅每 5 秒 `POST /api/heartbeat`，超过 `ONLINE_WINDOW`（默认
  30 秒）没心跳就算下线。所以不需要 Redis，也不会留下「幽灵在线」。
- **房间 = 房主权威。** 房主跑真正的游戏引擎，每帧把整段画面快照 `POST /api/room/state`；
  客人 `GET /api/room/state` 读快照渲染，自己的按键 `POST /api/room/input` 传上来。
  场上永远只有一份真值，两边不会各跑各的跑偏。
- **积分只在服务端累加。** 客户端只上报「这一局的结果」，算多少分由 `score_delta()` 说了算。
  多人房里由**房主**把两边一起报（房主手里才有权威的分与击杀数）。
- **统一 200 + `ok` 字段。** 网络错误和业务错误都由 `ok` 表达，前端只判这个字段，
  不用去分辨 HTTP 状态码。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 探活 + 数据库连通性 |
| POST | `/api/login` | 拿本机身份换用户档案（含积分、排名） |
| POST | `/api/heartbeat` | 心跳，上报昵称 / 状态 / 所在房间 |
| GET | `/api/online?user=` | 在线的人（自动排掉自己） |
| POST | `/api/invite` | 发邀请：`from` `fromName` `to` `mode` `aiCount` `aiLevel` |
| GET | `/api/invites?user=` | 我收到的、还没处理的邀请 |
| POST | `/api/invite/respond` | 接受 / 拒绝：`id` `user` `nickname` `accept` |
| POST | `/api/room` | 开房：`host` `nickname` `mode` `aiCount` `aiLevel` |
| GET | `/api/room?room=` | 读一间房 |
| POST | `/api/room/join` | 加入：`room` `user` `nickname` |
| POST | `/api/room/leave` | 退房（房主走了房间就散） |
| GET | `/api/rooms` | 大厅能直接看到的公开房间 |
| POST | `/api/room/status` | 改房间状态：`lobby` / `playing` / `over` |
| POST | `/api/room/state` | **房主**推画面快照：`room` `user` `state` `gameStatus` |
| GET | `/api/room/state?room=&since=` | **客人**读画面；没有新画面就回 `stale` |
| POST | `/api/room/input` | **客人**传按键：`room` `user` `dirs` `fire` |
| GET | `/api/room/inputs?room=` | **房主**读别人的按键（按座位号做键） |
| POST | `/api/match/report` | 上报一局结果，服务端算分并累加 |
| GET | `/api/leaderboard?limit=` | 积分榜 |
| GET | `/api/profile?user=` | 个人档案 + 最近十局 |
| GET | `/` | 一页人看得懂的状态页 |

`mode` 只有 `coop` 和 `pvp`；`aiLevel` 只有 `rookie` / `veteran` / `hunter` / `ace`，
写错了会退回 `veteran` 而不是报错。

## 数据库

`tankbattle`，8 张表，见 `schema.sql`：

| 表 | 作用 |
| --- | --- |
| `users` | 用户档案与积分（`username` 就是那个身份串） |
| `presence` | 在线心跳（`last_seen` 过期即离线） |
| `invites` | 邀请（`pending` / `accepted` / `declined`，超时自动清） |
| `rooms` | 房间 + 房主推上来的画面快照（`state` / `state_seq`） |
| `room_members` | 房间成员与座位（`seat` 0 = 房主） |
| `room_inputs` | 客人的按键（按 `seat` 一行，覆盖式更新） |
| `matches` / `match_players` | 对局与每人战果、加分 |

## 容量（实测，不是估的）

这套联机是**轮询**的，成本跟「同时进行多少桌」成正比，跟「注册过多少人」没关系。
一桌 2 人在打的时候，每秒固定要打这些请求：

| 谁 | 节奏 | 每拍请求 | 折算 |
| --- | --- | --- | --- |
| 房主 | 每 60ms | 读客人按键 + 推画面快照 | 33.3 req/s |
| 客人 | 每 50ms | 推自己按键 + 拉画面快照 | 40.0 req/s |
| | | | **≈ 73 req/s / 桌** |

大厅里闲着的人也要打：心跳每 5 秒 1 次，大厅轮询每 4 秒 4 个接口 ≈ 1.2 req/s / 人。

`test/scale.py` 就是按上面这个节奏真压出来的（服务器上对本机跑，8 核 / 4 个 gunicorn
sync worker）：

| 同时桌数 | 达成 | p50 | 房主节拍达成 | 客人节拍达成 |
| --- | --- | --- | --- | --- |
| 10 | 728 req/s | 2.2ms | 99% | 99% |
| 25 | 1816 req/s | 2.8ms | 99% | 99% |
| 50 | 2198 req/s | 45.1ms | 66% | 55% |
| 80 | 1093 req/s | 64.1ms | 21% | 17% |

**拐点在 25～50 桌之间，单机实用上限按 25 桌左右算。** 判据是「节拍达成率」：p50 一旦涨到
50ms（= 客人的拍子间隔），客人就开始追不上房主的画面了，再多并发只是把延迟堆得更高。
瓶颈是 `POST /api/room/input`（唯一的高频写）。在线大厅的承载大致是**几百到一千多人**。

两条必须知道的：

- 想提高上限，第一件事不是加机器，是**把轮询改成推送**（WebSocket / SSE），
  或者至少把「读按键 + 推画面」合成一次请求 —— 现在的 73 req/s 里有近一半是重复握手。
- **隔着办公网压是不算数的**。同一份压测从办公网打过去，并发一过 2 就塌到几十 req/s
  （同一个脚本、同一个服务，回环 2700 req/s）。所以要在服务器本机跑，量到的才是服务本身。

## 自检

三份，都只用标准库，都不需要装任何东西。

```sh
# 服务端自己那一侧：建库、算分、房间生命周期
# 默认打本机 127.0.0.1:9010，换地址用 TANK_API=http://host:port
python3 test/smoke.py

# 插件前端半的确切调用契约：路径、查询参数、请求体字段名、前端读的响应字段名
python3 test/client_contract.py http://127.0.0.1:9010

# 容量：造 N 个真房间按真节奏压，看从几桌开始追不上（会写数据，跑完自己清）
python3 test/scale.py http://127.0.0.1:9010
```

`client_contract.py` 是**故意**把字段名从 `plugins/tank-battle/client.js` 里抄过来的：
改了插件与服务的接口而没同步改这边，它就会先红。这是「前端页面突然什么都不显示」这类
静默故障的唯一防线。

## 文件

```
app.py                    全部 HTTP 接口
db.py                     PyMySQL 连接（按线程缓存 + 自动重连）
schema.sql                建库建表
requirements.txt          Flask + PyMySQL
deploy/tankserver.service systemd unit（gunicorn 4 worker，9010）
test/smoke.py             服务端自检（建库、算分、房间生命周期）
test/client_contract.py   插件前端的调用契约自检（字段名对齐）
test/scale.py             容量压测（造 N 个真房间按真节奏压，出「几桌开始追不上」）
```
