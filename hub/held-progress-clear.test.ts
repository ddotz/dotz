// A dotz_send held for the turn's answer is shown on the web chat's progress line at once (hub/routes-send.ts). The note that
// releases it (a [later] turn: 2026-11-26 11:18, a final answer) must finalize that line with an empty progress note, as it does
// the gateway's own status; before, only a line the live reporter posted was finalized and the held text stayed up twice.
import { expect, test } from "bun:test";
import * as discord from "./discord.ts";
import { emit, type HubEvent, onEmit } from "./events.ts";
import * as livestatus from "./livestatus.ts";
import { progress } from "./outbound.ts";

test("clearing a conversation's progress also finalizes a held send's web line, once", async () => {
	livestatus.setWebProgress((target, text) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "gateway", target, text, update_key: "progress" }));
	const seen: HubEvent[] = [];
	onEmit(e => void seen.push(e));
	await progress("web", "progress", "HELD-TEXT sent early", undefined, "main", "dotz_send");
	await discord.clearProgress("web");
	await discord.clearProgress("web");
	const lines = seen.filter(e => e.kind === "out" && e.update_key === "progress" && e.target === "web").map(e => e.text);
	expect(lines).toEqual(["HELD-TEXT sent early", ""]);
});
