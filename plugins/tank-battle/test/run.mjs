// 打坦克自检：只验纯逻辑、路由契约和真实对局，不联网、不依赖第三方库、不开图形界面。
// 跑法：node test/run.mjs
// 界面行为另有 test/render.mjs（同样不依赖第三方库）。
//
// 写盘的用例在子进程里跑，并且把 DSH_HOME / USERPROFILE 指到临时目录 —— 免得把使用者本机
// 那份 $DSH_HOME/tank-battle.json 改掉。这是这个自检最重要的纪律。

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const TILE = 16;

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
	const one = JSON.stringify(actual);
	const other = JSON.stringify(expected);
	if (one === other) {
		passed += 1;
		console.log(`ok   ${label}`);
		return;
	}
	failed += 1;
	console.log(`FAIL ${label}  →  实际 ${one}，期望 ${other}`);
}

function checkTrue(label, condition, detail) {
	if (condition) {
		passed += 1;
		console.log(`ok   ${label}`);
		return;
	}
	failed += 1;
	console.log(`FAIL ${label}${detail === undefined ? "" : `  →  ${detail}`}`);
}

function headline(text) {
	console.log(`\n== ${text} ==`);
}

// ============================================================
// 子进程模式：只跑「真的写盘」这一段
// ============================================================

if (process.env.TANK_TEST_CHILD === "1") {
	const { readStats, recordResult, statsPath, normalizeStats } = await import("../tank-stats.js");
	const root = process.env.TANK_TEST_HOME || "";
	const file = statsPath();
	console.log(`[child] 战绩文件落在 ${file}`);
	if (!root || !file.startsWith(root)) {
		console.log("[child] SKIP 临时 HOME 没生效，跳过写盘用例（宁可不测也不动本机文件）");
		process.exit(0);
	}
	const lines = [];
	const say = (label, condition, detail) => lines.push({ label, condition: Boolean(condition), detail });

	const empty = await readStats();
	say("空文件读出来是空战绩", empty.plays === 0 && empty.bestScore === 0 && Array.isArray(empty.recent));

	const first = await recordResult({ score: 1200, stage: 3, level: 2, ai: "hunter", outcome: "clear" });
	say("第一局记进去", first.plays === 1 && first.bestScore === 1200 && first.bestStage === 3 && first.clearedStages === 1);

	const second = await recordResult({ score: 900, stage: 2, level: 1, ai: "ace", outcome: "over" });
	say("第二局低分不会压低最高分", second.plays === 2 && second.bestScore === 1200 && second.bestStage === 3 && second.wins === 0);

	const third = await recordResult({ score: 5000, stage: 4, level: 3, ai: "ace", outcome: "win" });
	say("通关局刷新最高分并计一次通关", third.bestScore === 5000 && third.bestStage === 4 && third.wins === 1);

	const reread = await readStats();
	say("重新读回来与内存里一致", JSON.stringify(reread) === JSON.stringify(third), "两份不一致");
	say("最近十局按时间倒序", reread.recent.length === 3 && reread.recent[0].score === 5000 && reread.recent[2].score === 1200);

	const dirty = normalizeStats({ bestScore: -5, bestStage: "abc", plays: 1.9, wins: null, recent: "nope" });
	say("脏数据收拾成 0 而不是 NaN", dirty.bestScore === 0 && dirty.bestStage === 0 && dirty.plays === 1 && dirty.wins === 0 && dirty.recent.length === 0);

	writeFileSync(file, "{ 这不是 JSON", "utf8");
	const broken = await readStats();
	say("文件坏了退回空战绩而不抛错", broken.plays === 0 && broken.bestScore === 0);

	for (const line of lines) {
		console.log(`${line.condition ? "ok  " : "FAIL"} [child] ${line.label}${line.detail ? `  →  ${line.detail}` : ""}`);
	}
	console.log(`[child] ${lines.filter((line) => line.condition).length}/${lines.length}`);
	process.exit(lines.every((line) => line.condition) ? 0 : 1);
}

// ============================================================
// 载入宿主半与浏览器半
// ============================================================

const host = await import("../index.js");
const identity = await import("../identity.js");
const statsModule = await import("../tank-stats.js");

const SOURCE = readFileSync(join(PLUGIN, "client.js"), "utf8");
let captured = null;
const sandboxWindow = {
	__ModuleLoader__: {
		load: (definition) => {
			captured = definition;
		}
	}
};
new Function("window", SOURCE)(sandboxWindow);
if (captured === null) throw new Error("client.js 没有调用 __ModuleLoader__.load");
if (captured.id !== "dsh-tank-battle") throw new Error(`client.js 的插件 id 不对：${captured.id}`);

// 这个自检不渲染界面（那是 render.mjs 的事），所以 React 只要够 factory 建完对象即可。
const reactStub = {
	createElement: () => null,
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useRef: (initial) => ({ current: initial }),
	useEffect: () => {},
	useMemo: (factory) => factory(),
	useCallback: (factory) => factory
};
const client = captured.factory((name) => {
	if (name === "react") return reactStub;
	throw new Error(`浏览器半不该 require 别的包：${name}`);
});
const engine = client.engine;
const CLIENT_VERSION = (SOURCE.match(/const PLUGIN_VERSION = "([^"]+)"/) ?? [])[1] ?? "";

// ============================================================
// 一、插件元信息与配置契约
// ============================================================

headline("元信息与配置契约");
const manifest = JSON.parse(readFileSync(join(PLUGIN, "package.json"), "utf8"));
const patch = readFileSync(join(PLUGIN, "cordis.patch.yml"), "utf8");

check("插件包名", manifest.name, "dsh-tank-battle");
check("前端半版本与 package.json 一致", CLIENT_VERSION, manifest.version);
check("宿主半版本与 package.json 一致", host.VERSION, manifest.version);
checkTrue("package.json 带 dsh.bundle.patch", manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch === "./cordis.patch.yml");
checkTrue("package.json 带 dsh.client.inject", Array.isArray(manifest.dsh && manifest.dsh.client && manifest.dsh.client.inject) && manifest.dsh.client.inject.length > 0);
for (const file of ["index.js", "client.js", "identity.js", "tank-stats.js", "icon.svg", "preview.html", "locale/zh.json", "locale/en.json", "README.md"]) {
	checkTrue(`files 里列了 ${file}`, (manifest.files || []).includes(file));
}
checkTrue("cordis.patch.yml 里插件 id 是 tank-battle", /- insert:\s*\n\s*- id: tank-battle/.test(patch));
checkTrue("cordis.patch.yml 里写的包名与 package.json 一致", patch.includes(manifest.name));
for (const file of ["locale/zh.json", "locale/en.json"]) {
	const locale = JSON.parse(readFileSync(join(PLUGIN, file), "utf8"));
	checkTrue(`${file} 用官方的 meta 约定`, Boolean(locale.meta && locale.meta.title && locale.meta.description));
}

const resolved = host.resolveConfig(host.DEFAULTS);
for (const key of host.CONFIG_KEYS) {
	// 最容易漏的就是 resolveConfig 的返回对象：漏一个键，config.<key> 恒为 undefined，
	// 而且静默失效、不报错，所以这里逐个断言。
	checkTrue(`resolveConfig 返回 ${key}`, Object.prototype.hasOwnProperty.call(resolved, key));
	checkTrue(`DEFAULTS 里有 ${key}`, Object.prototype.hasOwnProperty.call(host.DEFAULTS, key));
	checkTrue(`cordis.patch.yml 的 config 里有 ${key}`, new RegExp(`^\\s+${key}:`, "m").test(patch));
}
check("默认设置原样回来", resolved, host.DEFAULTS);
check("未知 AI 退回默认档", host.resolveConfig({ defaultAi: "god" }).defaultAi, host.DEFAULTS.defaultAi);
check("敌人数量上限夹到 60", host.resolveConfig({ enemyCount: 999 }).enemyCount, 60);
check("敌人数量下限夹到 4", host.resolveConfig({ enemyCount: -3 }).enemyCount, 4);
check("生命数下限夹到 1", host.resolveConfig({ lives: 0 }).lives, 1);
check("音效默认开启", host.resolveConfig({}).sound, true);
check("音效可以显式关闭", host.resolveConfig({ sound: false }).sound, false);
check("传 null 不炸", host.resolveConfig(null), host.DEFAULTS);
check("传字符串不炸", host.resolveConfig("x"), host.DEFAULTS);

