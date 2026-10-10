// 打坦克的战绩在本机读写。
//
// 只有四个数字加一张最近十局的清单，存成 $DSH_HOME/tank-battle.json（默认
// ~/.dsh/tank-battle.json），明文就行 —— 这里没有任何敏感信息，不值得加密。
//
// 为什么另开一个文件而不是塞进 index.js：index.js 是路由层，落盘的事单独放，
// 自检可以直接 import 这个模块做真实读写（用临时目录），不用把整个路由跑起来。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { dshHome } from "./identity.js";

export const STATS_VERSION = 1;

export function statsPath() {
	return join(dshHome(), "tank-battle.json");
}

const AI_IDS = ["rookie", "veteran", "hunter", "ace"];

function emptyStats() {
	return {
		v: STATS_VERSION,
		bestScore: 0,
		bestStage: 0,
		plays: 0,
		wins: 0,
		clearedStages: 0,
		lastPlayed: "",
		recent: []
	};
}

/** 非负整数，其他一律当 0。外来的东西一律不信。 */
function wholeNumber(value, max) {
	const num = Math.floor(Number(value));
	if (!Number.isFinite(num) || num < 0) return 0;
	return Math.min(max, num);
}

function oneLine(value, limit) {
	return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
}

/** 把磁盘上读回来的东西收拾成固定形状：字段缺了就补，类型不对就当没写。 */
export function normalizeStats(raw) {
	const base = emptyStats();
	if (!raw || typeof raw !== "object") return base;
	base.bestScore = wholeNumber(raw.bestScore, 99_999_999);
	base.bestStage = wholeNumber(raw.bestStage, 9999);
	base.plays = wholeNumber(raw.plays, 9_999_999);
	base.wins = wholeNumber(raw.wins, 9_999_999);
	base.clearedStages = wholeNumber(raw.clearedStages, 9_999_999);
	base.lastPlayed = oneLine(raw.lastPlayed, 32);
	base.recent = Array.isArray(raw.recent)
		? raw.recent.slice(0, 10).map((row) => ({
			score: wholeNumber(row && row.score, 99_999_999),
			stage: wholeNumber(row && row.stage, 9999),
			level: wholeNumber(row && row.level, 9),
			ai: AI_IDS.includes(row && row.ai) ? row.ai : "veteran",
			outcome: row && row.outcome === "win" ? "win" : row && row.outcome === "clear" ? "clear" : "over",
			at: oneLine(row && row.at, 32)
		}))
		: [];
	return base;
}

export async function readStats() {
	try {
		return normalizeStats(JSON.parse(await readFile(statsPath(), "utf8")));
	} catch {
		// 文件不在、读不动、JSON 坏了，都当成「还没打过」——这是只读的娱乐功能，
		// 没必要因为它把页面卡住或者提示一堆报错。
		return emptyStats();
	}
}

/**
 * 记一局。
 *
 * 读-合-写：先把磁盘上的现状读回来，再合并这一局，最后整份写回去。
 * 直接拿内存里的旧值覆盖会把另一个窗口刚打的那局抹掉。
 */
export async function recordResult(entry) {
	const current = await readStats();
	const outcome = entry && entry.outcome === "win" ? "win" : entry && entry.outcome === "clear" ? "clear" : "over";
	const row = {
		score: wholeNumber(entry && entry.score, 99_999_999),
		stage: wholeNumber(entry && entry.stage, 9999),
		level: wholeNumber(entry && entry.level, 9),
		ai: AI_IDS.includes(entry && entry.ai) ? entry.ai : "veteran",
		outcome,
		at: new Date().toISOString()
	};
	const next = {
		...current,
		bestScore: Math.max(current.bestScore, row.score),
		bestStage: Math.max(current.bestStage, row.stage),
		plays: current.plays + 1,
		wins: current.wins + (outcome === "win" ? 1 : 0),
		clearedStages: current.clearedStages + (outcome === "win" || outcome === "clear" ? 1 : 0),
		lastPlayed: row.at,
		recent: [row, ...current.recent].slice(0, 10)
	};
	await writeStats(next);
	return next;
}

async function writeStats(stats) {
	const file = statsPath();
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(stats, null, 2), { encoding: "utf8" });
}
