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

## 放到公网（实测跑通的一套）

本机自己玩不用看这节。要让外面的人也能联机，把这份服务放到一台有公网 IP 的机器上就行。
下面是照着做就能复现的一整套，括号里记的是当时踩到的坑。

参照环境：Ubuntu 24.04 / 4 核 / 3.7G 内存，而且这台机器上**已经有别的服务在跑**。

### 1. 装 MySQL，压到最小

```sh
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server
```

这台机器上还跑着别的东西，别让 MySQL 按默认吃内存（默认常驻 300MB 起）。写一份
`/etc/mysql/mysql.conf.d/99-tankbattle.cnf`：

```ini
[mysqld]
bind-address = 127.0.0.1          # 只服务本机的 tankserver，不对外开 3306
skip-name-resolve = ON
innodb_buffer_pool_size = 64M
performance_schema = OFF          # 这一行能省一两百 MB 常驻内存
max_connections = 64
table_open_cache = 128
tmp_table_size = 8M
max_heap_table_size = 8M
key_buffer_size = 8M
```

`sudo systemctl restart mysql` 之后，常驻内存从 300MB+ 落到 **约 150MB**。

### 2. 建库 + 一个只能从本机连的账号

```sh
PW=$(openssl rand -hex 16)        # 别用默认那对口令
sudo mysql -e "
CREATE DATABASE IF NOT EXISTS tankbattle DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER IF NOT EXISTS 'tank'@'127.0.0.1' IDENTIFIED BY '$PW';
GRANT ALL PRIVILEGES ON tankbattle.* TO 'tank'@'127.0.0.1';
FLUSH PRIVILEGES;"
sudo mysql < schema.sql
```

是 `'tank'@'127.0.0.1'` 不是 `'tank'@'%'` —— 服务就在本机跑，没理由让这个账号能从任何地方连。

### 3. 代码与虚拟环境

```sh
sudo mkdir -p /opt/tankbattle && sudo chown $USER /opt/tankbattle
# 把仓库里的 server/ 放进 /opt/tankbattle/server（整个仓库放进去也行）
cd /opt/tankbattle && python3 -m venv venv
./venv/bin/pip install -r server/requirements.txt
```

> 国内机器上 `pypi.org` 常常不通，加 `-i https://mirrors.aliyun.com/pypi/simple/`。

### 4. 口令单独放一个 root 只读文件

systemd 的 unit 文件通常人人可读，所以**不要把数据库口令写进 unit**，改用 `EnvironmentFile`：

```sh
sudo tee /etc/tankbattle.env >/dev/null <<EOF
TANK_DB_HOST=127.0.0.1
TANK_DB_USER=tank
TANK_DB_PASSWORD=<上一步生成的那串>
TANK_DB_NAME=tankbattle
EOF
sudo chown root:root /etc/tankbattle.env && sudo chmod 600 /etc/tankbattle.env
```

unit 里写 `EnvironmentFile=-/etc/tankbattle.env`（前面那个 `-` 表示文件不存在也不报错）。

### 5. systemd 起服务

`deploy/tankserver.service` 拿去改三处：

- **MySQL 的服务名**：RHEL 系是 `mysqld.service`，**Ubuntu 是 `mysql.service`**
  （在 Ubuntu 上写 `mysqld.service`，服务根本起不来）。模板里两种写法都提到了。
- **`ExecStart` 的 `--bind`**：改成 `127.0.0.1:9010`，只绑回环，对外交给反代（下一步）。
  公网直接暴露一个没有鉴权的服务没有必要。
- 顺手加一条 `MemoryMax=512M`。机器上还有邻居时，这条能保证它失控了也挤不掉别人。

### 6. 用路径反代出去，不占新端口

80 端口上已经有站点时（这台机器上就有），**不要新建 server 块去抢端口**，往已有的 server
里加一段 `location` 即可 —— 完整片段见 `deploy/nginx-tanks.conf`：

```nginx
location /tanks/ {
    limit_req zone=tanks burst=400 nodelay;   # 限流区定义在 http 块
    limit_conn tanksconn 64;
    proxy_pass http://127.0.0.1:9010/;        # 末尾这个 / 会剥掉 /tanks 前缀
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

`limit_req_zone` / `limit_conn_zone` **只能写在 http 块**，所以单独放一个
`/etc/nginx/conf.d/tanks-limit.conf`（`nginx.conf` 会 include 这个目录），文件名随便取。

改完 `sudo nginx -t && sudo systemctl reload nginx`。

> **两个坑，都实际踩到了。**
> 1. **别把备份文件留在 `sites-enabled/` 里。** 那里的文件会被全部加载，一个
>    `gamehub.bak-xxx` 就会导致 `a duplicate default server for 0.0.0.0:80`，
>    整个 nginx 起重失败。备份挪到 `/etc/nginx/backups/`。
> 2. `reload` 完**立刻** curl 可能拿到 404。那是优雅重载期间旧 worker 还在处理连接，
>    过一秒就好 —— 不是配置没生效，别急着回去改配置。

### 7. 从外面验一遍

```sh
curl http://<公网IP>/tanks/api/health
# {"ok":true,"service":"tankbattle","database":{"database":"tankbattle","ok":true,...}}

# 契约也从外面跑一遍，确认反代没有改变任何字段（这一步最值得做）
python3 test/client_contract.py http://<公网IP>/tanks
```

插件的「服务器地址」填 `http://<公网IP>/tanks`（**末尾不要斜杠**，宿主半会自己接 `/api/...`）。