headline("路由注册");
const routes = [];
const warnings = [];
host.apply({
	webServer: {
		register(route) {
			routes.push(route);
			return () => {};
		}
	},
	effect(fn) {
		fn();
	},
	logger: {
		warn: (error) => warnings.push(String(error))
	}
}, host.DEFAULTS);
const exactRoutes = routes.filter((route) => route.kind === "exact");
const prefixRoutes = routes.filter((route) => route.kind === "prefix");
check("精确路由条数与清单一致", exactRoutes.length, host.ACTIONS.length);
check("精确路由路径清单", exactRoutes.map((route) => route.path), host.ACTIONS.map((action) => `${host.ROUTE_BASE}/${action}`));
check("反代是一条前缀路由", prefixRoutes.map((route) => route.path), [host.API_PREFIX]);
checkTrue("每条路由都有处理函数", routes.every((route) => typeof route.handler === "function"));
check("注册过程没有告警", warnings, []);

const ping = await host.handlers.ping({}, host.DEFAULTS);
check("ping 报出自己的名字", ping.game, "tank-battle");
check("ping 会带回默认设置", ping.config, host.DEFAULTS);
checkTrue("stats 与 record 都在处理函数表里", typeof host.handlers.stats === "function" && typeof host.handlers.record === "function");
check("战绩文件格式版本是数字", typeof statsModule.STATS_VERSION, "number");

// ============================================================
// 一之二、后台服务契约（身份 + 反代）
// ============================================================

headline("后台服务契约");
check("默认连作者公网部署的服务端", host.DEFAULT_SERVER_BASE, "http://122.51.206.118/tanks");
// 包里那份 patch 和代码里的默认值必须同一个地址：两边漂了的话，装好不改配置的人
// 连的是 patch 那份、拼地址用的又是代码那份，「换个默认地址」就会变成半好不坏。
const patchServerBase = (patch.match(/serverBase:\s*'([^']*)'/) ?? [])[1] ?? "";
check("cordis.patch.yml 里的 serverBase 与代码默认值一致", patchServerBase, host.DEFAULT_SERVER_BASE);
check("没配 serverBase 就用默认地址", host.resolveServerBase({}), host.DEFAULT_SERVER_BASE);
check("配了 serverBase 就用配置的", host.resolveServerBase({ serverBase: "https://tanks.example.com" }), "https://tanks.example.com");
check("地址末尾的斜杠剪掉，免得拼出双斜杠", host.resolveServerBase({ serverBase: "http://a.b.c:9010///" }), "http://a.b.c:9010");
check("serverBase 是空串时退回默认", host.resolveServerBase({ serverBase: "" }), host.DEFAULT_SERVER_BASE);
check("resolveServerBase 传 null / 字符串不炸", [host.resolveServerBase(null), host.resolveServerBase("x")], [host.DEFAULT_SERVER_BASE, host.DEFAULT_SERVER_BASE]);
checkTrue("环境变量优先于插件设置", (() => {
	process.env.TANK_SERVER_BASE = "http://env.example:1/";
	try {
		return host.resolveServerBase({ serverBase: "http://config.example:2" }) === "http://env.example:1";
	} finally {
		delete process.env.TANK_SERVER_BASE;
	}
})(), process.env.TANK_SERVER_BASE);
checkTrue("反代超时是个正数", Number.isFinite(host.PROXY_TIMEOUT_MS) && host.PROXY_TIMEOUT_MS > 0);
checkTrue("identity 在路由清单里", host.ACTIONS.includes("identity"));

// 反代：拿一个假 fetch 顶上去，验「路径怎么拼、状态码和响应体有没有原样回去」。
const realFetch = globalThis.fetch;
const proxied = [];
globalThis.fetch = async (url, init) => {
	proxied.push({ url, init });
	return {
		status: 201,
		async text() { return JSON.stringify({ ok: true, from: "fake-backend" }); }
	};
};
function fakeRes() {
	return {
		status: 0,
		headers: null,
		body: "",
		writeHead(status, headers) { this.status = status; this.headers = headers; },
		end(text) { this.body = text; }
	};
}
async function callProxy(url, method, body, base) {
	const res = fakeRes();
	const chunks = body === undefined ? [] : [Buffer.from(body, "utf8")];
	async function* gen() { for (const chunk of chunks) yield chunk; }
	await host.proxyApi({ url, method, [Symbol.asyncIterator]: gen }, res, base);
	return { res, sent: proxied[proxied.length - 1] };
}

const GUEST = "guest-0123456789ab";
const CUSTOM = "https://tanks.example.com";
const getCase = await callProxy(`/tank-battle/api/online?user=${GUEST}`, "GET");
check("反代把路径映射到服务端", getCase.sent.url, `${host.DEFAULT_SERVER_BASE}/api/online?user=${GUEST}`);
check("反代把 GET 带过去", getCase.sent.init.method, "GET");
check("反代不给自己加请求体", getCase.sent.init.body, undefined);
check("反代原样回状态码", getCase.res.status, 201);
check("反代原样回响应体", JSON.parse(getCase.res.body), { ok: true, from: "fake-backend" });

const postCase = await callProxy("/tank-battle/api/heartbeat", "POST", JSON.stringify({ username: GUEST }));
check("反代把 POST 请求体带过去", JSON.parse(postCase.sent.init.body), { username: GUEST });
check("反代给服务端要 JSON", postCase.sent.init.headers.accept, "application/json");

const customCase = await callProxy("/tank-battle/api/rooms", "GET", undefined, CUSTOM);
check("换成自建地址后反代跟着走", customCase.sent.url, `${CUSTOM}/api/rooms`);

// 后台没起来时不能把异常抛给 webserver（那会记 400 且前端读不到 ok 字段），
// 所以这里走的是真的那条前缀路由 —— 兜底在路由层，不在 proxyApi 里。
globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
const downRes = fakeRes();
await prefixRoutes[0].handler({ url: "/tank-battle/api/rooms", method: "GET" }, downRes);
check("后台连不上时回 200 而不是抛异常", downRes.status, 200);
const downBody = JSON.parse(downRes.body);
check("后台连不上时 ok 是 false", downBody.ok, false);
checkTrue("后台连不上时提示里带上了服务地址", String(downBody.message).includes(host.DEFAULT_SERVER_BASE), String(downBody.message));
globalThis.fetch = realFetch;

// ============================================================
// 一之三、身份：登录账号 / 游客
// ============================================================
//
// 账号服务是个普通对象，这里拿假替身把各条分支都撞一遍 —— 不用真去登录，
// 也不用碰这台机器上真实的账号状态。

headline("身份：登录账号 / 游客");

const seenMetadata = [];
const signedInAccount = {
	async getState() { return { status: "credential-stored" }; },
	async getProfile(client) {
		seenMetadata.push(client);
		return { status: "ready", value: { id: 10086, name: "老王", avatarUrl: "https://cdn.example/a.png", contact: "138****0000" } };
	}
};
const stub = (state, profile) => ({
	async getState() { return state; },
	async getProfile() { return profile; }
});

const signedIn = await identity.resolveIdentity(signedInAccount, "9.9.9");
check("登录了就报账号", [signedIn.signedIn, signedIn.source, signedIn.username, signedIn.nickname], [true, "account", "10086", "老王"]);
check("账号头像带出来", signedIn.avatarUrl, "https://cdn.example/a.png");
check("账号身份没有多余提示", signedIn.message, "");
check("调账号服务时带了客户端元数据",
	[seenMetadata[0].version, seenMetadata[0].locale.length > 0, Number.isInteger(seenMetadata[0].timezoneOffsetSeconds)],
	["9.9.9", true, true]);

