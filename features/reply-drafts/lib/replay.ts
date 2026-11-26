// `draft.ts replay <ref>`: a recorded draft (its received text, app, mailbox, configured instruction and rule are on the record) goes through the paths a real draft takes
// - the write (flow.ts buildDraft, what `new` and the offer call), the revise (reviseDraft) and the pre-send check (check-draft.ts checkDraft, the one `send` runs) - and nothing is sent.
// The run happens in a scratch data dir holding only what those paths read (config, rule ledger, tone files, mailboxes) with DOTZ_DIR pointing at it, removed at the end: the real
// draft store, learn log, ledger, tone files and cards are never written. The deps it runs with have `send` replaced (and no tool runner), so a send reached anyway throws.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkDraft } from "./check-draft.ts";
import { buildDraft, type FlowDeps, type Meta, reviseDraft } from "./flow.ts";
import { dataDir, paths } from "./settings.ts";
import { addDraft, type DraftCheck, type DraftRec, getDraft } from "./store.ts";

export const DEFAULT_CHANGE = "더 짧고 간단하게 고쳐 주세요";
// What the replayed draft keeps from the record, as a revise keeps it (flow.ts reviseClaimed).
const CARRIED = ["brief", "request", "rule", "origin", "accounts", "compose", "cc", "mode", "ownerRecipients"] as const;

/** The send a replay runs with: `deps.send` is only told (a test's spy), then the answer is a throw. */
export const sendOf = (deps: Pick<FlowDeps, "send">): NonNullable<FlowDeps["send"]> => async rec => {
	await deps.send?.(rec);
	throw new Error("replay never sends");
};

export type Replayed = { ok: boolean; lines: string[]; data: { id: string; change?: string; draft?: string; revised?: string; check?: DraftCheck; error?: string }; draft?: string; revised?: string; check?: DraftCheck };

const shown = (d: DraftRec): string => `${d.subject ? `제목: ${d.subject}\n` : ""}받는 사람: ${d.to}\n${d.body}`;
const checkLines = (c: DraftCheck): string[] => [...c.refuse.map(r => `거절: ${r}`), ...c.warn.map(w => `경고: ${w}`), ...(c.refuse.length || c.warn.length ? [] : ["문제 없어요"])];

// The files the draft paths read, copied as they are into the scratch dir (never the other way).
function copyScratch(from: string, to: string): void {
	for (const file of [paths.config(from), paths.ledger(from), join(dirname(paths.config(from)), "tone"), join(from, "custom", "mailboxes.json")])
		if (existsSync(file)) {
			mkdirSync(dirname(join(to, relative(from, file))), { recursive: true });
			cpSync(file, join(to, relative(from, file)), { recursive: true });
		}
}

/** Replays the stored draft `id` with `change` (default: a short one) without sending or writing real data. */
export async function replay(id: string, change: string | undefined, deps: FlowDeps): Promise<Replayed> {
	const rec = getDraft(id);
	if (!rec) {
		const error = `초안 ${id}을(를) 찾지 못했어요`;
		return { ok: false, lines: [error], data: { id, error } };
	}
	const asked = change?.trim() || DEFAULT_CHANGE;
	const real = dataDir(), before = process.env.DOTZ_DIR, scratch = mkdtempSync(join(tmpdir(), "dotz-replay-"));
	const lines = [`재연: ${id} (${rec.app}) - 보내지 않고 초안 -> 고치기 -> 발송 직전 검사만 돌려요`];
	const data: Replayed["data"] = { id, change: asked };
	const stopped = (error: string, extra: Partial<Replayed["data"]> = {}): Replayed => ({ ok: false, lines: [...lines, "", error], data: { ...data, ...extra, error }, ...(extra.draft ? { draft: extra.draft } : {}) });
	try {
		copyScratch(real, scratch);
		process.env.DOTZ_DIR = scratch;
		const flow: FlowDeps = { ...deps, run: undefined, send: sendOf(deps) };
		const meta: Meta = { source: rec.source, mailId: rec.mailId, ref: rec.ref, ...(rec.box && rec.instance ? { box: rec.box, instance: rec.instance } : {}), ...(rec.account ? { account: rec.account } : {}), ...(rec.origAttachments ? { origAttachments: rec.origAttachments } : {}), ...(rec.rule ? { rule: rec.rule } : {}) };
		const built = await buildDraft(rec.request === undefined ? rec.item : { ...rec.item, text: rec.request }, meta, flow).catch((e: Error) => ({ action: "failed" as const, reason: e.message }));
		if (built.action !== "draft") return stopped(`초안 단계에서 멈췄어요: ${built.action === "ask" ? built.question : built.reason}`);
		for (const k of CARRIED) if (rec[k] !== undefined) Object.assign(built.rec, { [k]: rec[k] });
		addDraft(built.rec);
		const draft = shown(built.rec);
		lines.push("", "[1] 초안", draft);
		const step = await reviseDraft(built.rec.id, asked, flow, { learn: false }).catch((e: Error) => ({ ok: false, text: e.message, id: undefined }));
		const revised = step.ok && step.id ? getDraft(step.id) : undefined;
		if (!revised) return stopped(`고치기 단계에서 멈췄어요: ${step.text}`, { draft });
		lines.push("", `[2] 고친 초안 (고칠 말: ${asked})`, shown(revised));
		const check = await checkDraft(revised, undefined, revised.check?.judged ?? []);
		lines.push("", "[3] 발송 직전 검사", ...checkLines(check), "", "발송은 하지 않았어요");
		return { ok: true, lines, data: { ...data, draft, revised: shown(revised), check }, draft, revised: shown(revised), check };
	} finally {
		if (before === undefined) delete process.env.DOTZ_DIR;
		else process.env.DOTZ_DIR = before;
		rmSync(scratch, { recursive: true, force: true });
	}
}