### 限流参数别照抄，先算一遍

第一版按「挡住脚本」的思路设了 `rate=40r/s`，结果**会误伤正常玩家** —— 按实测一桌的
客人自己就要 40 req/s（50ms 一拍 × 2 请求），正好压在线上；同一个 NAT 出口（公司、宿舍）
两个人一起玩就是 73 req/s，必然被拦。

最后定的是 **`rate=200r/s` + `burst=400` + `limit_conn 64`**，实测：

| 负载 | 实际速率 | 结果 |
| --- | --- | --- |
| 一桌玩家（按真节奏打 6 秒） | 72 req/s | 432 个请求**全 200**，零误伤 |
| 脚本刷量（1200 请求不限速） | — | 只放行 548 个，**挡下 652 个 503** |

判据一句话：**阈值要明显高于「一桌 73 req/s」**，否则罚的是正常玩家。它只是兜底，
不是容量管理 —— 真能开几桌由上面那节容量数字说了算。

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

## 换成别的数据库？（实测数据，省得你重跑）

数据库层全在 `db.py`，连接参数全走环境变量 `TANK_DB_HOST` / `TANK_DB_PORT` / `TANK_DB_USER` /
`TANK_DB_PASSWORD` / `TANK_DB_NAME`，所以换机器、换库都不用改代码。

**先记住判据**：联机是轮询的，客人 50ms 一拍、房主 60ms 一拍，**每拍要打 3 条 SQL**
（见 `plugins/tank-battle/client.js` 的 `hostNet` / `guestNet`）。所以真正的指标是
「**每拍花在数据库上多少毫秒**」，不是数据库的总吞吐。`test/db_roundtrip.py` 量的就是单条语句往返：

```
本机 MySQL  1 条语句 p50 0.176ms  →  每拍约 0.5ms（占 50ms 拍子的 1%）
```

### 换 SQLite

`test/sqlite_bench.py`（纯标准库、4 个独立进程 = 4 个 gunicorn worker、25 房、每拍 2 写 1 读）：

| 日志模式 | 吞吐 | 一拍 p50 | p99 | 写锁冲突 |
| --- | --- | --- | --- | --- |
| **WAL + `synchronous=NORMAL`** | **51,342 req/s** | 1.49ms | 14.83ms | 0 |
| WAL + `synchronous=FULL` | 2,863 req/s | 21.06ms | 2,155ms | 0 |
| 回滚日志 + `synchronous=FULL`（SQLite 默认） | 579 req/s | 128.33ms | 6,470ms | 0 |

**能扛，但必须显式 `journal_mode=WAL` + `synchronous=NORMAL`。** 用 SQLite 的默认档位只有
579 req/s，WAL 但同步 FULL 也只有 2,863 req/s 且 p99 到 2 秒 —— 表现就是「画面卡死」，不是「慢一点」。
代价是 NORMAL 下掉电可能丢最后几个事务（对局画面无所谓，积分窗口有界）。

需要改的地方：`ON DUPLICATE KEY UPDATE ... VALUES(x)` ×3 → `ON CONFLICT(...) DO UPDATE ... excluded.x`；
`NOW() - INTERVAL 300 SECOND` → `datetime('now','-300 seconds')`；`IF()` → `iif()`；
`%s` → `?`；游标换 `row_factory = sqlite3.Row`；schema 里的 `ON UPDATE CURRENT_TIMESTAMP`
SQLite 没有，要自己补。

### 换远程 MySQL

**只有一个前提：必须和本服务同地域、同一个 VPC（走内网）。** 每拍 = 3 × 网络往返：

| 数据库位置 | 单程 RTT | 每拍开销 | 占 50ms 拍子 |
| --- | --- | --- | --- |
| 同地域云数据库（内网 VPC） | ≈0.3~0.5ms | 1.5ms | 3% ✅ |
| 公网同省 IDC | ≈5ms | 15ms | 30% ⚠️ |
| 公网跨地域 / 异地办公网 | ≈20ms | 60ms | 120% ❌ 必然卡顿 |

走公网就**别想了**：实测云主机到境内目标的 TCP 连接延迟就在 3.5~11ms，代入正好是
10~33ms/拍，把 50ms 的余量啃掉一大半。另外快照 JSON 每帧约 2~4KB、房主每 60ms 推一次，
25 桌时应用↔数据库这条链路要扛约 10Mbps —— 本机 MySQL 是内存搬运不花钱，走远程要额外买单。

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
app.py                      全部 HTTP 接口
db.py                       PyMySQL 连接（按线程缓存 + 自动重连）
schema.sql                  建库建表
requirements.txt            Flask + PyMySQL + gunicorn
deploy/tankserver.service   systemd unit（gunicorn 4 worker，9010）
deploy/nginx-tanks.conf     反代 + 限流的 nginx 片段（放到公网时用）
test/smoke.py               服务端自检（建库、算分、房间生命周期）
test/client_contract.py     插件前端的调用契约自检（字段名对齐）
test/scale.py               容量压测（造 N 个真房间按真节奏压，出「几桌开始追不上」）
test/sqlite_bench.py        换 SQLite 时用：多进程按真节奏压写，比三种日志模式
test/db_roundtrip.py        量单条 SQL 的往返成本（判「换远程数据库」划不划算时用它）
```
