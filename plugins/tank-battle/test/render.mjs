// 打坦克浏览器半的行为自检：用一个极简 React 替身把整页真跑起来，走完
// 「首屏问设置 → 开始游戏 → 开局保护结束 → 走动 → 开火 → 暂停 → 结束 → 打到基地被毁并上报战绩」
// 整条路径。只验前端逻辑，不联网、不依赖第三方库、不开真浏览器。
// 跑法：node test/render.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = await readFile(join(HERE, "..", "client.js"), "utf8");

/** 前端半写死的版本号。假的宿主半也用它回报，免得改一次版本就要改一遍测试。 */
const CLIENT_VERSION = (SOURCE.match(/const PLUGIN_VERSION = "([^"]+)"/) ?? [])[1] ?? "";

const VIEW_W = 240;
const VIEW_H = 208;
const FIELD = 208;
/** 玩家一级时的车体色，用来在画面上把它认出来（敌方没有这个色）。 */
const PLAYER_BODY = "#e8c53a";
/** 没登录账号时游客身份长这样（假宿主半照这个形状回）。 */
const GUEST_ID = "guest-0f8fad5bd9cb";

let passed = 0;
let failed = 0;

/** 判定式断言：condition 为真就过，detail 只用于失败时说明。 */
function check(name, condition, detail) {
	if (condition) {
		passed += 1;
		console.log(`ok   ${name}`);
		return;
	}
	failed += 1;
	console.log(`FAIL ${name}${detail === undefined ? "" : `  →  ${detail}`}`);
}

/** 比较式断言：把实际值和期望值都打出来。 */
function same(name, actual, expected) {
	const one = JSON.stringify(actual);
	const other = JSON.stringify(expected);
	if (one === other) {
		passed += 1;
		console.log(`ok   ${name}`);
		return;
	}
	failed += 1;
	console.log(`FAIL ${name}  →  实际 ${one}，期望 ${other}`);
}

// ---------- 极简 React 替身 ----------

function createReactShim() {
	const state = { values: [], deps: [], cursor: 0, queued: [], dirty: false };
	const equalDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
	const React = {
		createElement(type, props, ...children) {
			const flat = [];
			const push = (item) => {
				if (item === null || item === undefined || item === false || item === true) return;
				if (Array.isArray(item)) {
					item.forEach(push);
					return;
				}
				flat.push(item);
			};
			children.forEach(push);
			return { type, props: { ...(props ?? {}) }, children: flat };
		},
		useState(initial) {
			const slot = state.cursor++;
			if (!(slot in state.values)) state.values[slot] = typeof initial === "function" ? initial() : initial;
			const set = (next) => {
				const value = typeof next === "function" ? next(state.values[slot]) : next;
				if (value !== state.values[slot]) {
					state.values[slot] = value;
					state.dirty = true;
				}
			};
			return [state.values[slot], set];
		},
		useRef(initial) {
			const slot = state.cursor++;
			if (!(slot in state.values)) state.values[slot] = { current: initial };
			return state.values[slot];
		},
		useMemo(factory, deps) {
			const slot = state.cursor++;
			if (!(slot in state.values) || !equalDeps(state.deps[slot], deps)) {
				state.values[slot] = factory();
				state.deps[slot] = deps;
			}
			return state.values[slot];
		},
		useCallback(factory, deps) {
			const slot = state.cursor++;
			if (!(slot in state.values) || !equalDeps(state.deps[slot], deps)) {
				state.values[slot] = factory;
				state.deps[slot] = deps;
			}
			return state.values[slot];
		},
		useEffect(effect, deps) {
			const slot = state.cursor++;
			const previous = state.deps[slot];
			state.deps[slot] = deps;
			if (previous === undefined || !equalDeps(previous, deps)) state.queued.push(effect);
		}
	};
	return { React, state };
}

// ---------- 假的 DOM / 画布 ----------
//
// 真画布每帧都是「先清屏、再重画」，所以一帧画完留下的矩形就是当前画面。
// 这里照此建模：离屏这一层是用「整屏铺黑」当清屏的，看到整屏黑底就当新一帧开始，
// 把上一帧记的矩形丢掉；clearRect 覆盖整屏时同理。否则矩形会一帧帧叠起来，
// 后面按坐标找子弹就会翻出上一帧的旧位置。

