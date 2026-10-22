// Data command of the home card "유튜브·인스타" (DESIGN.md): kv JSON of channel stats and the approval queue. Stats come
// from cache/stats.json and are refreshed at most hourly; offline or an API error falls back to the cache with "(캐시)".
// Always exits 0 and never prints a secret.
import { existsSync } from "node:fs";
import { type Config, type Ctx, loadConfig, paths, readJson, realCtx, writeJson } from "../lib/config.ts";
import { me } from "../lib/instagram.ts";
import { listJobs } from "../lib/jobs.ts";
import { channelStats, myChannel } from "../lib/youtube.ts";

type Result = { lines: string[]; code: number };
type Cached<T> = T & { at: string };
type Stats = { youtube?: Cached<{ subscribers: number; views: number; videos: number }>; instagram?: Cached<{ followers: number; media: number }> };

const HOUR_MS = 3_600_000;
const BEFORE_SETUP = "설정 전이에요. 채팅에서 '유튜브·인스타 설정해줘'라고 말해 주세요";
const num = (n: number) => n.toLocaleString("en-US");
const fresh = (s: { at: string } | undefined, now: Date) => Boolean(s) && now.getTime() - Date.parse(s!.at) < HOUR_MS;

async function readStats(): Promise<Stats> {
	try {
		return readJson<Stats>(paths.stats()) ?? {};
	} catch {
		return {};
	}
}

async function refresh(ctx: Ctx, config: Config, stats: Stats): Promise<Stats> {
	const next: Stats = { ...stats };
	const at = ctx.now().toISOString();
	if (config.youtube && !fresh(stats.youtube, ctx.now())) {
		try {
			const s = await channelStats(ctx, config.youtube.channel_id);
			next.youtube = { subscribers: s.subscribers, views: s.views, videos: s.videos, at };
		} catch {}
	}
	if (config.instagram && !fresh(stats.instagram, ctx.now())) {
		try {
			const a = await me(ctx);
			next.instagram = { followers: a.followers, media: a.media, at };
		} catch {}
	}
	if (next.youtube !== stats.youtube || next.instagram !== stats.instagram) {
		try {
			writeJson(paths.stats(), next);
		} catch {}
	}
	return next;
}

async function jobCounts(): Promise<{ draft: number; scheduled: number } | undefined> {
	try {
		const jobs = await listJobs();
		return { draft: jobs.filter(j => j.status === "draft").length, scheduled: jobs.filter(j => j.status === "scheduled").length };
	} catch {
		return undefined;
	}
}

export async function run(ctx: Ctx, _args: string[] = []): Promise<Result> {
	const emit = (o: Record<string, string>): Result => ({ lines: [JSON.stringify(o)], code: 0 });
	try {
		if (!existsSync(paths.config())) return emit({ 상태: BEFORE_SETUP });
		const config = loadConfig();
		const stats = await readStats();
		const got = await refresh(ctx, config, stats);
		const out: Record<string, string> = {};
		const missing: string[] = [];
		const shown = (v: number | undefined, cached: boolean) => (v === undefined ? "(불러오지 못했어요)" : `${num(v)}${cached ? " (캐시)" : ""}`);
		const cachedYt = !fresh(got.youtube, ctx.now());
		const cachedIg = !fresh(got.instagram, ctx.now());
		if (config.youtube) {
			out["유튜브 구독자"] = shown(got.youtube?.subscribers, cachedYt);
			out["유튜브 영상"] = shown(got.youtube?.videos, cachedYt);
		} else missing.push("유튜브");
		if (config.instagram) {
			out["인스타 팔로워"] = shown(got.instagram?.followers, cachedIg);
			out["인스타 게시물"] = shown(got.instagram?.media, cachedIg);
		} else missing.push("인스타");
		const jobs = await jobCounts();
		out["답 기다리는 초안"] = jobs ? `${jobs.draft}개` : "(확인하지 못했어요)";
		out["예약된 게시"] = jobs ? `${jobs.scheduled}개` : "(확인하지 못했어요)";
		if (missing.length) out["연결"] = `${missing.join("·")}은(는) 아직 연결하지 않았어요`;
		return emit(out);
	} catch (e) {
		return emit({ 상태: `카드를 만들지 못했어요 (${(e as Error).message})` });
	}
}

if (import.meta.main) {
	const { lines } = await run(realCtx(), process.argv.slice(2));
	console.log(lines.join("\n"));
	process.exit(0);
}
