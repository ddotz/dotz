// Watch (dotz_watch script, every few minutes): reads the new comments of the sources the owner chose and stores them. Zero model tokens:
// it prints nothing unless a source with 자동 초안 on made a draft, and then only that draft's approval [ask].
import { commentAsk } from "../../../hub/comments/ask.ts";
import type { SourceConfig } from "../../../hub/comments/contract.ts";
import { realEngine } from "../../../hub/comments/real.ts";
import { appEntries, commentOwner, readAppsFile } from "../../../hub/integrations.ts";
import { createHub } from "../../../hub/kakao/hub.ts";
import { dataDir } from "../../reply-drafts/lib/settings.ts";

/** The source app instance's 디스코드 채널 (custom/apps.json "<instance>.discord_channel", hub/app-settings.ts), or undefined (web only). */
export function channelOf(dir: string, source: string, kind: SourceConfig["kind"]): string | undefined {
	const id = readAppsFile(dir)[commentOwner(appEntries(dir), kind === "website" ? "site" : kind, source)]?.discord_channel;
	return typeof id === "string" && /^\d{15,25}$/.test(id.trim()) ? id.trim() : undefined;
}

// A draft whose app has a channel is posted there by the gateway as the one card (same draft id: 보내기 there or in the web sends it once),
// so it is not printed for the orchestrator to post again; a post that fails is printed as before.
const sendTo = (dir: string) => async (target: string, text: string): Promise<boolean> => {
	const r = await createHub(dir).post("/api/send", { target, text });
	return r.status === 200 && (r.json as { delivered?: boolean } | undefined)?.delivered !== false;
};

export async function run(dir = dataDir(), engine = realEngine(dir), notify: (threads: { source: string; thread: string }[]) => Promise<void> = async t => void (await createHub(dir).post("/api/comments/changed", { threads: t })).status, post: (target: string, text: string) => Promise<boolean> = sendTo(dir)): Promise<string[]> {
	const r = await engine.collect();
	const touched = [...new Map([...r.added, ...r.drafted.map(d => ({ source: d.source, thread: d.thread }))].map(x => [`${x.source}/${x.thread}`, { source: x.source, thread: x.thread }])).values()];
	if (touched.length) await notify(touched).catch(() => {});
	const cfg = engine.store.config();
	const sentIds = new Set(r.sent.map(s => s.draft));
	const lines: string[] = [];
	for (const d of r.drafted.filter(d => !sentIds.has(d.code))) {
		const c = engine.store.comments().find(x => x.id === d.commentId);
		const src = cfg.sources[d.source];
		if (!c || !src) continue;
		const ask = commentAsk(src, c, d, undefined, engine.mailView(d));
		const ch = channelOf(dir, d.source, src.kind);
		if (ch && (await post(`ch:${ch}`, ask).catch(() => false))) continue;
		lines.push(ask);
	}
	return lines;
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
