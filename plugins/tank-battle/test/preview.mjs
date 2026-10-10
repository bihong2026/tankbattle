// preview.html 的自检：把它那一整段脚本真跑一遍。
//
// 为什么单独测这一份：preview.html 是「不装插件也能看/玩」的那张单页，除了自检没有别的
// 办法验证它 —— 它不在插件加载路径上，宿主不会加载它，也不会有人跑它。而它一旦坏了，
// 表现是整页空白，非常难查。
//
// 手法与 render.mjs 同源：假的 DOM / 画布 / RAF / fetch，把整页真跑起来。
// 另外顺手抓一类真会犯的错：**页面脚本读的每个 id，HTML 里必须真的存在**（写错一个字母
// 就是「点按钮没反应」）。
//
// 跑法：node test/preview.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const HTML = readFileSync(join(PLUGIN, "preview.html"), "utf8");
const CLIENT_SOURCE = readFileSync(join(PLUGIN, "client.js"), "utf8");

const VIEW_W = 240;
const VIEW_H = 208;
const FIELD = 208;
const PLAYER_BODY = "#e8c53a";
const SECOND_BODY = "#6fc3e8"; // 二号位在组队/同队时的车体色
const OPPONENT_BODY = "#e0725f"; // 二号位在对战时（B 队）的车体色

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
	if (condition) {
		passed += 1;
		console.log(`ok   ${name}`);
		return;
	}
	failed += 1;
	console.log(`FAIL ${name}${detail === undefined ? "" : `  →  ${detail}`}`);
}
function same(name, actual, expected) {
	check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

// ---------- 从 HTML 里抽页面脚本，以及它读到的那些 id ----------

const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((one) => one[1]);
if (scripts.length === 0) throw new Error("preview.html 里找不到内联脚本");

// 页面用 var $ = function (id) { return document.getElementById(id); }; 取元素，
// 所以 $("x") 就是「脚本会去读 id=x」。
function usedIds(source) {
	const ids = new Set();
	for (const one of source.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) ids.add(one[1]);
	for (const one of source.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)) ids.add(one[1]);
	return [...ids];
}

function declaredIds(html) {
	const ids = new Set();
	for (const one of html.matchAll(/\bid="([^"]+)"/g)) ids.add(one[1]);
	return ids;
}

// ---------- 假的 DOM ----------

function makeContext(bounds) {
	const rec = { fillStyle: "", rects: [] };
	const whole = (x, y, w, h) => {
		const box = typeof bounds === "function" ? bounds() : bounds;
		if (!box || !box.width || !box.height) return false;
		return x <= 0 && y <= 0 && w >= box.width && h >= box.height;
	};
	const ctx = {
		imageSmoothingEnabled: true,
		clearRect(x, y, w, h) {
			if (whole(x, y, w, h)) rec.rects.length = 0;
		},
		// 真画布是「先清屏再画」。blit 只做 drawImage，所以这里把来源的矩形搬过来，
		// 这样可见画布上也能按坐标找东西（否则屏幕永远空白）。
		drawImage(image) {
			if (image && image.ctx) rec.rects = image.ctx.rects.slice();
		},
		fillRect(x, y, w, h) {
			if (![x, y, w, h].every((value) => Number.isFinite(value))) {
				throw new Error(`fillRect 收到非数值：${x},${y},${w},${h}`);
			}
			if (rec.fillStyle === "#000000" && whole(x, y, w, h)) rec.rects.length = 0;
			rec.rects.push({ x, y, w, h, fill: rec.fillStyle });
		}
	};
	Object.defineProperty(ctx, "fillStyle", {
		get: () => rec.fillStyle,
		set: (value) => { rec.fillStyle = value; }
	});
	Object.defineProperty(ctx, "rects", { get: () => rec.rects });
	return ctx;
}

function makeElement(tag) {
	const element = {
		tagName: String(tag).toUpperCase(),
		width: 0,
		height: 0,
		style: {},
		dataset: {},
		children: [],
		textContent: "",
		value: "",
		hidden: false,
		disabled: false,
		title: "",
		attributes: {},
		listeners: new Map(),
		getContext() {
			if (!element.ctx) element.ctx = makeContext(element);
			return element.ctx;
		},
		appendChild(child) {
			element.children.push(child);
			return child;
		},
		addEventListener(type, fn) {
			if (!element.listeners.has(type)) element.listeners.set(type, new Set());
			element.listeners.get(type).add(fn);
		},
		removeEventListener(type, fn) {
			if (element.listeners.has(type)) element.listeners.get(type).delete(fn);
		},
		setAttribute(name, value) { element.attributes[name] = String(value); },
		removeAttribute(name) { delete element.attributes[name]; },
		getAttribute(name) { return element.attributes[name]; },
		getBoundingClientRect() { return { width: 720, height: 600, top: 0, left: 0 }; },
		fire(type, event) {
			const set = element.listeners.get(type);
			if (!set) return;
			for (const fn of set) fn(event);
		}
	};
	return element;
}