function makeContext(bounds) {
	const rec = { fillStyle: "", rects: [] };
	const fillsWholeCanvas = (x, y, w, h) => {
		const box = typeof bounds === "function" ? bounds() : bounds;
		if (!box || !box.width || !box.height) return false;
		return x <= 0 && y <= 0 && w >= box.width && h >= box.height;
	};
	const ctx = {
		imageSmoothingEnabled: true,
		clearRect(x, y, w, h) {
			if (fillsWholeCanvas(x, y, w, h)) rec.rects.length = 0;
		},
		drawImage() {},
		fillRect(x, y, w, h) {
			if (rec.fillStyle === "#000000" && fillsWholeCanvas(x, y, w, h)) rec.rects.length = 0;
			rec.rects.push({ x, y, w, h, fill: rec.fillStyle });
		}
	};
	Object.defineProperty(ctx, "fillStyle", {
		get: () => rec.fillStyle,
		set: (value) => {
			rec.fillStyle = value;
		}
	});
	Object.defineProperty(ctx, "rects", { get: () => rec.rects });
	return ctx;
}

function createDocument() {
	const canvases = [];
	return {
		canvases,
		createElement(tag) {
			const element = {
				tagName: String(tag).toUpperCase(),
				width: 0,
				height: 0,
				style: {}
			};
			const ctx = makeContext(() => element);
			element.getContext = () => ctx;
			element.ctx = ctx;
			if (String(tag) === "canvas") canvases.push(element);
			return element;
		}
	};
}

// ---------- 把整页装起来 ----------

/**
 * 装一个假后台服务。
 *
 * 默认是「本机没登录账号（以游客身份）、大厅空着」—— 这正是现存用例要的基线：
 * 联机那条线安静待着，不干扰单人玩法。想验联机就传一份非空的 me / online / invites。
 * me 给的是「登录了 DeepSeek 账号」那一种，不给就是游客。
 */
function makeBackend(overrides = {}) {
	return {
		me: null,
		online: [],
		invites: [],
		rooms: [],
		board: [],
		sent: [],
		...overrides
	};
}