const signedOut = await identity.resolveIdentity(stub({ status: "signed-out" }, null), "9.9.9");
checkTrue("没登录就退回游客", !signedOut.signedIn && signedOut.source === "guest" && /^guest-[0-9a-f]{12}$/.test(signedOut.username), signedOut.username);
checkTrue("游客也有显示名", typeof signedOut.nickname === "string" && signedOut.nickname.length > 0, signedOut.nickname);
checkTrue("游客身份会说明为什么", typeof signedOut.message === "string" && signedOut.message.length > 0, signedOut.message);

const noService = await identity.resolveIdentity(null, "9.9.9");
checkTrue("profile 里没有账号服务时也是游客（不抛错）", noService.source === "guest" && !noService.signedIn, JSON.stringify(noService));

const brokenState = await identity.resolveIdentity({ async getState() { throw new Error("凭证读不动"); } }, "9.9.9");
checkTrue("账号服务自己出错时退回游客", brokenState.source === "guest", JSON.stringify(brokenState));

const noId = await identity.resolveIdentity(stub({ status: "credential-stored" }, { status: "ready", value: { id: null, name: "x" } }), "9.9.9");
checkTrue("账号资料里没有 ID 时退回游客", noId.source === "guest", JSON.stringify(noId));

const failedProfile = await identity.resolveIdentity(stub({ status: "credential-stored" }, { status: "failed" }), "9.9.9");
checkTrue("资料请求失败时退回游客", failedProfile.source === "guest", JSON.stringify(failedProfile));

const throwingProfile = await identity.resolveIdentity({
	async getState() { return { status: "credential-stored" }; },
	async getProfile() { throw new Error("断网了"); }
}, "9.9.9");
checkTrue("取资料抛异常时退回游客", throwingProfile.source === "guest", JSON.stringify(throwingProfile));

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
check("游客号从匿名标识里取 12 位十六进制", identity.guestId(UUID), "guest-0f8fad5bd9cb");
checkTrue("同输入同输出（重启后游客号不变）", identity.guestId(UUID) === identity.guestId(UUID));
checkTrue("匿名标识读不到时也给个稳定游客号", /^guest-[0-9a-f]{12}$/.test(identity.guestId("")) && identity.guestId("") === identity.guestId(undefined));
checkTrue("游客号和账号 ID 不会撞（前缀不同）", identity.guestId(UUID).startsWith("guest-") && !"10086".startsWith("guest-"));
check("游客显示名带末尾四位", identity.guestName("guest-0f8fad5bd9cb"), "游客 D9CB");
checkTrue("harness home 尊重 $DSH_HOME", (() => {
	const before = process.env.DSH_HOME;
	process.env.DSH_HOME = "D:/tmp/dsh-home";
	try {
		return identity.dshHome() === "D:/tmp/dsh-home" && identity.anonymousIdPath().endsWith(".anonymous-user-id");
	} finally {
		if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
	}
})(), process.env.DSH_HOME);

// 身份接口：形状固定，而且永远 ok —— 没登录不是错误。
host.forgetIdentity();
const me = await host.handlers.identity();
check("身份接口永远回 ok", me.ok, true);
checkTrue("身份接口回 signedIn 布尔值", typeof me.signedIn === "boolean");
checkTrue("身份接口回 source（account / guest）", ["account", "guest"].includes(me.source), me.source);
checkTrue("身份接口回非空身份串", typeof me.username === "string" && me.username.length > 0, me.username);
checkTrue("身份接口回显示名", typeof me.nickname === "string" && me.nickname.length > 0, me.nickname);
checkTrue("身份接口绝不回凭证", !("password" in me) && !("token" in me) && !/token|password|secret/i.test(JSON.stringify(me)));

// 走一遍 ctx.get：有账号服务就用账号，没有就是游客，服务自己出错也不能把请求打挂。
host.forgetIdentity();
const withAccount = await host.handlers.identity({ get: (key) => (key === "deepseekAccount" ? signedInAccount : undefined) });
check("ctx 里有账号服务时报账号", [withAccount.signedIn, withAccount.source, withAccount.username], [true, "account", "10086"]);

host.forgetIdentity();
const withoutService = await host.handlers.identity({ get: () => undefined });
checkTrue("ctx 里没有账号服务时是游客", withoutService.source === "guest", JSON.stringify(withoutService));

host.forgetIdentity();
const throwingCtx = await host.handlers.identity({ get() { throw new Error("没有服务仓库"); } });
checkTrue("ctx.get 抛错时退回游客而不是把请求打挂", throwingCtx.source === "guest", JSON.stringify(throwingCtx));
host.forgetIdentity();

// 缓存：账号那一支认定了就缓存 5 分钟，游客那一支只缓存 15 秒 —— 刚登录完的人不该等 5 分钟
// 才被认出来。用假时钟把这几段直接撞一遍。
const accountCtx = { get: (key) => (key === "deepseekAccount" ? signedInAccount : undefined) };
const bareCtx = { get: () => undefined };
const T0 = 1_700_000_000_000;
host.forgetIdentity();
check("没登录时 identityOf 给游客", (await host.identityOf(bareCtx, T0)).source, "guest");
check("游客身份在缓存期内不会重问", (await host.identityOf(accountCtx, T0 + 5_000)).source, "guest");
check("过了游客缓存期（15 秒）就认出刚登录的账号",
	await (async () => {
		const me2 = await host.identityOf(accountCtx, T0 + 16_000);
		return [me2.signedIn, me2.source, me2.username];
	})(), [true, "account", "10086"]);
check("账号身份在缓存期内不会掉回游客", (await host.identityOf(bareCtx, T0 + 16_000 + 60_000)).source, "account");
check("账号身份过了 5 分钟会重新确认（账号服务没了就掉回游客）",
	(await host.identityOf(bareCtx, T0 + 16_000 + 6 * 60_000)).source, "guest");
host.forgetIdentity();


// ============================================================
// 二、关卡地图与开局状态
// ============================================================

headline("关卡地图");
const LEGAL = new Set([".", "#", "@", "~", "T", "=", "E"]);
check("四张地图", engine.STAGE_MAPS.length, 4);
for (let i = 0; i < engine.STAGE_MAPS.length; i += 1) {
	const map = engine.STAGE_MAPS[i];
	checkTrue(`第 ${i + 1} 关是 ${engine.ROWS} 行`, map.length === engine.ROWS, `实际 ${map.length} 行`);
	checkTrue(`第 ${i + 1} 关每行 ${engine.COLS} 个字符`, map.every((row) => row.length === engine.COLS), map.map((row) => row.length).join(","));
	checkTrue(`第 ${i + 1} 关只有合法字符`, map.every((row) => [...row].every((ch) => LEGAL.has(ch))));
	checkTrue(`第 ${i + 1} 关正好一个基地`, map.join("").split("E").length - 1 === 1);
	checkTrue(`第 ${i + 1} 关基地在最后一行`, map[engine.ROWS - 1].includes("E"));
}

headline("开局状态");
const game = engine.createGame({ ai: "hunter", enemyCount: 12, lives: 3, stage: 1 });
check("敌人队列长度等于设置", game.queue.length, 12);
checkTrue("前三个都是普通兵", game.queue.slice(0, 3).every((entry) => entry.kind === "basic"));
checkTrue("第 4、11 个是运兵车", game.queue[3].carrier === true && game.queue[10].carrier === true);
checkTrue("第 5 个不是运兵车", game.queue[4].carrier === false);
check("基地在正中间那一列", game.baseAt, { c: 6, r: 12 });
check("基地周围补了五块砖", game.baseGuard.length, 5);
let guardOk = true;
for (const cell of game.baseGuard) {
	if (game.tiles[engine.tileIndex(cell.c, cell.r)] !== engine.T.BRICK) guardOk = false;
}
checkTrue("护卫砖写成了砖墙", guardOk);
check("开局是预告状态", game.status, "intro");
checkTrue("开局有玩家坦克", Boolean(game.player && game.player.alive));
checkTrue("开局给一段保护时间", game.player.shield > 0);
check("敌人数量会被夹到合法区间", engine.createGame({ enemyCount: 999 }).cfg.enemyCount, 60);
check("未知 AI 会退回老兵", engine.createGame({ ai: "nobody" }).cfg.ai, "veteran");

