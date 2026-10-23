// Watch (dotz_watch script, every few minutes): reads the new comments of the sources the owner chose and stores them. Zero model tokens:
// it prints nothing unless a source with 자동 초안 on made a draft, and then only that draft's approval [ask].
import { commentAsk } from "../../../hub/comments/ask.ts";
import { realEngine } from "../../../hub/comments/real.ts";
import { createHub } from "../../../hub/kakao/hub.ts";
import { dataDir } from "../../reply-drafts/lib/settings.ts";

export async function run(dir = dataDir(), engine = realEngine(dir), notify: (threads: { source: string; thread: string }[]) => Promise<void> = async t => void (await createHub(dir).post("/api/comments/changed", { threads: t })).status): Promise<string[]> {
	const r = await engine.collect();
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

if (import.meta.main) {
	try {
		const lines = await run();
		if (lines.length) console.log(lines.join("\n\n"));
	} catch (e) {
		console.log("DOTZ_FAIL comments");
		console.log((e as Error).message.slice(0, 200));
		process.exit(1);
	}
}
