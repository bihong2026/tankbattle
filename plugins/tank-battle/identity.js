// 打坦克的身份在本机读，只读不写。
//
// 身份来源按优先级排两条：
//   1. 已登录的 DeepSeek 账号 —— 走官方账号服务，取稳定账号 UID。换了机器、重装了
//      Harness，只要还是同一个账号，积分和战绩就还是连着的那一份。
//   2. 游客 —— 官方那个按 harness home 生成的匿名标识（$DSH_HOME/.anonymous-user-id）。
//
// 两条都拿不到（profile 里没带账号服务、文件也读不着）就现算一个稳定的游客号：
// 不写任何文件，也不碰官方的东西。
//
// 身份只用于联机。拿不到账号不是错误 —— 只是发现队友 / 邀请 / 房间用不了，
// 单人照常玩。所以这里处处兜住、一律不抛错。
//
// 为什么另开一个文件而不是塞进 index.js：index.js 是路由层，读身份的事单独放，
// 自检可以直接 import 这个模块（用假的服务对象）验分支，不用把整个路由跑起来。

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** harness home：官方约定读 $DSH_HOME，没设就是 ~/.dsh。 */
export function dshHome() {
	const fromEnv = (process.env.DSH_HOME || "").trim();
	return fromEnv === "" ? join(homedir(), ".dsh") : fromEnv;
}

/**
 * 官方的匿名安装标识。
 *
 * 它是纯 UUID 文本，删掉文件下次启动就换一个新的 —— 所以只配当游客号，
 * 不能当账号用（官方说明里也明确写了不要拿它识别用户）。
 */
export function anonymousIdPath() {
	return join(dshHome(), ".anonymous-user-id");
}

/**
 * 调官方账号服务时带的「调用方元数据」：客户端版本、界面语言、时区偏移（秒）。
 *
 * 官方据此组装 Platform 请求头，报的是发起这次调用的界面，不是宿主上一次见到的界面，
 * 所以每处调用都自己带一份，不要共用。
 */
export function clientMetadata(version) {
	return {
		version: String(version || "0.0.0"),
		locale: detectLocale(),
		timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
	};
}

function detectLocale() {
	try {
		const tag = new Intl.DateTimeFormat().resolvedOptions().locale;
		if (tag) return tag;
	} catch {
		// Intl 不可用就往环境变量退
	}
	return (process.env.LANG || process.env.LC_ALL || "en-US").split(".")[0];
}

/**
 * 问官方账号服务要当前登录账号。拿不到就返回 null —— 这不是错误，是「没登录」。
 *
 * @param account 宿主注入的账号服务（`ctx.get("deepseekAccount")`）。没有账号服务的
 *   profile 传进来就是 undefined。
 * @param version 插件自己的版本号，当作调用方版本报给 Platform。
 * @returns `{ uid, name, avatarUrl }`，没登录 / 读不到返回 null。
 */
export async function readAccount(account, version) {
	if (!account || typeof account.getState !== "function") return null;

	let state;
	try {
		state = await account.getState();
	} catch {
		return null;
	}
	// status 只有 signed-out 和 credential-stored 两种：本地没存凭证就不用再问资料了。
	if (!state || state.status === "signed-out") return null;
	if (typeof account.getProfile !== "function") return null;

	let result;
	try {
		result = await account.getProfile(clientMetadata(version));
	} catch {
		return null;
	}
	// getProfile 走一次网络；断网 / 被拒 / 资料形状不对都会走到这里，一律当拿不到。
	const value = result && result.status === "ready" ? result.value : null;
	const id = value && value.id;
	if (id === undefined || id === null || String(id) === "") return null;

	return {
		uid: String(id),
		name: typeof value.name === "string" ? value.name : "",
		avatarUrl: typeof value.avatarUrl === "string" ? value.avatarUrl : ""
	};
}

/**
 * 把任意一串东西收拾成 `guest-` + 12 位十六进制。
 *
 * 从匿名标识里取够 12 位十六进制就用它；取不够（文件不在、内容被改坏）就用
 * harness home 和平台名算一个 —— 同一台机器每次算出来都一样，所以游客身份
 * 在重启之间是稳定的，不会每次开游戏都在积分榜上多出一个新游客。
 */
export function guestId(seed) {
	const hex = String(seed === undefined || seed === null ? "" : seed)
		.replace(/[^0-9a-fA-F]/g, "")
		.toLowerCase();
	const source = hex.length >= 12
		? hex
		: createHash("sha1").update(`tank-battle:${process.platform}:${dshHome()}`).digest("hex");
	return `guest-${source.slice(0, 12)}`;
}

/** 游客的显示名。末尾四位，方便在大厅里把两个游客分开。 */
export function guestName(id) {
	const tail = String(id || "").slice(-4).toUpperCase();
	return tail === "" ? "游客" : `游客 ${tail}`;
}

/** 读官方那个匿名标识。文件不在、读不动都返回空串，不抛错。 */
export async function readAnonymousId() {
	try {
		return (await readFile(anonymousIdPath(), "utf8")).trim();
	} catch {
		return "";
	}
}

/**
 * 定身份：先试账号，退回游客。
 *
 * 任何时候都返回一个能用的身份（不会返回 null）—— 界面上「我是谁」那一栏
 * 永远有东西可写，联机也永远有个名字可以挂在积分榜上。
 *
 * 返回里的 `username` 是给服务端当主键用的那个串：登录了就是账号 UID，
 * 没登录就是 `guest-xxxxxxxxxxxx`。名字沿用 username 是为了跟服务端字段对齐。
 */
export async function resolveIdentity(account, version) {
	const signed = await readAccount(account, version);
	if (signed) {
		return {
			signedIn: true,
			source: "account",
			username: signed.uid,
			nickname: signed.name,
			avatarUrl: signed.avatarUrl,
			message: ""
		};
	}

	const raw = await readAnonymousId();
	const id = guestId(raw);
	return {
		signedIn: false,
		source: "guest",
		username: id,
		nickname: guestName(id),
		avatarUrl: "",
		message: "还没登录 DeepSeek 账号，现在用本机游客身份联机；登录后战绩会记到账号下。"
	};
}