// ============================================================
// 三、地形与移动
// ============================================================

headline("地形与移动");

/** 一块空场，敌兵不会自己冒出来，也不会因为打光敌人而自动过关。 */
function emptyField() {
	const g = engine.createGame({ ai: "rookie", enemyCount: 4, lives: 3, stage: 1, sound: false });
	g.tiles.fill(engine.T.EMPTY);
	// 清场之后基地得放回去，否则「基地被毁」这条路径根本走不到。
	g.tiles[engine.tileIndex(g.baseAt.c, g.baseAt.r)] = engine.T.BASE;
	g.queue = [{ kind: "basic", carrier: false }, { kind: "basic", carrier: false }];
	g.spawnIndex = 1;
	g.spawnTimer = 1e9;
	g.enemies = [];
	g.players = [];
	g.player = null;
	// 复活倒计时按座位走：给一个大到不会到期的值，免得玩家自己冒出来干扰用例。
	g.respawnTimers = [1e9];
	g.status = "playing";
	g.introTimer = 0;
	g.bullets = [];
	g.effects = [];
	g.powerups = [];
	g.events = [];
	g.inputs = [{ dirs: [], fire: false }];
	return g;
}

/**
 * 摆一个可由本用例直接操纵的玩家坦克。
 * 新引擎的玩家是一组「座位」：坦克要进 game.players，输入要给 game.inputs[座位号]，
 * 只写 game.player 是拿不到控制的（pickup / 移动 / 掉命都按座位走）。
 */
function placePlayer(g, dir, x, y) {
	const tank = {
		side: "player",
		kind: "player",
		seat: 0,
		team: "A",
		x,
		y,
		dir,
		hp: 1,
		maxHp: 1,
		alive: true,
		fireTimer: 0,
		spawning: 0,
		shield: 0,
		treadFrame: 0,
		color: "#e8c53a",
		glideDir: dir,
		glideFor: 0
	};
	g.players = [tank];
	g.player = tank;
	g.inputs[0].dirs = [dir];
	return tank;
}

function run(g, steps) {
	for (let i = 0; i < steps; i += 1) engine.step(g, 1000 / 60);
}

const brickWall = emptyField();
brickWall.tiles[engine.tileIndex(3, 1)] = engine.T.BRICK;
const brickTank = placePlayer(brickWall, engine.RIGHT, 16, 16);
run(brickWall, 200);
checkTrue("砖墙挡得住坦克", brickTank.x < 3 * TILE, `x=${brickTank.x}`);

const openField = emptyField();
const openTank = placePlayer(openField, engine.RIGHT, 16, 16);
run(openField, 60);
checkTrue("空场上能一路开过去", openTank.x > 90, `x=${openTank.x}`);

const steelWall = emptyField();
steelWall.tiles[engine.tileIndex(4, 1)] = engine.T.STEEL;
const steelTank = placePlayer(steelWall, engine.RIGHT, 16, 16);
run(steelWall, 200);
checkTrue("钢墙挡得住坦克", steelTank.x < 4 * TILE, `x=${steelTank.x}`);

const waterWall = emptyField();
waterWall.tiles[engine.tileIndex(4, 1)] = engine.T.WATER;
const waterTank = placePlayer(waterWall, engine.RIGHT, 16, 16);
run(waterWall, 200);
checkTrue("河挡得住坦克", waterTank.x < 4 * TILE, `x=${waterTank.x}`);

const forest = emptyField();
forest.tiles[engine.tileIndex(4, 1)] = engine.T.FOREST;
const forestTank = placePlayer(forest, engine.RIGHT, 16, 16);
run(forest, 200);
checkTrue("树林能开进去", forestTank.x > 120, `x=${forestTank.x}`);

const ice = emptyField();
ice.tiles[engine.tileIndex(3, 1)] = engine.T.ICE;
ice.tiles[engine.tileIndex(4, 1)] = engine.T.ICE;
const iceTank = placePlayer(ice, engine.RIGHT, 16, 16);
run(ice, 30);
ice.inputs[0].dirs = [];
const iceStop = iceTank.x;
run(ice, 12);
checkTrue("冰面上松手会滑一段", iceTank.x > iceStop, `${iceStop} → ${iceTank.x}`);

const turn = emptyField();
const turnTank = placePlayer(turn, engine.RIGHT, 17, 13);
turn.inputs[0].dirs = [engine.DOWN];
run(turn, 1);
checkTrue("换向时把另一条轴对齐到 8px", turnTank.dir === engine.DOWN && turnTank.x % 8 === 0, `dir=${turnTank.dir} x=${turnTank.x}`);

// ============================================================
// 四、开火、子弹与摧毁
// ============================================================

headline("开火与摧毁");

function putTank(g, x, y, dir, side, kind) {
	const tank = {
		side,
		kind: kind || (side === "player" ? "player" : "basic"),
		seat: side === "player" ? 0 : -1,
		team: side === "player" ? "A" : "ENEMY",
		x,
		y,
		dir,
		speed: 0,
		hp: 1,
		maxHp: 1,
		alive: true,
		fireTimer: side === "player" ? 0 : 1e9,
		spawning: 0,
		shield: 0,
		treadFrame: 0,
		think: 0,
		movedAt: 0,
		stuckFor: 0,
		role: side === "player" ? "player" : "base",
		carrier: false,
		color: "#e8c53a",
		visited: []
	};
	// 玩家坦克必须进 game.players：拾道具、掉命、复活都按座位在这一组里找。
	if (side === "player") {
		g.players.push(tank);
		g.player = tank;
	} else {
		g.enemies.push(tank);
	}
	return tank;
}

const shoot = emptyField();
const shooter = putTank(shoot, 6 * TILE, 8 * TILE, engine.DOWN, "player");
shoot.tiles[engine.tileIndex(6, 10)] = engine.T.BRICK;
check("能开火", engine.fire(shoot, shooter), true);
check("场上一发子弹", shoot.bullets.length, 1);
check("一级火力同时只挂一发", engine.fire(shoot, shooter), false);
run(shoot, 40);
check("砖墙被打掉", shoot.tiles[engine.tileIndex(6, 10)], engine.T.EMPTY);
check("子弹撞墙后消失", shoot.bullets.length, 0);

const twoBullets = emptyField();
twoBullets.levelBySeat[0] = 2;
twoBullets.level = 2;
const twoShooter = putTank(twoBullets, 6 * TILE, 8 * TILE, engine.DOWN, "player");
check("二级第一发", engine.fire(twoBullets, twoShooter), true);
twoShooter.fireTimer = 0;
check("二级能挂上第二发", engine.fire(twoBullets, twoShooter), true);
twoShooter.fireTimer = 0;
check("二级第三发被拦住", engine.fire(twoBullets, twoShooter), false);

const steel = emptyField();
const steelShooter = putTank(steel, 6 * TILE, 8 * TILE, engine.DOWN, "player");
steel.tiles[engine.tileIndex(6, 10)] = engine.T.STEEL;
engine.fire(steel, steelShooter);
run(steel, 40);
check("普通子弹打不动钢墙", steel.tiles[engine.tileIndex(6, 10)], engine.T.STEEL);

const star3 = emptyField();
star3.levelBySeat[0] = 3;
star3.level = 3;
const starShooter = putTank(star3, 6 * TILE, 8 * TILE, engine.DOWN, "player");
star3.tiles[engine.tileIndex(6, 10)] = engine.T.STEEL;
engine.fire(star3, starShooter);
run(star3, 40);
check("三星子弹能打穿钢墙", star3.tiles[engine.tileIndex(6, 10)], engine.T.EMPTY);

const duel = emptyField();
const duelA = putTank(duel, 4 * TILE, 6 * TILE, engine.RIGHT, "player");
const duelB = putTank(duel, 10 * TILE, 6 * TILE, engine.LEFT, "enemy", "basic");
duelB.fireTimer = 0;
engine.fire(duel, duelA);
engine.fire(duel, duelB);
check("双方各一发子弹", duel.bullets.length, 2);
run(duel, 60);
check("敌我子弹相撞一起消失", duel.bullets.length, 0);
checkTrue("两颗坦克都还活着", duelA.alive && duelB.alive);

