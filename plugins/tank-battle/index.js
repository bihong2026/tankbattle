// 打坦克的宿主半。
//
// 游戏本身在浏览器端跑，宿主半只管四件事：
//   1. /tank-battle/ping     —— 探活 + 版本自检，顺带把插件设置里的默认值发给前端；
//   2. /tank-battle/stats    —— 读本机战绩（$DSH_HOME/tank-battle.json）；
//   3. /tank-battle/record   —— 记一局的结果；
//   4. /tank-battle/identity —— 报本机身份（登录的账号，没登录就是游客号）。
// 另外把 /tank-battle/api/* 整段反代到打坦克后台服务（在线发现、邀请、房间、积分）。
//
// 路由挂在官方的 dsh-host-webserver 上，与页面同源；桌面端由 dsh-app:// 协议整体
// 转发到宿主，所以 Web 形态和桌面形态共用同一份前端代码，也就不用让 Electron 外壳
// 再开 IPC 通道。
//
// 反代必须走宿主，不能让前端直接去 fetch 后台服务：页面自己的来源不是后台服务，
// 浏览器会拦（跨域 + 混合内容）。账号也一样，只有宿主半拿得到，前端不碰凭证。
//
// 插件设置（cordis.patch.yml 的 config）只放默认值：开局用哪一档 AI、敌人多少辆、
// 几条命、要不要音效、后台服务在哪儿。装好之后不改也能玩，改了就改这一处、重启应用
// 生效；游戏页里的选择只作用于当次，不写盘。

import { readFileSync } from "node:fs";

import { resolveIdentity } from "./identity.js";
import { readStats, recordResult } from "./tank-stats.js";

export const name = "tank-battle";
export const inject = ["webServer"];

/**
 * 宿主半自己的版本，从本包 package.json 读。
 * 前端半换包刷新即新，宿主半要等应用重启；两边对不上时页面直接提示重启。
 */
export const VERSION = readOwnVersion();

function readOwnVersion() {
	try {
		const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
		return typeof manifest.version === "string" ? manifest.version : "";
	} catch {
		return "";
	}
}

export const ROUTE_BASE = "/tank-battle";
/** 精确匹配的路由清单。自检会核对「路由清单 / 处理函数表 / 注册结果」三者一致。 */
export const ACTIONS = ["ping", "stats", "record", "identity"];
/** 反代前缀：这一整段（含子路径）转到后台服务。 */
export const API_PREFIX = `${ROUTE_BASE}/api`;

/**
 * 后台服务的默认地址：自己起一个服务端，默认就在本机 9010。
 *
 * 部署地址属于「谁部署谁填」，不进源码 —— 想指到别的机器，就在自己的
 * `$DSH_HOME/cordis.patch.yml` 里覆盖这个插件的 `serverBase`，或者设环境变量
 * `TANK_SERVER_BASE`。两者都没有才落到这个默认值。
 */
export const DEFAULT_SERVER_BASE = "http://127.0.0.1:9010";

/** 反代请求的超时。超了就当后台没起来，给前端一句人话。 */
export const PROXY_TIMEOUT_MS = 8000;

/** 战绩这类请求体很小，给 16KB 足够；联机按键包也在这以内。 */
export const MAX_BODY = 16 * 1024;

/** 插件设置里能改的键。自检会核对这五处（DEFAULTS / CONFIG_KEYS / resolveConfig 返回值 / cordis.patch.yml / 设置页）一致。 */
export const CONFIG_KEYS = ["defaultAi", "enemyCount", "lives", "sound"];

export const DEFAULTS = {
	defaultAi: "veteran",
	enemyCount: 20,
	lives: 3,
	sound: true
};

const AI_IDS = ["rookie", "veteran", "hunter", "ace"];

/**
 * 把插件设置收拾成确定的值。
 *
 * 返回对象必须带齐 CONFIG_KEYS 里的每一个键 —— 漏一个的话 config.<key> 会恒为
 * undefined，而且是静默失效、不报错，自检专门断言了这一点。
 */