// ---------- 把整页装起来 ----------

function bootPreview() {
	const ids = declaredIds(HTML);
	const byId = new Map();
	for (const id of ids) byId.set(id, makeElement(id === "screen" ? "canvas" : "div"));

	const stage = makeElement("div");
	const pad = [
		makeElement("button"), makeElement("button"),
		makeElement("button"), makeElement("button"), makeElement("button")
	];
	// 从 HTML 里读真实的 data-dir / data-fire，别在测试里另抄一份。
	const dirs = [...HTML.matchAll(/<button[^>]*data-dir="([a-z]+)"/g)].map((one) => one[1]);
	dirs.forEach((dir, index) => { pad[index].dataset.dir = dir; });
	if (/<button[^>]*data-fire="1"/.test(HTML)) pad[dirs.length].dataset.fire = "1";

	const created = [];
	const document = {
		getElementById: (id) => byId.get(id) ?? null,
		querySelector: (selector) => (selector === ".stage" ? stage : null),
		querySelectorAll: (selector) => (selector === ".pad button" ? pad : []),
		createElement: (tag) => {
			const element = makeElement(tag);
			created.push(element);
			return element;
		}
	};

	const listeners = new Map();
	const rafs = new Map();
	let rafId = 1;
	const window = {
		devicePixelRatio: 1,
		__ModuleLoader__: { load: (definition) => { window.__TANK_PLUGIN__ = definition; } },
		requestAnimationFrame(fn) { const id = rafId++; rafs.set(id, fn); return id; },
		cancelAnimationFrame(id) { rafs.delete(id); },
		addEventListener(type, fn) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(fn);
		},
		removeEventListener(type, fn) {
			if (listeners.has(type)) listeners.get(type).delete(fn);
		}
	};

	const previous = {
		document: globalThis.document,
		window: globalThis.window,
		fetch: globalThis.fetch
	};
	globalThis.document = document;
	globalThis.window = window;
	// 页面自己已经不用 fetch 了（版本号从引擎拿）。留着这个替身是为了兜底：万一以后
	// 页面或 client.js 在加载期发起请求，也只会拿到这段假数据，不会真的去连网。
	globalThis.fetch = async (url) => ({
		status: 200,
		async text() { return String(url).endsWith("client.js") ? CLIENT_SOURCE : HTML; }
	});

	// client.js 先跑（它一进来就调 __ModuleLoader__.load），再跑页面自己那段。
	let bootError = "";
	try {
		new Function("window", "document", CLIENT_SOURCE)(window, document);
		const page = scripts[scripts.length - 1];
		new Function("window", "document", "fetch", page)(window, document, globalThis.fetch);
	} catch (error) {
		// new Function 里抛错时，栈里只有一行「anonymous」；把消息留下就够定位了。
		bootError = String((error && error.message) || error);
	}

	let clock = 0;
	return {
		byId,
		stage,
		pad,
		created,
		window,
		bootError,
		/** 离屏那块画布：引擎往它画，可见画布只是 drawImage 贴出去。 */
		get offscreen() {
			return created.find((element) => element.width === VIEW_W && element.height === VIEW_H) ?? null;
		},
		get screen() { return byId.get("screen"); },
		rects() {
			const off = this.offscreen;
			return off && off.ctx ? off.ctx.rects : [];
		},
		frames(count, delta = 1000 / 60) {
			for (let i = 0; i < count; i += 1) {
				clock += delta;
				const pending = [...rafs.values()];
				rafs.clear();
				for (const fn of pending) fn(clock);
			}
		},
		rafCount: () => rafs.size,
		key(type, value) {
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
		},
		cleanup() {
			globalThis.document = previous.document;
			globalThis.window = previous.window;
			globalThis.fetch = previous.fetch;
		}
	};
}

function boxOf(rects, fill) {
	const found = rects.filter((rect) => rect.fill === fill && rect.x < FIELD);
	if (found.length === 0) return null;
	return {
		minX: Math.min(...found.map((rect) => rect.x)),
		maxX: Math.max(...found.map((rect) => rect.x + rect.w))
	};
}

