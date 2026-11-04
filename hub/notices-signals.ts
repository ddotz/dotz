// Hub signals that close a waiting failure or question (rerun passed, update, account). A part of the notice store split out of hub/notices.ts, code unchanged.
import { log, now } from "./config.ts";
import { emit } from "./events.ts";
import { clean, originOf } from "./notices-rules.ts";
import { laneTitle } from "./notices-lanes.ts";
import { summary } from "./notices-read.ts";
import { items, markNoticesRead, resolveAsks, upsert } from "./notices-store.ts";

// A session's work was checked by the orchestrator: its result item turns unread "done" and, once, a compact card goes into
// the main chat (a [done] that is only reported, not yet verified, stays in the bell).
export function laneVerified(name: string, fallbackText: string): void {
	const key = `lane:${name}`;
	const title = laneTitle(name);
	const prior = items.find(n => n.key === key);
	const text = ((prior?.tone === "done" ? prior.text : clean(fallbackText).text) || "확인을 마쳤어요").slice(0, 600);
	// The notice points at the compact card in the main chat, which carries the same ts.
	const at = now();
	resolveAsks(i => originOf(i) === key, at);
	upsert({ kind: "result", tone: "done", title, text, open: key, key, unread: true, src: "main", at });
	emit("outbox", { ts: at, kind: "result", source: "gateway", target: "web", session: name, title, tone: "done", verified: true, text: summary(text), open: key });
}

// The daily self-update check found a new dotz version: one fixed-key item in the bell (a later check updates it in place and
// turns it unread again), opening 설정 → 업데이트.
export const UPDATE_NOTICE_KEY = "self-update";
export function updateAvailable(text: string): void {
	upsert({ kind: "alert", tone: "", title: "새 버전", text: clean(text).text, open: "settings", key: UPDATE_NOTICE_KEY, unread: true });
}

// The Claude account requests really use changed without the owner's pick in the web: only logged. It is no notice (owner 2026-10-23:
// not needed); 설정's account list shows which account is in use.
export function accountUsedChanged(text: string, key: string): void {
	log(`account used changed (${key}): ${clean(text).text}`);
}

// The update was applied or the checkout is current again: the item stays in the list but is read.
export function updateResolved(): void {
	const item = items.find(n => n.key === UPDATE_NOTICE_KEY);
	if (item) markNoticesRead({ ids: [item.id] });
}