async function bootPage(hostConfig, records, hostVersion, backend = makeBackend()) {
	const reported = hostVersion === undefined ? CLIENT_VERSION : hostVersion;
	let captured = null;
	const listeners = new Map();
	const rafs = new Map();
	let rafId = 1;
	const document = createDocument();
	const sandboxWindow = {
		devicePixelRatio: 1,
		__ModuleLoader__: {
			load: (definition) => {
				captured = definition;
			}
		},
		requestAnimationFrame: (fn) => {
			const id = rafId++;
			rafs.set(id, fn);
			return id;
		},
		cancelAnimationFrame: (id) => {
			rafs.delete(id);
		},
		addEventListener: (type, fn) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(fn);
		},
		removeEventListener: (type, fn) => {
			if (listeners.has(type)) listeners.get(type).delete(fn);
		},
		setTimeout: (fn) => {
			// 音效里用到的 setTimeout 在这里直接忽略（音效本来就没开）。
			void fn;
			return 0;
		},
		clearTimeout: () => {}
	};
	const previousDocument = globalThis.document;
	globalThis.document = document;

	const calls = [];
	const stats = { bestScore: 0, bestStage: 0, plays: 0, wins: 0, clearedStages: 0, lastPlayed: "", recent: [] };
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (url, options = {}) => {
		const path = String(url);
		const method = options.method || "GET";
		const body = options.body ? JSON.parse(options.body) : undefined;
		calls.push({ path, method, body });
		const json = (payload) => ({ status: 200, json: async () => ({ hostVersion: reported, ...payload }) });
		if (path === "/tank-battle/ping") return json({ ok: true, game: "tank-battle", config: hostConfig });
		if (path === "/tank-battle/stats") return json({ ok: true, stats });
		if (path === "/tank-battle/record") {
			records.push(body);
			stats.plays += 1;
			stats.bestScore = Math.max(stats.bestScore, Number(body.score) || 0);
			stats.bestStage = Math.max(stats.bestStage, Number(body.stage) || 0);
			if (body.outcome === "win") stats.wins += 1;
			return json({ ok: true, stats });
		}
		if (path === "/tank-battle/identity") {
			// 宿主半这个接口永远回 ok —— 没登录不是错误，退回游客号照样能联机。
			return backend.me
				? json({
					ok: true, signedIn: true, source: "account",
					username: backend.me.username, nickname: backend.me.nickname,
					avatarUrl: "", message: ""
				})
				: json({
					ok: true, signedIn: false, source: "guest",
					username: GUEST_ID, nickname: "游客 D9CB",
					avatarUrl: "", message: "还没登录 DeepSeek 账号，现在用本机游客身份联机。"
				});
		}
		if (path.startsWith("/tank-battle/api/")) {
			// 宿主半的反代在真实环境里会把这一段转给后台服务；这里直接在假 fetch 里应答。
			const route = path.slice("/tank-battle/api/".length).split("?")[0];
			if (route === "online") return json({ ok: true, online: backend.online });
			if (route === "invites") return json({ ok: true, invites: backend.invites });
			if (route === "rooms") return json({ ok: true, rooms: backend.rooms });
			if (route === "leaderboard") return json({ ok: true, rows: backend.board });
			backend.sent.push({ route, method, body });
			// 服务端 room_public 会带回 host 与成员（房主排座位 0），这里照着回。
			if (route === "room") {
				return json({ ok: true, room: {
					id: "R-77", host: "10086", mode: (body && body.mode) || "coop",
					aiCount: 20, aiLevel: "rookie",
					members: [{ username: "10086", nickname: "老王", team: "A", seat: 0 }]
				} });
			}
			if (route === "room/join") return json({ ok: true, room: { id: (body && body.room) || "R-9", host: "lisi", mode: "coop", aiCount: 20, aiLevel: "hunter", members: [] } });
			if (route === "invite") return json({ ok: true, id: 501 });
			if (route === "invite/respond") {
				// 服务端返回的成员是「房主在前」。本机是客人，所以要能验出页面把自己提到了座位 0。
				return body && body.accept
					? json({ ok: true, accepted: true, room: {
						id: "R-9", host: "lisi", mode: "coop", aiCount: 20, aiLevel: "hunter",
						members: [
							{ username: "lisi", nickname: "李四", team: "A", seat: 0 },
							{ username: "10086", nickname: "老王", team: "A", seat: 1 }
						]
					} })
					: json({ ok: true, accepted: false });
			}
			return json({ ok: true });
		}
		return json({ ok: false, message: `未预期的请求 ${method} ${path}` });
	};

	new Function("window", SOURCE)(sandboxWindow);
	if (captured === null) throw new Error("client.js 没有调用 __ModuleLoader__.load");
	const shim = createReactShim();
	const client = captured.factory((name) => {
		if (name === "react") return shim.React;
		throw new Error(`浏览器半不该 require 别的包：${name}`);
	});

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
	const Page = slots.get("main").component;

	let tree = null;
	function renderPage() {
		shim.state.cursor = 0;
		shim.state.queued = [];
		shim.state.dirty = false;
		tree = Page({});
		const queued = shim.state.queued.splice(0);
		for (const effect of queued) effect();
	}

	async function settle(rounds = 4) {
		for (let i = 0; i < rounds; i += 1) {
			for (let k = 0; k < 4; k += 1) await Promise.resolve();
			if (shim.state.dirty) renderPage();
		}
	}

	let clock = 0;
	async function frame(delta = 1000 / 60) {
		clock += delta;
		const pending = [...rafs.values()];
		rafs.clear();
		for (const fn of pending) fn(clock);
		await Promise.resolve();
		if (shim.state.dirty) renderPage();
		await Promise.resolve();
		if (shim.state.dirty) renderPage();
	}

	async function frames(count, delta) {
		for (let i = 0; i < count; i += 1) await frame(delta);
	}

	function key(type, value) {
		const set = listeners.get(type);
		if (!set) return;
		for (const fn of set) {
			fn({
				key: value,
				target: null,
				altKey: false,
				ctrlKey: false,
				metaKey: false,
				preventDefault() {}
			});
		}
	}

	function cleanup() {
		globalThis.document = previousDocument;
		globalThis.fetch = previousFetch;
	}

	function rects() {
		return document.canvases[0] ? document.canvases[0].ctx.rects : [];
	}

	/** 玩家车体在画面上的包围盒。同一朝向之下，它的位置变化就等于坦克的位置变化。 */
	function playerBox() {
		const found = rects().filter((rect) => rect.fill === PLAYER_BODY && rect.x < FIELD);
		if (found.length === 0) return null;
		return {
			minX: Math.min(...found.map((rect) => rect.x)),
			maxX: Math.max(...found.map((rect) => rect.x + rect.w)),
			minY: Math.min(...found.map((rect) => rect.y)),
			maxY: Math.max(...found.map((rect) => rect.y + rect.h))
		};
	}

	/**
	 * 子弹的黄色芯（#ffe066）爆炸的爆心也在用，光靠颜色会把爆炸算进来。
	 * 但子弹的画法是「先铺一层 4×4 白底、再盖一层 2×2 黄芯」，所以真正的子弹一定是
	 * 一个 2×2 的 #ffe066 矩形，且它左上角外一格正好压着一个 4×4 的白矩形。
	 * 只认这种带白框的黄芯，就能把爆炸打出来的黄色散点排除掉。
	 */
	function bulletRects() {
		const all = rects();
		const frames = all.filter((rect) => rect.fill === "#f4f4f4" && rect.w === 4 && rect.h === 4);
		return all.filter(
			(rect) =>
				rect.fill === "#ffe066" &&
				rect.x < FIELD &&
				frames.some((frame) => frame.x === rect.x - 1 && frame.y === rect.y - 1)
		);
	}

	/** 玩家炮口附近的那发子弹（刚出膛时它就卡在车顶正上方）。敌兵都在场地另一头，不会认错。 */
	function muzzleBullet() {
		const box = playerBox();
		if (!box) return null;
		const near = bulletRects().filter(
			(rect) =>
				rect.x + rect.w > box.minX - 2 &&
				rect.x < box.maxX + 2 &&
				rect.y > box.minY - 44 &&
				rect.y < box.minY + 6
		);
		if (near.length === 0) return null;
		// 取最靠下的那发：刚出膛的子弹离车顶最近。
		return near.reduce((best, rect) => (rect.y > best.y ? rect : best), near[0]);
	}

	return {
		slots,
		document,
		calls,
		records,
		stats,
		backend,
		get tree() {
			return tree;
		},
		renderPage,
		settle,
		frame,
		frames,
		key,
		rects,
		playerBox,
		bulletRects,
		muzzleBullet,
		rafCount: () => rafs.size,
		cleanup
	};
}

