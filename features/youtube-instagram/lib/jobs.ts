// Approval jobs (DESIGN.md "Jobs and approval"): one JSON file per job in jobs/. Status flow draft -> approved |
// scheduled -> posting -> done | failed, or rejected. Nothing is published from a job that is not approved/scheduled;
// markPosting is the single gate every publish path goes through.
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Config, type Ctx, type Lang, loadConfig, paths, readJson, writeJson } from "./config.ts";
import { type Platform, zonedParts, zonedToDate } from "./watchkit.ts";
import type { YtLoc } from "./youtube.ts";

export type JobKind = "upload" | "reply" | "metadata";
export type JobStatus = "draft" | "approved" | "scheduled" | "posting" | "done" | "failed" | "rejected";
export type UploadSpec = { file: string; title: string; description: string; tags: string[]; localizations: Record<Lang, YtLoc>; privacy: "private" | "unlisted" | "public"; ig_caption?: string };
export type ReplySpec = { platform: Platform; comment_id: string; text: string };
export type MetadataSpec = { video_id: string; append: Record<Lang, string>; localizations: Record<Lang, YtLoc> };
export type Job = {
	id: string;
	kind: JobKind;
	status: JobStatus;
	created: string;
	targets: Platform[];
	publish_at?: string;
	upload?: UploadSpec;
	reply?: ReplySpec;
	metadata?: MetadataSpec;
	approved_at?: string;
	finished?: string;
	result: Partial<Record<Platform, string>>;
	notified?: Platform[];
	error?: string;
};
export type NewJobInput = { kind: JobKind; targets?: Platform[]; upload?: Partial<UploadSpec>; reply?: Partial<ReplySpec>; metadata?: Partial<MetadataSpec> };

const ID = /^j-\d{12}-[0-9a-f]{4}$/;
const PLATFORMS: Platform[] = ["youtube", "instagram"];
export const PUBLISHABLE: JobStatus[] = ["approved", "scheduled"];
export const OPEN: JobStatus[] = ["draft", "approved", "scheduled", "posting"];

const file = (id: string) => join(paths.jobs(), `${id}.json`);
const save = (j: Job) => writeJson(file(j.id), j);
const str = (v: unknown) => typeof v === "string" && v.trim().length > 0;

export function getJob(id: string): Job | undefined {
	if (!ID.test(id)) return undefined;
	try {
		return readJson<Job>(file(id));
	} catch {
		return undefined;
	}
}

function need(id: string): Job {
	const j = getJob(id);
	if (!j) throw new Error(`job ${id} not found`);
	return j;
}

export function listJobs(): Job[] {
	let names: string[];
	try {
		names = readdirSync(paths.jobs());
	} catch {
		return [];
	}
	const jobs: Job[] = [];
	for (const n of names) {
		const id = n.replace(/\.json$/, "");
		const j = n.endsWith(".json") ? getJob(id) : undefined;
		if (j) jobs.push(j);
	}
	return jobs.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

function newId(ctx: Ctx): string {
	const stamp = ctx.now().toISOString().replace(/\D/g, "").slice(0, 12);
	const rand = Array.from(crypto.getRandomValues(new Uint8Array(2)), b => b.toString(16).padStart(2, "0")).join("");
	return `j-${stamp}-${rand}`;
}

// Boundary check of a job body written by the orchestrator; fills the owner's defaults (targets, privacy).
export function newJob(ctx: Ctx, input: NewJobInput): Job {
	const cfg = loadConfig();
	const connected = PLATFORMS.filter(p => cfg[p]);
	const job: Job = { id: newId(ctx), kind: input.kind, status: "draft", created: ctx.now().toISOString(), targets: [], result: {} };
	if (input.kind === "upload") {
		const u = input.upload;
		if (!u || !str(u.file) || !u.file?.startsWith("/")) throw new Error("upload.file must be an absolute path");
		if (!str(u.title)) throw new Error("upload.title is required");
		job.targets = input.targets?.length ? input.targets : connected;
		if (!job.targets.every(t => connected.includes(t))) throw new Error("a target platform is not connected");
		job.upload = { file: u.file, title: u.title as string, description: u.description ?? "", tags: u.tags ?? [], localizations: u.localizations ?? {}, privacy: u.privacy ?? cfg.youtube?.privacy ?? "private", ig_caption: u.ig_caption };
	} else if (input.kind === "reply") {
		const r = input.reply;
		if (!r || !PLATFORMS.includes(r.platform as Platform) || !str(r.comment_id) || !str(r.text)) throw new Error("reply needs platform, comment_id and text");
		if (!connected.includes(r.platform as Platform)) throw new Error("a target platform is not connected");
		job.targets = [r.platform as Platform];
		job.reply = { platform: r.platform as Platform, comment_id: r.comment_id as string, text: r.text as string };
	} else if (input.kind === "metadata") {
		const m = input.metadata;
		if (!m || !str(m.video_id)) throw new Error("metadata.video_id is required");
		if (!cfg.youtube) throw new Error("a target platform is not connected");
		job.targets = ["youtube"];
		job.metadata = { video_id: m.video_id as string, append: m.append ?? {}, localizations: m.localizations ?? {} };
	} else {
		throw new Error("kind must be upload, reply or metadata");
	}
	mkdirSync(paths.jobs(), { recursive: true });
	save(job);
	return job;
}

export function nextPostingTime(cfg: Config, now: Date): Date {
	const times = [...cfg.posting_times].sort();
	const p = zonedParts(now, cfg.timezone);
	for (let offset = 0; offset <= 2; offset++) {
		const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + offset));
		for (const t of times) {
			const at = zonedToDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Number(t.slice(0, 2)), Number(t.slice(3, 5)), cfg.timezone);
			if (at.getTime() > now.getTime()) return at;
		}
	}
	throw new Error("no posting time found");
}