const kill = emptyField();
const killer = putTank(kill, 4 * TILE, 6 * TILE, engine.RIGHT, "player");
const victim = putTank(kill, 10 * TILE, 6 * TILE, engine.LEFT, "enemy", "fast");
engine.fire(kill, killer);
let killSteps = 0;
while (victim.alive && killSteps < 200) {
	engine.step(kill, 1000 / 60);
	killSteps += 1;
}
checkTrue("快速兵被打掉", !victim.alive);
check("快速兵记 200 分", kill.score, 200);
checkTrue("击毁当场留下爆炸特效", kill.effects.some((effect) => effect.kind === "boom"));

const armor = emptyField();
const armorKiller = putTank(armor, 4 * TILE, 6 * TILE, engine.RIGHT, "player");
const armorTank = putTank(armor, 10 * TILE, 6 * TILE, engine.LEFT, "enemy", "armor");
armorTank.hp = 4;
armorTank.maxHp = 4;
const armorColors = [];
for (let round = 0; round < 4; round += 1) {
	armorKiller.fireTimer = 0;
	engine.fire(armor, armorKiller);
	run(armor, 60);
	armorColors.push(armorTank.color);
}
checkTrue("装甲兵要打四发才死", !armorTank.alive);
check("装甲兵记 400 分", armor.score, 400);
checkTrue("挨打会换色", new Set(armorColors).size >= 3, armorColors.join(","));

const baseHit = emptyField();
for (const cell of baseHit.baseGuard) baseHit.tiles[engine.tileIndex(cell.c, cell.r)] = engine.T.EMPTY;
// 第 1 关地图本身在 (6,10) 也有一块砖，得一起清掉，不然子弹刚出膛就撞在砖上。
baseHit.tiles[engine.tileIndex(6, 10)] = engine.T.EMPTY;
const bomber = putTank(baseHit, 6 * TILE, 9 * TILE, engine.DOWN, "player");
engine.fire(baseHit, bomber);
run(baseHit, 60);
checkTrue("基地被打掉", !baseHit.baseAlive);
check("结束时状态是 over", baseHit.status, "over");
check("基地格变成残骸", baseHit.tiles[engine.tileIndex(6, 12)], engine.T.BASE_DEAD);

// ============================================================
// 五、道具
// ============================================================

headline("道具");

function grab(kind, tweak) {
	const g = emptyField();
	const player = putTank(g, 4 * TILE, 6 * TILE, engine.UP, "player");
	if (tweak) tweak(g, player);
	g.powerups = [{ kind, x: player.x, y: player.y, t: 0, life: 1000 }];
	engine.step(g, 1000 / 60);
	return g;
}

check("星星升一级", grab("star").level, 1);
check("星星最多升到三星", grab("star", (g) => { g.levelBySeat[0] = 3; g.level = 3; }).level, 3);
checkTrue("头盔给一段护盾", grab("helmet").player.shield > 5000);
checkTrue("时钟冻结敌军", (() => { const g = grab("clock"); return g.freezeUntil > g.clock; })());
checkTrue("铲子把基地加固成钢墙", (() => {
	const g = grab("shovel");
	return g.baseGuard.every((cell) => g.tiles[engine.tileIndex(cell.c, cell.r)] === engine.T.STEEL);
})());
checkTrue("加固时间到了变回砖墙", (() => {
	const g = grab("shovel");
	g.clock = g.shovelUntil + 1;
	engine.step(g, 1000 / 60);
	return g.baseGuard.every((cell) => g.tiles[engine.tileIndex(cell.c, cell.r)] === engine.T.BRICK);
})());
checkTrue("手雷清场并给分", (() => {
	const g = emptyField();
	const player = putTank(g, 4 * TILE, 6 * TILE, engine.UP, "player");
	putTank(g, 2 * TILE, 2 * TILE, engine.DOWN, "enemy", "basic");
	putTank(g, 8 * TILE, 2 * TILE, engine.DOWN, "enemy", "fast");
	g.powerups = [{ kind: "grenade", x: player.x, y: player.y, t: 0, life: 1000 }];
	engine.step(g, 1000 / 60);
	return g.enemies.filter((enemy) => enemy.alive).length === 0 && g.score === 300;
})());
check("增命道具加一条命", grab("tank").lives, 4);
checkTrue("道具会过期消失", (() => {
	const g = emptyField();
	const player = putTank(g, 4 * TILE, 6 * TILE, engine.UP, "player");
	g.powerups = [{ kind: "star", x: 12 * TILE, y: 0, t: 0, life: 500 }];
	for (let i = 0; i < 60; i += 1) engine.step(g, 1000 / 60);
	void player;
	return g.powerups.length === 0;
})());
checkTrue("打掉运兵车会掉道具", (() => {
	const g = emptyField();
	const player = putTank(g, 4 * TILE, 6 * TILE, engine.RIGHT, "player");
	const carrier = putTank(g, 10 * TILE, 6 * TILE, engine.LEFT, "enemy", "basic");
	carrier.carrier = true;
	engine.fire(g, player);
	let steps = 0;
	while (carrier.alive && steps < 200) {
		engine.step(g, 1000 / 60);
		steps += 1;
	}
	// 道具可能掉在玩家脚下被当场捡走，所以「还在场上」和「效果已经上身」都算掉出来了。
	const picked = g.level > 0 || g.lives > 3 || g.clock < g.freezeUntil || g.shovelUntil > 0
		|| Boolean(g.player && g.player.shield > 1000);
	return !carrier.alive && (g.powerups.length === 1 || picked);
})());

// ============================================================
// 六、死亡与命数
// ============================================================

headline("死亡与命数");

function shotFromAbove(lives) {
	const g = emptyField();
	g.livesBySeat[0] = lives;
	g.lives = lives;
	const player = putTank(g, 4 * TILE, 6 * TILE, engine.UP, "player");
	const foe = putTank(g, 4 * TILE, 2 * TILE, engine.DOWN, "enemy", "basic");
	foe.fireTimer = 0;
	engine.fire(g, foe);
	return g;
}

const dying = shotFromAbove(2);
run(dying, 90);
check("死一次少一条命", dying.lives, 1);
checkTrue("会重新投放玩家或进入复活倒计时", dying.player !== null || dying.respawnTimers[0] > 0);

const ending = shotFromAbove(1);
run(ending, 90);
check("命用完就结束", ending.status, "over");

// ============================================================
// 七、关卡推进
// ============================================================

headline("关卡推进");
const clearer = emptyField();
clearer.queue = [];
clearer.spawnIndex = 0;
clearer.score = 500;
engine.step(clearer, 1000 / 60);
check("打完场上的兵就过关", clearer.status, "stageClear");
run(clearer, 220);
check("过一会儿进下一关", clearer.stage, 2);
check("分数带到下一关", clearer.score, 500);
check("下一关重新排了敌人队列", clearer.queue.length, 4);
checkTrue("下一关重新给了玩家", Boolean(clearer.player && clearer.player.alive));

const winner = emptyField();
winner.stage = 4;
winner.queue = [];
winner.spawnIndex = 0;
engine.step(winner, 1000 / 60);
check("打完最后一关算通关", winner.status, "win");

// ============================================================
// 八、四档 AI 的行为差异（真实对局）
// ============================================================

headline("四档 AI（各跑 40 秒真实对局）");
check("四档 AI 齐全", engine.AI_ORDER, ["rookie", "veteran", "hunter", "ace"]);
for (const id of engine.AI_ORDER) {
	const profile = engine.AI_PROFILES[id];
	checkTrue(`${id} 参数齐全`, ["label", "help", "think", "aim", "dodge", "path", "fireGap", "base", "random", "lead"]
		.every((key) => Object.prototype.hasOwnProperty.call(profile, key)));
	checkTrue(`${id} 的 think 是正数`, Number.isFinite(profile.think) && profile.think > 0);
}
checkTrue("会寻路的档位确实开了寻路", engine.AI_PROFILES.hunter.path && engine.AI_PROFILES.ace.path);
checkTrue("最低档不开寻路", !engine.AI_PROFILES.rookie.path);