// ---------- 树上的小工具 ----------
//
// normalize 做成幂等的（打上 __norm 标记），这样 findAll / textOf 可以随便互相调用，
// 不用每处都记得「手上这个是原始树还是规范化过的树」。

function normalize(node) {
	if (node === null || node === undefined || node === false || node === true) return null;
	if (typeof node === "string" || typeof node === "number") return { __norm: true, text: String(node), children: [] };
	if (Array.isArray(node)) return { __norm: true, children: node.map(normalize).filter(Boolean) };
	if (node.__norm) return node;
	const { type, props, children } = node;
	if (typeof type === "function") {
		const rendered = normalize(type({ ...props, children: children.length <= 1 ? children[0] : children }));
		if (rendered !== null) return rendered;
	}
	return { __norm: true, type, props, children: children.map(normalize).filter(Boolean) };
}

function textOf(node, skipStyle = true) {
	const walk = (current) => {
		if (!current) return "";
		if (current.text !== undefined) return current.text;
		if (skipStyle && current.type === "style") return "";
		return current.children.map(walk).join(" ");
	};
	return walk(normalize(node));
}

function findAll(root, predicate, out = []) {
	const visit = (node) => {
		if (!node) return;
		if (predicate(node)) out.push(node);
		for (const child of node.children) visit(child);
	};
	visit(normalize(root));
	return out;
}

