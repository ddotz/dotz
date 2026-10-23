// Multilingual descriptions for every public video (off by default: youtube.bulk, needs youtube.languages). Each run lists the
// public uploads (playlistItems, 1 unit per 50), then edits as many as the day's quota budget allows: the Korean-or-base
// description stays, `[Language]` sections are appended and the localizations (title + description) are added. updateVideo
// writes the one-time backup before the first edit of a video, so restoreOne / restoreAll can undo it. Progress lives in
// bulk.json; the watch prints a progress line only when it moves by a 10% step, so the app row changes (and the model wakes)
// rarely. Translation is an injected function (tests pass a fake, the watch passes the gateway model call).
import { existsSync, readdirSync } from "node:fs";
import { type Config, type Ctx, type Lang, paths, readJson, writeJson } from "./config.ts";
import { COSTS, isExhausted, used } from "./quota.ts";
import { QuotaError } from "./watchkit.ts";
import { publicUploadIds, restoreVideo, updateVideo, videosWithLocalizations, type YtLoc, type YtVideo } from "./youtube.ts";

export type Translate = (system: string, user: string) => Promise<string>;
export type BulkState = { version: 1; started: string; total: number; applied: string[]; restored: string[]; skipped: Record<string, string>; fails: Record<string, number>; printed?: string; finished?: string };

export const BULK_RESERVE = 500;
const RUN_LIMIT_MS = 12 * 60_000;
const MAX_FAILS = 3;
const STEP = 10;
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;

export const readBulk = (): BulkState | undefined => {
	try {
		return readJson<BulkState>(paths.bulk());
	} catch {
		return undefined;
	}
};
const saveBulk = (s: BulkState) => writeJson(paths.bulk(), s);

// The units bulk work may spend per Pacific day: quota.bulk_budget, else the daily budget minus a reserve kept for comments and replies.
export const bulkBudget = (cfg: Config): number => Math.min(cfg.quota.bulk_budget ?? cfg.quota.daily_budget - BULK_RESERVE, cfg.quota.daily_budget);

const labelOf = (lang: Lang): string => {
	try {
		const n = new Intl.DisplayNames([lang], { type: "language" }).of(lang);
		return n ? n.charAt(0).toUpperCase() + n.slice(1) : lang;
	} catch {
		return lang;
	}
};

const SYSTEM = "You translate YouTube video metadata. Reply with one JSON object {\"title\": string, \"description\": string} and nothing else. Keep URLs, hashtags, timestamps and names unchanged.";
async function translateOne(translate: Translate, v: YtVideo, lang: Lang): Promise<YtLoc> {
	const raw = await translate(SYSTEM, `Target language: ${lang} (${labelOf(lang)})\n\n${JSON.stringify({ title: v.title, description: v.description })}`);
	const m = /\{[\s\S]*\}/.exec(raw);
	const j = m ? (JSON.parse(m[0]) as Partial<YtLoc>) : undefined;
	if (!j || typeof j.title !== "string" || typeof j.description !== "string" || !j.title.trim()) throw new Error("translation is not JSON with title and description");
	return { title: j.title.trim().slice(0, TITLE_MAX), description: j.description.trim() };
}

// The change for one video, or undefined when it already has every language section and localization.
export async function buildChange(translate: Translate, v: YtVideo, targets: Lang[]): Promise<{ description: string; localizations: Record<Lang, YtLoc> } | undefined> {
	let description = v.description;
	const localizations: Record<Lang, YtLoc> = {};
	let changed = false;
	for (const lang of targets) {
		const marker = `[${labelOf(lang)}]`;
		const have = description.includes(marker) && v.localizations[lang];
		if (have) continue;
		const t = await translateOne(translate, v, lang);
		if (!description.includes(marker)) description = `${description}\n\n${marker}\n${t.description}`;
		localizations[lang] = { title: t.title, description: t.description };
		changed = true;
	}
	return changed ? { description: description.slice(0, DESCRIPTION_MAX), localizations } : undefined;
}

const fresh = (ctx: Ctx, total: number): BulkState => ({ version: 1, started: ctx.now().toISOString(), total, applied: [], restored: [], skipped: {}, fails: {} });
const done = (s: BulkState) => new Set([...s.applied, ...s.restored, ...Object.keys(s.skipped)]);

