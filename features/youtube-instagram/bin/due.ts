// Watch: publishes approved/scheduled jobs whose time came (local only while nothing is due). YouTube goes through
// insertVideo when upload_via=api, Instagram through the tunnel + publishReel when post_via=api; a target set to `aside` is
// announced once as `aside-needed <jobId> <platform>` and the job stays scheduled for the orchestrator. Prints
// `posted <jobId> youtube=<id>` / `instagram=<id>` / `failed <jobId> <reason>`. publishJob is also what `sns.ts publish` runs.
// A YouTube upload saves its fingerprint on the job first and sends it as a tag; a retry looks the tag up before it uploads
// again. An exhausted YouTube quota is no failure: the job stays scheduled and the notice is `yt-quota-exhausted until=HH:MM`.
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config, Ctx } from "../lib/config.ts";
import { PUBLISH_MISSING_KO, publishState } from "../lib/ig-publish.ts";
import { PublishPermissionError, publishReel, reply as igReply } from "../lib/instagram.ts";
import { dueJobs, getJob, jobFeatureOn, type Job, markDone, markFailed, markNotified, markPosting, recordResult, release, saveUploadIntent, setError, setStudio } from "../lib/jobs.ts";
import { announceExhausted, COSTS, can, exhaustedLine, isExhausted } from "../lib/quota.ts";
import { type Aside, realStudioAside, uploadViaStudio } from "../lib/studio.ts";
import { type TunnelOpts, withTunnel } from "../lib/tunnel.ts";
import { AuthError, main, oneLine, type Platform, QuotaError, type RunResult, runWatch, TransientError } from "../lib/watchkit.ts";
import { findUploadByTag, insertVideo, replyToComment, updateVideo, type VideoReader, videosWithLocalizations } from "../lib/youtube.ts";

export const hooks: { reader?: VideoReader; tunnel?: TunnelOpts; aside?: Aside } = {};

const STUDIO_TRIES = 3;

// A YouTube upload goes through the API only for an audited Google project (an unaudited one locks API uploads to private and cannot
// set a related video); everything else uses YouTube Studio.
export const youtubeUploadVia = (cfg: Config): "api" | "aside" => (cfg.youtube?.upload_via === "api" && cfg.youtube.audited === true ? "api" : "aside");

const via = (cfg: Config, job: Job, platform: Platform): "api" | "aside" => (job.kind === "upload" ? (platform === "youtube" ? youtubeUploadVia(cfg) : cfg.instagram?.post_via) : "api") ?? "api";

// Runs the fixed Studio script for a YouTube upload. A login or code page, or the last allowed failure, hands the job to the
// orchestrator (aside-needed with the reason); an earlier failure just waits for the next run.
async function studioUpload(ctx: Ctx, cfg: Config, job: Job): Promise<{ ref?: string; handOff?: string }> {
	const u = job.upload as NonNullable<Job["upload"]>;
	if (!existsSync(u.file)) return { handOff: "file is missing" };
	const aside = hooks.aside ?? (await realStudioAside(ctx));
	markPosting(job.id, ctx.now());
	const r = await uploadViaStudio(aside, (cfg.youtube as NonNullable<Config["youtube"]>).channel_id, { file: u.file, title: u.title, description: u.description, visibility: u.privacy, related: u.related }, job.studio?.video_id, id => setStudio(job.id, { video_id: id }));
	release(job.id);
	if (r.state === "ok" && r.videoId) return { ref: r.videoId };
	const tries = (job.studio?.tries ?? 0) + 1;
	setStudio(job.id, { tries, ...(r.videoId ? { video_id: r.videoId } : {}) });
	const owner = r.state === "owner" || r.state === "code";
	return tries >= STUDIO_TRIES || owner ? { handOff: oneLine(r.note || r.state, 100) } : {};
}

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
		const known = job.upload_intent;
		const intent = known ?? saveUploadIntent(ctx, job.id);
		if (known) {
			const found = await findUploadByTag(ctx, (cfg.youtube as NonNullable<Config["youtube"]>).channel_id, intent.fingerprint);
			if (found) return found;
		}
		return insertVideo(ctx, { file: u.file, title: u.title, description: u.description, tags: [...u.tags, intent.fingerprint], privacy: u.privacy, defaultLanguage: cfg.youtube?.base_language, localizations: u.localizations }, hooks.reader);
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
	// A platform whose approval feature is switched off is not published: the job stays as it is until the owner turns it on (or rejects it).
	const remaining = job.targets.filter(t => !job.result[t] && jobFeatureOn(job.kind, t));
	for (const t of remaining.filter(x => via(cfg, job, x) === "aside" && !job.notified?.includes(x))) {
		let why = "";
		if (t === "youtube" && job.kind === "upload") {
			const s = await studioUpload(ctx, cfg, job);
			if (s.ref) {
				recordResult(id, t, s.ref);
				lines.push(`posted ${id} ${t}=${s.ref}`);
				continue;
			}
			if (!s.handOff) continue;
			why = ` ${s.handOff}`;
		}
		markNotified(id, t);
		lines.push(`aside-needed ${id} ${t}${why}`);
	}
	const api = remaining.filter(t => via(cfg, job, t) === "api");
	if (!api.length) {
		finishIfComplete(ctx, cfg, id);
		return lines;
	}
	const exhausted = api.includes("youtube") && isExhausted(ctx);
	const quotaShort = api.includes("youtube") && !exhausted && !can(ctx, cfg, youtubeCost(job));
	// A Reels upload waits (stays scheduled, nothing is sent to Meta) while the token is known to lack instagram_business_content_publish.
	const igBlocked = job.kind === "upload" && api.includes("instagram") && publishState().missing;
	const todo = (exhausted || quotaShort ? api.filter(t => t !== "youtube") : api).filter(t => !(igBlocked && t === "instagram"));
	const notice = exhausted && explicit ? exhaustedLine(ctx, cfg) : undefined;
	if (notice) lines.push(notice);
	if (igBlocked && (explicit || !job.notified?.includes("instagram"))) {
		markNotified(id, "instagram");
		lines.push(`ig-publish-blocked ${id}: ${PUBLISH_MISSING_KO}`);
	}
	if (quotaShort) {
		if (explicit || job.error !== "quota") lines.push(`failed ${id} quota`);
		setError(id, "quota");
	}
	if (!todo.length) return lines;
	markPosting(id, ctx.now());
	for (const platform of todo) {
		try {
			const ref = await publishTarget(ctx, cfg, job, platform);
			recordResult(id, platform, ref);
			lines.push(`posted ${id} ${platform}=${ref}`);
		} catch (e) {
			if (e instanceof QuotaError) {
				lines.push(...(await announceExhausted(ctx, cfg)));
				continue;
			}
			if (e instanceof PublishPermissionError) {
				markNotified(id, "instagram");
				lines.push(`ig-publish-blocked ${id}: ${PUBLISH_MISSING_KO}`);
				continue;
			}
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
			for (const j of dueJobs(ctx.now())) {
				try {
					lines.push(...(await publishJob(ctx, cfg, j.id)));
				} catch (e) {
					// Keep what already went out this run; the failing job was released and is retried on the next run.
					if (lines.length) return { lines };
					throw e;
				}
			}
			return { lines };
		},
	});
}

if (import.meta.main) await main(run);
