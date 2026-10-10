// 打坦克的浏览器半。
//
// 它占两个官方插槽，做一个完整的页（和插件市场、工作平台同一套做法）：
//   - sidebar.panellist：在侧栏加一项「打坦克」（id = tank-battle）
//   - 布局 root 的 keyed main：同一个 id，点侧栏那一项就开这个页面
//
// 游戏本身全部跑在这个文件里（Canvas 2D + requestAnimationFrame），不读别的插件的
// DOM、不往 document.body 追加第二套应用，样式只引用 --dsw-alias-* 令牌。
// 只有战绩要落盘，走宿主半的 /tank-battle/stats 与 /record。
//
// 画面做法：所有东西先画在一张 240×208 的离屏画布上（13×13 格战场 + 右侧 32px 状态栏，
// 一格 16px，就是红白机的比例），再用 imageSmoothingEnabled = false 整数倍放大贴到
// 显示画布上。所以像素是硬的，不会糊。
//
// 对原版做过的简化，都写在这里，免得以后当成 bug 查：
//   1. 砖墙以「整格 16×16」为单位摧毁（原版是 8×8 的四分之一格，要两发才能打穿）；
//      这里一发一个洞，一发就能开过去。
//   2. 敌方 AI 是四档可选（新兵 / 老兵 / 猎手 / 王牌），不是原版那套固定行为。
//   3. 冰面只做「提速 + 松手后滑一段」，没有做原版那种惯性漂移。
//   4. 道具、关卡地图是照原版风格重画的，不是逐像素复刻。

