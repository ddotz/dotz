// Gateway start (hub/main.ts): a web progress line still shown from a turn that ran before the start is finalized with an empty
// progress note, which the page drops (web/js/11-todo-strip.js); an answered or already cleared one is left alone.
import { expect, test } from "bun:test";
import { emit, type HubEvent, onEmit } from "./events.ts";
import { clearLeftWebProgress } from "./outbound.ts";

test("gateway start finalizes only the progress lines no answer or clear followed", () => {
	const at = () => new Date().toISOString();
	const note = (target: string, text: string) => emit("outbox", { ts: at(), kind: "out", source: "gateway", target, text, update_key: "progress" });
	note("ch:left-1", "[run] 5분째 작업 중이에요.");
	note("ch:answered", "[run] 5분째 작업 중이에요.");
	emit("outbox", { ts: at(), kind: "out", source: "orchestrator", target: "ch:answered", text: "[done] 끝났어요" });
	note("ch:cleared", "[run] 5분째 작업 중이에요.");
	note("ch:cleared", "");
	// After its answer, as on 2026-11-01 02:58 → 03:01.
	emit("outbox", { ts: at(), kind: "out", source: "orchestrator", target: "lane:left-2", text: "[done] 답" });
	note("lane:left-2", "[run] 5분째 작업 중이에요.");
	const seen: HubEvent[] = [];
	let on = true;
	onEmit(e => void (on && seen.push(e)));
	clearLeftWebProgress();
	on = false;
	const mine = new Set(["ch:left-1", "ch:answered", "ch:cleared", "lane:left-2"]);
	const cleared = seen.filter(e => e.kind === "out" && e.update_key === "progress" && e.text === "" && mine.has(String(e.target))).map(e => e.target);
	expect(cleared).toEqual(["ch:left-1", "lane:left-2"]);
});