const buttonWith = (tree, text) => findAll(tree, (node) => node.type === "button" && textOf(node).trim() === text)[0];
const byClass = (tree, name) => findAll(tree, (node) => node.props && node.props.className === name)[0];

// ============================================================
console.log("== 首屏 ==");
const cfg = { defaultAi: "hunter", enemyCount: 6, lives: 9, sound: false };
const records = [];
const page = await bootPage(cfg, records);
check("只注册侧栏与整页两个插槽", page.slots.size === 2, String(page.slots.size));
same("侧栏文案是「打坦克」", page.slots.get("sidebar.panellist").descriptor.label, "打坦克");

page.renderPage();
await page.settle();
let tree = page.tree;
same("标题是「打坦克」", textOf(byClass(tree, "hs-tank-title")).trim(), "打坦克");
same("页面上有四个下拉框（AI / 敌人 / 生命 / 关卡）", findAll(tree, (node) => node.type === "select").length, 4);
check("有开始 / 暂停 / 结束三个按钮", ["开始游戏", "暂停", "结束游戏"].every((label) => Boolean(buttonWith(tree, label))));
check("首屏问过宿主要设置", page.calls.some((call) => call.path === "/tank-battle/ping"), page.calls.map((call) => call.path).join(","));
check("首屏也读了战绩", page.calls.some((call) => call.path === "/tank-battle/stats"));
check("首屏也问了宿主我是谁", page.calls.some((call) => call.path === "/tank-battle/identity"));
// 这台机器没登录账号（假宿主半回的是游客那一支）：大厅照样能用，只是身份标游客。
const firstLobby = byClass(tree, "hs-tank-lobby");
check("没登录账号时大厅照常出来", firstLobby !== undefined);
check("没登录时身份标成游客", /游客/.test(textOf(firstLobby)) && /D9CB/.test(textOf(firstLobby)), textOf(firstLobby).slice(0, 160));
check("游客身份不把 guest- 那串摆给玩家看", !/guest-/.test(textOf(firstLobby)), textOf(firstLobby).slice(0, 160));
check("没登录时也给一句为什么", /还没登录 DeepSeek 账号/.test(textOf(firstLobby)), textOf(firstLobby).slice(0, 200));
check("版本一致时不提示重启", !textOf(tree).includes("请完整退出应用再启动"));
same("敌我 AI 默认取宿主设置里的 hunter", findAll(tree, (node) => node.type === "select")[0].props.value, "hunter");
same("离屏画布只有一块", page.document.canvases.length, 1);
same("离屏画布就是 240×208", `${page.document.canvases[0].width}×${page.document.canvases[0].height}`, `${VIEW_W}×${VIEW_H}`);
check("没开局时先画了一张静态战场", page.rects().length > 100, String(page.rects().length));
same("没开局时不跑动画", page.rafCount(), 0);

// ============================================================
console.log("\n== 开始游戏 ==");
buttonWith(page.tree, "开始游戏").props.onClick();
await page.settle();
check("开始后就跑起了动画", page.rafCount() > 0, String(page.rafCount()));
tree = page.tree;
same("开始后「开始游戏」变灰", buttonWith(tree, "开始游戏").props.disabled, true);
same("开始后「暂停」可用", buttonWith(tree, "暂停").props.disabled, false);
same("开始后「结束游戏」可用", buttonWith(tree, "结束游戏").props.disabled, false);
check("状态条报出关卡", /关卡/.test(textOf(tree)));
const statusText = () => textOf(byClass(page.tree, "hs-tank-status"));

// 开局有 0.9s 预告 + 1.3s 出生动画，先走完再操作。
await page.frames(160);
check("状态条里能读到得分", /得分/.test(statusText()), statusText().slice(0, 120));

// ============================================================
console.log("\n== 操作 ==");
const spawn = page.playerBox();
check("画面上能找到玩家坦克", spawn !== null, JSON.stringify(spawn));