/** 等一轮宏任务用。 */
function flush() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 从页面里那份 client.js 取引擎，断言用引擎里真实的常量（模式名、配色、出生点、版本号）。
 * 在测试里另抄一份「组队」这种文案，页面一改文案用例就红 —— 红的是测试，不是页面，
 * 白折腾一轮。所以只留「页面显示的必须等于引擎里的那个值」这条关系。
 */
function engineFrom(window) {
	const definition = window.__TANK_PLUGIN__;
	if (!definition) throw new Error("client.js 没有通过 __ModuleLoader__ 注册");
	const reactStub = {
		createElement: () => null,
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useRef: (initial) => ({ current: initial }),
		useEffect: () => {},
		useMemo: (factory) => factory(),
		useCallback: (factory) => factory
	};
	return definition.factory((name) => {
		if (name === "react") return reactStub;
		throw new Error("浏览器半不该 require 别的包：" + name);
	}).engine;
}

// ============================================================
console.log("== 结构 ==\n");

const scriptText = scripts[scripts.length - 1];
const declared = declaredIds(HTML);
const used = usedIds(scriptText);
const missing = used.filter((id) => !declared.has(id));
same("页面脚本读的每个 id 在 HTML 里都存在", missing, []);
check("HTML 里声明了画布", declared.has("screen"));
check("HTML 里声明了模式容器与设置项", ["modes", "ai", "enemyCount", "lives", "stage"].every((id) => declared.has(id)));
check("HTML 里声明了开始 / 暂停 / 结束三个按钮", ["start", "pause", "stop"].every((id) => declared.has(id)));
check("HTML 里有屏幕上的方向键与开火键", /data-dir="/.test(HTML) && /data-fire="1"/.test(HTML));
check("HTML 直接引了 client.js（用真实引擎，不是另抄一份）", /<script src="client\.js">/.test(HTML));
check("页面不靠 fetch 拿版本号（双击打开时 file:// 下 fetch 会被拦掉）", !/fetch\s*\(/.test(scriptText));

// ============================================================
console.log("\n== 首屏 ==\n");

const page = bootPreview();
const E = engineFrom(page.window);
// 整页脚本已经跑完，但里面还藏着异步的东西（定时器、promise）也会漏出来 —— 一起等掉，
// 免得断言跑在页面更新之前，红了却看不出是谁的错。
await flush();
same("整页脚本跑完没有抛错", page.bootError, "");
same("屏幕画布拿到了", page.screen !== null, true);
same("离屏画布就是 240×208", page.offscreen ? `${page.offscreen.width}×${page.offscreen.height}` : "没有", `${VIEW_W}×${VIEW_H}`);
check("首屏就画了一张静态战场", page.rects().length > 100, String(page.rects().length));
check("首屏不跑动画", page.rafCount() === 0, String(page.rafCount()));
same("版本号从引擎里读出来并显示", page.byId.get("ver").textContent, "v" + E.VERSION);
same("敌方 AI 下拉列了四档", page.byId.get("ai").children.length, 4);
same("默认选老兵", page.byId.get("ai").value, "veteran");
same("敌人总数下拉列了三档", page.byId.get("enemyCount").children.length, 3);
same("我方生命下拉列了四档", page.byId.get("lives").children.length, 4);
same("起始关卡下拉列了四关", page.byId.get("stage").children.length, 4);
same("模式按钮列了三种", page.byId.get("modes").children.length, 3);
same("默认是单人模式", page.byId.get("start").disabled, false);
same("没开局时「暂停」是灰的", page.byId.get("pause").disabled, true);
same("没开局时「结束游戏」是灰的", page.byId.get("stop").disabled, true);

// ============================================================
console.log("\n== 单人：开始 / 操作 / 暂停 / 结束 ==\n");

page.byId.get("start").fire("click");
check("开始后跑起了动画", page.rafCount() > 0, String(page.rafCount()));
same("开始后「开始游戏」变灰", page.byId.get("start").disabled, true);
same("开始后「暂停」可用", page.byId.get("pause").disabled, false);
same("开始后「结束游戏」可用", page.byId.get("stop").disabled, false);
same("状态条报出了模式", page.byId.get("s-mode").textContent, E.MODE_LABELS.solo);
same("单人模式不显示红队比分", page.byId.get("s-scoreB-wrap").hidden, true);

// 0.9s 预告 + 1.3s 出生动画，先走完再操作。
page.frames(220);
same("状态条里有关卡", page.byId.get("s-stage").textContent, "1");
same("状态条里有生命", page.byId.get("s-lives").textContent, "3");
same("状态条里有剩余敌兵", /^\d+$/.test(page.byId.get("s-left").textContent), true);
const before = boxOf(page.rects(), PLAYER_BODY);
check("画面上找得到本机那辆坦克", before !== null, JSON.stringify(page.rects().length));
// 出生点右边紧挨着基地的护卫砖，往左走才走得动。
page.key("keydown", "ArrowLeft");
page.frames(40);
const after = boxOf(page.rects(), PLAYER_BODY);
page.key("keyup", "ArrowLeft");
check("按住左方向键会往左开", before && after && after.minX < before.minX, `${before && before.minX} → ${after && after.minX}`);

page.key("keydown", "Escape");
page.frames(1);
same("Esc 之后「暂停」变成「继续」", page.byId.get("pause").textContent, "继续");
const frozen = boxOf(page.rects(), PLAYER_BODY);
page.frames(30);
same("暂停期间画面不再推进", JSON.stringify(boxOf(page.rects(), PLAYER_BODY)), JSON.stringify(frozen));
page.key("keydown", "Escape");
page.frames(1);
same("再按一次 Esc 继续", page.byId.get("pause").textContent, "暂停");

page.byId.get("stop").fire("click");
same("结束后动画停了", page.rafCount(), 0);
same("结束后回到「开始游戏」", page.byId.get("start").disabled, false);
same("结束后「结束游戏」变灰", page.byId.get("stop").disabled, true);

// ============================================================
console.log("\n== 组队：两个座位各有一套键 ==\n");

page.byId.get("modes").children[1].fire("click"); // 组队
page.byId.get("start").fire("click");
page.frames(220);
same("状态条报出组队模式", page.byId.get("s-mode").textContent, E.MODE_LABELS.coop);
const oneBefore = boxOf(page.rects(), PLAYER_BODY);
const twoBefore = boxOf(page.rects(), SECOND_BODY);
check("场上有二号位那辆坦克", twoBefore !== null, "二号位没画出来");
// 两辆车必须**分头出场**。坦克之间有碰撞，共用一个出生点会互相挡死：按了键谁也不动。
// 只验「都在场上」抓不到这个 —— 两辆车叠在一起时画面看着也是「都在」。
check("两个座位不叠在同一个点上", oneBefore !== null && twoBefore !== null && twoBefore.minX > oneBefore.minX,
	`一号位 ${oneBefore && oneBefore.minX}，二号位 ${twoBefore && twoBefore.minX}`);
// 一号位用方向键，二号位用 J；各走各的，互不干扰。
page.key("keydown", "ArrowLeft");
page.key("keydown", "l"); // 二号位往右
page.frames(40);
const oneAfter = boxOf(page.rects(), PLAYER_BODY);
const twoAfter = boxOf(page.rects(), SECOND_BODY);
page.key("keyup", "ArrowLeft");
page.key("keyup", "l");
check("一号位被方向键驱动", oneBefore && oneAfter && oneAfter.minX < oneBefore.minX, `${oneBefore && oneBefore.minX} → ${oneAfter && oneAfter.minX}`);
check("二号位被 I J K L 驱动", twoBefore && twoAfter && twoAfter.minX > twoBefore.minX, `${twoBefore && twoBefore.minX} → ${twoAfter && twoAfter.minX}`);
page.byId.get("stop").fire("click");

// ============================================================
console.log("\n== 对战：双队比分显示出来 ==\n");

page.byId.get("modes").children[2].fire("click"); // 对战
page.byId.get("start").fire("click");
// 0.9s 预告 + 1.3s 出生保护，这两段时间里坦克画的是护盾星、不是车体色。先走完再看画面。
page.frames(240);
same("状态条报出对战模式", page.byId.get("s-mode").textContent, E.MODE_LABELS.pvp);
same("对战模式显示红队比分", page.byId.get("s-scoreB-wrap").hidden, false);
same("红队比分是个数字", /^\d+$/.test(page.byId.get("s-scoreB").textContent), true);
// 对战是「一人一队」，所以两队各得有一辆车。只给一个座位时红队会连一辆本队车都没有。
check("对战里红队那辆也画出来了", boxOf(page.rects(), OPPONENT_BODY) !== null, "红队那辆没画出来");
page.byId.get("stop").fire("click");

// ============================================================
console.log("\n== 设置改动会重画静态战场 ==\n");

page.byId.get("lives").value = "9";
page.byId.get("stage").value = "3";
same("改设置之后仍是待开局状态", page.byId.get("start").disabled, false);
page.byId.get("start").fire("click");
page.frames(2);
same("按新设置开局：起始关卡跟着走", page.byId.get("s-stage").textContent, "3");
page.byId.get("stop").fire("click");

page.cleanup();

console.log(`\n合计 ${passed} 项通过，${failed} 项失败。`);
if (failed > 0) process.exit(1);