export function resolveConfig(config) {
	const raw = config && typeof config === "object" ? config : {};
	const enemyCount = Math.floor(Number(raw.enemyCount));
	const lives = Math.floor(Number(raw.lives));
	return {
		defaultAi: AI_IDS.includes(raw.defaultAi) ? raw.defaultAi : DEFAULTS.defaultAi,
		enemyCount: Number.isFinite(enemyCount) ? Math.min(60, Math.max(4, enemyCount)) : DEFAULTS.enemyCount,
		lives: Number.isFinite(lives) ? Math.min(9, Math.max(1, lives)) : DEFAULTS.lives,
		sound: raw.sound === undefined ? DEFAULTS.sound : raw.sound !== false
	};
}

/**
 * 后台服务在哪儿。三处按优先级：环境变量 `TANK_SERVER_BASE` → 插件设置 `serverBase`
 * → 本机默认值。末尾斜杠统一剪掉，免得拼出 `//api/...` 这种地址。
 */
export function resolveServerBase(config) {
	const fromEnv = (process.env.TANK_SERVER_BASE || "").trim();
	if (fromEnv !== "") return fromEnv.replace(/\/+$/, "");

	const raw = config && typeof config === "object" ? config.serverBase : "";
	const text = String(raw === undefined || raw === null ? "" : raw).trim();
	return text === "" ? DEFAULT_SERVER_BASE : text.replace(/\/+$/, "");
}

function messageOf(error) {
	if (error instanceof Error && error.message) return error.message;
	return String(error ?? "操作没有成功。");
}

/**
 * 取官方账号服务。用 `ctx.get` 而不是写进 `inject`：账号服务不是每个 profile 都带，
 * 写进 inject 会让「没带账号服务的 profile」整个插件都装不上，而这里只是想有就用、
 * 没有就算了。拿不到返回 null。
 */
function accountService(ctx) {
	if (!ctx || typeof ctx.get !== "function") return null;
	try {
		return ctx.get("deepseekAccount") ?? null;
	} catch {
		return null;
	}
}

/**
 * 身份缓存。账号资料读一次要走一次网络（问 DeepSeek 账号接口），所以认下来之后缓存一会儿，
 * 别每次心跳都问一遍。
 *
 * 但**游客那一支只缓存 15 秒**：`getState()` 读的是本机凭证、不花网络，退一步重问很便宜；
 * 而刚登录完的人总不该等 5 分钟才被认出来。账号那一支认定了就不太会变，缓存 5 分钟。
 */
const identityCache = { at: 0, value: null, ttl: 0 };
const IDENTITY_TTL = 5 * 60 * 1000;
const GUEST_TTL = 15 * 1000;

export async function identityOf(ctx, now = Date.now()) {
	if (identityCache.value && now - identityCache.at < identityCache.ttl) return identityCache.value;
	const value = await resolveIdentity(accountService(ctx), VERSION);
	identityCache.at = now;
	identityCache.value = value;
	identityCache.ttl = value.signedIn ? IDENTITY_TTL : GUEST_TTL;
	return value;
}

/** 存档点：自检要在用例之间清掉缓存。 */
export function forgetIdentity() {
	identityCache.at = 0;
	identityCache.value = null;
	identityCache.ttl = 0;
}

export const handlers = {
	/** 探活 + 版本自检 + 把默认设置发给前端。 */
	ping: async (ctx, config) => ({ ok: true, game: "tank-battle", config: resolveConfig(config) }),

	/** 本机战绩。读不到就是一份空战绩，不算失败。 */
	stats: async () => ({ ok: true, stats: await readStats() }),

	/** 记一局：分数、打到第几关、哪一档 AI、结果。 */
	record: async (ctx, config, url, body) => ({
		ok: true,
		stats: await recordResult({
			score: body && body.score,
			stage: body && body.stage,
			level: body && body.level,
			ai: body && body.ai,
			outcome: body && body.outcome
		})
	}),

	/**
	 * 本机身份。永远回 ok:true —— 没登录 DeepSeek 账号不是错误，退回游客号照样能联机。
	 * 只回一个身份串和显示名，凭证一个字都不出这个进程。
	 */
	identity: async (ctx) => {
		const me = await identityOf(ctx);
		return {
			ok: true,
			signedIn: me.signedIn,
			source: me.source,
			username: me.username,
			nickname: me.nickname,
			avatarUrl: me.avatarUrl,
			message: me.message
		};
	}
};

