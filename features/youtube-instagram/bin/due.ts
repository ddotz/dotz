// Watch: publishes approved/scheduled jobs whose time came (local only while nothing is due). YouTube goes through
// insertVideo when upload_via=api, Instagram through the tunnel + publishReel when post_via=api; a target set to `aside` is
// announced once as `aside-needed <jobId> <platform>` and the job stays scheduled for the orchestrator. Prints
// `posted <jobId> youtube=<id>` / `instagram=<id>` / `failed <jobId> <reason>`. publishJob is also what `sns.ts publish` runs.
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config, Ctx } from "../lib/config.ts";
import { publishReel, reply as igReply } from "../lib/instagram.ts";
import { dueJobs, getJob, type Job, markDone, markFailed, markNotified, markPosting, recordResult, release, setError } from "../lib/jobs.ts";
import { COSTS, can } from "../lib/quota.ts";
import { type TunnelOpts, withTunnel } from "../lib/tunnel.ts";
import { AuthError, main, oneLine, type Platform, type RunResult, runWatch, TransientError } from "../lib/watchkit.ts";
import { insertVideo, replyToComment, updateVideo, type VideoReader, videosWithLocalizations } from "../lib/youtube.ts";

export const hooks: { reader?: VideoReader; tunnel?: TunnelOpts } = {};

const via = (cfg: Config, job: Job, platform: Platform): "api" | "aside" => (job.kind === "upload" ? (platform === "youtube" ? cfg.youtube?.upload_via : cfg.instagram?.post_via) : "api") ?? "api";

function youtubeCost(job: Job): number {
	if (job.kind === "upload") return COSTS.videoInsert;
	return job.kind === "reply" ? COSTS.insertComment : COSTS.list + COSTS.update;
}

async function applyMetadata(ctx: Ctx, cfg: Config, job: Job): Promise<string> {
	const m = job.metadata as NonNullable<Job["metadata"]>;
	const [video] = await videosWithLocalizations(ctx, [m.video_id]);
	if (!video) throw new Error("video not found");
	let description = video.description;
	for (const [lang, text] of Object.entries(m.append)) if (!description.includes(text)) description += `\n\n[${lang}]\n${text}`;
	await updateVideo(ctx, video, { description, localizations: m.localizations }, cfg.youtube?.base_language ?? "en");
	return m.video_id;
}

async function publishTarget(ctx: Ctx, cfg: Config, job: Job, platform: Platform): Promise<string> {
	if (job.kind === "reply") {
		const r = job.reply as NonNullable<Job["reply"]>;
		return platform === "youtube" ? replyToComment(ctx, r.comment_id, r.text) : igReply(ctx, r.comment_id, r.text);
	}
	if (job.kind === "metadata") return applyMetadata(ctx, cfg, job);
	const u = job.upload as NonNullable<Job["upload"]>;
	if (!existsSync(u.file)) throw new Error("file is missing");
	if (platform === "youtube") {
		return insertVideo(ctx, { file: u.file, title: u.title, description: u.description, tags: u.tags, privacy: u.privacy, defaultLanguage: cfg.youtube?.base_language, localizations: u.localizations }, hooks.reader);
	}
	return withTunnel(u.file, url => publishReel(ctx, url, u.ig_caption ?? u.title), { ...hooks.tunnel, sleep: ctx.sleep });
}

function moveToDone(ctx: Ctx, cfg: Config, file: string): void {
	if (!existsSync(file)) return;
	const dir = join(cfg.inbox_dir, "done");
	mkdirSync(dir, { recursive: true });
	let dest = join(dir, basename(file));
	if (existsSync(dest)) dest = join(dir, `${ctx.now().getTime()}-${basename(file)}`);
	try {
		renameSync(file, dest);
	} catch {
		copyFileSync(file, dest);
		unlinkSync(file);
	}
}

// Marks the job done and files the source video away once every target has a result.
export function finishIfComplete(ctx: Ctx, cfg: Config, id: string): boolean {
	const job = getJob(id);
	if (!job || job.status === "done" || !job.targets.every(t => job.result[t])) return false;
	markDone(ctx, id);
	if (job.upload) moveToDone(ctx, cfg, job.upload.file);
	return true;
}

// Publishes one approved/scheduled job; returns the output lines. `explicit` (sns.ts publish) repeats the quota notice.
export async function publishJob(ctx: Ctx, cfg: Config, id: string, explicit = false): Promise<string[]> {
	const job = getJob(id);
	if (!job) throw new Error(`job ${id} not found`);
	const lines: string[] = [];
	const remaining = job.targets.filter(t => !job.result[t]);
	for (const t of remaining.filter(x => via(cfg, job, x) === "aside" && !job.notified?.includes(x))) {
		markNotified(id, t);
		lines.push(`aside-needed ${id} ${t}`);
	}
	const api = remaining.filter(t => via(cfg, job, t) === "api");
	if (!api.length) return lines;
	const quotaShort = api.includes("youtube") && !can(ctx, cfg, youtubeCost(job));
	const todo = quotaShort ? api.filter(t => t !== "youtube") : api;
	if (quotaShort) {
		if (explicit || job.error !== "quota") lines.push(`failed ${id} quota`);
		setError(id, "quota");
		if (!todo.length) return lines;
	}
	markPosting(id);
	for (const platform of todo) {
		try {
			const ref = await publishTarget(ctx, cfg, job, platform);
			recordResult(id, platform, ref);
			lines.push(`posted ${id} ${platform}=${ref}`);
		} catch (e) {
			if (e instanceof AuthError || e instanceof TransientError) {
				release(id);
				if (lines.length) return lines;
				throw e;
			}
			markFailed(ctx, id, oneLine(e instanceof Error ? e.message : "unexpected failure", 120));
			lines.push(`failed ${id} ${oneLine(e instanceof Error ? e.message : "unexpected failure", 120)}`);
			return lines;
		}
	}
	if (!finishIfComplete(ctx, cfg, id)) release(id);
	return lines;
}

export async function run(ctx: Ctx, _args: string[] = []): Promise<RunResult> {
	return runWatch<null>(ctx, {
		body: async cfg => {
			const lines: string[] = [];
			for (const j of dueJobs(ctx.now())) lines.push(...(await publishJob(ctx, cfg, j.id)));
			return { lines };
		},
	});
}

if (import.meta.main) await main(run);