// 出生点右边紧挨着基地的护卫砖，所以往左走才走得动。
page.key("keydown", "ArrowLeft");
await page.frames(18);
const leftA = page.playerBox();
await page.frames(30);
const leftB = page.playerBox();
check("按住左方向键会往左开", leftA && leftB && leftB.minX < leftA.minX, `${leftA && leftA.minX} → ${leftB && leftB.minX}`);
page.key("keyup", "ArrowLeft");
await page.frames(3);

page.key("keydown", "ArrowUp");
await page.frames(20);
page.key("keyup", "ArrowUp");
await page.frames(3);
page.key("keydown", " ");
await page.frame();
const hull = page.playerBox();
const fired = page.muzzleBullet();
check("按空格会从玩家炮口打出一发子弹", fired !== null, JSON.stringify(page.bulletRects()));
// 判定「从炮口朝上飞出去」靠的是出膛位置，不是「它还在不在」：
// 场上敌兵是随机的，子弹可能几帧之内就撞上砖墙或被打掉，那不该让这条用例变红。
check("子弹从车体上沿正中间出膛（炮口朝上）",
	hull !== null && fired !== null && fired.y <= hull.minY && fired.x + fired.w > hull.minX && fired.x < hull.maxX,
	`bullet=${JSON.stringify(fired)} hull=${JSON.stringify(hull)}`);
// 再走一帧：还在场上就必然更靠上；已经不在了说明它先撞上了什么，同样算它飞出去了。
await page.frame();
const fled = page.muzzleBullet();
check("下一帧子弹要么更靠上、要么已经撞掉", fled === null || (fired !== null && fled.y < fired.y), `${JSON.stringify(fired)} → ${JSON.stringify(fled)}`);
page.key("keyup", " ");

// ============================================================
console.log("\n== 暂停 ==");
page.key("keydown", "Escape");
await page.frame();
check("Esc 之后出现暂停遮罩", page.rects().some((rect) => rect.x === 6 && rect.w === FIELD - 12 && rect.h === 28), "没找到暂停条");
check("暂停时按钮变成「继续」", Boolean(buttonWith(page.tree, "继续")));
const frozen = page.playerBox();
await page.frames(30);
const stillFrozen = page.playerBox();
same("暂停期间画面不再推进", JSON.stringify(frozen), JSON.stringify(stillFrozen));
page.key("keydown", "Escape");
await page.frame();
check("再按一次 Esc 继续", Boolean(buttonWith(page.tree, "暂停")));

// ============================================================
console.log("\n== 结束游戏 ==");
buttonWith(page.tree, "结束游戏").props.onClick();
await page.settle();
same("结束后动画停了", page.rafCount(), 0);
same("结束后回到「开始游戏」", buttonWith(page.tree, "开始游戏").props.disabled, false);
same("结束后「结束游戏」变灰", buttonWith(page.tree, "结束游戏").props.disabled, true);
check("结束后提示改了", /本局已结束/.test(textOf(page.tree)), textOf(page.tree).slice(0, 80));
check("未打完的一局不会上报战绩", page.records.length === 0, JSON.stringify(page.records));
page.cleanup();

// ============================================================
console.log("\n== 打到基地被毁（真跑一整局，验证战绩上报）==");
const hardRecords = [];
const hard = await bootPage({ defaultAi: "ace", enemyCount: 30, lives: 1, sound: false }, hardRecords);
hard.renderPage();
await hard.settle();
buttonWith(hard.tree, "开始游戏").props.onClick();
await hard.settle();
let over = false;
for (let i = 0; i < 7000; i += 1) {
	await hard.frame();
	if (hard.records.length > 0 && hard.rafCount() === 0) {
		over = true;
		break;
	}
}
check("敌方 AI 能把基地推掉，游戏会自己结束", over, `上报了 ${hard.records.length} 次`);
if (over) {
	const body = hard.records[0];
	check("战绩里有分数", typeof body.score === "number" && body.score >= 0, String(body.score));
	same("战绩里有打到第几关", body.stage, 1);
	same("战绩里记了用的哪一档 AI", body.ai, "ace");
	same("战绩里的结果是 over", body.outcome, "over");
	check("上报之后按钮变成「再来一局」", Boolean(buttonWith(hard.tree, "再来一局")), textOf(hard.tree).slice(0, 60));
	check("上报回来的战绩显示在页脚", /最高分/.test(textOf(hard.tree)));
	check("游戏结束后不再跑动画", hard.rafCount() === 0, String(hard.rafCount()));
}
hard.cleanup();