function sendJson(res, status, payload) {
	const text = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text)
	});
	res.end(text);
}

async function readTextBody(req, limit = MAX_BODY) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req, limit = MAX_BODY) {
	const text = (await readTextBody(req, limit)).trim();
	if (text === "") return {};
	return JSON.parse(text);
}

/**
 * 把 /tank-battle/api/<x> 转成 <serverBase>/api/<x> 打给后台服务，原样回传。
 *
 * 前端不直接连后台：跨域会被浏览器拦，而且桌面端页面在 dsh-app:// 下，
 * 直连 http 还会被判混合内容。走宿主同源最省事，也顺手把超时兜住。
 */
export async function proxyApi(req, res, serverBase = DEFAULT_SERVER_BASE) {
	const url = new URL(req.url ?? "/", "http://dsh.invalid");
	const path = url.pathname.startsWith(ROUTE_BASE) ? url.pathname.slice(ROUTE_BASE.length) : url.pathname;
	const target = `${serverBase}${path}${url.search}`;
	const method = String(req.method || "GET").toUpperCase();
	const hasBody = method !== "GET" && method !== "HEAD";
	let signal;
	try {
		signal = AbortSignal.timeout(PROXY_TIMEOUT_MS);
	} catch {
		signal = undefined;
	}
	const response = await fetch(target, {
		method,
		headers: { accept: "application/json", "content-type": "application/json" },
		body: hasBody ? await readTextBody(req) : undefined,
		signal
	});
	const text = await response.text();
	res.writeHead(response.status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text)
	});
	res.end(text);
}

/**
 * 注册一条同源路由。注册失败（热重载时旧实例的路由还没摘掉，报 duplicate route）
 * 只影响这一条，不能让后面几条一起不注册，所以每条自带 try/catch。
 */
function registerRoute(ctx, path, handler, kind = "exact") {
	ctx.effect(
		() => {
			try {
				return ctx.webServer.register({ kind, path, handler });
			} catch (error) {
				ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
				return () => {};
			}
		},
		`tank-battle: ${path}`
	);
}

export function apply(ctx, config) {
	const serverBase = resolveServerBase(config);

	for (const action of ACTIONS) {
		const path = `${ROUTE_BASE}/${action}`;
		registerRoute(ctx, path, async (req, res) => {
			// 路由自己兜住异常：既不让 webserver 记 400，也让前端只需要看 ok 字段。
			try {
				const url = new URL(req.url ?? "/", "http://dsh.invalid");
				const body = req.method === "POST" ? await readJsonBody(req) : {};
				const payload = await handlers[action](ctx, config, url, body);
				sendJson(res, 200, { ...payload, hostVersion: VERSION });
			} catch (error) {
				ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
				sendJson(res, 200, { ok: false, message: messageOf(error), hostVersion: VERSION });
			}
		});
	}

	// 反代：整段 /tank-battle/api 交给后台服务。前缀匹配，子路径原样带过去。
	registerRoute(ctx, API_PREFIX, async (req, res) => {
		try {
			await proxyApi(req, res, serverBase);
		} catch (error) {
			ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
			// 后台没起来是常态（比如还没起服务端），给一句人话，别让大厅白屏。
			sendJson(res, 200, {
				ok: false,
				message: `连不上打坦克后台服务（${serverBase}）：${messageOf(error)}`,
				hostVersion: VERSION
			});
		}
	}, "prefix");
}