// No publish_at -> next posting time; `now` or a time already past -> approved (due at once); a future time -> scheduled.
export function approve(ctx: Ctx, id: string, opts: { publish_at?: string } = {}): Job {
	const j = need(id);
	if (j.status !== "draft") throw new Error(`job ${id} is ${j.status}; only a draft can be approved`);
	const now = ctx.now();
	let at: Date;
	if (opts.publish_at === "now") at = now;
	else if (opts.publish_at) {
		at = new Date(opts.publish_at);
		if (Number.isNaN(at.getTime())) throw new Error("publish_at must be an ISO time or now");
	} else at = nextPostingTime(loadConfig(), now);
	j.publish_at = at.toISOString();
	j.approved_at = now.toISOString();
	j.status = at.getTime() > now.getTime() ? "scheduled" : "approved";
	save(j);
	return j;
}

export function reject(id: string): Job {
	const j = need(id);
	if (!["draft", ...PUBLISHABLE].includes(j.status)) throw new Error(`job ${id} is ${j.status}; it cannot be rejected`);
	j.status = "rejected";
	save(j);
	return j;
}

export function markPosting(id: string): Job {
	const j = need(id);
	if (!PUBLISHABLE.includes(j.status)) throw new Error(`job ${id} is ${j.status}; only an approved or scheduled job can be published`);
	j.status = "posting";
	save(j);
	return j;
}

export function release(id: string): Job {
	const j = need(id);
	if (j.status === "posting") {
		j.status = "scheduled";
		save(j);
	}
	return j;
}

export function recordResult(id: string, platform: Platform, ref: string): Job {
	const j = need(id);
	j.result[platform] = ref;
	save(j);
	return j;
}

export function markNotified(id: string, platform: Platform): Job {
	const j = need(id);
	j.notified = [...new Set([...(j.notified ?? []), platform])];
	save(j);
	return j;
}

export function markDone(ctx: Ctx, id: string): Job {
	const j = need(id);
	j.status = "done";
	j.finished = ctx.now().toISOString();
	delete j.error;
	save(j);
	return j;
}

export function markFailed(ctx: Ctx, id: string, error: string): Job {
	const j = need(id);
	j.status = "failed";
	j.finished = ctx.now().toISOString();
	j.error = error;
	save(j);
	return j;
}

export function setError(id: string, error: string | undefined): Job {
	const j = need(id);
	if (error === undefined) delete j.error;
	else j.error = error;
	save(j);
	return j;
}

export function dueJobs(now: Date): Job[] {
	return listJobs()
		.filter(j => PUBLISHABLE.includes(j.status) && (!j.publish_at || Date.parse(j.publish_at) <= now.getTime()))
		.sort((a, b) => (a.publish_at ?? a.created).localeCompare(b.publish_at ?? b.created));
}