// ============================================================
console.log("\n== 联机大厅（在线发现 / 邀请 / 组队房 / 积分榜）==");
const backend = makeBackend({
	me: { username: "10086", nickname: "老王" },
	online: [
		{ username: "10086", nickname: "老王", status: "lobby" },
		{ username: "lisi", nickname: "李四", status: "lobby" }
	],
	invites: [{ id: 501, fromName: "李四", mode: "coop" }],
	rooms: [{ id: "R-9", host: "王五", mode: "pvp", members: 1 }],
	board: [{ rank: 1, username: "lisi", nickname: "李四", score: 3200 }]
});
const lounge = await bootPage({ defaultAi: "rookie", enemyCount: 20, lives: 3, sound: true }, [], undefined, backend);
lounge.renderPage();
await lounge.settle();
const loungeText = () => textOf(byClass(lounge.tree, "hs-tank-lobby"));
const buttonsIn = (root, label) => findAll(root, (node) => node.type === "button" && textOf(node).trim() === label);

check("首屏问了宿主要身份", lounge.calls.some((call) => call.path === "/tank-battle/identity"), lounge.calls.map((call) => call.path).join(","));
check("大厅显示我的账号 ID 与显示名", /老王/.test(loungeText()) && /10086/.test(loungeText()), loungeText().slice(0, 160));
check("登录身份标成 DeepSeek 账号", /DeepSeek 账号/.test(loungeText()), loungeText().slice(0, 160));
check("在线名单里能看到别人", /李四/.test(loungeText()));
same("在线名单把自己排掉（只剩 1 人）", byClass(lounge.tree, "hs-tank-lobby") && findAll(byClass(lounge.tree, "hs-tank-lobby"), (node) => node.type === "button" && textOf(node).trim() === "组队").length, 1);
check("在线的人各带组队 / 对战两个入口", buttonsIn(lounge.tree, "对战").length === 1, String(buttonsIn(lounge.tree, "对战").length));
check("收到邀请有接受入口", buttonsIn(lounge.tree, "接受").length === 1);
check("收到邀请有拒绝入口", buttonsIn(lounge.tree, "拒绝").length === 1);
check("公开房间列了出来并带加入入口", /王五/.test(loungeText()) && buttonsIn(lounge.tree, "加入").length === 1);
check("积分榜列了出来", /3200 分/.test(loungeText()), loungeText().slice(-160));
check("能自己开组队房 / 对战房", Boolean(buttonWith(lounge.tree, "开组队房")) && Boolean(buttonWith(lounge.tree, "开对战房")));
check("进大厅就先报了一次心跳", backend.sent.some((entry) => entry.route === "heartbeat"), JSON.stringify(backend.sent));
check("心跳带上了账号 ID", (backend.sent.find((entry) => entry.route === "heartbeat") || {}).body.username === "10086");

// 邀请别人：点在线名单里的「组队」，应该打到 /api/invite。
buttonsIn(lounge.tree, "组队")[0].props.onClick();
await lounge.settle();
const sentInvite = backend.sent.find((entry) => entry.route === "invite");
check("点「组队」会发出邀请", Boolean(sentInvite), JSON.stringify(backend.sent));
check("邀请发给了点的那个人", sentInvite && sentInvite.body.to === "lisi", JSON.stringify(sentInvite && sentInvite.body));
same("邀请携带的是组队模式", sentInvite && sentInvite.body.mode, "coop");
check("邀请后页面给了回执", /已邀请/.test(textOf(lounge.tree)), textOf(lounge.tree).slice(-120));