function countBricks(g) {
	let count = 0;
	for (const id of g.tiles) if (id === engine.T.BRICK) count += 1;
	return count;
}

function simulate(ai, seconds) {
	const g = engine.createGame({ ai, enemyCount: 30, lives: 5, stage: 1, sound: false });
	g.status = "playing";
	g.introTimer = 0;
	// 场上没有玩家时所有敌兵都盯着基地，四档才有可比性。
	g.players = [];
	g.player = null;
	g.respawnTimers = [1e9];
	g.inputs = [{ dirs: [], fire: false }];
	const bricks0 = countBricks(g);
	const tally = { enemyFire: 0, boom: 0 };
	let minDist = Infinity;
	let moved = 0;
	const prev = new Map();
	const steps = Math.round((seconds * 1000) / (1000 / 60));
	for (let i = 0; i < steps; i += 1) {
		engine.step(g, 1000 / 60);
		for (const event of g.events) {
			if (event.type === "fire" && event.side === "enemy") tally.enemyFire += 1;
			if (event.type === "boom") tally.boom += 1;
		}
		g.events.length = 0;
		for (const enemy of g.enemies) {
			const before = prev.get(enemy);
			if (before) moved += Math.abs(enemy.x - before.x) + Math.abs(enemy.y - before.y);
			prev.set(enemy, { x: enemy.x, y: enemy.y });
			minDist = Math.min(minDist, Math.hypot(enemy.x - g.baseAt.c * TILE, enemy.y - g.baseAt.r * TILE) / TILE);
		}
		// 这一段只量 AI 的行为。基地被打掉就当场扶正，免得整段提前收场 ——
		// 不然量到的只是「开局那几秒谁先摸到基地」。
		if (g.status !== "playing" && g.status !== "intro") {
			g.status = "playing";
			g.outroTimer = 0;
			g.baseAlive = true;
			g.tiles[engine.tileIndex(g.baseAt.c, g.baseAt.r)] = engine.T.BASE;
			g.events.length = 0;
		}
	}
	return { tally, minDist, moved, bricks0, bricks: countBricks(g), status: g.status, score: g.score };
}

const aiReport = {};
for (const id of engine.AI_ORDER) {
	const result = simulate(id, 40);
	aiReport[id] = result;
	console.log(`     ${id.padEnd(8)} 开火 ${String(result.tally.enemyFire).padStart(3)} 次 · 爆炸 ${String(result.tally.boom).padStart(3)} 次 · 走了 ${String(Math.round(result.moved)).padStart(5)} px · 离基地最近 ${result.minDist.toFixed(1)} 格 · 剩砖 ${result.bricks}/${result.bricks0}`);
}
for (const id of engine.AI_ORDER) {
	checkTrue(`${id} 会开火`, aiReport[id].tally.enemyFire > 0);
	checkTrue(`${id} 会移动`, aiReport[id].moved > 200, `${Math.round(aiReport[id].moved)} px`);
	checkTrue(`${id} 不会把砖墙弄多`, aiReport[id].bricks <= aiReport[id].bricks0, `${aiReport[id].bricks} vs ${aiReport[id].bricks0}`);
}
checkTrue("敌兵会打砖墙开路", engine.AI_ORDER.some((id) => aiReport[id].bricks < aiReport[id].bricks0),
	engine.AI_ORDER.map((id) => `${id} ${aiReport[id].bricks}/${aiReport[id].bricks0}`).join(" · "));
checkTrue("有档位能一路推到基地脚下", engine.AI_ORDER.some((id) => aiReport[id].minDist <= 2),
	engine.AI_ORDER.map((id) => `${id} ${aiReport[id].minDist.toFixed(1)}`).join(" · "));
checkTrue("王牌开火明显比新兵密", aiReport.ace.tally.enemyFire > aiReport.rookie.tally.enemyFire,
	`ace ${aiReport.ace.tally.enemyFire} vs rookie ${aiReport.rookie.tally.enemyFire}`);
checkTrue("猎手能绕到基地附近", aiReport.hunter.minDist <= 8, `最近 ${aiReport.hunter.minDist.toFixed(1)} 格`);
checkTrue("王牌能绕到基地附近", aiReport.ace.minDist <= 8, `最近 ${aiReport.ace.minDist.toFixed(1)} 格`);

headline("寻路代价表");
const pathGame = engine.createGame({ ai: "ace", enemyCount: 4, lives: 1, stage: 2 });
// 从基地左边那一格往外算。基地本身是不可通行的，所以它是这张表的「终点邻居」。
const field = engine.distanceField(pathGame, { c: 4, r: 11 });
const at = (c, r) => field[engine.tileIndex(c, r)];
checkTrue("能从基地旁边走到左上角", Number.isFinite(at(0, 0)), String(at(0, 0)));
checkTrue("离基地越远代价越大", at(0, 0) > at(2, 11), `${at(0, 0)} vs ${at(2, 11)}`);
checkTrue("砖墙是可走但更贵的路", Number.isFinite(at(5, 11)) && at(5, 11) >= 6, String(at(5, 11)));
checkTrue("基地本身不当作可走格子", !Number.isFinite(at(pathGame.baseAt.c, pathGame.baseAt.r)));
const steelCells = [];
for (let r = 0; r < engine.ROWS; r += 1) {
	for (let c = 0; c < engine.COLS; c += 1) {
		if (pathGame.tiles[engine.tileIndex(c, r)] === engine.T.STEEL) steelCells.push([c, r]);
	}
}
checkTrue("这一关有钢墙可验", steelCells.length > 0, String(steelCells.length));
checkTrue("钢墙的距离是无穷（不可通行）", steelCells.every(([c, r]) => !Number.isFinite(at(c, r))));
const waterCells = [];
for (let r = 0; r < engine.ROWS; r += 1) {
	for (let c = 0; c < engine.COLS; c += 1) {
		if (pathGame.tiles[engine.tileIndex(c, r)] === engine.T.WATER) waterCells.push([c, r]);
	}
}
checkTrue("河也当成不可通行（得绕路）", waterCells.every(([c, r]) => !Number.isFinite(at(c, r))));

// ============================================================
// 九、一局完整对局（带一个会动会打的玩家机器人）
// ============================================================

headline("完整对局回归");

function playFullRound(ai, maxSeconds) {
	const g = engine.createGame({ ai, enemyCount: 20, lives: 3, stage: 1, sound: false });
	g.status = "playing";
	g.introTimer = 0;
	g.inputs = [{ dirs: [], fire: false }];
	const steps = Math.round((maxSeconds * 1000) / (1000 / 60));
	let shots = 0;
	for (let i = 0; i < steps; i += 1) {
		// 一个很笨的机器人：来回横着走，看到同一列有敌兵就开火。够用来把整局跑完。
		const input = g.inputs[0];
		const player = g.player;
		if (player && player.alive && player.spawning <= 0) {
			input.dirs = [Math.floor(i / 45) % 2 === 0 ? engine.RIGHT : engine.LEFT];
			const aligned = g.enemies.some((enemy) => enemy.alive && Math.abs(enemy.x - player.x) < 12);
			input.fire = aligned;
			if (aligned && player.fireTimer <= 0) shots += 1;
		} else {
			input.dirs = [];
			input.fire = false;
		}
		engine.step(g, 1000 / 60);
		g.events.length = 0;
		if (g.status === "over" || g.status === "win") break;
	}
	return { played: g, shots };
}

for (const ai of ["rookie", "ace"]) {
	const { played, shots } = playFullRound(ai, 300);
	console.log(`     ${ai.padEnd(8)} 结束状态 ${played.status} · 分数 ${played.score} · 第 ${played.stage} 关 · 场上剩敌 ${played.enemies.filter((enemy) => enemy.alive).length} · 未出场 ${played.queue.length - played.spawnIndex} · 玩家开火 ${shots} 次`);
	checkTrue(`跟 ${ai} 打能走到终局`, played.status === "over" || played.status === "win", `停在 ${played.status}`);
	checkTrue(`跟 ${ai} 打的时候玩家开过火`, shots > 0, String(shots));
	checkTrue(`跟 ${ai} 打的分数不为负`, played.score >= 0);
}

