# 打坦克（Tank Battle）

一个 DeepSeek Harness 插件：在侧栏开一个整页，红白机经典打坦克（Battle City）。

- **单人**打 NPC，四档 AI 随时换；
- **组队**：发现同时在线的其他玩家，邀请一起打中立的 NPC；
- **对战**：各自带一队 NPC 互相对攻，两边各有基地；
- 带在线用户发现、邀请、房间与**积分榜**。

游戏本体纯浏览器端跑（Canvas + `requestAnimationFrame`），不依赖任何第三方库，也不改
Harness 官方的任何一个文件。联机部分有一套可选的后台服务（本仓库的 `server/`），
**不装它也能玩**，只是大厅会是空的。

```
plugins/tank-battle/   插件本体（浏览器半 + 宿主半 + 自检 + 一张免安装预览页）
server/                可选的联机后台服务（Flask + MySQL）
```

## 装插件

桌面版（DeepSeek Harness）**没有可用的命令行安装方式** —— `dsh` 启动器对 `desktop` 这个
profile 会直接报错（「managed exclusively by the desktop application」），它由桌面应用
独占管理。所以走界面装：

1. 打开应用 → **插件** → **添加插件**；
2. 粘下面任意一种地址，点安装；
3. **完整退出应用再启动**（关窗口不算，要从托盘退出）。

| 形式 | 填什么 |
| --- | --- |
| 本地目录 | 把本仓库克隆到本地后，填 `plugins/tank-battle` 的绝对路径 |
| 包名 | `dsh-tank-battle` |
| Git | `<仓库地址>#path:plugins/tank-battle` |

装完侧栏多出一项「打坦克」。玩法、模式、AI 档位、插件设置、故障排查都在
[`plugins/tank-battle/README.md`](plugins/tank-battle/README.md)。

## 先看一眼再装

`plugins/tank-battle/preview.html` 双击就能打开（`file://` 也行），三种模式、四档 AI、
屏幕上的方向键都能用；它引的就是插件里同一份 `client.js`，不是另抄一版。

## 起联机后台（可选）

```sh
cd server
mysql -u root -p < schema.sql        # 建库建表（库名 tankbattle）
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python app.py             # 默认 0.0.0.0:9010
```

插件的默认后台地址就是 `http://127.0.0.1:9010`，所以本机这么起起来之后不用改插件。

**要让公网上的人一起玩**，`server/README.md` 里有一整套照做可复现的步骤（MySQL 最小化
配置、只能本机连的账号、systemd unit、在既有 80 端口上用 `/tanks/` 路径反代、按真实
节奏算出来的限流档位），现成的模板在 `server/deploy/`。跑通之后是这么个形态：

- 后端只监听 `127.0.0.1:9010`，**不占任何新端口**；
- 对外走 `http://<你的域名或公网 IP>/tanks`。

把插件指过去有两种办法（任选其一，改完要重启应用）：

- 改插件 `cordis.patch.yml` 里的 `serverBase`；
- 或者设环境变量 `TANK_SERVER_BASE=https://...`。

细节、接口清单、容量实测与部署脚本见 [`server/README.md`](server/README.md)。

## 身份

联机要有个名字挂在积分榜上。插件按两条来源取，都在**宿主半**读取，凭证不出那个进程：

1. **登录的 DeepSeek 账号** —— 走 Harness 自带的账号服务，取稳定账号 UID；
2. **游客** —— 没登录就用一个按 harness home 生成的本机游客号（`guest-` 开头）。

所以**单人玩法完全不需要登录**，也用不着后台服务。

## 自检

插件的三套自检不联网、不依赖第三方库、不开真浏览器，直接用 `node` 跑：

```sh
cd plugins/tank-battle
node test/run.mjs      # 引擎、地图、四档 AI、完整对局、路由契约、身份分支、反代、战绩写盘
node test/render.mjs   # 首屏 → 大厅 → 邀请 → 接受 → 开房 → 开始 → 操作 → 暂停 → 结束 → 上报战绩
node test/preview.mjs  # 预览页：首屏 → 单人 → 组队两套键 → 对战双队比分
```

后台服务那侧有自己三份（只用 Python 标准库，见 [`server/README.md`](server/README.md)）。

## 许可

MIT，见 [`LICENSE`](LICENSE)。
