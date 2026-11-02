// Watch (dotz_watch script, every few minutes): reads the new comments of the sources the owner chose and stores them. Zero model tokens:
// it prints nothing unless a source with 자동 초안 on made a draft, and then only that draft's approval [ask].
import { commentAsk } from "../../../hub/comments/ask.ts";
import { realEngine } from "../../../hub/comments/real.ts";
import { createHub } from "../../../hub/kakao/hub.ts";
import { dataDir } from "../../reply-drafts/lib/settings.ts";

// The hub kills the watch at 600 s. After RUN_BUDGET_MS no source is read and no draft is started (the queue keeps the rest for the next
// run); every read, post and model call has its own timeout, so a run ends well before the kill. HARD_STOP_MS is the last guard.
const RUN_BUDGET_MS = 240_000;
const HARD_STOP_MS = 480_000;

export async function run(dir = dataDir(), engine = realEngine(dir), notify: (threads: { source: string; thread: string }[]) => Promise<void> = async t => void (await createHub(dir).post("/api/comments/changed", { threads: t })).status, deadline = Date.now() + RUN_BUDGET_MS): Promise<string[]> {
	const r = await engine.collect({ deadline });
	const touched = [...new Map([...r.added, ...r.drafted.map(d => ({ source: d.source, thread: d.thread }))].map(x => [`${x.source}/${x.thread}`, { source: x.source, thread: x.thread }])).values()];
	if (touched.length) await notify(touched).catch(() => {});
	const cfg = engine.store.config();
	const sentIds = new Set(r.sent.map(s => s.draft));
	return r.drafted
		.filter(d => !sentIds.has(d.code))
		.flatMap(d => {
			const c = engine.store.comments().find(x => x.id === d.commentId);
			const src = cfg.sources[d.source];
			return c && src ? [commentAsk(src, c, d, undefined, engine.mailView(d))] : [];
		});
}

// Explicit exits: a draft's model call leaves a warm `omo --mode rpc` process (hub/model-runner.ts, idle-killed after 10 min) whose pipes
// keep Bun alive after the work is done, which made the hub kill a finished run at 600 s. Drafts are stored before they are printed.
if (import.meta.main) {
	setTimeout(() => {
		console.log("DOTZ_FAIL comments");
		console.log(`run took longer than ${HARD_STOP_MS / 1000}s`);
		process.exit(1);
	}, HARD_STOP_MS).unref();
	try {
		const lines = await run();
		if (lines.length) console.log(lines.join("\n\n"));
		process.exit(0);
	} catch (e) {
		console.log("DOTZ_FAIL comments");
		console.log((e as Error).message.slice(0, 200));
		process.exit(1);
	}
}
