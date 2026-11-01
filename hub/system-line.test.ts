// A gateway status line (outbound.ts systemNote, e.g. the [later] deferral receipt) is marked `system` on its event: the web draws it as
// a compact system line, it never counts as unread and it never pushes.
import { expect, test } from "bun:test";
import { unreadOf } from "./conversations.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { systemNote } from "./outbound.ts";
import { classify } from "./push.ts";

test("a deferral receipt is a system event: flagged, not unread, no push", async () => {
	const seen: HubEvent[] = [];
	onEmit(e => void (e.kind === "out" && e.target === "web" && seen.push(e)));
	const before = unreadOf("main");
	await systemNote("web", "백그라운드 작업으로 맡겼어요: 홈 진행 중 목록 다듬기", "deferred", "st_w1");
	const e = seen.find(x => String(x.text).startsWith("백그라운드 작업으로 맡겼어요"));
	expect(e).toMatchObject({ source: "gateway", system: "deferred", worker: "st_w1" });
	expect(unreadOf("main")).toBe(before);
	expect(classify(e!, 10 * 60_000)).toBeUndefined();
});
