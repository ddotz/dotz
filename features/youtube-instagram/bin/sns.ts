// Action CLI the orchestrator runs: `job new --kind upload|reply|metadata --json <file>`, `approve <id> [--at ISO|now]`,
// `reject <id>`, `publish <id>` (approved/scheduled only; same path as due.ts), `status`, `tone-sample [--limit 30]`,
// `restore <videoId>` and `mark-done <id> <platform> [ref]` (records a target the orchestrator finished through the
// browser). Prints plain status lines; nothing public happens from a job that was not approved.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Ctx, loadConfig, paths, SetupError } from "../lib/config.ts";
import { commentsFor, mediaWithCounts } from "../lib/instagram.ts";
import { approve, getJob, type Job, type JobKind, listJobs, newJob, type NewJobInput, OPEN, PUBLISHABLE, recordResult, reject } from "../lib/jobs.ts";
import { COSTS, can } from "../lib/quota.ts";
import { AuthError, failFrom, main, oneLine, type Platform, type RunResult, TransientError } from "../lib/watchkit.ts";
import { ownReplies, restoreVideo } from "../lib/youtube.ts";
import { finishIfComplete, publishJob } from "./due.ts";

const HEADING = "## 예시";
const KINDS: JobKind[] = ["upload", "reply", "metadata"];
const PLATFORMS: Platform[] = ["youtube", "instagram"];

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

function positionals(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i].startsWith("--")) i++;
		else out.push(args[i]);
	}
	return out;
}

const ok = (...lines: string[]): RunResult => ({ lines, code: 0 });
const usage = (): RunResult => ({ lines: ["usage: sns.ts job new --kind upload|reply|metadata --json <file> | approve <id> [--at ISO|now] | reject <id> | publish <id> | status | tone-sample [--limit N] | restore <videoId> | mark-done <id> <platform> [ref]"], code: 2 });

function summary(j: Job): string {
	if (j.upload) return oneLine(j.upload.title, 60);
	if (j.reply) return `${j.reply.platform} ${oneLine(j.reply.text, 60)}`;
	return j.metadata?.video_id ?? "";
}

// Replaces the `## 예시` section of tone.md (up to the next `## ` heading) and keeps everything else.
export function mergeExamples(existing: string, examples: string[]): string {
	const section = `${HEADING}\n\n${examples.map(e => `- ${e}`).join("\n")}\n`;
	const lines = existing.split("\n");
	const start = lines.findIndex(l => l.trim() === HEADING);
	if (start < 0) return `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${section}`;
	const next = lines.findIndex((l, i) => i > start && /^## /.test(l));
	const tail = next < 0 ? "" : `\n${lines.slice(next).join("\n")}`;
	return `${lines.slice(0, start).join("\n")}${start ? "\n" : ""}${section}${tail}`;
}

export const cleanExample = (s: string): string => oneLine(s.replace(/@\S+/g, ""), 200);

async function toneSample(ctx: Ctx, args: string[]): Promise<RunResult> {
	const cfg = loadConfig();
	const limit = Math.min(100, Math.max(1, Number(flag(args, "--limit") ?? 30) || 30));
	const texts: string[] = [];
	if (cfg.youtube && can(ctx, cfg, COSTS.list * 3)) texts.push(...(await ownReplies(ctx, cfg.youtube.channel_id, limit)));
	if (cfg.instagram) {
		const owner = cfg.instagram.username.toLowerCase();
		for (const m of (await mediaWithCounts(ctx)).filter(x => x.comments_count > 0).slice(0, 10)) {
			for (const c of await commentsFor(ctx, m.id)) for (const r of c.replies) if (r.username.toLowerCase() === owner) texts.push(r.text);
			if (texts.length >= limit) break;
		}
	}
	const examples = [...new Set(texts.map(cleanExample).filter(Boolean))].slice(0, limit);
	if (!examples.length) return ok("tone-sample 0");
	mkdirSync(dirname(paths.tone()), { recursive: true });
	writeFileSync(paths.tone(), mergeExamples(existsSync(paths.tone()) ? readFileSync(paths.tone(), "utf8") : "", examples));
	return ok(`tone-sample ${examples.length}`);
}

async function dispatch(ctx: Ctx, args: string[]): Promise<RunResult> {
	const [cmd, ...rest] = args;
	const pos = positionals(rest);
	switch (cmd) {
		case "job": {
			if (rest[0] !== "new") return usage();
			const kind = flag(rest, "--kind") as JobKind;
			const path = flag(rest, "--json");
			if (!KINDS.includes(kind) || !path) return usage();
			const body = JSON.parse(readFileSync(path, "utf8")) as Omit<NewJobInput, "kind">;
			const j = newJob(ctx, { ...body, kind });
			return ok(`created ${j.id} ${j.kind} ${j.status}`);
		}
		case "approve": {
			if (!pos[0]) return usage();
			const j = approve(ctx, pos[0], { publish_at: flag(rest, "--at") });
			return ok(`approved ${j.id} ${j.status} at=${j.publish_at}`);
		}
		case "reject": {
			if (!pos[0]) return usage();
			return ok(`rejected ${reject(pos[0]).id}`);
		}
		case "publish": {
			if (!pos[0]) return usage();
			const j = getJob(pos[0]);
			if (!j) throw new Error(`job ${pos[0]} not found`);
			if (!PUBLISHABLE.includes(j.status)) throw new Error(`job ${j.id} is ${j.status}; only an approved or scheduled job can be published`);
			const lines = await publishJob(ctx, loadConfig(), j.id, true);
			return { lines, code: lines.some(l => l.startsWith("failed ")) ? 1 : 0 };
		}
		case "status": {
			const open = listJobs().filter(j => OPEN.includes(j.status));
			if (!open.length) return ok("열려 있는 작업이 없어요");
			return ok(...open.map(j => `${j.id} ${j.kind} ${j.status}${j.publish_at ? ` at=${j.publish_at}` : ""} ${summary(j)}`.trim()));
		}
		case "tone-sample":
			return toneSample(ctx, rest);
		case "restore": {
			if (!pos[0]) return usage();
			if (!can(ctx, loadConfig(), COSTS.update)) return { lines: [`failed restore ${pos[0]} quota`], code: 1 };
			await restoreVideo(ctx, pos[0]);
			return ok(`restored ${pos[0]}`);
		}
		case "mark-done": {
			const [id, platform, ref] = pos;
			if (!id || !PLATFORMS.includes(platform as Platform)) return usage();
			const j = getJob(id);
			if (!j) throw new Error(`job ${id} not found`);
			if (!PUBLISHABLE.includes(j.status) || !j.targets.includes(platform as Platform)) throw new Error(`job ${id} cannot take ${platform} as done`);
			recordResult(id, platform as Platform, ref ?? "aside");
			return ok(`marked ${id} ${platform}`, ...(finishIfComplete(ctx, loadConfig(), id) ? [`done ${id}`] : []));
		}
		default:
			return usage();
	}
}

export async function run(ctx: Ctx, args: string[]): Promise<RunResult> {
	try {
		return await dispatch(ctx, args);
	} catch (e) {
		if (e instanceof AuthError || e instanceof SetupError || e instanceof TransientError) return failFrom(e);
		return { lines: [`error: ${oneLine(e instanceof Error ? e.message : "unexpected failure", 200)}`], code: 1 };
	}
}

if (import.meta.main) await main(run);
