// Action CLI the orchestrator runs: `job new --kind upload|reply|metadata --json <file>`, `approve <id> [--at ISO|now]`,
// `reject <id>`, `publish <id>` (approved/scheduled only; same path as due.ts), `status`, `tone-sample [--limit 30]`,
// `restore <videoId>` and `mark-done <id> <platform> [ref]` (records a target the orchestrator finished through the
// browser). Prints plain status lines; nothing public happens from a job that was not approved.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { draftVerdict } from "../../../hub/draft-approval.ts";
import { reviseComment } from "../../reply-drafts/lib/comments.ts";
import { defaultCall, type FlowDeps } from "../../reply-drafts/lib/flow.ts";
import { loadSettings as replySettings, paths as replyPaths } from "../../reply-drafts/lib/settings.ts";
import { getDraft, setStatus } from "../../reply-drafts/lib/store.ts";
import { type Ctx, loadConfig, paths, SetupError } from "../lib/config.ts";
import { PUBLISH_BLOCKED_CARD, publishState } from "../lib/ig-publish.ts";
import { approve, getJob, type Job, type JobKind, listJobs, newJob, type NewJobInput, OPEN, PUBLISHABLE, recordResult, reject } from "../lib/jobs.ts";
import { COSTS, can } from "../lib/quota.ts";
import { cleanExample, ownReplyTexts, snsAdapter } from "../lib/reply-adapter.ts";
import { AuthError, failFrom, main, oneLine, type Platform, type RunResult, TransientError } from "../lib/watchkit.ts";
import { progressLine, readBulk, restoreAll, restoreOne } from "../lib/bulk.ts";
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
const usage = (): RunResult => ({ lines: ["usage: sns.ts job new --kind upload|reply|metadata --json <file> | approve <id> [--at ISO|now] | revise <replyJobId> --change <text> | reject <id> | publish <id> | status | tone-sample [--limit N] | restore <videoId>|all | bulk-status | mark-done <id> <platform> [ref]"], code: 2 });

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

export { cleanExample };

async function toneSample(ctx: Ctx, args: string[]): Promise<RunResult> {
	const cfg = loadConfig();
	const limit = Math.min(100, Math.max(1, Number(flag(args, "--limit") ?? 30) || 30));
	const texts: string[] = [];
	for (const platform of PLATFORMS) texts.push(...(await ownReplyTexts(ctx, cfg, platform, limit)));
	const examples = [...new Set(texts.map(cleanExample).filter(Boolean))].slice(0, limit);
	if (!examples.length) return ok("tone-sample 0");
	mkdirSync(dirname(paths.tone()), { recursive: true });
	writeFileSync(paths.tone(), mergeExamples(existsSync(paths.tone()) ? readFileSync(paths.tone(), "utf8") : "", examples));
	return ok(`tone-sample ${examples.length}`);
}

// A reply goes public only on the owner's own 1) 보내기 pick for exactly this job, made after the job was created (hub/draft-approval.ts).
function requirePick(j: Job): void {
	const v = draftVerdict(replyPaths.inbox(), j.id, Date.parse(j.created));
	if (v.verdict === "send") return;
	if (v.verdict === "edit") throw new Error(`고치기를 골랐어요${v.detail ? ` (${v.detail})` : ""}. sns.ts revise ${j.id} --change "<내용>"로 고친 뒤 다시 물어봐 주세요`);
	if (v.verdict === "drop") throw new Error(`보내지 않기로 한 답글이에요. sns.ts reject ${j.id}`);
	throw new Error("아직 보내도 된다는 답을 받지 못했어요");
}

async function dispatch(ctx: Ctx, args: string[], deps: FlowDeps): Promise<RunResult> {
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
			const made = ok(`created ${j.id} ${j.kind} ${j.status}`);
			// The approval card of a Reels upload says it cannot go out yet, instead of the job failing at publish time.
			const blocked = j.kind === "upload" && j.targets.includes("instagram") && publishState().missing;
			return blocked ? { ...made, lines: [...made.lines, `ig-publish-blocked ${j.id}: ${PUBLISH_BLOCKED_CARD}`] } : made;
		}
		case "approve": {
			if (!pos[0]) return usage();
			const before = getJob(pos[0]);
			if (before?.kind === "reply") requirePick(before);
			const j = approve(ctx, pos[0], { publish_at: flag(rest, "--at") });
			return ok(`approved ${j.id} ${j.status} at=${j.publish_at}`);
		}
		case "revise": {
			const j = pos[0] ? getJob(pos[0]) : undefined;
			if (!j?.reply || j.status !== "draft") return usage();
			const r = await reviseComment(snsAdapter(ctx, j.reply.platform), j.id, flag(rest, "--change") ?? "", deps);
			return { lines: [r.text], code: r.ok ? 0 : 1 };
		}
		case "reject": {
			if (!pos[0]) return usage();
			const j = reject(pos[0]);
			if (j.kind === "reply" && getDraft(j.id)?.status === "pending") setStatus(j.id, "dropped");
			return ok(`rejected ${j.id}`);
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
			const cfg = loadConfig();
			if (pos[0] === "all") {
				const r = await restoreAll(ctx, cfg);
				return ok(`restored ${r.restored} left ${r.left}`);
			}
			if (!can(ctx, cfg, COSTS.update)) return { lines: [`failed restore ${pos[0]} quota`], code: 1 };
			await restoreOne(ctx, pos[0]);
			return ok(`restored ${pos[0]}`);
		}
		case "bulk-status": {
			const s = readBulk();
			return ok(s ? progressLine(s) : "다국어 일괄 적용을 시작하지 않았어요");
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

// The real CLI refines the tone identity after a 고치기 with the same subscription model call as the drafts (reply-drafts/lib/persona.ts).
export async function run(ctx: Ctx, args: string[], deps: FlowDeps = { analyze: defaultCall(replySettings().model) }): Promise<RunResult> {
	try {
		return await dispatch(ctx, args, deps);
	} catch (e) {
		if (e instanceof AuthError || e instanceof SetupError || e instanceof TransientError) return failFrom(e);
		return { lines: [`error: ${oneLine(e instanceof Error ? e.message : "unexpected failure", 200)}`], code: 1 };
	}
}

if (import.meta.main) await main(run);
