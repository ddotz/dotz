import { join } from "node:path";
import { readRun } from "./lib.ts";

const runId = process.argv[2];
if (!runId) {
	console.error("usage: bun .omp/skills/verify-dotz/scripts/seed-auto-reply.ts <run-id> (spawned by drive.ts with the run's env)");
	process.exit(2);
}
const run = readRun(runId);
if (process.env.DOTZ_DIR !== run.data) throw new Error(`DOTZ_DIR must be the run's data dir ${run.data}`);
const mail = JSON.parse(process.env.VERIFY_MAIL ?? "null") as { key: string; target: string; from: string; subject: string; body: string; self: string; id: string };

const flow = await import(join(run.code, "features/reply-drafts/lib/flow.ts"));
const store = await import(join(run.code, "features/reply-drafts/lib/store.ts"));
const answer = { action: "draft", reason: "asks for a meeting time", to: mail.from.replace(/^.*<|>.*$/g, ""), subject: `Re: ${mail.subject}`, body: process.env.VERIFY_DRAFT_BODY ?? "", questions: [] };
const item = { kind: "mail", app: "mail", from: mail.from, self: [mail.self], to: [mail.self], subject: mail.subject, text: mail.body, expected: true };
const built = await flow.buildDraft(item, { source: "zele", mailId: mail.id, ref: mail.key }, { call: async () => `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` });
if (built.action !== "draft") throw new Error(`buildDraft did not draft: ${JSON.stringify(built)}`);
built.rec.mode = "reply";
store.addDraft(built.rec);
store.markDrafted(mail.key);
console.log(JSON.stringify({ id: built.rec.id, text: flow.askText(built.rec, built.warnings) }));