window.__ModuleLoader__.load({
	id: "dsh-tank-battle",
	factory(require) {
		const React = require("react");
		const h = React.createElement;

		/** 侧栏那一项与整页共用同一个 id，改这里两处一起改。 */
		const PANEL_ID = "tank-battle";
		/** 宿主半注册的路由前缀。 */
		const API = "/tank-battle";
		/** 前端半自己的版本，必须与 package.json 的 version 一致（自检会核对）。 */
		const PLUGIN_VERSION = "0.3.1";

		// ==================== 尺寸与常量 ====================

		/** 一格 16px；战场 13×13 格 = 208×208，右边留 32px 放状态栏。 */
		const TILE = 16;
		const COLS = 13;
		const ROWS = 13;
		const FIELD = COLS * TILE;
		const HUD_W = 32;
		const VIEW_W = FIELD + HUD_W;
		const VIEW_H = FIELD;
		/** 逻辑帧长：物理固定 60 帧，纯计时用真实时间，帧率高低都不影响手感。 */
		const STEP = 1000 / 60;

		const T = { EMPTY: 0, BRICK: 1, STEEL: 2, WATER: 3, FOREST: 4, ICE: 5, BASE: 6, BASE_DEAD: 7 };
		const UP = 0;
		const RIGHT = 1;
		const DOWN = 2;
		const LEFT = 3;
		const DIRS = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
		const OPPOSITE = [DOWN, LEFT, UP, RIGHT];
		/** 坦克过不去的地形。树林和冰面能过，水过不去，基地和基座残骸算实心。 */
		const SOLID = { 0: false, 1: true, 2: true, 3: true, 4: false, 5: false, 6: true, 7: true };
		/** 子弹打得到的地形（水、树林、冰面穿过）。 */
		const BULLET_BLOCK = { 1: true, 2: true, 6: true, 7: true };

		const BLACK = "#000000";
		const WHITE = "#f4f4f4";
		const GRAY = "#7c848c";
		const RED = "#d0463a";

		// ==================== 模式与队伍 ====================
		//
		// 三种玩法共用一套引擎，区别只在「谁和谁打」：
		//   solo 单人闯关   —— 玩家队 A 一辆车，打中立 NPC（ENEMY 队）
		//   coop 组队打NPC  —— 两个玩家同在 A 队，一起打中立的 ENEMY 队
		//   pvp  双人对战   —— 甲 A 队、乙 B 队，各自带一队 NPC 互相攻防，各有一座基地
		//
		// 「敌对」的判定一律走 team：子弹只伤非同队的坦克。所以加模式不用改伤害逻辑。

		const MODES = ["solo", "coop", "pvp"];
		const MODE_LABELS = { solo: "单人闯关", coop: "组队打NPC", pvp: "双人对战" };
		const MODE_HELP = {
			solo: "一个人守基地、打光所有敌兵",
			coop: "两人同队，背靠背清场",
			pvp: "各带一队 NPC、各守一座基地，打掉对方基地就赢"
		};
		/** A 队蓝、B 队红、中立 NPC 灰——和战场上的车体色是一套。 */
		const TEAM_COLORS = { A: "#4f9dea", B: "#e0574a", ENEMY: "#b6bfc7" };
		const TEAM_NAMES = { A: "蓝队", B: "红队", ENEMY: "敌军" };
		const ENEMY_TEAM = "ENEMY";
		/**
		 * 两名玩家的出生点：A 队在下方基地两侧，B 队在顶部基地两侧。
		 *
		 * 每队**两个**点，同队两辆车各占一边。这不是装饰 —— 坦克之间是有碰撞的
		 * （`tankFits` 里那条 `overlaps`），组队时两辆车都算 A 队，要是共用一个点就会
		 * 严丝合缝地叠在一起，谁也走不出第一步：一按左键，检验落点的那辆车正好压在
		 * 同伴身上，判定「不通过」，两辆车从此锁死在原地。
		 */
		const PLAYER_SPAWNS = {
			A: [{ x: 4 * TILE, y: 12 * TILE }, { x: 8 * TILE, y: 12 * TILE }],
			// B 队第一个点保持原样（对战时客人在右上），第二个点补基地左侧。
			B: [{ x: 8 * TILE, y: 0 }, { x: 4 * TILE, y: 0 }]
		};
		/** NPC 出兵点：双方各从自己那侧出，省得开局就扎堆在对面基地门口。 */
		const SPAWN_POINTS = {
			A: [{ x: 0, y: 12 * TILE }, { x: 12 * TILE, y: 12 * TILE }],
			B: [{ x: 0, y: 0 }, { x: 12 * TILE, y: 0 }],
			ENEMY: [{ x: 0, y: 0 }, { x: 6 * TILE, y: 0 }, { x: 12 * TILE, y: 0 }]
		};

		// ==================== 点阵字（3×5） ====================

		/**
		 * 3×5 的英文字母数字。用 canvas 直接 fillText 在小画布上会糊，放大三倍之后更难看，
		 * 所以自己画点阵——这也正好是红白机那个味道。
		 */
		const FONT = {
			"0": ["111", "101", "101", "101", "111"],
			"1": ["010", "110", "010", "010", "111"],
			"2": ["111", "001", "111", "100", "111"],
			"3": ["111", "001", "111", "001", "111"],
			"4": ["101", "101", "111", "001", "001"],
			"5": ["111", "100", "111", "001", "111"],
			"6": ["111", "100", "111", "101", "111"],
			"7": ["111", "001", "001", "001", "001"],
			"8": ["111", "101", "111", "101", "111"],
			"9": ["111", "101", "111", "001", "111"],
			A: ["010", "101", "111", "101", "101"],
			B: ["110", "101", "110", "101", "110"],
			C: ["011", "100", "100", "100", "011"],
			D: ["110", "101", "101", "101", "110"],
			E: ["111", "100", "110", "100", "111"],
			F: ["111", "100", "110", "100", "100"],
			G: ["011", "100", "101", "101", "011"],
			H: ["101", "101", "111", "101", "101"],
			I: ["111", "010", "010", "010", "111"],
			J: ["001", "001", "001", "101", "010"],
			K: ["101", "101", "110", "101", "101"],
			L: ["100", "100", "100", "100", "111"],
			M: ["101", "111", "111", "101", "101"],
			N: ["101", "111", "111", "111", "101"],
			O: ["010", "101", "101", "101", "010"],
			P: ["110", "101", "110", "100", "100"],
			Q: ["010", "101", "101", "111", "011"],
			R: ["110", "101", "110", "101", "101"],
			S: ["011", "100", "010", "001", "110"],
			T: ["111", "010", "010", "010", "010"],
			U: ["101", "101", "101", "101", "011"],
			V: ["101", "101", "101", "101", "010"],
			W: ["101", "101", "111", "111", "101"],
			X: ["101", "101", "010", "101", "101"],
			Y: ["101", "101", "010", "010", "010"],
			Z: ["111", "001", "010", "100", "111"],
			"-": ["000", "000", "111", "000", "000"],
			":": ["000", "010", "000", "010", "000"],
			".": ["000", "000", "000", "000", "010"],
			"!": ["010", "010", "010", "000", "010"],
			"/": ["001", "001", "010", "100", "100"],
			" ": ["000", "000", "000", "000", "000"]
		};

		function textWidth(text, scale) {
			const count = String(text).length;
			if (count === 0) return 0;
			return (count * 4 - 1) * scale;
		}

		function drawText(c, text, x, y, color, scale) {
			const px = scale || 1;
			c.fillStyle = color || WHITE;
			const chars = String(text).toUpperCase();
			for (let i = 0; i < chars.length; i += 1) {
				const glyph = FONT[chars[i]] || FONT["."];
				const ox = x + i * 4 * px;
				for (let r = 0; r < 5; r += 1) {
					const row = glyph[r];
					for (let k = 0; k < 3; k += 1) {
						if (row[k] === "1") c.fillRect(ox + k * px, y + r * px, px, px);
					}
				}
			}
		}

		// ==================== 调色 ====================

		/** 把 #rrggbb 提亮（amount>0）或压暗（amount<0）。传进来的都是自己写死的色值。 */
		function shade(hex, amount) {
			const value = hex.replace("#", "");
			const num = parseInt(value.length === 3
				? value.split("").map((ch) => ch + ch).join("")
				: value, 16);
			let r = (num >> 16) & 255;
			let g = (num >> 8) & 255;
			let b = num & 255;
			if (amount >= 0) {
				r += (255 - r) * amount;
				g += (255 - g) * amount;
				b += (255 - b) * amount;
			} else {
				r *= 1 + amount;
				g *= 1 + amount;
				b *= 1 + amount;
			}
			const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
			return `#${to(r)}${to(g)}${to(b)}`;
		}

		// ==================== 敌我参数 ====================

		/** 每档敌坦克：速度单位是逻辑像素/秒。 */
		const ENEMY_KINDS = {
			basic: { label: "普通", speed: 56, bullet: 200, hp: 1, fireDelay: 1150, score: 100, color: "#b6bfc7" },
			fast: { label: "快速", speed: 104, bullet: 200, hp: 1, fireDelay: 1000, score: 200, color: "#8fc3ee" },
			power: { label: "强力", speed: 64, bullet: 320, hp: 1, fireDelay: 680, score: 300, color: "#e2d79c" },
			armor: { label: "装甲", speed: 72, bullet: 200, hp: 4, fireDelay: 880, score: 400, color: "#8ecf7c" }
		};
		/** 装甲坦克按剩余装甲换色：满甲是绿的，越打越红。 */
		const ARMOR_COLORS = ["#8ecf7c", "#d9c95a", "#d99a4a", "#cf5c4a"];

		/** 玩家自己：星级越高打得越快、能同时挂的弹越多，三星能打穿钢墙。 */
		const PLAYER_LEVELS = [
			{ speed: 92, bullet: 300, maxBullets: 1, power: 0, color: "#e8c53a" },
			{ speed: 96, bullet: 400, maxBullets: 1, power: 0, color: "#e8c53a" },
			{ speed: 100, bullet: 400, maxBullets: 2, power: 0, color: "#e8c53a" },
			{ speed: 104, bullet: 440, maxBullets: 2, power: 1, color: "#f0d855" }
		];

		const PLAYER_FIRE_DELAY = 170;
		/** 场上同时最多几辆 NPC —— 敌兵总数越多，放出场的也越多，免得大场面看着空。 */
		function maxOnField(game) {
			const total = game.cfg.mode === "pvp" ? game.cfg.enemyCount / 2 : game.cfg.enemyCount;
			return clamp(3 + Math.floor(total / 6), 3, 6);
		}

		/** 道具掉落位置（原版是固定几格，这里按空格随机取）。 */
		const POWERUPS = ["star", "helmet", "clock", "shovel", "grenade", "tank"];
		const POWERUP_NAMES = {
			star: "火力升级",
			helmet: "无敌护盾",
			clock: "冻结敌军",
			shovel: "加固基地",
			grenade: "全屏轰炸",
			tank: "增加生命"
		};

		// ==================== 关卡地图 ====================
		//
		// '.' 空地  '#' 砖墙  '@' 钢墙  '~' 河  'T' 树林  '=' 冰面  'E' 基地
		// 每行必须正好 13 个字符、共 13 行；基地按原版惯例自己补一圈砖墙，
		// 所以地图里写不写护卫砖都不影响可玩性。

		const STAGE_MAPS = [
			[
				".............",
				".##.##.##.##.",
				".##.##.##.##.",
				".............",
				".##.##.##.##.",
				".##.##.##.##.",
				".............",
				".##.##.##.##.",
				".##.##.##.##.",
				".............",
				"..#.#####.#..",
				".....###.....",
				".....#E#....."
			],
			[
				".............",
				"..#.##.##.#..",
				"..#.##.##.#..",
				"..#.......#..",
				".TTT.~~~.TTT.",
				".TTT.~~~.TTT.",
				".....~~~.....",
				".@@@.....@@@.",
				".............",
				"..==.....==..",
				"..==.###.==..",
				".....###.....",
				".....#E#....."
			],
			[
				".............",
				".###.....###.",
				".#@#.TTT.#@#.",
				".###.TTT.###.",
				".....TTT.....",
				".######.#####",
				"......~......",
				"#####.######.",
				".....==......",
				"..###.==.###.",
				"..##.....##..",
				".....###.....",
				".....#E#....."
			],
			[
				".............",
				".##.##.##.##.",
				".@@.##.##.@@.",
				".##.##.##.##.",
				".............",
				".~~~.###.~~~.",
				".~~~.###.~~~.",
				".............",
				".@@.#.#.#.@@.",
				".##.#.#.#.##.",
				"....#...#....",
				".....###.....",
				".....#E#....."
			]
		];

		const STAGE_LEGEND = {
			".": T.EMPTY,
			"#": T.BRICK,
			"@": T.STEEL,
			"~": T.WATER,
			"T": T.FOREST,
			"=": T.ICE,
			"E": T.BASE
		};

		// ==================== 四档 AI ====================
		//
		// think   多久重新做一次决定（毫秒），越小反应越快
		// aim     与目标对上时开火的概率；对不上时按 aim/4 走
		// dodge   躲弹倾向，0 表示完全不管
		// path    true 用 Dijkstra 按地形代价寻路，false 只按曼哈顿距离贪心
		// fireGap 开火间隔的倍率，越小越密
		// base    「打基地」的执念，1 表示一半的兵冲基地，其余找玩家
		// random  决策里的随机扰动，越大越没章法

		const AI_PROFILES = {
			rookie: { label: "新兵", help: "乱走乱打，偶尔摸到基地", think: 520, aim: 0.20, dodge: 0, path: false, fireGap: 1.5, base: 0.35, random: 0.85, lead: 0 },
			veteran: { label: "老兵", help: "直线逼近基地和玩家，对上了就开火", think: 320, aim: 0.48, dodge: 0.25, path: false, fireGap: 1.0, base: 0.55, random: 0.35, lead: 0 },
			hunter: { label: "猎手", help: "会绕路、会卡位、看到子弹会闪", think: 210, aim: 0.72, dodge: 0.6, path: true, fireGap: 0.65, base: 0.6, random: 0.14, lead: 0.5 },
			ace: { label: "王牌", help: "绕路包抄、预判走位、集火基地", think: 140, aim: 0.9, dodge: 0.9, path: true, fireGap: 0.45, base: 0.7, random: 0.05, lead: 1 }
		};
		const AI_ORDER = ["rookie", "veteran", "hunter", "ace"];

		function aiProfile(game) {
			return AI_PROFILES[game?.cfg?.ai] || AI_PROFILES.veteran;
		}

		/** 敌兵编成：越往后的关卡，强力兵越多。 */
		function stageMix(stage) {
			const table = [
				{ basic: 0.70, fast: 0.15, power: 0.10, armor: 0.05 },
				{ basic: 0.55, fast: 0.20, power: 0.15, armor: 0.10 },
				{ basic: 0.45, fast: 0.22, power: 0.18, armor: 0.15 },
				{ basic: 0.35, fast: 0.25, power: 0.20, armor: 0.20 }
			];
			return table[Math.min(table.length - 1, Math.max(0, stage - 1))];
		}

		/**
		 * 排一支敌兵队列。前三个固定是普通兵（开场给玩家一点余地），
		 * 第 4、11、18 个是「运兵车」——打掉会掉道具（原版就是这个套路）。
		 */
		function buildQueue(count, stage) {
			const mix = stageMix(stage);
			const queue = [];
			const rolls = ["basic", "basic", "basic"];
			for (let i = 3; i < count; i += 1) {
				const roll = Math.random();
				let acc = mix.basic;
				if (roll < acc) rolls.push("basic");
				else {
					acc += mix.fast;
					if (roll < acc) rolls.push("fast");
					else {
						acc += mix.power;
						if (roll < acc) rolls.push("power");
						else rolls.push("armor");
					}
				}
			}
			for (let i = 0; i < count; i += 1) {
				const carrier = i === 3 || i === 10 || i === 17;
				queue.push({ kind: rolls[i] || "basic", carrier });
			}
			return queue;
		}
		// ==================== 几何与地形 ====================

		const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
		const tileIndex = (c, r) => r * COLS + c;
		const colOf = (x) => clamp(Math.floor(x / TILE), 0, COLS - 1);
		const rowOf = (y) => clamp(Math.floor(y / TILE), 0, ROWS - 1);
		const centerX = (c) => c * TILE + TILE / 2;
		const centerY = (r) => r * TILE + TILE / 2;
		const snap8 = (value) => Math.round(value / 8) * 8;

		function overlaps(ax, ay, bx, by, size) {
			return ax < bx + size && bx < ax + size && ay < by + size && by < ay + size;
		}

		/** 这个位置的 16×16 框，坦克能不能进。 */
		function tankFits(game, x, y, self) {
			// 坐标必须是有限数。少这一句的话，速度一旦变成 NaN 就会一路算成
			// tiles[NaN] = undefined、SOLID[undefined] = 假，最后「允许」把坦克
			// 放到 NaN 上，从此再也撞不到任何东西 —— 静默失效，很难查。
			if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
			if (x < 0 || y < 0 || x + TILE > FIELD || y + TILE > FIELD) return false;
			const c0 = colOf(x);
			const c1 = colOf(x + TILE - 0.01);
			const r0 = rowOf(y);
			const r1 = rowOf(y + TILE - 0.01);
			for (let r = r0; r <= r1; r += 1) {
				for (let c = c0; c <= c1; c += 1) {
					if (SOLID[game.tiles[tileIndex(c, r)]]) return false;
				}
			}
			for (const other of [...game.players, ...game.enemies]) {
				if (other === self || !other.alive || other.spawning > 0) continue;
				if (overlaps(x, y, other.x, other.y, TILE - 1)) return false;
			}
			return true;
		}

		/**
		 * 转向时把垂直轴对齐到 8px —— 原版坦克就是这么走的，不对齐的话
		 * 会卡在只有一格宽的缺口前，玩家会觉得「明明对准了却过不去」。
		 */
		function alignPerpendicular(game, tank, dir) {
			const axis = dir === UP || dir === DOWN ? "x" : "y";
			const current = tank[axis];
			const candidates = [snap8(current), Math.floor(current / 8) * 8, Math.ceil(current / 8) * 8];
			for (const value of candidates) {
				const probeX = axis === "x" ? value : tank.x;
				const probeY = axis === "x" ? tank.y : value;
				if (tankFits(game, probeX, probeY, tank)) {
					tank[axis] = value;
					return;
				}
			}
			tank[axis] = snap8(current);
		}

		/** 沿 dir 走距离 distance；走不动返回 false（调用方据此判断撞墙）。 */
		function driveTank(game, tank, dir, distance) {
			if (!Number.isFinite(distance) || distance === 0) return false;
			const d = DIRS[dir];
			const nx = tank.x + d.x * distance;
			const ny = tank.y + d.y * distance;
			if (!tankFits(game, nx, ny, tank)) return false;
			tank.x = nx;
			tank.y = ny;
			return true;
		}

		/** 坦克脚下的地形（按中心点算），冰面判定用。 */
		function tileUnder(game, tank) {
			return game.tiles[tileIndex(colOf(tank.x + TILE / 2), rowOf(tank.y + TILE / 2))];
		}

		// ==================== 局面 ====================

		function createGame(cfg) {
			const mode = MODES.includes(cfg?.mode) ? cfg.mode : "solo";
			const seats = normalizeSeats(mode, cfg?.seats);
			const game = {
				cfg: {
					mode,
					ai: AI_PROFILES[cfg?.ai] ? cfg.ai : "veteran",
					enemyCount: clamp(Math.round(Number(cfg?.enemyCount) || 20), 4, 60),
					lives: clamp(Math.round(Number(cfg?.lives) || 3), 1, 9),
					stage: clamp(Math.round(Number(cfg?.stage) || 1), 1, 99),
					sound: cfg?.sound !== false
				},
				seats,
				tiles: new Uint8Array(COLS * ROWS),
				baseAt: { c: 6, r: 12 },
				bases: [],
				baseGuard: [],
				baseAlive: true,
				players: [],
				player: null,
				enemies: [],
				bullets: [],
				powerups: [],
				effects: [],
				queue: [],
				spawnIndex: 0,
				spawnTimer: 0,
				respawnTimer: 0,
				respawnTimers: [],
				status: "intro",
				introTimer: 900,
				outroTimer: 0,
				clock: 0,
				score: 0,
				scoreA: 0,
				scoreB: 0,
				lives: 0,
				livesBySeat: [],
				// 击毁数按座位存。坦克被打掉之后就从这个数组里被移走了，只记在坦克身上会跟着丢，
				// 结果就是上报给服务端的击杀数永远是 0。
				killsBySeat: [],
				stage: 0,
				level: 0,
				levelBySeat: [],
				freezeUntil: 0,
				shovelUntil: 0,
				lastScorePopupAt: -1,
				events: [],
				// 每个座位一份操作。座位 0 是本机（房主/单人），座位 1 是客人。
				inputs: seats.map(() => ({ dirs: [], fire: false }))
			};
			game.lives = game.cfg.lives;
			game.stage = game.cfg.stage;
			loadStage(game, game.cfg.stage, 0);
			return game;
		}

		/**
		 * 把服务端给的房间成员排成本机的座位表。
		 *
		 * 引擎有一条硬约定：**座位 0 永远是本机**（本机按键就喂在 game.inputs[0]）。
		 * 服务端返回的成员是「房主在前」，客人这边必须把自己提到最前面 ——
		 * 否则本机按键会喂到房主那辆坦克上。队别（team）跟着成员走、不跟座位号走，
		 * 所以翻转顺序不会把队伍换错。
		 *
		 * 抽成纯函数是为了能单测：真实对局里客人不跑本地引擎（房主权威），
		 * 光靠页面自检看不出座位有没有排错。
		 */
		function orderSeats(members, self) {
			const list = Array.isArray(members) ? members.filter(Boolean).slice(0, 2) : [];
			const me = String(self || "");
			const mine = me ? list.find((member) => String(member.username || "") === me) : undefined;
			if (!mine || list[0] === mine) return list;
			return [mine, ...list.filter((member) => member !== mine)];
		}

		/**
		 * 把「几个座位、谁在哪一队」收拾成确定的样子。成员身上写了队别就用它，没写才按座位推。
		 *
		 * 组队和对战都**必须**凑满两个座位：这两种模式少了座位就不是「少个人」而已 ——
		 * 对战的第二队会连一个本队车都没有，组队则是「说好两个人一起打」却只出来一辆车。
		 * 谁会碰上：预览页（本机一个人看三种模式）、房间还没凑齐人时点了开局。
		 * 房间里已经有两个成员时这段不会触发，服务端算好的队别原样照用。
		 */
		function normalizeSeats(mode, raw) {
			const list = Array.isArray(raw) ? raw.filter(Boolean).slice(0, 2) : [];
			const seats = list.map((seat, index) => ({
				seat: index,
				// pvp 默认左 A 右 B；但服务端已经算好了队别（房主 A、客人 B），有就照用。
				team: TEAM_COLORS[seat?.team] ? seat.team : (mode === "pvp" ? (index === 0 ? "A" : "B") : "A"),
				username: String(seat?.username || ""),
				name: String(seat?.name || `P${index + 1}`)
			}));
			if (seats.length === 0) seats.push({ seat: 0, team: "A", username: "", name: "P1" });
			if (mode === "coop" && seats.length < 2) seats.push({ seat: 1, team: "A", username: "", name: "P2" });
			// 补的那队跟现有那辆错开：两个座位都算一队的话，对战就变成自己打自己。
			if (mode === "pvp" && seats.length < 2) {
				seats.push({ seat: 1, team: seats[0].team === "A" ? "B" : "A", username: "", name: "P2" });
			}
			if (mode === "solo") seats.length = 1;
			return seats;
		}

		/** 把第 index 关的地图铺到 tiles 上；carryScore 用于关卡之间保留分数与火力。 */
		function loadStage(game, stage, carryScore) {
			const map = STAGE_MAPS[(Math.max(1, stage) - 1) % STAGE_MAPS.length];
			game.stage = stage;
			game.score = carryScore || 0;
			game.tiles.fill(T.EMPTY);
			game.baseAlive = true;
			let baseAt = { c: 6, r: 12 };
			for (let r = 0; r < ROWS; r += 1) {
				const row = map[r] || "";
				for (let c = 0; c < COLS; c += 1) {
					const id = STAGE_LEGEND[row[c]];
					game.tiles[tileIndex(c, r)] = id === undefined ? T.EMPTY : id;
					if (id === T.BASE) baseAt = { c, r };
				}
			}
			// 基地：单人/组队只有一座（A 队）；对战两队各一座，B 队那座放在对顶。
			game.baseAt = baseAt;
			game.bases = [makeBase("A", baseAt.c, baseAt.r)];
			if (game.cfg.mode === "pvp") game.bases.push(makeBase("B", baseAt.c, 0));
			for (const base of game.bases) {
				game.tiles[tileIndex(base.c, base.r)] = T.BASE;
				// 基地护卫砖：不管地图怎么写，基地都按原版围一圈砖，不会裸奔。
				for (const cell of base.guard) {
					if (cell.c < 0 || cell.r < 0 || cell.c >= COLS || cell.r >= ROWS) continue;
					game.tiles[tileIndex(cell.c, cell.r)] = T.BRICK;
				}
			}
			game.baseGuard = game.bases[0].guard;

			const count = game.cfg.mode === "pvp"
				? Math.max(2, Math.round(game.cfg.enemyCount / 2) * 2)
				: game.cfg.enemyCount;
			game.queue = buildQueue(count, stage);
			game.spawnIndex = 0;
			game.spawnTimer = 420;
			game.enemies = [];
			game.bullets = [];
			game.powerups = [];
			game.effects = [];
			game.freezeUntil = 0;
			game.shovelUntil = 0;
			game.level = Math.max(0, game.level);
			game.respawnTimer = 0;
			game.status = "intro";
			game.introTimer = 900;

			game.players = [];
			game.livesBySeat = [];
			game.levelBySeat = [];
			game.inputs = game.seats.map(() => ({ dirs: [], fire: false }));
			for (const seat of game.seats) {
				game.livesBySeat[seat.seat] = game.cfg.lives;
				game.levelBySeat[seat.seat] = game.level;
				const tank = makePlayer(game, seat);
				tank.spawning = 1300;
				game.players.push(tank);
			}
			game.player = game.players[0] || null;
			game.lives = game.livesBySeat[0] || 0;
		}

		function makeBase(team, c, r) {
			return {
				team,
				c,
				r,
				alive: true,
				guard: [
					{ c: c - 1, r: r - 1 },
					{ c, r: r - 1 },
					{ c: c + 1, r: r - 1 },
					{ c: c - 1, r },
					{ c: c + 1, r }
				]
			};
		}

		/**
		 * 这一辆车该从哪儿出场。
		 *
		 * 同队出场次序**不能**用座位号推：组队时座位 0 和座位 1 都是 A 队，两个人都得
		 * 在场上，所以按「场上还活着的同队车数」算 —— 同伴已阵亡时复活的这辆就回到第一个点。
		 * 首选点被同伴占着就退到下一个点，免得刚出场两辆车又叠在一起卡住。
		 */
		function spawnPoint(game, seat) {
			const points = PLAYER_SPAWNS[seat.team] || PLAYER_SPAWNS.A;
			const taken = game.players.filter((tank) => tank.team === seat.team && tank.alive).length;
			for (let step = 0; step < points.length; step += 1) {
				const point = points[(taken + step) % points.length];
				if (tankFits(game, point.x, point.y, null)) return point;
			}
			return points[taken % points.length];
		}

		function makePlayer(game, seat) {
			const spec = PLAYER_LEVELS[clamp(game.levelBySeat?.[seat.seat] ?? game.level, 0, 3)];
			const spawn = spawnPoint(game, seat);
			return {
				side: "player",
				team: seat.team,
				seat: seat.seat,
				username: seat.username,
				name: seat.name,
				kind: "player",
				x: spawn.x,
				y: spawn.y,
				dir: seat.team === "B" ? DOWN : UP,
				speed: spec.speed,
				hp: 1,
				maxHp: 1,
				alive: true,
				fireTimer: 0,
				spawning: 0,
				shield: 2200,
				treadFrame: 0,
				movedAt: 0,
				think: 0,
				role: "player",
				carrier: false,
				color: seat.seat === 0 ? spec.color : (seat.team === "B" ? "#e0725f" : "#6fc3e8")
			};
		}

		function makeEnemy(game, spawn, kind, carrier, team) {
			const spec = ENEMY_KINDS[kind] || ENEMY_KINDS.basic;
			const profile = aiProfile(game);
			// 打基地还是找玩家：同一档 AI 里也留一点分工，免得四个兵排队走同一条路。
			const toBase = Math.random() < profile.base;
			const who = team || ENEMY_TEAM;
			return {
				side: "enemy",
				team: who,
				kind,
				x: spawn.x,
				y: spawn.y,
				dir: who === "A" ? UP : DOWN,
				speed: spec.speed,
				hp: spec.hp,
				maxHp: spec.hp,
				alive: true,
				fireTimer: 400 + Math.random() * 500,
				spawning: 1100,
				shield: 0,
				treadFrame: 0,
				movedAt: 0,
				think: Math.random() * profile.think,
				role: toBase ? "base" : "player",
				carrier: Boolean(carrier),
				visited: [],
				lastBucket: null,
				stuckFor: 0,
				color: spec.color,
				// NPC 的体色按队伍染一下，一眼看出是谁的兵。
				bodyColor: who === ENEMY_TEAM ? spec.color : TEAM_COLORS[who]
			};
		}

		/** 火力升级：只涨永不降（原版死一次会掉，这里放宽，玩起来更爽）。火力按座位各算各的。 */
		function playerSpec(game, tank) {
			const seat = tank && tank.seat !== undefined ? tank.seat : 0;
			const level = game.levelBySeat && game.levelBySeat[seat] !== undefined
				? game.levelBySeat[seat]
				: game.level;
			return PLAYER_LEVELS[clamp(level, 0, 3)];
		}

		// ==================== 开火与伤害 ====================

		function countBullets(game, owner) {
			let count = 0;
			for (const bullet of game.bullets) if (bullet.owner === owner) count += 1;
			return count;
		}

		/** 能不能开火。星级决定同时挂几发，敌方一律只挂一发。 */
		function canFire(game, tank) {
			if (!tank || !tank.alive || tank.spawning > 0) return false;
			if (tank.fireTimer > 0) return false;
			const limit = tank.side === "player" ? playerSpec(game, tank).maxBullets : 1;
			return countBullets(game, tank) < limit;
		}

		function fire(game, tank) {
			if (!canFire(game, tank)) return false;
			const spec = tank.side === "player" ? playerSpec(game, tank) : (ENEMY_KINDS[tank.kind] || ENEMY_KINDS.basic);
			const d = DIRS[tank.dir];
			const size = 4;
			game.bullets.push({
				x: tank.x + TILE / 2 + d.x * (TILE / 2 - 1) - size / 2,
				y: tank.y + TILE / 2 + d.y * (TILE / 2 - 1) - size / 2,
				size,
				dir: tank.dir,
				speed: spec.bullet,
				side: tank.side,
				team: tank.team || ENEMY_TEAM,
				owner: tank,
				power: tank.side === "player" ? spec.power : 0,
				dead: false
			});
			tank.fireTimer = tank.side === "player"
				? PLAYER_FIRE_DELAY
				: (ENEMY_KINDS[tank.kind] || ENEMY_KINDS.basic).fireDelay * aiProfile(game).fireGap;
			game.events.push({ type: "fire", side: tank.side });
			return true;
		}

		function boom(game, x, y, big) {
			game.effects.push({
				kind: "boom",
				x: x + TILE / 2,
				y: y + TILE / 2,
				t: 0,
				life: big ? 460 : 260,
				big: Boolean(big)
			});
		}

		function popup(game, x, y, text) {
			game.effects.push({ kind: "text", x: x + TILE / 2, y: y, t: 0, life: 900, text });
		}

		function award(game, tank, score) {
			game.score += score;
			if (tank && tank.team === "B") game.scoreB += score;
			else game.scoreA += score;
			popup(game, tank.x, tank.y, String(score));
		}

		function damageTank(game, tank, bullet) {
			if (tank.side === "player") {
				if (tank.shield > 0 || tank.spawning > 0) return;
				killPlayer(game, tank, bullet && bullet.owner);
				return;
			}
			tank.hp -= 1;
			if (tank.hp > 0) {
				// 装甲兵挨打会换色：绿 → 黄 → 橙 → 红，一眼看出还剩几层。
				tank.color = ARMOR_COLORS[clamp(tank.maxHp - tank.hp, 0, ARMOR_COLORS.length - 1)];
				tank.bodyColor = tank.team === ENEMY_TEAM
					? tank.color
					: shade(TEAM_COLORS[tank.team] || tank.color, -(tank.maxHp - tank.hp) / (tank.maxHp + 1));
				boom(game, tank.x, tank.y, false);
				game.events.push({ type: "hit" });
				return;
			}
			killEnemy(game, tank, bullet && bullet.owner);
		}

		/**
		 * 记一次击毁。
		 *
		 * 记在坦克身上方便画面用（比如头顶飘分），但真正要留给结算的是按座位存的那一份：
		 * 坦克被毁之后就从 game.players 里被移走了，只记在坦克上会跟着一起丢。
		 */
		function creditKill(game, tank) {
			if (!tank || tank.side !== "player") return;
			tank.kills = (tank.kills || 0) + 1;
			const seat = tank.seat ?? 0;
			game.killsBySeat[seat] = (game.killsBySeat[seat] || 0) + 1;
		}

		function killEnemy(game, tank, byTank) {
			if (!tank.alive) return;
			tank.alive = false;
			const spec = ENEMY_KINDS[tank.kind] || ENEMY_KINDS.basic;
			boom(game, tank.x, tank.y, true);
			game.events.push({ type: "boom" });
			if (byTank && byTank.side === "player") {
				award(game, byTank, spec.score);
				creditKill(game, byTank);
			}
			if (tank.carrier) dropPowerup(game, tank.x, tank.y);
		}

		/** 掉一条命。seat 决定掉谁的那条命，所以两个玩家各算各的。 */
		function killPlayer(game, player, byTank) {
			if (!player || !player.alive) return;
			player.alive = false;
			boom(game, player.x, player.y, true);
			game.events.push({ type: "die" });
			const seat = player.seat ?? 0;
			// 打死对面玩家有额外奖励，鼓励对战里多找人打。
			if (byTank && byTank.side === "player" && byTank.team !== player.team) {
				award(game, byTank, 300);
				creditKill(game, byTank);
			}
			game.livesBySeat[seat] = Math.max(0, (game.livesBySeat[seat] || 0) - 1);
			game.levelBySeat[seat] = Math.max(0, (game.levelBySeat[seat] || 0) - 1);
			game.players = game.players.filter((tank) => tank !== player);
			game.player = game.players.find((tank) => tank.seat === 0) || null;
			game.lives = game.livesBySeat[0] || 0;
			if ((game.livesBySeat[seat] || 0) > 0) game.respawnTimers[seat] = 1100;
			else if (game.cfg.mode === "pvp") sideOut(game, seat);
			maybeFinish(game);
		}

		function killBase(game, base) {
			if (!base || !base.alive) return;
			base.alive = false;
			game.tiles[tileIndex(base.c, base.r)] = T.BASE_DEAD;
			boom(game, base.c * TILE, base.r * TILE, true);
			boom(game, base.c * TILE - TILE, base.r * TILE, true);
			boom(game, base.c * TILE + TILE, base.r * TILE, true);
			game.events.push({ type: "die" });
			game.baseAlive = game.bases[0] ? game.bases[0].alive : false;
			if (game.cfg.mode !== "pvp") {
				finish(game, "over");
				return;
			}
			// 对战：打掉对面基地就赢，自家基地没了就输。
			const localTeam = game.seats[0] ? game.seats[0].team : "A";
			finish(game, base.team === localTeam ? "lose" : "win");
		}

		/** 对战里某一队打光了（没命了）。 */
		function sideOut(game, seat) {
			const seatTeam = game.seats[seat] ? game.seats[seat].team : "A";
			const other = game.seats.find((s) => s.team !== seatTeam);
			if (!other) return;
			finish(game, seat === 0 ? "lose" : "win");
		}

		/** 所有座位都没命了就结束。 */
		function maybeFinish(game) {
			if (game.status !== "playing") return;
			if (game.cfg.mode === "pvp") return; // 对战由基地/团灭来判
			const anyLeft = game.livesBySeat.some((n) => (n || 0) > 0);
			if (!anyLeft && game.players.length === 0) finish(game, "over");
		}

		function finish(game, outcome) {
			if (game.status === "over" || game.status === "win") return;
			game.status = outcome === "win" ? "win" : "over";
			game.outcome = outcome;
			game.outroTimer = 0;
			game.events.push({ type: outcome === "win" ? "clear" : "over", last: true });
		}

		// ==================== 子弹推进 ====================

		function resolveBullet(game, bullet) {
			if (bullet.x < 0 || bullet.y < 0 || bullet.x + bullet.size > FIELD || bullet.y + bullet.size > FIELD) {
				bullet.dead = true;
				return;
			}
			for (const tank of [...game.enemies, ...game.players]) {
				if (!tank || !tank.alive || tank === bullet.owner || tank.spawning > 0) continue;
				// 敌对只认队伍：同队子弹打不到同队坦克（组队时不误伤，对战时才互相打得着）。
				if (tank.team === bullet.team) continue;
				if (!overlaps(bullet.x, bullet.y, tank.x, tank.y, TILE - 2)) continue;
				bullet.dead = true;
				damageTank(game, tank, bullet);
				return;
			}
			const c0 = colOf(bullet.x);
			const c1 = colOf(bullet.x + bullet.size - 0.01);
			const r0 = rowOf(bullet.y);
			const r1 = rowOf(bullet.y + bullet.size - 0.01);
			for (let r = r0; r <= r1; r += 1) {
				for (let c = c0; c <= c1; c += 1) {
					const at = tileIndex(c, r);
					const id = game.tiles[at];
					if (!BULLET_BLOCK[id]) continue;
					bullet.dead = true;
					if (id === T.BRICK) {
						game.tiles[at] = T.EMPTY;
						boom(game, c * TILE, r * TILE, false);
					} else if (id === T.STEEL) {
						// 只有玩家升到三星的子弹能打穿钢墙（原版就是这个规矩）。
						if (bullet.power >= 1) {
							game.tiles[at] = T.EMPTY;
							boom(game, c * TILE, r * TILE, false);
						} else {
							game.events.push({ type: "clank" });
						}
					} else if (id === T.BASE || id === T.BASE_DEAD) {
						const base = game.bases.find((one) => one.c === c && one.r === r);
						if (base) killBase(game, base);
					}
					return;
				}
			}
		}

		function updateBullets(game, dt) {
			const list = game.bullets.filter((bullet) => !bullet.dead);
			let farthest = 0;
			for (const bullet of list) farthest = Math.max(farthest, (bullet.speed * dt) / 1000);
			/**
			 * 把所有子弹切成同样多的小步一起走，并且每走一小步就两两判撞。
			 *
			 * 为什么必须切小步：两颗相向而行的子弹一帧的相对位移能有十几像素，而弹体只有
			 * 4px —— 一次性走完再判，它们会直接穿过去（玩家看到的就是「我的子弹从敌人子弹
			 * 里穿过去了」）。这里保证每个小步里的相对位移不超过弹体尺寸。
			 */
			const subSteps = clamp(Math.ceil(farthest), 1, 12);
			const slice = 1 / subSteps;
			for (let s = 0; s < subSteps; s += 1) {
				for (const bullet of list) {
					if (bullet.dead) continue;
					const step = ((bullet.speed * dt) / 1000) * slice;
					if (step <= 0) continue;
					bullet.x += DIRS[bullet.dir].x * step;
					bullet.y += DIRS[bullet.dir].y * step;
					resolveBullet(game, bullet);
				}
				// 子弹对撞：敌我子弹相撞双双消失，这是原版的重要防守手段。
				for (let i = 0; i < list.length; i += 1) {
					const a = list[i];
					if (a.dead) continue;
					for (let k = i + 1; k < list.length; k += 1) {
						const b = list[k];
						if (b.dead || a.team === b.team) continue;
						if (!overlaps(a.x, a.y, b.x, b.y, a.size)) continue;
						a.dead = true;
						b.dead = true;
						boom(game, a.x - TILE / 2, a.y - TILE / 2, false);
						break;
					}
				}
			}
			game.bullets = list.filter((bullet) => !bullet.dead);
		}

		// ==================== 道具 ====================

		/** 找个没有墙的格子放道具，免得掉在墙里没人捡得到。 */
		function dropPowerup(game, x, y) {
			const kind = POWERUPS[Math.floor(Math.random() * POWERUPS.length)];
			let px = clamp(Math.round(x / 8) * 8, 0, FIELD - TILE);
			let py = clamp(Math.round(y / 8) * 8, 0, FIELD - TILE);
			for (let attempt = 0; attempt < 24; attempt += 1) {
				if (!SOLID[game.tiles[tileIndex(colOf(px), rowOf(py))]]) break;
				px = Math.floor(Math.random() * (COLS - 1)) * TILE;
				py = Math.floor(Math.random() * (ROWS - 2)) * TILE;
			}
			game.powerups.push({ kind, x: px, y: py, t: 0, life: 17000 });
		}

		/** 道具效果归「吃到它的那辆车」：组队各升各的火力，对战只坑对面。 */
		function applyPowerup(game, item, picker) {
			game.events.push({ type: "powerup" });
			const seat = picker ? picker.seat : 0;
			const myTeam = picker ? picker.team : "A";
			switch (item.kind) {
				case "star":
					game.levelBySeat[seat] = Math.min(3, (game.levelBySeat[seat] || 0) + 1);
					game.level = game.levelBySeat[0] || 0;
					break;
				case "helmet":
					if (picker) picker.shield = 11000;
					break;
				case "clock":
					// 冻结的是「敌对」NPC，自家的兵不动。
					for (const enemy of game.enemies) {
						if (enemy.team !== myTeam) enemy.frozenUntil = game.clock + 8000;
					}
					game.freezeUntil = game.clock + 8000;
					break;
				case "shovel": {
					const base = game.bases.find((one) => one.team === myTeam);
					game.shovelUntil = game.clock + 17000;
					if (base) {
						for (const cell of base.guard) {
							if (cell.c < 0 || cell.r < 0 || cell.c >= COLS || cell.r >= ROWS) continue;
							game.tiles[tileIndex(cell.c, cell.r)] = T.STEEL;
						}
						base.shoveled = true;
					}
					break;
				}
				case "grenade":
					for (const enemy of [...game.enemies]) {
						if (enemy.alive && enemy.team !== myTeam) killEnemy(game, enemy, picker);
					}
					break;
				case "tank":
					game.livesBySeat[seat] = (game.livesBySeat[seat] || 0) + 1;
					game.lives = game.livesBySeat[0] || 0;
					break;
				default:
					break;
			}
			game.lastPowerup = POWERUP_NAMES[item.kind] || "";
			game.lastPowerupAt = game.clock;
		}

		function updatePowerups(game, dt) {
			const kept = [];
			for (const item of game.powerups) {
				item.t += dt;
				if (item.t > item.life) continue;
				kept.push(item);
			}
			game.powerups = kept;
			for (let i = game.powerups.length - 1; i >= 0; i -= 1) {
				const item = game.powerups[i];
				const picker = game.players.find((player) => player.alive && overlaps(item.x, item.y, player.x, player.y, TILE));
				if (!picker) continue;
				game.powerups.splice(i, 1);
				applyPowerup(game, item, picker);
			}
		}

		function updateEffects(game, dt) {
			const kept = [];
			for (const effect of game.effects) {
				effect.t += dt;
				if (effect.t < effect.life) kept.push(effect);
			}
			game.effects = kept;
		}

		// ==================== 出兵 ====================

		function updateSpawns(game, dt) {
			if (game.spawnIndex >= game.queue.length) return;
			if (game.enemies.length >= maxOnField(game)) return;
			game.spawnTimer -= dt;
			if (game.spawnTimer > 0) return;
			const entry = game.queue[game.spawnIndex];
			// 对战两队轮流出，各自从自己那侧进场；单人/组队一律是中立的 ENEMY 队。
			const team = game.cfg.mode === "pvp"
				? (game.spawnIndex % 2 === 0 ? "A" : "B")
				: ENEMY_TEAM;
			const points = SPAWN_POINTS[team] || SPAWN_POINTS.ENEMY;
			const round = game.cfg.mode === "pvp" ? Math.floor(game.spawnIndex / 2) : game.spawnIndex;
			const spawn = points[round % points.length];
			game.spawnIndex += 1;
			game.spawnTimer = 2200;
			const enemy = makeEnemy(game, spawn, entry.kind, entry.carrier, team);
			game.enemies.push(enemy);
			game.events.push({ type: "spawn" });
		}

		// ==================== 敌方 AI ====================

		/**
		 * 按地形代价算一张到各格的最短距离表。
		 * 砖墙代价高但不是不能走（可以打穿），钢墙和河是死路。
		 */
		function distanceField(game, from) {
			const total = COLS * ROWS;
			const cost = new Float64Array(total);
			for (let i = 0; i < total; i += 1) {
				const id = game.tiles[i];
				cost[i] = id === T.STEEL || id === T.WATER || id === T.BASE || id === T.BASE_DEAD
					? Infinity
					: id === T.BRICK ? 6 : 1;
			}
			const dist = new Float64Array(total).fill(Infinity);
			const seen = new Uint8Array(total);
			const start = tileIndex(from.c, from.r);
			dist[start] = 0;
			for (;;) {
				let best = -1;
				let bestValue = Infinity;
				for (let i = 0; i < total; i += 1) {
					if (!seen[i] && dist[i] < bestValue) {
						bestValue = dist[i];
						best = i;
					}
				}
				if (best < 0) break;
				seen[best] = 1;
				const c = best % COLS;
				const r = (best - c) / COLS;
				for (const d of DIRS) {
					const nc = c + d.x;
					const nr = r + d.y;
					if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
					const at = tileIndex(nc, nr);
					if (!isFinite(cost[at])) continue;
					const candidate = dist[best] + cost[at];
					if (candidate < dist[at]) dist[at] = candidate;
				}
			}
			return dist;
		}

		/** 这辆 NPC 想去哪儿：优先它认定的敌对目标——对战里就是对面那队的人和基地。 */
		function enemyTarget(game, enemy) {
			const hostileBase = game.bases.find((base) => base.team !== enemy.team && base.alive);
			const hostilePlayers = game.players.filter((tank) => tank.alive && tank.team !== enemy.team);
			const wantsBase = enemy.role === "base" || hostilePlayers.length === 0;
			if (wantsBase) {
				const base = hostileBase || game.bases[0];
				if (base) {
					return { c: base.c, r: base.r, px: centerX(base.c), py: centerY(base.r) };
				}
				return { c: colOf(enemy.x), r: rowOf(enemy.y), px: enemy.x, py: enemy.y };
			}
			// 最近的敌对玩家：两三个玩家时也只盯一个，免得来回摇摆。
			let player = hostilePlayers[0];
			let bestDistance = Math.abs(player.x - enemy.x) + Math.abs(player.y - enemy.y);
			for (const candidate of hostilePlayers) {
				const distance = Math.abs(candidate.x - enemy.x) + Math.abs(candidate.y - enemy.y);
				if (distance < bestDistance) {
					bestDistance = distance;
					player = candidate;
				}
			}
			const lead = aiProfile(game).lead;
			if (lead > 0) {
				// 预判：朝玩家正前方几格打，堵他的去路（子弹是直线飞的，只能靠站位）。
				const d = DIRS[player.dir];
				const steps = 2 + Math.round(lead * 2);
				return {
					c: colOf(clamp(player.x + d.x * steps * TILE, 0, FIELD - TILE)),
					r: rowOf(clamp(player.y + d.y * steps * TILE, 0, FIELD - TILE)),
					px: player.x + d.x * steps * TILE,
					py: player.y + d.y * steps * TILE
				};
			}
			return { c: colOf(player.x), r: rowOf(player.y), px: player.x, py: player.y };
		}

		/** 朝我飞过来的敌对子弹，用来做「闪」的判断。 */
		function incomingThreat(game, enemy) {
			for (const bullet of game.bullets) {
				if (bullet.team === enemy.team) continue;
				const d = DIRS[bullet.dir];
				if (d.y !== 0) {
					if (Math.abs(bullet.x + 2 - (enemy.x + TILE / 2)) > 10) continue;
					if (d.y > 0 ? bullet.y > enemy.y + TILE : bullet.y < enemy.y) continue;
				} else {
					if (Math.abs(bullet.y + 2 - (enemy.y + TILE / 2)) > 10) continue;
					if (d.x > 0 ? bullet.x > enemy.x + TILE : bullet.x < enemy.x) continue;
				}
				return bullet;
			}
			return null;
		}

		/** 同列/同行且朝得着，就是「对上了」。 */
		function alignedWith(tank, target) {
			const dx = target.px - tank.x;
			const dy = target.py - tank.y;
			if (Math.abs(dx) < 10) return { ok: true, dir: dy > 0 ? DOWN : UP };
			if (Math.abs(dy) < 10) return { ok: true, dir: dx > 0 ? RIGHT : LEFT };
			return { ok: false, dir: -1 };
		}

		/** 中间只隔着砖（能打穿）或空地就算通视。 */
		function lineClear(game, tank, target) {
			const from = { c: colOf(tank.x), r: rowOf(tank.y) };
			const to = { c: target.c, r: target.r };
			if (from.c !== to.c && from.r !== to.r) return false;
			const stepC = Math.sign(to.c - from.c);
			const stepR = Math.sign(to.r - from.r);
			let c = from.c;
			let r = from.r;
			let guard = 0;
			while ((c !== to.c || r !== to.r) && guard < COLS + ROWS) {
				guard += 1;
				c += stepC;
				r += stepR;
				const id = game.tiles[tileIndex(c, r)];
				if (id === T.STEEL || id === T.WATER) return false;
			}
			return true;
		}

		function enemyThink(game, enemy) {
			const profile = aiProfile(game);
			const target = enemyTarget(game, enemy);
			const from = { c: colOf(enemy.x), r: rowOf(enemy.y) };
			const field = profile.path ? distanceField(game, from) : null;
			const here = from.r * COLS + from.c;
			const threat = profile.dodge > 0 ? incomingThreat(game, enemy) : null;
			const threatDir = threat ? threat.dir : -1;
			let bestScore = -Infinity;
			const best = [];
			for (let dir = 0; dir < 4; dir += 1) {
				const d = DIRS[dir];
				const nc = from.c + d.x;
				const nr = from.r + d.y;
				if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
				const nextTile = game.tiles[tileIndex(nc, nr)];
				const passable = !SOLID[nextTile];
				let score = Math.random() * profile.random * 12;

				// 1) 朝目标推进：有寻路表就按真实地形代价，没有就用曼哈顿距离。
				if (field) {
					const thereIs = field[nr * COLS + nc];
					if (isFinite(thereIs) && isFinite(field[here])) score += (field[here] - thereIs) * 5;
					else score -= 10;
				} else {
					const before = Math.abs(from.c - target.c) + Math.abs(from.r - target.r);
					const after = Math.abs(nc - target.c) + Math.abs(nr - target.r);
					score += (before - after) * 9;
				}

				// 2) 走不过去就重罚；但砖墙可以打穿，所以不是完全禁止。
				if (!passable) score -= nextTile === T.BRICK ? 14 : 40;

				// 3) 这一走正好对上了目标，站位加分。
				const dx = target.px - enemy.x;
				const dy = target.py - enemy.y;
				if ((dir === UP && dy < 0 && Math.abs(dx) < 12)
					|| (dir === DOWN && dy > 0 && Math.abs(dx) < 12)
					|| (dir === LEFT && dx < 0 && Math.abs(dy) < 12)
					|| (dir === RIGHT && dx > 0 && Math.abs(dy) < 12)) score += 8;

				// 4) 别原地打转：刚走过的格子扣分，掉头额外扣分。
				const bucket = `${nc},${nr}`;
				if (enemy.lastBucket === bucket) score -= 3;
				if (enemy.visited.includes(bucket)) score -= 6;
				if (dir === OPPOSITE[enemy.dir]) score -= 4;

				// 5) 闪子弹：顺着来弹方向走最危险，横着走最安全。
				if (threatDir >= 0 && profile.dodge > 0) {
					if (dir === threatDir) score -= 26 * profile.dodge;
					else if (dir === OPPOSITE[threatDir]) score -= 10 * profile.dodge;
					else score += 13 * profile.dodge;
				}

				if (score > bestScore + 0.001) {
					bestScore = score;
					best.length = 0;
					best.push(dir);
				} else if (Math.abs(score - bestScore) < 0.5) {
					best.push(dir);
				}
			}
			if (best.length === 0) return;
			enemy.dir = best[Math.floor(Math.random() * best.length)];
			enemy.visited.push(`${from.c},${from.r}`);
			if (enemy.visited.length > 8) enemy.visited.shift();
			enemy.lastBucket = `${from.c},${from.r}`;
			alignPerpendicular(game, enemy, enemy.dir);
		}

		function enemyFire(game, enemy, dt) {
			const profile = aiProfile(game);
			enemy.fireTimer -= dt;
			if (enemy.fireTimer > 0) return;
			const target = enemyTarget(game, enemy);
			const aligned = alignedWith(enemy, target);
			let chance = profile.aim * (aligned.ok && aligned.dir === enemy.dir ? 1 : 0.22);
			if (aligned.ok && aligned.dir === enemy.dir && lineClear(game, enemy, target)) chance = 1;
			if (Math.random() < chance) {
				if (fire(game, enemy)) return;
				enemy.fireTimer = 120;
				return;
			}
			enemy.fireTimer = 110;
		}

		function updateEnemies(game, dt) {
			const globalFrozen = game.clock < game.freezeUntil;
			for (const enemy of game.enemies) {
				if (!enemy.alive) continue;
				if (enemy.spawning > 0) {
					enemy.spawning -= dt;
					continue;
				}
				// 冻结有两层：全局的（单人/组队吃时钟）和只冻结对面 NPC 的（对战吃时钟）。
				if (globalFrozen || (enemy.frozenUntil && game.clock < enemy.frozenUntil)) continue;
				enemy.think -= dt;
				if (enemy.think <= 0) {
					enemyThink(game, enemy);
					enemy.think = aiProfile(game).think * (0.7 + Math.random() * 0.6);
				}
				const before = { x: enemy.x, y: enemy.y };
				if (!driveTank(game, enemy, enemy.dir, (enemy.speed * dt) / 1000)) {
					// 撞墙了立刻重想，不要傻站到下一个决策点。
					enemy.think = 0;
				} else {
					enemy.treadFrame += (enemy.speed * dt) / 900;
				}
				// 卡住太久就随机换向，兜住寻路表看不出来的死锁（比如被同伴堵住）。
				if (Math.abs(enemy.x - before.x) < 0.01 && Math.abs(enemy.y - before.y) < 0.01) {
					enemy.stuckFor += dt;
					if (enemy.stuckFor > 700) {
						enemy.dir = Math.floor(Math.random() * 4);
						alignPerpendicular(game, enemy, enemy.dir);
						enemy.stuckFor = 0;
						enemy.visited.length = 0;
					}
				} else {
					enemy.stuckFor = 0;
				}
				enemyFire(game, enemy, dt);
			}
			game.enemies = game.enemies.filter((enemy) => enemy.alive);
		}

		// ==================== 玩家 ====================

		/** 所有座位一起走：单人是 1 个座位，组队/对战是 2 个。每个座位读自己的那份操作。 */
		function updatePlayers(game, dt) {
			// 阵亡的座位到点了就复活（还有命的话）。
			for (const seat of game.seats) {
				const index = seat.seat;
				const alive = game.players.some((tank) => tank.seat === index);
				if (alive) continue;
				game.respawnTimers[index] = Math.max(0, (game.respawnTimers[index] || 0) - dt);
				if (game.respawnTimers[index] > 0) continue;
				if ((game.livesBySeat[index] || 0) <= 0) continue;
				if (game.status !== "playing" && game.status !== "stageClear") continue;
				const tank = makePlayer(game, seat);
				tank.spawning = 1300;
				game.players.push(tank);
				if (index === 0) game.player = tank;
			}
			for (const player of [...game.players]) {
				updateOnePlayer(game, player, dt, game.inputs[player.seat] || { dirs: [], fire: false });
			}
		}

		function updateOnePlayer(game, player, dt, input) {
			player.fireTimer = Math.max(0, player.fireTimer - dt);
			if (player.spawning > 0) {
				player.spawning -= dt;
				return;
			}
			if (player.shield > 0) player.shield -= dt;

			const dirs = (input && input.dirs) || [];
			const wanted = dirs.length > 0 ? dirs[dirs.length - 1] : -1;
			const spec = playerSpec(game, player);
			const onIce = tileUnder(game, player) === T.ICE;

			if (wanted >= 0) {
				if (wanted !== player.dir) {
					player.dir = wanted;
					alignPerpendicular(game, player, wanted);
				}
				const glide = onIce ? 1.18 : 1;
				const moved = driveTank(game, player, wanted, (spec.speed * glide * dt) / 1000);
				if (moved) {
					player.treadFrame += (spec.speed * dt) / 800;
					player.glideDir = wanted;
					player.glideFor = onIce ? 360 : 0;
				}
			} else if (onIce && player.glideFor > 0) {
				// 冰面松手滑一段，这是冰面唯一的作用。
				player.glideFor -= dt;
				if (driveTank(game, player, player.glideDir, (spec.speed * 0.55 * dt) / 1000)) {
					player.treadFrame += (spec.speed * dt) / 1400;
				} else {
					player.glideFor = 0;
				}
			}
			if (input && input.fire) fire(game, player);
			if (player.shield < 0) player.shield = 0;
		}

		// ==================== 关卡推进 ====================

		function checkStageEnd(game) {
			if (game.status !== "playing") return;
			if (game.spawnIndex < game.queue.length || game.enemies.length > 0) return;
			if (game.cfg.mode === "pvp") {
				// 兵都打光了还没人掉基地：按分数定胜负，分一样就是平局。
				const localTeam = game.seats[0] ? game.seats[0].team : "A";
				const mine = localTeam === "A" ? game.scoreA : game.scoreB;
				const theirs = localTeam === "A" ? game.scoreB : game.scoreA;
				finish(game, mine > theirs ? "win" : mine < theirs ? "lose" : "draw");
				return;
			}
			if (game.stage >= STAGE_MAPS.length) {
				game.score += 1000;
				finish(game, "win");
				return;
			}
			game.status = "stageClear";
			game.outroTimer = 1600;
			game.events.push({ type: "clear" });
		}

		function updateShovel(game) {
			if (!game.shovelUntil || game.clock < game.shovelUntil) return;
			game.shovelUntil = 0;
			for (const base of game.bases) {
				if (!base.shoveled) continue;
				base.shoveled = false;
				for (const cell of base.guard) {
					if (cell.c < 0 || cell.r < 0 || cell.c >= COLS || cell.r >= ROWS) continue;
					if (game.tiles[tileIndex(cell.c, cell.r)] === T.STEEL) {
						game.tiles[tileIndex(cell.c, cell.r)] = T.BRICK;
					}
				}
			}
		}

		/** 一帧逻辑。dt 固定 16.67，帧率高低都不影响手感。 */
		function step(game, dt) {
			game.clock += dt;
			if (game.status === "intro") {
				game.introTimer -= dt;
				if (game.introTimer <= 0) game.status = "playing";
				return;
			}
			if (game.status === "stageClear") {
				game.outroTimer -= dt;
				if (game.outroTimer <= 0) {
					const score = game.score;
					const levels = game.levelBySeat.slice();
					loadStage(game, game.stage + 1, score);
					// 关卡之间保留火力与剩余命。
					game.levelBySeat = levels.map((value) => value || 0);
					for (const player of game.players) {
						player.speed = playerSpec(game, player).speed;
						player.spawning = 1300;
					}
				}
				return;
			}
			if (game.status !== "playing") {
				game.outroTimer += dt;
				return;
			}
			updateShovel(game);
			updatePlayers(game, dt);
			updateEnemies(game, dt);
			updateBullets(game, dt);
			updatePowerups(game, dt);
			updateEffects(game, dt);
			updateSpawns(game, dt);
			checkStageEnd(game);
		}

		// ==================== 画：地形 ====================

		function drawBrick(c, x, y) {
			c.fillStyle = "#7a3a1c";
			c.fillRect(x, y, TILE, TILE);
			c.fillStyle = "#cf6f34";
			c.fillRect(x + 1, y + 1, 6, 6);
			c.fillRect(x + 9, y + 1, 6, 6);
			c.fillRect(x + 1, y + 9, 6, 6);
			c.fillRect(x + 9, y + 9, 6, 6);
			c.fillStyle = "#e79a5f";
			c.fillRect(x + 1, y + 1, 6, 1);
			c.fillRect(x + 9, y + 9, 6, 1);
		}

		function drawSteel(c, x, y) {
			c.fillStyle = "#838d96";
			c.fillRect(x, y, TILE, TILE);
			c.fillStyle = "#c9d4dc";
			c.fillRect(x + 1, y + 1, 6, 6);
			c.fillRect(x + 9, y + 9, 6, 6);
			c.fillStyle = "#5d666e";
			c.fillRect(x + 9, y + 1, 6, 6);
			c.fillRect(x + 1, y + 9, 6, 6);
		}

		function drawWater(c, x, y, frame) {
			c.fillStyle = "#1c3f7a";
			c.fillRect(x, y, TILE, TILE);
			c.fillStyle = "#3f7fd0";
			const shift = frame ? 4 : 0;
			for (let i = 0; i < 3; i += 1) c.fillRect(x + ((i * 6 + shift) % 12), y + 2 + i * 5, 6, 2);
			c.fillStyle = "#8fc3f5";
			for (let i = 0; i < 3; i += 1) c.fillRect(x + ((i * 6 + shift) % 12), y + 2 + i * 5, 2, 2);
		}

		function drawIce(c, x, y) {
			c.fillStyle = "#bcd8ea";
			c.fillRect(x, y, TILE, TILE);
			c.fillStyle = "#e8f4fb";
			c.fillRect(x + 2, y + 2, 5, 2);
			c.fillRect(x + 9, y + 7, 5, 2);
			c.fillStyle = "#93b9d0";
			c.fillRect(x + 2, y + 11, 4, 1);
			c.fillRect(x + 11, y + 3, 3, 1);
		}

		function drawForest(c, x, y, phase) {
			c.fillStyle = "#1d5a22";
			c.fillRect(x, y, TILE, TILE);
			c.fillStyle = "#2f8f33";
			c.fillRect(x + 1, y + 1, 5, 5);
			c.fillRect(x + 9, y + 2, 6, 5);
			c.fillRect(x + 3, y + 9, 6, 6);
			c.fillRect(x + 11, y + 11, 4, 4);
			c.fillStyle = "#5fc457";
			c.fillRect(x + 2, y + 2, 2, 2);
			c.fillRect(x + 10, y + 3, 2, 2);
			c.fillRect(x + 4, y + 10, 2, 2);
			if (phase) c.fillRect(x + 12, y + 12, 2, 2);
		}

		/** 基地：一只老鹰趴在底座上。打掉之后只剩残骸。 */
		function drawBase(c, x, y, alive) {
			if (!alive) {
				c.fillStyle = "#3a3a3a";
				c.fillRect(x, y + 10, TILE, 6);
				c.fillStyle = "#8a2620";
				c.fillRect(x + 3, y + 4, 10, 7);
				c.fillStyle = "#c05046";
				c.fillRect(x + 5, y + 6, 3, 3);
				c.fillRect(x + 9, y + 8, 2, 2);
				return;
			}
			c.fillStyle = "#9aa4ad";
			c.fillRect(x, y + 12, TILE, 4);
			c.fillStyle = "#e6e8ea";
			c.fillRect(x + 6, y + 3, 4, 9);
			c.fillRect(x + 2, y + 6, 12, 3);
			c.fillRect(x + 3, y + 9, 10, 2);
			c.fillStyle = "#c9a227";
			c.fillRect(x + 7, y + 11, 2, 2);
			c.fillStyle = "#8a8f94";
			c.fillRect(x + 1, y + 5, 2, 2);
			c.fillRect(x + 13, y + 5, 2, 2);
		}

		// ==================== 画：单位 ====================

		function drawTank(c, tank) {
			const x = Math.round(tank.x);
			const y = Math.round(tank.y);
			if (tank.spawning > 0) {
				// 出生保护：闪一个星形，别让敌人从墙缝里偷袭。
				const phase = Math.floor(tank.spawning / 90) % 2;
				c.fillStyle = phase ? WHITE : "#7fd0ff";
				c.fillRect(x + 3, y + 3, 10, 10);
				c.fillStyle = BLACK;
				c.fillRect(x + 6, y + 6, 4, 4);
				c.fillStyle = phase ? WHITE : "#7fd0ff";
				c.fillRect(x + 7, y + 1, 2, 14);
				c.fillRect(x + 1, y + 7, 14, 2);
				return;
			}
			const vertical = tank.dir === UP || tank.dir === DOWN;
			const body = tank.bodyColor || tank.color || "#b6bfc7";
			const dark = shade(body, -0.42);
			const light = shade(body, 0.4);

			c.fillStyle = dark;
			if (vertical) {
				c.fillRect(x, y, 3, TILE);
				c.fillRect(x + 13, y, 3, TILE);
			} else {
				c.fillRect(x, y, TILE, 3);
				c.fillRect(x, y + 13, TILE, 3);
			}
			// 履带纹随行驶推进，两帧交替。
			c.fillStyle = light;
			const phase = Math.floor(tank.treadFrame) % 2 === 0 ? 0 : 2;
			for (let i = 0; i < TILE; i += 4) {
				const at = (i + phase) % TILE;
				if (vertical) {
					c.fillRect(x, y + at, 3, 1);
					c.fillRect(x + 13, y + at, 3, 1);
				} else {
					c.fillRect(x + at, y, 1, 3);
					c.fillRect(x + at, y + 13, 1, 3);
				}
			}

			c.fillStyle = body;
			if (vertical) c.fillRect(x + 4, y + 1, 8, 14);
			else c.fillRect(x + 1, y + 4, 14, 8);
			c.fillStyle = light;
			c.fillRect(x + 5, y + 5, 6, 2);
			c.fillStyle = dark;
			c.fillRect(x + 5, y + 9, 6, 2);

			// 炮塔与炮管
			c.fillStyle = light;
			c.fillRect(x + 5, y + 5, 6, 6);
			c.fillStyle = body;
			c.fillRect(x + 6, y + 6, 4, 4);
			const d = DIRS[tank.dir];
			c.fillStyle = dark;
			if (vertical) c.fillRect(x + 7, d.y < 0 ? y - 2 : y + 8, 2, 10);
			else c.fillRect(d.x < 0 ? x - 2 : x + 8, y + 7, 10, 2);

			if (tank.carrier) {
				// 运兵车闪白光，一眼知道打它有道具。
				if (Math.floor(tank.treadFrame * 2) % 2 === 0) {
					c.fillStyle = WHITE;
					c.fillRect(x + 6, y + 6, 4, 4);
				}
			}
			if (tank.shield > 0) {
				const on = Math.floor(tank.shield / 80) % 2 === 0;
				c.fillStyle = on ? "#7fd0ff" : WHITE;
				c.fillRect(x - 1, y - 1, 2, 2);
				c.fillRect(x + 15, y - 1, 2, 2);
				c.fillRect(x - 1, y + 15, 2, 2);
				c.fillRect(x + 15, y + 15, 2, 2);
				c.fillRect(x + 6, y - 2, 4, 1);
				c.fillRect(x + 6, y + 17, 4, 1);
				c.fillRect(x - 2, y + 6, 1, 4);
				c.fillRect(x + 17, y + 6, 1, 4);
			}
			if (tank.side === "player" && tank.seat > 0) {
				// 二号玩家的车顶加一道彩色横杠，混战里一眼分清谁是谁。
				c.fillStyle = tank.team === "B" ? "#e0725f" : "#6fc3e8";
				c.fillRect(x + 3, y - 3, 10, 1);
			}
		}

		function drawBullet(c, bullet) {
			c.fillStyle = WHITE;
			c.fillRect(Math.round(bullet.x), Math.round(bullet.y), bullet.size, bullet.size);
			c.fillStyle = "#ffe066";
			c.fillRect(Math.round(bullet.x) + 1, Math.round(bullet.y) + 1, bullet.size - 2, bullet.size - 2);
		}

		const POWERUP_GLYPHS = {
			star: (c, x, y) => {
				c.fillStyle = "#ffd23f";
				c.fillRect(x + 7, y + 1, 2, 14);
				c.fillRect(x + 1, y + 7, 14, 2);
				c.fillRect(x + 4, y + 4, 8, 8);
				c.fillStyle = "#fff3b0";
				c.fillRect(x + 7, y + 4, 2, 2);
			},
			helmet: (c, x, y) => {
				c.fillStyle = "#8fd0ff";
				c.fillRect(x + 3, y + 2, 10, 8);
				c.fillRect(x + 4, y + 10, 8, 3);
				c.fillRect(x + 6, y + 13, 4, 2);
				c.fillStyle = WHITE;
				c.fillRect(x + 5, y + 4, 6, 2);
			},
			clock: (c, x, y) => {
				c.fillStyle = WHITE;
				c.fillRect(x + 3, y + 2, 10, 12);
				c.fillRect(x + 2, y + 4, 12, 8);
				c.fillStyle = "#2b3a4a";
				c.fillRect(x + 7, y + 5, 2, 5);
				c.fillRect(x + 8, y + 9, 4, 2);
			},
			shovel: (c, x, y) => {
				c.fillStyle = "#c9d4dc";
				c.fillRect(x + 7, y + 1, 2, 8);
				c.fillRect(x + 5, y + 8, 6, 7);
				c.fillStyle = "#f0c088";
				c.fillRect(x + 6, y + 1, 4, 3);
			},
			grenade: (c, x, y) => {
				c.fillStyle = "#4a4f57";
				c.fillRect(x + 4, y + 4, 8, 10);
				c.fillRect(x + 5, y + 3, 6, 12);
				c.fillStyle = "#8c939c";
				c.fillRect(x + 6, y + 1, 4, 3);
				c.fillStyle = RED;
				c.fillRect(x + 3, y + 8, 2, 2);
			},
			tank: (c, x, y) => {
				c.fillStyle = "#8ecf7c";
				c.fillRect(x + 1, y + 6, 14, 8);
				c.fillRect(x + 6, y + 2, 4, 5);
				c.fillStyle = "#2f5f2a";
				c.fillRect(x + 1, y + 12, 14, 2);
			}
		};

		function drawPowerup(c, item) {
			const blink = Math.floor(item.t / 140) % 2 === 0;
			const x = Math.round(item.x);
			const y = Math.round(item.y);
			c.fillStyle = blink ? "#f4f4f4" : "#c9c9c9";
			c.fillRect(x, y, TILE, TILE);
			c.fillStyle = "#1d1d1d";
			c.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
			const glyph = POWERUP_GLYPHS[item.kind];
			if (glyph) glyph(c, x, y);
		}

		function drawBurst(c, cx, cy, radius, color) {
			c.fillStyle = color;
			const r = Math.max(2, Math.round(radius));
			for (let dy = -r; dy <= r; dy += 2) {
				for (let dx = -r; dx <= r; dx += 2) {
					if (dx * dx + dy * dy > r * r) continue;
					c.fillRect(Math.round(cx + dx), Math.round(cy + dy), 2, 2);
				}
			}
		}

		function drawEffect(c, effect) {
			const p = clamp(effect.t / effect.life, 0, 1);
			if (effect.kind === "boom") {
				const radius = (effect.big ? 6 : 4) + p * (effect.big ? 13 : 7);
				drawBurst(c, effect.x, effect.y, radius, p < 0.34 ? "#ffe066" : p < 0.68 ? "#f08a24" : "#c0402a");
				if (p < 0.5) drawBurst(c, effect.x, effect.y, radius * 0.45, WHITE);
			} else if (effect.kind === "text") {
				drawText(c, effect.text, Math.round(effect.x - textWidth(effect.text, 1) / 2), Math.round(effect.y - p * 12), WHITE, 1);
			}
		}

		// ==================== 画：右侧状态栏 ====================

		function drawEnemyIcon(c, x, y) {
			c.fillStyle = WHITE;
			c.fillRect(x, y + 1, 2, 4);
			c.fillRect(x + 5, y + 1, 2, 4);
			c.fillRect(x + 2, y, 3, 6);
		}

		function drawHud(c, game) {
			c.fillStyle = "#000000";
			c.fillRect(FIELD, 0, HUD_W, VIEW_H);
			c.fillStyle = "#3a3f45";
			c.fillRect(FIELD, 0, 1, VIEW_H);

			// 敌兵图标 = 还没打掉的（场上的 + 没出场的）
			let remaining = game.enemies.filter((enemy) => enemy.alive).length;
			for (let i = game.spawnIndex; i < game.queue.length; i += 1) remaining += 1;
			const show = Math.min(20, remaining);
			for (let i = 0; i < show; i += 1) {
				const col = i % 2;
				const row = Math.floor(i / 2);
				drawEnemyIcon(c, FIELD + 5 + col * 8, 6 + row * 8);
			}
			if (remaining > 20) {
				drawText(c, String(remaining), FIELD + 4, 6 + 10 * 8, WHITE, 1);
			}

			if (game.cfg.mode === "pvp") {
				// 对战：直接摆两队的比分，谁领先一眼看得出。
				drawText(c, "A", FIELD + 5, 100, TEAM_COLORS.A, 2);
				drawText(c, String(Math.max(0, game.scoreA)), FIELD + 4, 114, TEAM_COLORS.A, 1);
				drawText(c, "B", FIELD + 5, 136, TEAM_COLORS.B, 2);
				drawText(c, String(Math.max(0, game.scoreB)), FIELD + 4, 150, TEAM_COLORS.B, 1);
			} else {
				drawText(c, "IP", FIELD + 6, 100, WHITE, 1);
				drawText(c, String(Math.max(0, game.lives)), FIELD + 6, 110, WHITE, 2);
				drawText(c, "LV", FIELD + 6, 132, WHITE, 1);
				const level = game.levelBySeat[0] || 0;
				drawText(c, String(level), FIELD + 6, 142, level >= 3 ? "#ffd23f" : WHITE, 2);
			}
			drawText(c, "ST", FIELD + 6, 170, WHITE, 1);
			drawText(c, String(game.stage), FIELD + 6, 180, WHITE, 2);

			// 冻结 / 加固生效时给个小标记，免得玩家以为卡了。
			if (game.clock < game.freezeUntil) {
				const on = Math.floor(game.clock / 200) % 2 === 0;
				c.fillStyle = on ? "#8fd0ff" : "#3a5f80";
				c.fillRect(FIELD + 20, 100, 6, 6);
			}
			if (game.clock < game.shovelUntil) {
				const on = Math.floor(game.clock / 200) % 2 === 0;
				c.fillStyle = on ? "#c9d4dc" : "#5d666e";
				c.fillRect(FIELD + 20, 170, 6, 6);
			}
		}

		function drawOverlay(c, game) {
			let lines = null;
			const mode = game.cfg.mode;
			const outcome = game.outcome || (game.status === "win" ? "win" : "over");
			if (game.status === "idle") lines = [["TANK BATTLE", 1], ["PRESS START", 0]];
			else if (game.status === "intro") lines = [[`STAGE ${game.stage}`, 1]];
			else if (game.status === "stageClear") lines = [["STAGE CLEAR", 1]];
			else if (game.status === "over" || game.status === "win") {
				const localTeam = game.seats[0] ? game.seats[0].team : "A";
				if (mode === "pvp") {
					const title = outcome === "draw"
						? "DRAW"
						: (outcome === "win" ? `${TEAM_NAMES[localTeam]}` : `${TEAM_NAMES[localTeam === "A" ? "B" : "A"]}`) + " WINS";
					lines = [[title, 1], ["YOUR SCORE " + (localTeam === "A" ? game.scoreA : game.scoreB), 0]];
				} else {
					lines = outcome === "win"
						? [[mode === "coop" ? "TEAM CLEAR" : "YOU WIN", 1], ["ALL STAGES CLEAR", 0]]
						: [["GAME OVER", 1], ["BASE LOST", 0]];
				}
			}
			if (!lines) return false;
			const height = lines.length * 12 + 10;
			c.fillStyle = "rgba(0, 0, 0, 0.72)";
			c.fillRect(6, FIELD / 2 - height / 2, FIELD - 12, height);
			c.fillStyle = "#f4f4f4";
			c.fillRect(6, FIELD / 2 - height / 2, FIELD - 12, 1);
			c.fillRect(6, FIELD / 2 + height / 2 - 1, FIELD - 12, 1);
			lines.forEach((line, index) => {
				const text = line[0];
				drawText(c, text, Math.round(FIELD / 2 - textWidth(text, line[1] ? 2 : 1) / 2), Math.round(FIELD / 2 - height / 2 + 6 + index * 12), line[1] ? "#ffd23f" : WHITE, line[1] ? 2 : 1);
			});
			return true;
		}

		/** 把整局画到离屏画布上。 */
		function drawScene(c, game, now) {
			c.imageSmoothingEnabled = false;
			c.fillStyle = "#000000";
			c.fillRect(0, 0, VIEW_W, VIEW_H);

			const waterFrame = Math.floor(now / 420) % 2 === 0 ? 0 : 1;
			const forestPhase = Math.floor(now / 300) % 2 === 0;

			for (let r = 0; r < ROWS; r += 1) {
				for (let col = 0; col < COLS; col += 1) {
					const x = col * TILE;
					const y = r * TILE;
					switch (game.tiles[tileIndex(col, r)]) {
						case T.BRICK: drawBrick(c, x, y); break;
						case T.STEEL: drawSteel(c, x, y); break;
						case T.WATER: drawWater(c, x, y, waterFrame); break;
						case T.ICE: drawIce(c, x, y); break;
						default: break;
					}
				}
			}
			for (const base of game.bases) drawBase(c, base.c * TILE, base.r * TILE, base.alive);
			for (const bullet of game.bullets) drawBullet(c, bullet);
			for (const enemy of game.enemies) if (enemy.alive) drawTank(c, enemy);
			for (const player of game.players) if (player.alive) drawTank(c, player);
			// 树林画在坦克上面——原版就是钻进去看不见。
			for (let r = 0; r < ROWS; r += 1) {
				for (let col = 0; col < COLS; col += 1) {
					if (game.tiles[tileIndex(col, r)] === T.FOREST) drawForest(c, col * TILE, r * TILE, forestPhase);
				}
			}
			for (const item of game.powerups) drawPowerup(c, item);
			for (const effect of game.effects) drawEffect(c, effect);
			drawHud(c, game);
			drawOverlay(c, game);
		}

		// ==================== 音效（现场合成，不带音频文件） ====================

		function createAudio() {
			let context = null;
			let enabled = true;
			function ensure() {
				if (!enabled) return null;
				if (context) return context;
				const Ctor = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
				if (!Ctor) return null;
				try {
					context = new Ctor();
				} catch {
					context = null;
				}
				return context;
			}
			function blip(frequency, seconds, type, volume, slideTo) {
				const ac = ensure();
				if (!ac) return;
				const now = ac.currentTime;
				const osc = ac.createOscillator();
				const gain = ac.createGain();
				osc.type = type || "square";
				osc.frequency.setValueAtTime(Math.max(20, frequency), now);
				if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now + seconds);
				gain.gain.setValueAtTime(0.0001, now);
				gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume || 0.05), now + 0.008);
				gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
				osc.connect(gain);
				gain.connect(ac.destination);
				osc.start(now);
				osc.stop(now + seconds + 0.03);
			}
			return {
				setEnabled(value) {
					enabled = value !== false;
					if (!enabled && context) {
						try {
							context.close();
						} catch {
							// 关不掉就算了，下次重新建一个
						}
						context = null;
					}
				},
				resume() {
					const ac = ensure();
					if (ac && ac.state === "suspended") ac.resume().catch(() => {});
				},
				play(type) {
					switch (type) {
						case "fire": blip(760, 0.06, "square", 0.03, 300); break;
						case "enemyFire": blip(380, 0.06, "square", 0.02, 200); break;
						case "hit": blip(240, 0.07, "square", 0.035, 150); break;
						case "clank": blip(1400, 0.05, "square", 0.02, 900); break;
						case "boom": blip(170, 0.24, "sawtooth", 0.06, 40); break;
						case "spawn": blip(320, 0.12, "triangle", 0.03, 720); break;
						case "die": blip(300, 0.5, "square", 0.07, 55); break;
						case "powerup":
							blip(660, 0.08, "square", 0.05, 990);
							setTimeout(() => blip(990, 0.12, "square", 0.05, 1320), 90);
							break;
						case "clear":
							blip(520, 0.12, "square", 0.05, 660);
							setTimeout(() => blip(660, 0.12, "square", 0.05, 830), 130);
							setTimeout(() => blip(830, 0.2, "square", 0.05, 1040), 270);
							break;
						case "over":
							blip(440, 0.2, "square", 0.06, 330);
							setTimeout(() => blip(330, 0.3, "square", 0.06, 165), 210);
							setTimeout(() => blip(220, 0.6, "square", 0.06, 90), 520);
							break;
						default: break;
					}
				}
			};
		}

		// ==================== 字号与文案 ====================

		function readable(error) {
			if (error instanceof Error && error.message) return error.message;
			return String(error ?? "操作没有成功。");
		}

		/** 前端半与宿主半版本对不上时给一句能直接照做的话；对得上返回空串。 */
		function skewNote(hostVersion) {
			const value = typeof hostVersion === "string" ? hostVersion.trim() : "";
			if (value === PLUGIN_VERSION) return "";
			if (value === "") return `宿主半没有自报版本，说明它还是没带版本号的老版；本插件已更新到 v${PLUGIN_VERSION}。请完整退出应用再启动。`;
			return `前端半是 v${PLUGIN_VERSION}，宿主半是 v${value}，两者不一致；宿主半要等应用重启才会换成本版。请完整退出应用再启动。`;
		}

		async function callApi(path, body) {
			const options = body === undefined
				? { headers: { accept: "application/json" } }
				: {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify(body)
				};
			const response = await fetch(`${API}${path}`, options);
			const payload = await response.json().catch(() => null);
			if (payload === null || typeof payload !== "object") {
				throw new Error(response.status === 404
					? "宿主没有这条接口（HTTP 404）：装好或更新过插件之后，要完整退出应用再启动，宿主半才会换成新版（关掉窗口不算，从托盘退出）。"
					: `宿主没有返回可识别的数据（HTTP ${response.status}）。`);
			}
			return payload;
		}

		// ==================== 样式 ====================
		//
		// 只引用官方 --dsw-alias-* 令牌，不读别的插件的 DOM，也不往 document.body 追加东西。

		const CSS = `
.hs-tank { box-sizing: border-box; height: 100%; overflow: hidden; display: flex; flex-direction: column; gap: 10px; padding: calc(var(--dsh-frame-top-clearance, 0px) + 14px) 20px 14px; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f2329); font: 14px/1.5 var(--dsw-font-family, "Segoe UI", "Microsoft YaHei", sans-serif); }
.hs-tank * { box-sizing: border-box; }
.hs-tank ::-webkit-scrollbar { width: 6px; height: 6px; }
.hs-tank ::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, #e5e5e5); border-radius: 999px; }
.hs-tank-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex: 0 0 auto; }
.hs-tank-title { margin: 0; font-size: 18px; font-weight: 500; }
.hs-tank-sub { margin: 4px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; }
.hs-tank-chip { flex: 0 0 auto; display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; }
.hs-tank-bar { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l3, #eff0f1); border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-alias-bg-layer-1, #fff); }
.hs-tank-field { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; }
.hs-tank-field > span { white-space: nowrap; }
.hs-tank select, .hs-tank input[type=number] { height: 30px; min-width: 92px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, #e4e6eb); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-base, #fff); color: inherit; font: inherit; font-size: 13px; }
.hs-tank-check { display: inline-flex; align-items: center; gap: 6px; height: 30px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; cursor: pointer; }
.hs-tank-btn { height: 32px; padding: 0 14px; border: 1px solid var(--dsw-alias-border-l2, #e4e6eb); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.hs-tank-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, #e8eaed); }
.hs-tank-btn-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #1456f0); color: var(--dsw-alias-label-primary-foreground, #fff); }
.hs-tank-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #0f47cc); }
.hs-tank-btn-danger { color: var(--dsw-alias-label-error, #d63a3a); }
.hs-tank-btn:disabled { opacity: .45; cursor: default; }
.hs-tank-spacer { flex: 1 1 auto; }
.hs-tank-status { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; }
.hs-tank-stat { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); color: var(--dsw-alias-label-secondary, #646a73); }
.hs-tank-stat b { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 600; font-variant-numeric: tabular-nums; }
.hs-tank-message { color: var(--dsw-alias-label-secondary, #646a73); }
.hs-tank-message[data-kind=ok] { color: var(--dsw-alias-state-success-primary, #1e8e3e); }
.hs-tank-message[data-kind=error] { color: var(--dsw-alias-label-error, #d63a3a); }
.hs-tank-message[data-kind=warn] { color: var(--dsw-alias-state-warn-primary, #b7791f); }
.hs-tank-stage { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: var(--dsw-radius-lg, 12px); background: #000; border: 1px solid var(--dsw-alias-border-l3, #eff0f1); }
.hs-tank-stage[data-live=true] { border-color: var(--dsw-alias-border-l2, #e4e6eb); }
.hs-tank-canvas { display: block; image-rendering: pixelated; image-rendering: crisp-edges; }
.hs-tank-foot { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
.hs-tank-keys { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.hs-tank-key { display: inline-flex; align-items: center; gap: 4px; }
.hs-tank-kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 5px; border: 1px solid var(--dsw-alias-border-l2, #e4e6eb); border-bottom-width: 2px; border-radius: 5px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2329); font-size: 11px; }
.hs-tank-pad { display: flex; align-items: center; gap: 6px; }
.hs-tank-pad button { width: 34px; height: 34px; border: 1px solid var(--dsw-alias-border-l2, #e4e6eb); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); color: inherit; font: inherit; font-size: 15px; cursor: pointer; touch-action: none; user-select: none; }
.hs-tank-pad button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, #e8eaed); }
.hs-tank-pad button:disabled { opacity: .45; cursor: default; }
.hs-tank-pad .hs-tank-fire { width: 52px; font-size: 12px; }
.hs-tank-note { margin: 0; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; }
.hs-tank-lobby { flex: 0 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(232px, 1fr)); gap: 10px; }
.hs-tank-card { display: flex; flex-direction: column; gap: 6px; min-height: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l3, #eff0f1); border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-alias-bg-layer-1, #fff); }
.hs-tank-card h3 { margin: 0; display: flex; align-items: baseline; gap: 6px; font-size: 13px; font-weight: 600; }
.hs-tank-card h3 em { font-style: normal; font-weight: 400; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.hs-tank-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; max-height: 138px; overflow: auto; }
.hs-tank-list li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.hs-tank-list .hs-tank-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hs-tank-empty { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; }
.hs-tank-mini { height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, #e4e6eb); border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.hs-tank-mini:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, #e8eaed); }
.hs-tank-mini:disabled { opacity: .45; cursor: default; }
.hs-tank-mini-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #1456f0); color: var(--dsw-alias-label-primary-foreground, #fff); }
.hs-tank-modes { display: inline-flex; gap: 4px; padding: 3px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); }
.hs-tank-modes button { height: 26px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #646a73); font: inherit; font-size: 12px; cursor: pointer; }
.hs-tank-modes button[data-on=true] { background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f2329); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.hs-tank-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 4px; font-size: 11px; }
.hs-tank-badge[data-team=A] { background: rgba(79,157,234,.16); color: #2f6fba; }
.hs-tank-badge[data-team=B] { background: rgba(224,87,74,.16); color: #b8443a; }
`;

		// ==================== 侧栏图标 ====================

		/** 侧栏那一项的图标：一个像素坦克，和官方图标尺寸（16/18）对齐。 */
		function TanksIcon(props) {
			const size = Number(props && props.size) || 18;
			return h("svg", {
				"aria-hidden": "true",
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				style: { display: "block" }
			}, [
				h("rect", { key: "t1", x: 0, y: 3, width: 3, height: 10, fill: "#4a7d3a" }),
				h("rect", { key: "t2", x: 13, y: 3, width: 3, height: 10, fill: "#4a7d3a" }),
				h("rect", { key: "b1", x: 3, y: 4, width: 10, height: 8, fill: "#6b8f23" }),
				h("rect", { key: "b2", x: 5, y: 5, width: 6, height: 6, fill: "#8fbe2f" }),
				h("rect", { key: "c1", x: 7, y: 0, width: 2, height: 7, fill: "#3a5f2e" }),
				h("rect", { key: "w1", x: 1, y: 7, width: 1, height: 2, fill: "#cfe0a0" }),
				h("rect", { key: "w2", x: 14, y: 7, width: 1, height: 2, fill: "#cfe0a0" })
			]);
		}

		// ==================== 页面 ====================

		function TanksPage() {
			const [hostVersion, setHostVersion] = React.useState("");
			const [phase, setPhase] = React.useState("idle");
			const [options, setOptions] = React.useState({
				mode: "solo",
				ai: "veteran",
				enemyCount: 20,
				lives: 3,
				stage: 1,
				sound: true
			});
			const [hud, setHud] = React.useState({ score: 0, stage: 1, lives: 3, level: 0, remaining: 20, scoreA: 0, scoreB: 0 });
			const [stats, setStats] = React.useState(null);
			const [message, setMessage] = React.useState("选好模式与敌方 AI，点「开始游戏」。方向键移动，空格开火。");
			const [tone, setTone] = React.useState("");
			const [scale, setScale] = React.useState(3);
			const [identity, setIdentity] = React.useState({ username: "", nickname: "", saved: false });
			const [lobby, setLobby] = React.useState({ online: [], invites: [], rooms: [], board: [] });
			const [room, setRoom] = React.useState(null);
			const [busy, setBusy] = React.useState("");

			const stageRef = React.useRef(null);
			const canvasRef = React.useRef(null);
			const offRef = React.useRef(null);
			const gameRef = React.useRef(null);
			const rafRef = React.useRef(0);
			const lastRef = React.useRef(0);
			const accRef = React.useRef(0);
			const aliveRef = React.useRef(false);
			const inputRef = React.useRef({ dirs: [], fire: false });
			const audioRef = React.useRef(null);
			const optionsRef = React.useRef(options);
			const reportedRef = React.useRef(false);
			const hudSigRef = React.useRef("");
			const phaseRef = React.useRef("idle");
			const identityRef = React.useRef(identity);
			const roomRef = React.useRef(null);
			/** 多人联机的定时器与游标：role 是 host / guest，seq 是客人已收到的画面序号。 */
			const netRef = React.useRef({ role: null, timers: [], seq: 0 });

			React.useEffect(() => {
				identityRef.current = identity;
			}, [identity]);
			React.useEffect(() => {
				roomRef.current = room;
			}, [room]);

			const whoami = () => identityRef.current.username || "";
			const displayName = () => identityRef.current.nickname || whoami() || "我";

			/** 定时器包一层：测试用的假 window 没有 setInterval，那里就退化成不轮询。 */
			function every(ms, fn) {
				if (typeof window.setInterval === "function") {
					const id = window.setInterval(fn, ms);
					return () => window.clearInterval(id);
				}
				return () => {};
			}

			const DIR_CHARS = ["U", "R", "D", "L"];
			const dirsToString = (dirs) => (dirs || []).map((dir) => DIR_CHARS[dir] || "").join("");
			const dirsFromString = (text) => String(text || "").split("").map((ch) => DIR_CHARS.indexOf(ch)).filter((dir) => dir >= 0);

			function audio() {
				if (!audioRef.current) audioRef.current = createAudio();
				return audioRef.current;
			}

			function applyScale() {
				const node = stageRef.current;
				if (!node) return 3;
				const rect = node.getBoundingClientRect();
				if (rect.width < 40 || rect.height < 40) return scale;
				return clamp(Math.floor(Math.min((rect.width - 8) / VIEW_W, (rect.height - 8) / VIEW_H)), 1, 8);
			}

			function offscreen() {
				if (offRef.current) return offRef.current;
				const canvas = document.createElement("canvas");
				canvas.width = VIEW_W;
				canvas.height = VIEW_H;
				offRef.current = canvas;
				return canvas;
			}

			function patchOptions(patch) {
				const merged = { ...optionsRef.current, ...patch };
				optionsRef.current = merged;
				setOptions(merged);
				return merged;
			}

			function blit() {
				const canvas = canvasRef.current;
				if (!canvas) return;
				const ctx = canvas.getContext("2d");
				ctx.imageSmoothingEnabled = false;
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				ctx.drawImage(offscreen(), 0, 0, VIEW_W, VIEW_H, 0, 0, canvas.width, canvas.height);
			}

			function drawPauseBanner() {
				const ctx = offscreen().getContext("2d");
				ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
				ctx.fillRect(6, FIELD / 2 - 14, FIELD - 12, 28);
				drawText(ctx, "PAUSE", Math.round(FIELD / 2 - textWidth("PAUSE", 2) / 2), FIELD / 2 - 6, WHITE, 2);
			}

			/** 没开局时也画一张静态战场，让人先看到这一关长什么样。 */
			function drawIdle() {
				const opts = optionsRef.current;
				const seats = opts.mode === "solo"
					? [{ seat: 0, team: "A", name: "P1" }]
					: [{ seat: 0, team: "A", name: "P1" }, { seat: 1, team: opts.mode === "pvp" ? "B" : "A", name: "P2" }];
				const preview = createGame({ ...opts, seats });
				preview.players = [];
				preview.enemies = [];
				preview.bullets = [];
				preview.powerups = [];
				preview.effects = [];
				preview.status = "idle";
				drawScene(offscreen().getContext("2d"), preview, Date.now());
				blit();
			}

			function render(game, now) {
				drawScene(offscreen().getContext("2d"), game, now);
				if (phaseRef.current === "paused") drawPauseBanner();
				blit();
			}

			function publish(game) {
				const next = {
					score: game.score,
					stage: game.stage,
					lives: Math.max(0, game.livesBySeat[0] || 0),
					level: game.levelBySeat[0] || 0,
					remaining: game.enemies.filter((enemy) => enemy.alive).length + (game.queue.length - game.spawnIndex),
					scoreA: game.scoreA,
					scoreB: game.scoreB
				};
				const signature = `${next.score}|${next.stage}|${next.lives}|${next.level}|${next.remaining}|${next.scoreA}|${next.scoreB}`;
				if (signature === hudSigRef.current) return;
				hudSigRef.current = signature;
				setHud(next);
			}

			function halt() {
				aliveRef.current = false;
				if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
				rafRef.current = 0;
			}

			function stopNet() {
				for (const off of netRef.current.timers) {
					try {
						off();
					} catch {
						// 定时器已经停了就算了
					}
				}
				netRef.current = { role: null, timers: [], seq: 0 };
			}

			/** 本局结果：本地战绩照旧落盘，服务端积分另走后台服务。 */
			/**
			 * 一局结束后的两件收尾事：写本机战绩、把结果交给后台服务算积分。
			 *
			 * 多人房里由**房主**把两边一起上报：房主手里才有权威的分与击杀数，
			 * 两边各报一次会让服务端重复计分（客人那边连自己的击杀数都是 0）。
			 */
			async function reportResult(game) {
				const me = whoami();
				const myTeam = game.seats[0] ? game.seats[0].team : "A";
				const myScore = game.cfg.mode === "pvp"
					? (myTeam === "A" ? game.scoreA : game.scoreB)
					: game.score;
				const outcome = game.outcome || (game.status === "win" ? "win" : "over");
				try {
					const payload = await callApi("/record", {
						score: myScore,
						stage: game.stage,
						level: game.levelBySeat[0] || 0,
						ai: game.cfg.ai,
						outcome
					});
					if (payload.hostVersion) setHostVersion(payload.hostVersion);
					if (payload.ok && payload.stats) setStats(payload.stats);
				} catch {
					// 本地战绩写不进去只是少一条记录，不影响这一局。
				}

				const active = roomRef.current;
				if (!me || (active && active.host && active.host !== whoami())) return;

				// 对战里两边的胜负是相反的，不能都写同一个 outcome。
				const flip = (side) => (outcome === "draw" ? "draw" : side === "win" ? "lose" : "win");
				const results = game.seats.map((seat) => ({
					username: seat.username || (seat.seat === 0 ? me : ""),
					nickname: seat.name || seat.username || me,
					team: seat.team,
					score: game.cfg.mode === "pvp" ? (seat.team === "A" ? game.scoreA : game.scoreB) : game.score,
					kills: game.killsBySeat[seat.seat] || 0,
					outcome: game.cfg.mode === "pvp" && seat.team !== myTeam ? flip(outcome) : outcome
				})).filter((row) => row.username);

				try {
					const payload = await callApi("/api/match/report", {
						room: (active && active.id) || "",
						mode: game.cfg.mode,
						outcome,
						results
					});
					if (payload.ok && payload.deltas && payload.deltas[me]) {
						const got = payload.deltas[me];
						setMessage(`本局 ${outcome === "win" ? "获胜" : outcome === "draw" ? "打平" : "结束"}：本局得 ${myScore} 分，积分 +${got.delta}，累计 ${got.user.score}（第 ${got.rank} 名）。`);
						setTone(outcome === "win" ? "ok" : "");
					}
				} catch {
					// 服务端记不上就只当没有排名，不影响结算画面。
				}
			}

			function drain(game) {
				if (game.events.length === 0) return;
				const sound = audio();
				for (const event of game.events) {
					if (event.type === "fire") sound.play(event.side === "player" ? "fire" : "enemyFire");
					else sound.play(event.type);
					if (event.type === "powerup") {
						setMessage(`捡到道具：${game.lastPowerup || "未知"}`);
						setTone("ok");
					} else if (event.type === "clear" && !event.last) {
						setMessage(`第 ${game.stage} 关通过！`);
						setTone("ok");
					} else if (event.type === "over") {
						setMessage(game.cfg.mode === "pvp" ? "本局结束。" : "基地被摧毁，本局结束。");
						setTone("error");
					} else if (event.type === "clear" && event.last) {
						setMessage("四个关卡全部通过，通关！");
						setTone("ok");
					}
				}
				game.events.length = 0;
			}

			function frame(now) {
				if (!aliveRef.current) return;
				rafRef.current = window.requestAnimationFrame(frame);
				const game = gameRef.current;
				if (!game) return;
				const delta = lastRef.current === 0 ? STEP : Math.min(50, now - lastRef.current);
				lastRef.current = now;
				// 客人不跑逻辑：画面由房主发来的快照填，自己只负责画和上传按键。
				if (phaseRef.current !== "paused" && netRef.current.role !== "guest") {
					accRef.current += delta;
					let guard = 0;
					while (accRef.current >= STEP && guard < 8) {
						step(game, STEP);
						accRef.current -= STEP;
						guard += 1;
					}
					if (accRef.current > STEP * 8) accRef.current = 0;
					drain(game);
				}
				render(game, now);
				publish(game);
				if ((game.status === "over" || game.status === "win") && !reportedRef.current) {
					reportedRef.current = true;
					phaseRef.current = game.status;
					setPhase(game.status);
					stopNet();
					void reportResult(game);
					halt();
				}
			}

			/** 房主侧联机：把客人的按键取回来喂进引擎，再把画面发出去。 */
			async function hostNet() {
				const game = gameRef.current;
				const active = roomRef.current;
				if (!game || !active) return;
				try {
					const payload = await callApi(`/api/room/inputs?room=${encodeURIComponent(active.id)}`);
					const inputs = (payload && payload.inputs) || {};
					for (const seat of game.seats) {
						if (seat.seat === 0) continue;
						const got = inputs[String(seat.seat)];
						if (got) game.inputs[seat.seat] = { dirs: dirsFromString(got.dirs), fire: Boolean(got.fire) };
					}
				} catch {
					// 取不到就当作对面没按键
				}
				try {
					await callApi("/api/room/state", {
						room: active.id,
						user: whoami(),
						state: serializeGame(game),
						gameStatus: game.status
					});
				} catch {
					// 推不上去就等下一拍
				}
			}

			/** 客人侧联机：上传自己的按键，拉房主的画面。 */
			async function guestNet() {
				const game = gameRef.current;
				const active = roomRef.current;
				if (!game || !active) return;
				try {
					await callApi("/api/room/input", {
						room: active.id,
						user: whoami(),
						dirs: dirsToString(inputRef.current.dirs),
						fire: inputRef.current.fire
					});
				} catch {
					// 传不上去就等下一拍
				}
				try {
					const payload = await callApi(`/api/room/state?room=${encodeURIComponent(active.id)}&since=${netRef.current.seq}`);
					if (payload && payload.ok && !payload.stale && payload.state) {
						netRef.current.seq = payload.seq;
						applySnapshot(game, payload.state);
					}
				} catch {
					// 拉不到就保持上一帧
				}
			}

			function startNet(game) {
				stopNet();
				const active = roomRef.current;
				if (!active || optionsRef.current.mode === "solo") return;
				const isHost = active.host === whoami();
				netRef.current.role = isHost ? "host" : "guest";
				netRef.current.seq = 0;
				netRef.current.timers.push(every(isHost ? 60 : 50, isHost ? hostNet : guestNet));
				setMessage(isHost
					? `你是房主（${whoami()}），这一局的画面由你这边算，等着对面的按键就行。`
					: `你是客人（${whoami()}），画面跟着房主走，操作会实时传过去。`);
				setTone("");
			}

			/**
			 * 排出这一局的座位表。座位 0 是本机，规则都在 orderSeats 里。
			 */
			const seatsFor = (mode, active) => {
				const list = active && Array.isArray(active.members) ? active.members : [];
				const ordered = orderSeats(list, whoami());
				if (ordered.length) {
					return ordered.map((member, index) => ({
						seat: index,
						team: member.team || (mode === "pvp" && index === 1 ? "B" : "A"),
						username: member.username,
						name: member.nickname || member.username
					}));
				}
				if (mode === "solo") return [{ seat: 0, team: "A", username: whoami(), name: displayName() }];
				return [
					{ seat: 0, team: "A", username: whoami(), name: displayName() },
					{ seat: 1, team: mode === "pvp" ? "B" : "A", username: "", name: "P2" }
				];
			};

			const start = () => {
				const opts = optionsRef.current;
				audio().resume();
				audio().setEnabled(opts.sound);
				halt();
				const game = createGame({ ...opts, seats: seatsFor(opts.mode, roomRef.current) });
				game.inputs[0] = inputRef.current;
				inputRef.current.dirs.length = 0;
				inputRef.current.fire = false;
				gameRef.current = game;
				reportedRef.current = false;
				hudSigRef.current = "";
				lastRef.current = 0;
				accRef.current = 0;
				aliveRef.current = true;
				phaseRef.current = "playing";
				setPhase("playing");
				publish(game);
				startNet(game);
				if (optionsRef.current.mode === "solo") {
					setMessage(`第 ${game.stage} 关开始 · 敌方 AI：${AI_PROFILES[game.cfg.ai].label}（${AI_PROFILES[game.cfg.ai].help}）`);
					setTone("");
				}
				rafRef.current = window.requestAnimationFrame(frame);
			};

			const endRound = () => {
				halt();
				stopNet();
				gameRef.current = null;
				inputRef.current.dirs.length = 0;
				inputRef.current.fire = false;
				phaseRef.current = "idle";
				setPhase("idle");
				hudSigRef.current = "";
				setHud({ score: 0, stage: optionsRef.current.stage, lives: optionsRef.current.lives, level: 0, remaining: optionsRef.current.enemyCount, scoreA: 0, scoreB: 0 });
				setMessage("本局已结束。改完设置可以再开一局。");
				setTone("");
				drawIdle();
			};

			const togglePause = () => {
				if (phaseRef.current === "playing") {
					phaseRef.current = "paused";
					setPhase("paused");
					inputRef.current.dirs.length = 0;
					inputRef.current.fire = false;
					setMessage("已暂停。点「继续」或再按一次 Esc / P 接着打。");
					setTone("warn");
				} else if (phaseRef.current === "paused") {
					phaseRef.current = "playing";
					setPhase("playing");
					lastRef.current = 0;
					setMessage("继续。");
					setTone("");
				}
			};

			// ---------- 大厅动作 ----------

			const invite = async (target, mode) => {
				if (!whoami()) {
					setMessage("还没拿到本机身份，稍等一下再试；联机要用它认人。");
					setTone("warn");
					return;
				}
				setBusy(`invite:${target}`);
				try {
					const payload = await callApi("/api/invite", {
						from: whoami(), fromName: displayName(), to: target, mode,
						aiCount: optionsRef.current.enemyCount, aiLevel: optionsRef.current.ai
					});
					setMessage(payload.ok ? `已邀请 ${target}（${MODE_LABELS[mode]}）。` : payload.message || "邀请失败。");
					setTone(payload.ok ? "ok" : "error");
				} catch (error) {
					setMessage(readable(error));
					setTone("error");
				}
				setBusy("");
			};

			const respond = async (id, accept) => {
				setBusy(`invite:${id}`);
				try {
					const payload = await callApi("/api/invite/respond", { id, user: whoami(), nickname: displayName(), accept });
					if (payload.ok && payload.accepted && payload.room) {
						setRoom(payload.room);
						patchOptions({ mode: payload.room.mode, enemyCount: payload.room.aiCount, ai: payload.room.aiLevel });
						setMessage(`已加入 ${payload.room.host} 的房间（${MODE_LABELS[payload.room.mode]}）。点「开始游戏」开打。`);
						setTone("ok");
					} else {
						setMessage(payload.message || (accept ? "接受失败。" : "已拒绝。"));
						setTone(accept ? "error" : "");
					}
				} catch (error) {
					setMessage(readable(error));
					setTone("error");
				}
				setBusy("");
			};

			const createRoom = async (mode) => {
				if (!whoami()) {
					setMessage("还没拿到本机身份，稍等一下再试；联机要用它认人。");
					setTone("warn");
					return;
				}
				setBusy("room");
				try {
					const payload = await callApi("/api/room", {
						host: whoami(), nickname: displayName(), mode,
						aiCount: optionsRef.current.enemyCount, aiLevel: optionsRef.current.ai
					});
					if (payload.ok && payload.room) {
						setRoom(payload.room);
						patchOptions({ mode });
						setMessage(`开好了 ${MODE_LABELS[mode]} 的房间 ${payload.room.id}，把房间号或邀请发给队友。`);
						setTone("ok");
					} else {
						setMessage(payload.message || "开房失败。");
						setTone("error");
					}
				} catch (error) {
					setMessage(readable(error));
					setTone("error");
				}
				setBusy("");
			};

			const joinRoom = async (id) => {
				if (!whoami()) {
					setMessage("还没拿到本机身份，稍等一下再试。");
					setTone("warn");
					return;
				}
				setBusy(`room:${id}`);
				try {
					const payload = await callApi("/api/room/join", { room: id, user: whoami(), nickname: displayName() });
					if (payload.ok && payload.room) {
						setRoom(payload.room);
						patchOptions({ mode: payload.room.mode, enemyCount: payload.room.aiCount, ai: payload.room.aiLevel });
						setMessage(`已加入房间 ${id}（${MODE_LABELS[payload.room.mode]}）。`);
						setTone("ok");
					} else {
						setMessage(payload.message || "加入失败。");
						setTone("error");
					}
				} catch (error) {
					setMessage(readable(error));
					setTone("error");
				}
				setBusy("");
			};

			const leaveRoom = async () => {
				const active = roomRef.current;
				setRoom(null);
				stopNet();
				if (active && whoami()) {
					try {
						await callApi("/api/room/leave", { room: active.id, user: whoami() });
					} catch {
						// 退房失败不影响本地
					}
				}
				setMessage("已退出房间。");
				setTone("");
			};

			// 首屏：问宿主半要默认设置、本机身份与战绩。读不到也不挡着打游戏。
			React.useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const payload = await callApi("/ping");
						if (!alive) return;
						setHostVersion(payload.hostVersion || "");
						if (payload.ok && payload.config) {
							const cfg = payload.config;
							patchOptions({
								ai: AI_PROFILES[cfg.defaultAi] ? cfg.defaultAi : optionsRef.current.ai,
								enemyCount: Number(cfg.enemyCount) || optionsRef.current.enemyCount,
								lives: Number(cfg.lives) || optionsRef.current.lives,
								sound: cfg.sound !== false
							});
						}
					} catch (error) {
						if (alive) {
							setMessage(readable(error));
							setTone("error");
						}
					}
					try {
						const payload = await callApi("/identity");
						if (alive && payload && payload.ok) {
							setIdentity({
								username: payload.username || "",
								nickname: payload.nickname || "",
								signedIn: Boolean(payload.signedIn),
								source: payload.source || "",
								message: payload.message || ""
							});
						}
					} catch {
						// 身份读不到只影响联机，不影响单人玩
					}
					try {
						const payload = await callApi("/stats");
						if (alive && payload.ok) setStats(payload.stats);
					} catch {
						// 战绩读不到就当没有
					}
				})();
				return () => {
					alive = false;
				};
			}, []);

			// 大厅轮询：在线的人、给我的邀请、公开房间、排行榜。
			React.useEffect(() => {
				let alive = true;
				const tick = async () => {
					const me = whoami();
					try {
						const [online, invites, rooms, board] = await Promise.all([
							callApi(`/api/online?user=${encodeURIComponent(me)}`),
							callApi(`/api/invites?user=${encodeURIComponent(me)}`),
							callApi("/api/rooms"),
							callApi("/api/leaderboard?limit=10")
						]);
						if (!alive) return;
						setLobby({
							online: (online && online.online) || [],
							invites: (invites && invites.invites) || [],
							rooms: (rooms && rooms.rooms) || [],
							board: (board && board.rows) || []
						});
					} catch {
						// 后台服务没起来时大厅就是空的，不打扰玩家
					}
				};
				tick();
				const stop = every(4000, tick);
				return () => {
					alive = false;
					stop();
				};
			}, [identity.username]);

			// 心跳：让后台知道我在线。
			React.useEffect(() => {
				const me = whoami();
				if (!me) return undefined;
				const beat = () => {
					void callApi("/api/heartbeat", {
						username: me,
						nickname: displayName(),
						status: phaseRef.current === "playing" || phaseRef.current === "paused" ? "playing" : "lobby",
						room: (roomRef.current && roomRef.current.id) || ""
					}).catch(() => {});
				};
				beat();
				return every(5000, beat);
			}, [identity.username, room]);

			// 画布尺寸：按容器算整数倍，只放大不缩小到糊。
			React.useEffect(() => {
				const node = stageRef.current;
				if (!node) return;
				const sync = () => {
					const rect = node.getBoundingClientRect();
					if (rect.width < 40 || rect.height < 40) return;
					const next = clamp(Math.floor(Math.min((rect.width - 8) / VIEW_W, (rect.height - 8) / VIEW_H)), 1, 8);
					setScale((prev) => (prev === next ? prev : next));
				};
				sync();
				if (typeof ResizeObserver === "function") {
					const observer = new ResizeObserver(sync);
					observer.observe(node);
					return () => observer.disconnect();
				}
				window.addEventListener("resize", sync);
				return () => window.removeEventListener("resize", sync);
			}, []);

			React.useEffect(() => {
				const canvas = canvasRef.current;
				if (!canvas) return;
				const dpr = Math.min(3, window.devicePixelRatio || 1);
				canvas.width = Math.round(VIEW_W * scale * dpr);
				canvas.height = Math.round(VIEW_H * scale * dpr);
				canvas.style.width = `${VIEW_W * scale}px`;
				canvas.style.height = `${VIEW_H * scale}px`;
				const game = gameRef.current;
				if (game) render(game, Date.now());
				else drawIdle();
			}, [scale]);

			// 改设置时顺手把预览刷新一遍。
			React.useEffect(() => {
				if (phaseRef.current === "idle") drawIdle();
			}, [options.ai, options.enemyCount, options.lives, options.stage, options.mode]);

			// 键位：只在开着游戏的那一屏接管，输入框里打字不受影响。
			React.useEffect(() => {
				const keyDir = {
					arrowup: UP, w: UP, arrowdown: DOWN, s: DOWN, arrowleft: LEFT, a: LEFT, arrowright: RIGHT, d: RIGHT
				};
				const typing = (target) => {
					const tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
					return tag === "input" || tag === "textarea" || tag === "select" || Boolean(target && target.isContentEditable);
				};
				const release = (dir) => {
					const at = inputRef.current.dirs.indexOf(dir);
					if (at !== -1) inputRef.current.dirs.splice(at, 1);
				};
				const onKeyDown = (event) => {
					const current = phaseRef.current;
					if (current !== "playing" && current !== "paused") return;
					if (event.altKey || event.ctrlKey || event.metaKey) return;
					if (typing(event.target)) return;
					const key = String(event.key || "").toLowerCase();
					if (key === "escape" || key === "p") {
						event.preventDefault();
						togglePause();
						return;
					}
					const dir = keyDir[key];
					if (dir !== undefined) {
						event.preventDefault();
						if (!inputRef.current.dirs.includes(dir)) inputRef.current.dirs.push(dir);
						return;
					}
					if (key === " " || key === "spacebar" || key === "j" || key === "enter") {
						event.preventDefault();
						inputRef.current.fire = true;
					}
				};
				const onKeyUp = (event) => {
					const key = String(event.key || "").toLowerCase();
					const dir = keyDir[key];
					if (dir !== undefined) release(dir);
					if (key === " " || key === "spacebar" || key === "j" || key === "enter") inputRef.current.fire = false;
				};
				const onBlur = () => {
					inputRef.current.dirs.length = 0;
					inputRef.current.fire = false;
				};
				window.addEventListener("keydown", onKeyDown);
				window.addEventListener("keyup", onKeyUp);
				window.addEventListener("blur", onBlur);
				return () => {
					window.removeEventListener("keydown", onKeyDown);
					window.removeEventListener("keyup", onKeyUp);
					window.removeEventListener("blur", onBlur);
				};
			}, []);

			// 离开这一页就收干净，不留计时器也不留声音。
			React.useEffect(() => () => {
				halt();
				stopNet();
				gameRef.current = null;
				if (audioRef.current) audioRef.current.setEnabled(false);
			}, []);

			const running = phase === "playing" || phase === "paused";
			const finished = phase === "over" || phase === "win";

			const hold = (dir) => ({
				onPointerDown: (event) => {
					event.preventDefault();
					if (!inputRef.current.dirs.includes(dir)) inputRef.current.dirs.push(dir);
				},
				onPointerUp: () => {
					const at = inputRef.current.dirs.indexOf(dir);
					if (at !== -1) inputRef.current.dirs.splice(at, 1);
				},
				onPointerCancel: () => {
					const at = inputRef.current.dirs.indexOf(dir);
					if (at !== -1) inputRef.current.dirs.splice(at, 1);
				},
				onPointerLeave: () => {
					const at = inputRef.current.dirs.indexOf(dir);
					if (at !== -1) inputRef.current.dirs.splice(at, 1);
				}
			});

			const selectField = (label, value, items, onChange) => h("label", { className: "hs-tank-field", key: label }, [
				h("span", null, label),
				h("select", { value, onChange: (event) => onChange(event.target.value) },
					items.map((item) => h("option", { key: String(item[0]), value: String(item[0]) }, item[1])))
			]);

			// ---------- 大厅 ----------

			const others = lobby.online.filter((row) => row.username !== whoami());
			// 登录了就把显示名和账号一起写出来（大括号里那串是账号 ID，方便对榜）；
			// 游客只写显示名，那串 guest-xxxx 没必要摆给玩家看。
			const identityName = identity.signedIn
				? `${identity.nickname || "DeepSeek 账号"}（${identity.username}）`
				: identity.nickname || identity.username || "";
			const lobbyView = phase !== "idle" ? null : h("div", { className: "hs-tank-lobby", key: "lobby" }, [
				h("div", { className: "hs-tank-card", key: "me" }, [
					h("h3", null, ["我的身份", h("em", null, identity.signedIn ? "DeepSeek 账号" : identity.username ? "游客" : "未取到")]),
					h("p", { className: "hs-tank-note" }, identityName || "还没拿到本机身份，联机功能暂时不可用；单人照常玩。"),
					identity.message ? h("p", { className: "hs-tank-note" }, identity.message) : null,
					stats ? h("p", { className: "hs-tank-note" }, `本地战绩：最高分 ${stats.bestScore} · 最高第 ${stats.bestStage} 关 · ${stats.plays} 局 · 通关 ${stats.wins} 次`) : null
				]),
				h("div", { className: "hs-tank-card", key: "online" }, [
					h("h3", null, ["在线的人", h("em", null, `${others.length} 人`)]),
					others.length === 0
						? h("p", { className: "hs-tank-empty" }, "暂时没别人在线。")
						: h("ul", { className: "hs-tank-list" }, others.slice(0, 12).map((row) => h("li", { key: row.username }, [
							h("span", { className: "hs-tank-name" }, `${row.nickname || row.username}${row.status === "playing" ? " · 对局中" : ""}`),
							h("button", { type: "button", className: "hs-tank-mini", disabled: running || Boolean(busy), onClick: () => invite(row.username, "coop") }, "组队"),
							h("button", { type: "button", className: "hs-tank-mini", disabled: running || Boolean(busy), onClick: () => invite(row.username, "pvp") }, "对战")
						])))
				]),
				h("div", { className: "hs-tank-card", key: "invites" }, [
					h("h3", null, ["收到的邀请", h("em", null, `${lobby.invites.length} 条`)]),
					lobby.invites.length === 0
						? h("p", { className: "hs-tank-empty" }, "没有新邀请。")
						: h("ul", { className: "hs-tank-list" }, lobby.invites.slice(0, 8).map((row) => h("li", { key: row.id }, [
							h("span", { className: "hs-tank-name" }, `${row.fromName} 邀你${MODE_LABELS[row.mode] || row.mode}`),
							h("button", { type: "button", className: "hs-tank-mini hs-tank-mini-primary", disabled: running || Boolean(busy), onClick: () => respond(row.id, true) }, "接受"),
							h("button", { type: "button", className: "hs-tank-mini", disabled: running || Boolean(busy), onClick: () => respond(row.id, false) }, "拒绝")
						])))
				]),
				h("div", { className: "hs-tank-card", key: "rooms" }, [
					h("h3", null, ["公开房间", h("em", null, `${lobby.rooms.length} 间`)]),
					h("div", { className: "hs-tank-list" }, [
						h("div", { key: "create", style: { display: "flex", gap: "6px", flexWrap: "wrap" } }, [
							h("button", { type: "button", className: "hs-tank-mini hs-tank-mini-primary", disabled: running || Boolean(busy), onClick: () => createRoom("coop") }, "开组队房"),
							h("button", { type: "button", className: "hs-tank-mini", disabled: running || Boolean(busy), onClick: () => createRoom("pvp") }, "开对战房"),
							room ? h("button", { type: "button", className: "hs-tank-mini", onClick: leaveRoom }, "退出房间") : null
						]),
						room ? h("p", { className: "hs-tank-note" }, `当前房间 ${room.id} · ${MODE_LABELS[room.mode]} · ${room.members.length} 人：${room.members.map((m) => m.nickname || m.username).join(" / ")}`) : null,
						lobby.rooms.length === 0
							? h("p", { className: "hs-tank-empty" }, "暂时没有别人开的房。")
							: h("ul", { className: "hs-tank-list" }, lobby.rooms.slice(0, 8).map((row) => h("li", { key: row.id }, [
								h("span", { className: "hs-tank-name" }, `${row.host} · ${MODE_LABELS[row.mode]} · ${row.members} 人`),
								h("button", { type: "button", className: "hs-tank-mini", disabled: running || Boolean(busy) || row.members >= 2, onClick: () => joinRoom(row.id) }, row.members >= 2 ? "满" : "加入")
							])))
					])
				]),
				h("div", { className: "hs-tank-card", key: "board" }, [
					h("h3", null, ["积分榜", h("em", null, "前 10")]),
					lobby.board.length === 0
						? h("p", { className: "hs-tank-empty" }, "还没有人上分。")
						: h("ul", { className: "hs-tank-list" }, lobby.board.map((row) => h("li", { key: row.username }, [
							h("span", { className: "hs-tank-name" }, `${row.rank}. ${row.nickname || row.username}`),
							h("span", null, `${row.score} 分`)
						])))
				])
			]);

			const bar = h("div", { className: "hs-tank-bar", key: "bar" }, [
				h("div", { className: "hs-tank-field", key: "mode" }, [
					h("span", null, "模式"),
					h("div", { className: "hs-tank-modes" }, MODES.map((id) => h("button", {
						key: id,
						type: "button",
						"data-on": options.mode === id ? "true" : "false",
						disabled: running,
						title: MODE_HELP[id],
						onClick: () => {
							patchOptions({ mode: id });
							setMessage(`${MODE_LABELS[id]}：${MODE_HELP[id]}`);
							setTone("");
						}
					}, MODE_LABELS[id])))
				]),
				selectField("敌方 AI", options.ai, AI_ORDER.map((id) => [id, `${AI_PROFILES[id].label} · ${AI_PROFILES[id].help}`]), (value) => {
					patchOptions({ ai: value });
					setMessage(`敌方 AI 换成「${AI_PROFILES[value].label}」：${AI_PROFILES[value].help}。开局后也能改，下一帧就生效。`);
					setTone("");
				}),
				selectField("敌人总数", options.enemyCount, [[10, "10 辆（短局）"], [20, "20 辆（标准）"], [30, "30 辆（持久战）"]], (value) => patchOptions({ enemyCount: Number(value) })),
				selectField("我方生命", options.lives, [[1, "1 条"], [3, "3 条"], [5, "5 条"], [9, "9 条"]], (value) => patchOptions({ lives: Number(value) })),
				selectField("起始关卡", options.stage, [[1, "第 1 关"], [2, "第 2 关"], [3, "第 3 关"], [4, "第 4 关"]], (value) => patchOptions({ stage: Number(value) })),
				h("label", { className: "hs-tank-check", key: "sound" }, [
					h("input", {
						type: "checkbox",
						checked: options.sound,
						onChange: (event) => {
							const on = event.target.checked;
							patchOptions({ sound: on });
							audio().setEnabled(on);
							if (on) audio().resume();
						}
					}),
					"音效"
				]),
				h("span", { className: "hs-tank-spacer", key: "gap" }),
				h("button", {
					key: "start",
					type: "button",
					className: "hs-tank-btn hs-tank-btn-primary",
					disabled: running,
					onClick: start
				}, finished ? "再来一局" : "开始游戏"),
				h("button", {
					key: "pause",
					type: "button",
					className: "hs-tank-btn",
					disabled: !running,
					onClick: togglePause
				}, phase === "paused" ? "继续" : "暂停"),
				h("button", {
					key: "stop",
					type: "button",
					className: "hs-tank-btn hs-tank-btn-danger",
					disabled: phase === "idle",
					onClick: endRound
				}, "结束游戏")
			]);

			const status = h("div", { className: "hs-tank-status", key: "status" }, [
				h("span", { className: "hs-tank-stat", key: "mode" }, ["模式", h("b", null, MODE_LABELS[options.mode])]),
				h("span", { className: "hs-tank-stat", key: "score" }, [options.mode === "pvp" ? "蓝队" : "得分", h("b", null, String(options.mode === "pvp" ? hud.scoreA : hud.score))]),
				options.mode === "pvp" ? h("span", { className: "hs-tank-stat", key: "scoreB" }, ["红队", h("b", null, String(hud.scoreB))]) : null,
				h("span", { className: "hs-tank-stat", key: "stage" }, ["关卡", h("b", null, String(hud.stage))]),
				h("span", { className: "hs-tank-stat", key: "lives" }, ["生命", h("b", null, String(hud.lives))]),
				h("span", { className: "hs-tank-stat", key: "level" }, ["火力", h("b", null, `★${hud.level}`)]),
				h("span", { className: "hs-tank-stat", key: "left" }, ["剩余敌兵", h("b", null, String(Math.max(0, hud.remaining)))]),
				h("span", { className: "hs-tank-stat", key: "ai" }, ["敌方 AI", h("b", null, AI_PROFILES[options.ai].label)]),
				room ? h("span", { className: "hs-tank-stat", key: "room" }, ["房间", h("b", null, room.id)]) : null,
				h("span", { className: "hs-tank-message", key: "msg", "data-kind": tone || undefined }, message)
			]);

			const foot = h("div", { className: "hs-tank-foot", key: "foot" }, [
				h("div", { className: "hs-tank-keys", key: "keys" }, [
					h("span", { className: "hs-tank-key", key: "move" }, [
						h("span", { className: "hs-tank-kbd" }, "↑"),
						h("span", { className: "hs-tank-kbd" }, "↓"),
						h("span", { className: "hs-tank-kbd" }, "←"),
						h("span", { className: "hs-tank-kbd" }, "→"),
						h("span", null, "或 WASD 移动")
					]),
					h("span", { className: "hs-tank-key", key: "fire" }, [h("span", { className: "hs-tank-kbd" }, "空格"), h("span", null, "开火")]),
					h("span", { className: "hs-tank-key", key: "pause" }, [h("span", { className: "hs-tank-kbd" }, "Esc"), h("span", null, "暂停")])
				]),
				h("div", { className: "hs-tank-pad", key: "pad" }, [
					h("button", { key: "l", type: "button", disabled: !running, "aria-label": "左", ...hold(LEFT) }, "◀"),
					h("button", { key: "u", type: "button", disabled: !running, "aria-label": "上", ...hold(UP) }, "▲"),
					h("button", { key: "d", type: "button", disabled: !running, "aria-label": "下", ...hold(DOWN) }, "▼"),
					h("button", { key: "r", type: "button", disabled: !running, "aria-label": "右", ...hold(RIGHT) }, "▶"),
					h("button", {
						key: "f",
						type: "button",
						className: "hs-tank-fire",
						disabled: !running,
						"aria-label": "开火",
						onPointerDown: (event) => {
							event.preventDefault();
							inputRef.current.fire = true;
						},
						onPointerUp: () => { inputRef.current.fire = false; },
						onPointerCancel: () => { inputRef.current.fire = false; },
						onPointerLeave: () => { inputRef.current.fire = false; }
					}, "开火")
				]),
				h("span", { className: "hs-tank-spacer", key: "gap" }),
				stats
					? h("span", { key: "stats" }, `本地战绩：最高分 ${stats.bestScore} · 最高第 ${stats.bestStage} 关 · ${stats.plays} 局 · 通关 ${stats.wins} 次`)
					: null,
				h("span", { className: "hs-tank-note", key: "note" }, "砖墙一发打穿一格；三星子弹能打穿钢墙；对战打掉对方基地即胜。")
			]);

			const note = skewNote(hostVersion);

			return h("div", { className: "hs-tank" }, [
				h("style", { key: "css" }, CSS),
				h("div", { className: "hs-tank-head", key: "head" }, [
					h("div", { key: "text" }, [
						h("h1", { className: "hs-tank-title" }, "打坦克"),
						h("p", { className: "hs-tank-sub" }, "红白机经典玩法，单人或和同事联机：组队一起打 NPC，也可以各带一队 NPC 互相对战。AI 四档随时换。")
					]),
					h("span", { className: "hs-tank-chip", key: "ver" }, `v${PLUGIN_VERSION}`)
				]),
				note ? h("p", { className: "hs-tank-message", key: "skew", "data-kind": "warn" }, note) : null,
				lobbyView,
				bar,
				status,
				h("div", { className: "hs-tank-stage", key: "stage", ref: stageRef, "data-live": running ? "true" : "false" },
					h("canvas", { className: "hs-tank-canvas", ref: canvasRef }),
				),
				foot
			]);
		}

		// ==================== 画面快照（多人同步用） ====================
		//
		// 房主权威：房主跑引擎，按节流把这一小段状态发出去；客人只把它套回画面渲染，
		// 自己那份输入交给房主。这样场上永远只有一份真值，两边不会各跑各的跑偏。
		// 只传「看得见的东西」——AI 的内部状态（visited / think 计时）不传，客人用不上。

		function serializeGame(game) {
			return {
				v: 2,
				mode: game.cfg.mode,
				status: game.status,
				outcome: game.outcome || null,
				stage: game.stage,
				clock: Math.round(game.clock),
				score: game.score,
				scoreA: game.scoreA,
				scoreB: game.scoreB,
				lives: game.livesBySeat.slice(0, game.seats.length),
				levels: game.levelBySeat.slice(0, game.seats.length),
				freeze: Math.round(Math.max(0, game.freezeUntil - game.clock)),
				shovel: Math.round(Math.max(0, game.shovelUntil - game.clock)),
				tiles: Array.from(game.tiles).join(""),
				bases: game.bases.map((base) => ({ team: base.team, c: base.c, r: base.r, alive: base.alive })),
				players: game.players.map(serializeTank),
				enemies: game.enemies.map(serializeTank),
				bullets: game.bullets.map((b) => [Math.round(b.x), Math.round(b.y), b.dir, b.team]),
				powerups: game.powerups.map((item) => [item.kind, Math.round(item.x), Math.round(item.y)]),
				effects: game.effects.slice(-16).map((e) => [e.kind, Math.round(e.x), Math.round(e.y), Math.round(e.t), e.life, e.big ? 1 : 0, e.text || ""]),
				spawnIndex: game.spawnIndex,
				queue: game.queue.length,
				remaining: game.enemies.filter((e) => e.alive).length + (game.queue.length - game.spawnIndex)
			};
		}

		function serializeTank(tank) {
			return {
				seat: tank.seat === undefined ? -1 : tank.seat,
				team: tank.team,
				kind: tank.kind,
				x: Math.round(tank.x),
				y: Math.round(tank.y),
				dir: tank.dir,
				hp: tank.hp,
				alive: tank.alive,
				spawning: Math.round(Math.max(0, tank.spawning || 0)),
				shield: Math.round(Math.max(0, tank.shield || 0)),
				tread: Math.round(tank.treadFrame || 0),
				color: tank.color,
				bodyColor: tank.bodyColor || null,
				carrier: Boolean(tank.carrier),
				name: tank.name || ""
			};
		}

		function tankFromSnap(snap) {
			return {
				side: snap.kind === "player" ? "player" : "enemy",
				team: snap.team,
				seat: snap.seat,
				kind: snap.kind,
				x: snap.x,
				y: snap.y,
				dir: snap.dir,
				hp: snap.hp,
				maxHp: snap.hp,
				alive: snap.alive,
				spawning: snap.spawning,
				shield: snap.shield,
				treadFrame: snap.tread,
				color: snap.color,
				bodyColor: snap.bodyColor || undefined,
				carrier: snap.carrier,
				name: snap.name,
				fireTimer: 0,
				speed: 0,
				movedAt: 0,
				think: 0
			};
		}

		/** 客人把房主发来的快照套回一份「只用来画」的局面。 */
		function applySnapshot(game, snap) {
			if (!snap) return game;
			game.cfg.mode = MODES.includes(snap.mode) ? snap.mode : game.cfg.mode;
			game.status = snap.status || "playing";
			game.outcome = snap.outcome || null;
			game.stage = snap.stage || 1;
			game.clock = snap.clock || 0;
			game.score = snap.score || 0;
			game.scoreA = snap.scoreA || 0;
			game.scoreB = snap.scoreB || 0;
			game.freezeUntil = game.clock + (snap.freeze || 0);
			game.shovelUntil = game.clock + (snap.shovel || 0);
			const tiles = String(snap.tiles || "");
			for (let i = 0; i < game.tiles.length && i < tiles.length; i += 1) {
				game.tiles[i] = tiles.charCodeAt(i) - 48;
			}
			game.bases = (snap.bases || []).map((base) => {
				const made = makeBase(base.team, base.c, base.r);
				made.alive = base.alive;
				return made;
			});
			if (game.bases[0]) {
				game.baseAt = { c: game.bases[0].c, r: game.bases[0].r };
				game.baseAlive = game.bases[0].alive;
			}
			game.players = (snap.players || []).map(tankFromSnap);
			game.enemies = (snap.enemies || []).map(tankFromSnap);
			game.bullets = (snap.bullets || []).map((b) => ({
				x: b[0], y: b[1], size: 4, dir: b[2], team: b[3], owner: null, dead: false
			}));
			game.powerups = (snap.powerups || []).map((p) => ({ kind: p[0], x: p[1], y: p[2], t: 0, life: 17000 }));
			game.effects = (snap.effects || []).map((e) => ({
				kind: e[0], x: e[1], y: e[2], t: e[3], life: e[4], big: Boolean(e[5]), text: e[6]
			}));
			game.livesBySeat = (snap.lives || []).slice();
			game.levelBySeat = (snap.levels || []).slice();
			game.lives = game.livesBySeat[0] || 0;
			game.level = game.levelBySeat[0] || 0;
			game.player = game.players.find((tank) => tank.seat === 0) || null;
			game.spawnIndex = snap.spawnIndex || 0;
			const left = Math.max(0, (snap.queue || 0) - (snap.spawnIndex || 0));
			game.queue = new Array(left).fill({ kind: "basic", carrier: false });
			return game;
		}

		return {
			inject: ["slots", "layout"],
			apply(ctx) {
				// 整页：key 与侧栏那一项同 id，官方布局靠这个 id 把两者对上。
				ctx.slots.inject("main", () => ctx.slots.register({
					name: "main",
					key: PANEL_ID
				}, TanksPage));
				// 侧栏菜单项。
				ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
					name: "sidebar.panellist",
					id: PANEL_ID,
					order: 7,
					label: "打坦克"
				}, TanksIcon));
			},
			// 只给 test/render.mjs 用：加载器与宿主半都不读这个字段。
			engine: {
				VIEW_W,
				VIEW_H,
				COLS,
				ROWS,
				TILE,
				T,
				UP,
				RIGHT,
				DOWN,
				LEFT,
				AI_ORDER,
				AI_PROFILES,
				ENEMY_KINDS,
				STAGE_MAPS,
				MODES,
				MODE_LABELS,
				MODE_HELP,
				TEAM_COLORS,
				PLAYER_SPAWNS,
				SPAWN_POINTS,
				spawnPoint,
				// 版本号也放出来：预览页要显示它，省得再 fetch 一遍 client.js
				// —— 直接双击打开预览页（file://）时 fetch 会被浏览器拦掉。
				VERSION: PLUGIN_VERSION,
				normalizeSeats,
				orderSeats,
				createGame,
				step,
				fire,
				loadStage,
				distanceField,
				buildQueue,
				drawScene,
				textWidth,
				tileIndex,
				serializeGame,
				applySnapshot
			}
		};
	}
});