// ============================================================
// 十、绘制
// ============================================================

headline("绘制");

function fakeCtx() {
	const state = { fillStyle: "", rects: [] };
	return {
		imageSmoothingEnabled: true,
		get fillStyle() {
			return state.fillStyle;
		},
		set fillStyle(value) {
			state.fillStyle = value;
		},
		fillRect(x, y, w, h) {
			if (![x, y, w, h].every((value) => Number.isFinite(value))) {
				throw new Error(`fillRect 收到非数值：${x},${y},${w},${h}`);
			}
			state.rects.push({ x, y, w, h, fill: state.fillStyle });
		},
		clearRect() {},
		drawImage() {},
		get rects() {
			return state.rects;
		}
	};
}

const COLOUR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const scene = engine.createGame({ ai: "ace", enemyCount: 6, lives: 3, stage: 2 });
const ctx = fakeCtx();
let drawError = "";
try {
	engine.drawScene(ctx, scene, 12345);
} catch (error) {
	drawError = String(error && error.message ? error.message : error);
}
check("整屏绘制不抛错", drawError, "");
checkTrue("画的东西够多", ctx.rects.length > 200, `${ctx.rects.length} 个矩形`);
const badFill = ctx.rects.map((rect) => rect.fill).find((fill) => !COLOUR.test(fill) && fill !== "rgba(0, 0, 0, 0.72)");
check("所有颜色都是有效色值", badFill, undefined);
checkTrue("右侧 32px 状态栏也画到了", ctx.rects.some((rect) => rect.x >= 208), "没画到状态栏");
checkTrue("画布尺寸就是 240×208", engine.VIEW_W === 240 && engine.VIEW_H === 208, `${engine.VIEW_W}×${engine.VIEW_H}`);
check("点阵字宽度算得对", engine.textWidth("STAGE 1", 2), (7 * 4 - 1) * 2);
check("空字符串宽度为 0", engine.textWidth("", 1), 0);
const glyphs = fakeCtx();
engine.drawScene(glyphs, objectWithStatus(scene, "idle"), 0);
checkTrue("没开局时画面里有提示条", glyphs.rects.some((rect) => rect.fill === "rgba(0, 0, 0, 0.72)"));
const overs = fakeCtx();
engine.drawScene(overs, objectWithStatus(scene, "over"), 0);
checkTrue("结束时画面里有提示条", overs.rects.some((rect) => rect.fill === "rgba(0, 0, 0, 0.72)"));

function objectWithStatus(game, status) {
	const copy = { ...game, status };
	copy.tiles = game.tiles;
	return copy;
}

// ============================================================
// 十一、多人：座位表、画面快照、击杀计数
// ============================================================

headline("座位表");

// 引擎的硬约定：座位 0 永远是本机。服务端返回的成员是房主在前，客人必须被提到最前面，
// 否则本机按键会喂到房主那辆坦克上。
const hostRow = { username: "host", nickname: "房主", team: "A", seat: 0 };
const guestRow = { username: "me", nickname: "我", team: "B", seat: 1 };
check("客人会被提到座位 0", engine.orderSeats([hostRow, guestRow], "me").map((row) => row.username), ["me", "host"]);
check("本来就在前面就不动它", engine.orderSeats([guestRow, hostRow], "me").map((row) => row.username), ["me", "host"]);
check("认不出自己时保持服务端顺序", engine.orderSeats([hostRow, guestRow], "nobody").map((row) => row.username), ["host", "me"]);
check("空成员表不炸", engine.orderSeats([], "me"), []);
check("成员表最多取两个", engine.orderSeats([hostRow, guestRow, { username: "third" }], "me").length, 2);

check("服务端给的队别会盖过按座位推的默认值",
	engine.normalizeSeats("pvp", [guestRow, hostRow]).map((seat) => seat.team), ["B", "A"]);
check("没给队别时按座位推 A / B",
	engine.normalizeSeats("pvp", [{ username: "a" }, { username: "b" }]).map((seat) => seat.team), ["A", "B"]);
check("组队模式只有一个座位时会补上第二个",
	engine.normalizeSeats("coop", [{ username: "a" }]).length, 2);
check("对战模式没给座位时会补上对面那队",
	engine.normalizeSeats("pvp", []).map((seat) => seat.team), ["A", "B"]);
check("对战模式只剩一个客人时补的是蓝队（别补成同一队）",
	engine.normalizeSeats("pvp", [guestRow]).map((seat) => seat.team), ["B", "A"]);
check("单人模式只留一个座位",
	engine.normalizeSeats("solo", [{ username: "a" }, { username: "b" }]).length, 1);
check("单人模式的队别是 A", engine.normalizeSeats("solo", [])[0].team, "A");

headline("出生点");
// 坦克之间是**有碰撞**的（`tankFits` 最后那段 overlaps）。组队时两辆车都算 A 队，
// 要是共用一个出生点就会严丝合缝地叠在一起：一按方向键，检验落点的那辆车正好压在
// 同伴身上，判定「不通过」—— 两辆车从此锁死在原地，操作看起来完全没反应。
// 这类故障只有「开局之后两辆车都真的动起来」才抓得住，所以下面按「动没动」来验。
const coopGame = engine.createGame({ mode: "coop", ai: "rookie", enemyCount: 10, lives: 3, stage: 1, sound: false });
coopGame.status = "playing";
coopGame.introTimer = 0;
check("组队开局两个座位都出场", coopGame.players.length, 2);
check("组队两个座位同属 A 队", coopGame.players.map((tank) => tank.team), ["A", "A"]);
checkTrue("组队的两个座位不在同一个点上",
	coopGame.players[0].x !== coopGame.players[1].x || coopGame.players[0].y !== coopGame.players[1].y,
	coopGame.players.map((tank) => `${tank.x},${tank.y}`).join(" / "));
checkTrue("组队第二个座位在基地另一侧", coopGame.players[1].x > coopGame.players[0].x,
	`${coopGame.players[0].x} → ${coopGame.players[1].x}`);

const eastTank = coopGame.players[1];
const westTank = coopGame.players[0];
westTank.spawning = 0;
eastTank.spawning = 0;
coopGame.inputs[0] = { dirs: [engine.LEFT], fire: false };
coopGame.inputs[1] = { dirs: [engine.RIGHT], fire: false };
const bornAt = [westTank.x, eastTank.x];
for (let i = 0; i < 60; i += 1) engine.step(coopGame, 1000 / 60);
checkTrue("组队座位 0 按左真的开出去了", westTank.x < bornAt[0], `${bornAt[0]} → ${westTank.x}`);
checkTrue("组队座位 1 按右真的开出去了", eastTank.x > bornAt[1], `${bornAt[1]} → ${eastTank.x}`);

// 单人 / 对战沿用每队的第一个点，位置与之前一模一样（别为了修组队把别的模式挪了）。
const soloGame = engine.createGame({ mode: "solo", ai: "rookie", enemyCount: 10, lives: 3, stage: 1, sound: false });
check("单人只有一个座位", soloGame.players.length, 1);
check("单人用 A 队第一个出生点", [soloGame.players[0].x, soloGame.players[0].y],
	[engine.PLAYER_SPAWNS.A[0].x, engine.PLAYER_SPAWNS.A[0].y]);

// 对战连座位都不给也得凑成一人一队：预览页本机一个人看「对战」就是这么用的。
const duelGame = engine.createGame({ mode: "pvp", ai: "rookie", enemyCount: 10, lives: 3, stage: 2, sound: false });
check("对战没给座位也凑满两个座位", duelGame.players.map((tank) => tank.team), ["A", "B"]);
check("对战客人用 B 队第一个出生点（在顶部队里那一侧）",
	[duelGame.players[1].x, duelGame.players[1].y],
	[engine.PLAYER_SPAWNS.B[0].x, engine.PLAYER_SPAWNS.B[0].y]);
