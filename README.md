# 打坦克 · Tank Battle

<!-- 徽章一律用静态 badge（不需要 shields 回源 GitHub API，加载快、不会显示 invalid）。
     发新版时请把下面 dsh-tank-battle 那一条的版本号与 plugins/tank-battle/package.json 同步。 -->
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![dsh-tank-battle](https://img.shields.io/badge/dsh--tank--battle-v0.3.1-4d6bfe.svg)](plugins/tank-battle/package.json)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bfe.svg)](#安装)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#安装)

一个 **DeepSeek Harness（dsh）插件**：在侧栏开一整页，玩红白机经典打坦克（Battle City）。
单人打 NPC、和同时在线的其他玩家**组队**打 NPC，或者各带一队 NPC**互相对战**，带积分榜。

游戏本体**纯浏览器端**跑（Canvas + `requestAnimationFrame`），**不依赖任何第三方库**，
也**不改 Harness 官方的任何一个文件**。联机部分有一套可选的后台服务（本仓库 `server/`），
**不装它也能玩**——只是大厅里没人、积分榜不显示。

```
plugins/tank-battle/   插件本体（浏览器半 + 宿主半 + 自检 + 一张免安装的预览页）
server/                可选的联机后台服务（Flask + MySQL）
```

## 仓库

同一份代码、同一个提交历史，同时托管在两处：

| 托管 | 地址 | 说明 |
| --- | --- | --- |
| **GitHub**（主） | <https://github.com/bihong2026/tankbattle> | Issue / PR 走这里 |
| Gitee（镜像） | <https://gitee.com/bihong2023/tankbattle> | 国内镜像，省得打不开 GitHub |

```sh
git clone https://github.com/bihong2026/tankbattle.git
```

> 打不开 GitHub 就把上面这条换成 Gitee 地址，其余步骤完全一样。下面的命令都给出两个地址。

## 安装

### 一分钟装上（桌面版）

桌面版**没有可用的命令行安装方式**：`dsh` 启动器对 `desktop` 这个 profile 会直接报错
（`profile "desktop" is managed exclusively by the Electron application`），它由桌面应用
独占管理。所以走界面装：

1. 打开应用 → **插件** → **添加插件**；
2. 粘贴下面这个地址，点安装：

   ```
   https://github.com/bihong2026/tankbattle.git#path:plugins/tank-battle
   ```

3. **完整退出应用再启动**（关窗口不算，要从托盘退出）。

装完侧栏会多出一项「打坦克」，点开就能玩。三种地址形式都能用：

| 形式 | 填什么 |
| --- | --- |
| Git 地址（推荐） | `https://github.com/bihong2026/tankbattle.git#path:plugins/tank-battle`<br>打不开 GitHub 就用 `https://gitee.com/bihong2023/tankbattle.git#path:plugins/tank-battle` |
| 本地目录 | 把仓库克隆到本地后，填 `plugins/tank-battle` 的**绝对路径**，例如 `D:\code\tankbattle\plugins\tank-battle` |
| 包名 | `dsh-tank-battle`（需要先把它发布到包源） |

### 命令行（`web` / `headless` / `sdk` / `sdk-minimal` / `acp` 等 profile）

非桌面 profile 可以用 `dsh plugin` 装（它把参数转发给 `pnpm`，所以 **`pnpm` 要在 `PATH` 上**；
`<profile>` 换成你自己的 profile 名，例如 `web`）：

```sh
# 方式一：直接从 GitHub 装（插件在仓库子目录里，用 #path: 指过去）
dsh plugin --profile <profile> add "git+https://github.com/bihong2026/tankbattle.git#path:plugins/tank-battle"
# 　Gitee 镜像：把 github.com/bihong2026 换成 gitee.com/bihong2023 即可

# 方式二：先克隆，再装本地目录（相对路径按「你敲命令时所在的目录」解析）
git clone https://github.com/bihong2026/tankbattle.git
cd tankbattle
dsh plugin --profile <profile> add ./plugins/tank-battle

# 卸载
dsh plugin --profile <profile> remove dsh-tank-battle

# 装完启动该 profile
dsh --profile <profile>
```

两点说明：

- **装完（或升级、卸载）必须重启那个 profile** —— 组合包的增删只在启动时生效。
  如果页面顶部提示「请完整退出应用再启动」，就是前端半已经换了、宿主半还是旧的。
- 本插件**没有构建步骤**（纯 JS、零依赖、`package.json` 里没有 `prepare` 脚本），
  所以不会撞上 pnpm ≥10 的 `allowBuilds` 拦截。

装好之后侧栏会多出一项「打坦克」。玩法、模式、AI 档位、插件设置与故障排查见
[`plugins/tank-battle/README.md`](plugins/tank-battle/README.md)。

## 先看一眼再装

`plugins/tank-battle/preview.html` **双击就能打开**（`file://` 也行，页面不依赖 `fetch`）。
单人 / 组队 / 对战三种模式都能玩，四档 AI 随时切换，屏幕上的方向键也能用
（二号位是 `I` `J` `K` `L` + `U`）。它引的就是插件里**同一份** `client.js`，不是另抄一版。

## 联机后台

**联机开箱可用**：插件的默认后台地址指向作者已经架好的公网服务
`http://122.51.206.118/tanks`，所以两个人各装一个插件、点开大厅就能互相看见、开房对局，
**不用自己起任何服务**。单人模式、预览页更是跟后台完全无关。

### 想自己架一个后台（可选）

```sh
cd server
mysql -u root -p < schema.sql        # 建库建表（库名 tankbattle）
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python app.py             # 默认监听 0.0.0.0:9010
```

架起来之后**插件默认不会连它**（默认连的是作者那台），把插件指过去即可（三选一，
前两种改完要重启）：

- 编辑 `$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh/cordis.patch.yml`，不存在就新建），
  覆盖插件设置里的 `serverBase` —— 见 [`plugins/tank-battle/README.md`](plugins/tank-battle/README.md#插件设置默认值)；
- 或者设环境变量 `TANK_SERVER_BASE=http://127.0.0.1:9010`；
- 或者干脆改仓库里 `plugins/tank-battle/cordis.patch.yml` 那一行（本地自己用可以这么干）。

优先级是 **环境变量 → 插件设置 → 代码默认值**。

**要让公网上的人一起玩**，[`server/README.md`](server/README.md) 里有一整套照做可复现的步骤
（MySQL 最小化配置、只能本机连的账号、systemd unit、在既有 80 端口上用 `/tanks/` 路径反代、
按真实节奏算出来的限流档位），现成模板在 `server/deploy/`。跑通之后是这么个形态：

- 后端只监听 `127.0.0.1:9010`，**不占任何新端口**；
- 对外走 `http://<你的域名或公网 IP>/tanks`。

接口清单、容量实测（25~50 桌的拐点是怎么量出来的）与部署脚本见
[`server/README.md`](server/README.md)。

## 身份

联机要有个名字挂在积分榜上。插件按两条来源取，都在**宿主半**读取，凭证不出那个进程：

1. **登录的 DeepSeek 账号** —— 走 Harness 自带的账号服务，取稳定账号 UID；
2. **游客** —— 没登录就用一个按 harness home 生成的本机游客号（`guest-` 开头，重启不变）。

所以**单人玩法完全不需要登录**，也用不着后台服务。

> ⚠️ 官方账号服务是**可选依赖**：宿主里没有它时插件照常工作，只是身份退回游客。

## 自检

插件的三套自检**不联网、不依赖第三方库、不开真浏览器**，直接用 `node` 跑
（用一个假 React + 假 DOM + 假画布把整页真跑起来）：

```sh
cd plugins/tank-battle
node test/run.mjs      # 引擎、地图、四档 AI、完整对局、路由契约、身份分支、反代、战绩写盘
node test/render.mjs   # 首屏 → 大厅 → 邀请 → 接受 → 开房 → 开始 → 操作 → 暂停 → 结束 → 上报战绩
node test/preview.mjs  # 预览页：首屏 → 单人 → 组队两套键 → 对战双队比分
```

后台服务那侧也有自己几套，**只用 Python 标准库**（见 [`server/README.md`](server/README.md)），
其中 `server/test/scale.py` 是按真实联机节拍压容量的、`server/test/sqlite_bench.py` 与
`server/test/db_roundtrip.py` 是换数据库时用的实测脚本。

## 文档

| 文件 | 内容 |
| --- | --- |
| [`plugins/tank-battle/README.md`](plugins/tank-battle/README.md) | 玩法、按键、三种模式、四档 AI、插件设置、故障排查 |
| [`server/README.md`](server/README.md) | 后台服务：接口清单、部署、容量、数据库选型 |
| [`plugins/tank-battle/preview.html`](plugins/tank-battle/preview.html) | 免安装试玩页 |

## 标签（Topics）

本仓库刻意打了这几组标签，方便在 GitHub 和插件市场里被搜到：

| 标签 | 含义 |
| --- | --- |
| `dsh`、`dsh-plugin`、`dsh-plugins` | 这是一个 DeepSeek Harness（dsh）插件 |
| `deepseek`、`deepseek-harness`、`deepseek-harness-plugin` | 运行宿主 |
| `cordis`、`cordis-plugin` | 底层插件框架（Harness 用 Cordis 装载插件） |
| `tank-battle`、`battle-city`、`tank-game` | 玩法关键词 |
| `canvas-game`、`html5-game` | 实现方式（纯浏览器端 Canvas） |
| `multiplayer` | 支持联机 |

其中 **`dsh-plugin` 是社区约定俗成的发现标签**（GitHub 上已有上万个仓库在用它，
社区索引 `awesome-dsh-plugin` 的收录要求里也明确要求打这个标签），所以它最重要。

## 许可

MIT，见 [`LICENSE`](LICENSE)。