export function progressLine(s: BulkState): string {
	if (s.finished) return `다국어 설명을 공개 영상 ${s.total}개에 모두 적용했어요`;
	const applied = s.applied.filter(id => !s.restored.includes(id)).length;
	return `다국어 설명 ${applied}/${s.total}개 적용했어요${s.restored.length ? ` (되돌린 영상 ${s.restored.length}개)` : ""}`;
}

// The line a run prints: the stored one until the progress moved by another STEP percent (or finished), so the watch output stays put.
function lineToPrint(s: BulkState): string {
	const pct = s.total ? Math.floor((done(s).size * 100) / s.total / STEP) * STEP : 100;
	const key = s.finished ? "done" : String(pct);
	const prev = s.printed?.split("|")[0];
	if (prev === key && s.printed) return s.printed.split("|")[1] as string;
	s.printed = `${key}|${progressLine(s)}`;
	return progressLine(s);
}

export async function runBulk(ctx: Ctx, cfg: Config, deps: { translate: Translate }): Promise<string[]> {
	const yt = cfg.youtube;
	if (!yt?.bulk || !yt.languages.length) return [];
	const limit = bulkBudget(cfg);
	if (isExhausted(ctx) || used(ctx) + COSTS.list + COSTS.update > limit) {
		const kept = readBulk();
		return kept ? [kept.printed?.split("|")[1] ?? progressLine(kept)] : [];
	}
	const ids = await publicUploadIds(ctx, yt.channel_id);
	const state = readBulk() ?? fresh(ctx, ids.length);
	state.total = Math.max(ids.length, done(state).size);
	delete state.finished;
	const targets = yt.languages.filter(l => l !== yt.base_language);
	const deadline = ctx.now().getTime() + RUN_LIMIT_MS;
	const skip = done(state);
	let todo = ids.filter(id => !skip.has(id));
	outer: while (todo.length) {
		const batch = todo.slice(0, 50);
		todo = todo.slice(50);
		if (used(ctx) + COSTS.list + COSTS.update > limit) break;
		for (const v of await videosWithLocalizations(ctx, batch)) {
			if (ctx.now().getTime() > deadline || used(ctx) + COSTS.update > limit || isExhausted(ctx)) break outer;
			try {
				const change = await buildChange(deps.translate, v, targets);
				if (change) await updateVideo(ctx, v, change, yt.base_language);
				state.applied.push(v.id);
			} catch (e) {
				if (e instanceof QuotaError) break outer;
				state.fails[v.id] = (state.fails[v.id] ?? 0) + 1;
				if (state.fails[v.id]! >= MAX_FAILS) state.skipped[v.id] = (e instanceof Error ? e.message : "failed").slice(0, 80);
			}
			saveBulk(state);
		}
	}
	if (!ids.some(id => !done(state).has(id))) state.finished = ctx.now().toISOString();
	const line = lineToPrint(state);
	saveBulk(state);
	return [line];
}

export function markRestored(ids: string[]): void {
	const s = readBulk();
	if (!s) return;
	s.restored = [...new Set([...s.restored, ...ids])];
	delete s.finished;
	saveBulk(s);
}

export async function restoreOne(ctx: Ctx, videoId: string): Promise<void> {
	await restoreVideo(ctx, videoId);
	markRestored([videoId]);
}

// Restores the videos the bulk run changed, as many as the daily budget allows; the rest waits for the next day (`left`).
export async function restoreAll(ctx: Ctx, cfg: Config): Promise<{ restored: number; left: number }> {
	const s = readBulk();
	const pending = (s?.applied ?? []).filter(id => !s?.restored.includes(id) && existsSync(`${paths.backup()}/${id}.json`));
	let restored = 0;
	for (const id of pending) {
		if (isExhausted(ctx) || used(ctx) + COSTS.update > cfg.quota.daily_budget) break;
		await restoreOne(ctx, id);
		restored++;
	}
	return { restored, left: pending.length - restored };
}

export const backupIds = (): string[] => (existsSync(paths.backup()) ? readdirSync(paths.backup()).filter(n => n.endsWith(".json")).map(n => n.slice(0, -5)) : []);