// 接受邀请：应该打到 /api/invite/respond，并把房间挂到页面上。
buttonsIn(lounge.tree, "接受")[0].props.onClick();
await lounge.settle();
const sentRespond = backend.sent.find((entry) => entry.route === "invite/respond");
check("点「接受」会回邀请", Boolean(sentRespond), JSON.stringify(backend.sent));
same("回应的是那一条邀请", sentRespond && sentRespond.body.id, 501);
same("回应是接受", sentRespond && sentRespond.body.accept, true);
same("接受之后敌人数跟着房间走", findAll(lounge.tree, (node) => node.type === "select")[1].props.value, 20);
check("接受之后页面挂上了房间", /R-9/.test(textOf(lounge.tree)), textOf(lounge.tree).slice(-160));
check("接受之后能给退出房间的入口", Boolean(buttonWith(lounge.tree, "退出房间")));

// 客人这边不跑本地引擎（房主权威）：画面只等房主的快照，本地按键只往上送。
buttonWith(lounge.tree, "开始游戏").props.onClick();
await lounge.settle();
await lounge.frames(220);
check("客人侧一开局就说清了谁是房主", /客人/.test(textOf(lounge.tree)), textOf(lounge.tree).slice(-160));
check("客人侧本地不自己推进画面（等房主快照）", lounge.playerBox() === null && lounge.rafCount() > 0, `${JSON.stringify(lounge.playerBox())} · raf=${lounge.rafCount()}`);
buttonWith(lounge.tree, "结束游戏").props.onClick();
await lounge.settle();
check("客人退出对局后大厅又回来了", byClass(lounge.tree, "hs-tank-lobby") !== undefined);

// 开房：点「开对战房」，应该打到 /api/room 并带上模式。
buttonWith(lounge.tree, "开对战房").props.onClick();
await lounge.settle();
const sentRoom = backend.sent.find((entry) => entry.route === "room");
check("点「开对战房」会开房", Boolean(sentRoom), JSON.stringify(backend.sent));
same("开的是对战房", sentRoom && sentRoom.body.mode, "pvp");
check("开房之后页面挂上了新房间", /R-77/.test(textOf(lounge.tree)), textOf(lounge.tree).slice(-160));

// 这次自己是房主：本地引擎真跑，本机按键必须驱动本机那辆坦克。
buttonWith(lounge.tree, "开始游戏").props.onClick();
await lounge.settle();
await lounge.frames(220);
check("房主侧一开局就说清了谁是房主", /房主/.test(textOf(lounge.tree)), textOf(lounge.tree).slice(-160));
const hostBefore = lounge.playerBox();
check("房主侧画面上有本机那辆坦克", hostBefore !== null, JSON.stringify(hostBefore));
lounge.key("keydown", "ArrowLeft");
await lounge.frames(45);
const hostAfter = lounge.playerBox();
lounge.key("keyup", "ArrowLeft");
check("房主侧本机按键真的开动了本机那辆坦克", hostBefore && hostAfter && hostAfter.minX < hostBefore.minX, `${hostBefore && hostBefore.minX} → ${hostAfter && hostAfter.minX}`);

// 进对局之后大厅收起，别让面板越堆越长。
check("开局之后大厅收起来了", byClass(lounge.tree, "hs-tank-lobby") === undefined);
check("开局之后房间号还在状态条上", /R-77/.test(textOf(byClass(lounge.tree, "hs-tank-status"))), textOf(byClass(lounge.tree, "hs-tank-status")));
lounge.cleanup();

// ============================================================
console.log("\n== 版本对不上时会说清楚 ==");
const skew = await bootPage({ defaultAi: "rookie", enemyCount: 20, lives: 3, sound: true }, [], "0.0.1");
skew.renderPage();
await skew.settle();
check("宿主半版本比前端半旧时提示重启", /请完整退出应用再启动/.test(textOf(skew.tree)), textOf(skew.tree).slice(0, 120));
skew.cleanup();

const noVersion = await bootPage({ defaultAi: "rookie", enemyCount: 20, lives: 3, sound: true }, [], "");
noVersion.renderPage();
await noVersion.settle();
check("宿主半没自报版本时也提示重启", /宿主半没有自报版本/.test(textOf(noVersion.tree)), textOf(noVersion.tree).slice(0, 120));
noVersion.cleanup();

console.log(`\n合计 ${passed} 项通过，${failed} 项失败。`);
if (failed > 0) process.exit(1);