check("对战两个座位各占一个出生点", duelGame.players[0].x !== duelGame.players[1].x, true);

// 出生点写死的是格子坐标，换一张图就可能落在砖里 —— 四张图都得是空地。
const spawnGround = engine.STAGE_MAPS.map((map) => {
	const teams = [...engine.PLAYER_SPAWNS.A, ...engine.PLAYER_SPAWNS.B];
	return teams.map((point) => (map[point.y / TILE] || "")[point.x / TILE]);
});
checkTrue("四个玩家出生点在四张图上都是空地",
	spawnGround.every((row) => row.every((ground) => ground === ".")), JSON.stringify(spawnGround));

// 复活时的取点：同伴还占着首选点就退到另一个，同伴已阵亡就回到第一个点。
const crowded = engine.createGame({ mode: "coop", ai: "rookie", enemyCount: 10, lives: 3, stage: 1, sound: false });
const mateHome = crowded.players[1];
mateHome.x = engine.PLAYER_SPAWNS.A[1].x;
mateHome.y = engine.PLAYER_SPAWNS.A[1].y;
mateHome.spawning = 0;
crowded.players = [mateHome]; // 座位 0 已阵亡、从场上移走
const fallback = engine.spawnPoint(crowded, crowded.seats[1]);
check("首选出生点被同伴占着时退到另一个点", [fallback.x, fallback.y],
	[engine.PLAYER_SPAWNS.A[0].x, engine.PLAYER_SPAWNS.A[0].y]);

const lonely = engine.createGame({ mode: "coop", ai: "rookie", enemyCount: 10, lives: 3, stage: 1, sound: false });
lonely.players = [];
const backHome = engine.spawnPoint(lonely, lonely.seats[1]);
check("同伴阵亡后复活的这辆回到第一个出生点", [backHome.x, backHome.y],
	[engine.PLAYER_SPAWNS.A[0].x, engine.PLAYER_SPAWNS.A[0].y]);

headline("击杀计数");
// 击毁数按座位存：坦克被打掉之后就从 game.players 里被移走了，只记在坦克身上会跟着丢，
// 上报给服务端的击杀数就会永远是 0。
const tally = emptyField();
checkTrue("开局就有按座位的击杀数组", Array.isArray(tally.killsBySeat), typeof tally.killsBySeat);
const tallyPlayer = putTank(tally, 4 * TILE, 6 * TILE, engine.RIGHT, "player");
const tallyFoe = putTank(tally, 10 * TILE, 6 * TILE, engine.LEFT, "enemy", "fast");
engine.fire(tally, tallyPlayer);
let tallySteps = 0;
while (tallyFoe.alive && tallySteps < 200) {
	engine.step(tally, 1000 / 60);
	tallySteps += 1;
}
check("打掉一个敌兵，座位 0 记 1 次击毁", tally.killsBySeat[0], 1);
check("坦克自己也记着击毁数", tallyPlayer.kills, 1);
const tallyAvenger = putTank(tally, 10 * TILE, 6 * TILE, engine.LEFT, "enemy", "basic");
tallyAvenger.fireTimer = 0;
engine.fire(tally, tallyAvenger);
let dyingSteps = 0;
while (tallyPlayer.alive && dyingSteps < 300) {
	engine.step(tally, 1000 / 60);
	dyingSteps += 1;
}
checkTrue("玩家确实被对面打掉了", !tallyPlayer.alive, `${dyingSteps} 步后还活着`);
check("玩家阵亡后座位上的击毁数还留着", tally.killsBySeat[0], 1);
check("打掉 NPC 的那次不算成第二个座位", tally.killsBySeat.length, 1);

headline("画面快照");
// 房主权威：房主跑引擎，按节流把整段画面发出去；客人只套回渲染。这里验「套得回去」。
const hostSeats = [
	{ seat: 0, team: "A", username: "host", name: "房主" },
	{ seat: 1, team: "B", username: "me", name: "我" }
];
const hostGame = engine.createGame({ ai: "hunter", enemyCount: 8, lives: 3, stage: 2, mode: "pvp", seats: hostSeats, sound: false });
hostGame.status = "playing";
hostGame.introTimer = 0;
for (let i = 0; i < 90; i += 1) engine.step(hostGame, 1000 / 60);
const snap = engine.serializeGame(hostGame);
check("快照带上了版本号", snap.v, 2);
check("快照带上了模式", snap.mode, "pvp");
check("快照带上了两个基地", snap.bases.length, 2);
check("快照带上了两个玩家", snap.players.length, 2);

const mirrorGame = engine.createGame({ ai: "rookie", enemyCount: 6, lives: 1, stage: 1, mode: "solo", sound: false });
engine.applySnapshot(mirrorGame, snap);
check("套回之后模式跟着房主", mirrorGame.cfg.mode, "pvp");
check("套回之后基地也是两个", mirrorGame.bases.length, 2);
check("套回之后玩家也是两个", mirrorGame.players.length, 2);
check("套回之后地形与房主逐格一致", Array.from(mirrorGame.tiles).join(""), Array.from(hostGame.tiles).join(""));
check("套回之后分数与房主一致", mirrorGame.score, hostGame.score);
check("套回之后蓝红两队比分都跟着走", [mirrorGame.scoreA, mirrorGame.scoreB], [hostGame.scoreA, hostGame.scoreB]);
check("套回之后关卡跟着房主", mirrorGame.stage, hostGame.stage);
checkTrue("套回之后本机那辆坦克在座位 0 上", (mirrorGame.player || {}).seat === 0, JSON.stringify(mirrorGame.player));
checkTrue("套回一份空快照不炸", engine.applySnapshot(mirrorGame, null) === mirrorGame);

const mirrorCtx = fakeCtx();
let mirrorError = "";
try {
	engine.drawScene(mirrorCtx, mirrorGame, 5000);
} catch (error) {
	mirrorError = String(error && error.message ? error.message : error);
}
check("套回之后的局面能直接画", mirrorError, "");

// ============================================================
// 十二、浏览器半的插槽契约（真跑一遍 apply）
// ============================================================

headline("插槽注册");
const slots = new Map();
client.apply({
	slots: {
		inject: (name, factory) => factory(),
		register: (descriptor, component) => {
			slots.set(descriptor.name, { descriptor, component });
			return () => {};
		}
	},
	layout: { selectPanel: () => {} }
});
check("一共注册两个插槽", slots.size, 2);
checkTrue("注册的是侧栏与整页", slots.has("sidebar.panellist") && slots.has("main"));
check("侧栏那一项与整页共用同一个 id", slots.get("main").descriptor.key, slots.get("sidebar.panellist").descriptor.id);
check("侧栏菜单文案是「打坦克」", slots.get("sidebar.panellist").descriptor.label, "打坦克");
checkTrue("侧栏有排序值", Number.isFinite(slots.get("sidebar.panellist").descriptor.order));
checkTrue("侧栏图标是组件", typeof slots.get("sidebar.panellist").component === "function");
checkTrue("整页是组件", typeof slots.get("main").component === "function");

// ============================================================
// 十三、写盘（子进程 + 临时 HOME）
// ============================================================

headline("战绩落盘（子进程 + 临时 HOME）");
const tempHome = mkdtempSync(join(tmpdir(), "tank-check-"));
let childOk = false;
try {
	const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
		env: { ...process.env, TANK_TEST_CHILD: "1", TANK_TEST_HOME: tempHome, USERPROFILE: tempHome, HOME: tempHome, DSH_HOME: tempHome },
		encoding: "utf8"
	});
	process.stdout.write(output);
	childOk = true;
} catch (error) {
	console.log("FAIL 子进程写盘用例没过");
	if (error && error.stdout) process.stdout.write(String(error.stdout));
	if (error && error.stderr) console.log(String(error.stderr));
}
checkTrue("写盘用例全过", childOk);
rmSync(tempHome, { recursive: true, force: true });

// ============================================================
// 收尾
// ============================================================

console.log(`\n合计 ${passed} 项通过，${failed} 项失败。`);
if (failed > 0) process.exit(1);
