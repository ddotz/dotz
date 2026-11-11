import { afterAll, expect, test } from "bun:test";
import { type HubEvent, emit } from "./events.ts";
import { deriveSpec } from "./message-spec-derive.ts";
import { fakeHub, json, on } from "./test-web.ts";

// An answer's leading status mark is the status tag a [done] answer draws, never the mark as words (owner 2026-11-09: a fail mark must not show as
// plain text). The answers go through emit, so each carries the spec the hub stores; the last one is a spec stored before the hub read the emoji.
const ts = (n: number) => `2026-11-09T18:${String(10 + n).padStart(2, "0")}:00.000Z`;
const body = "점검을 끝냈어요. 점수가 올랐어요.\n\n- **점수:** 83.85 → 93.49\n- **상태:** 정상";
const texts = { marker: `[done] ${body}`, emoji: `✅ ${body}`, both: `[ask] ✅ ${body}`, failed: "❌ 빌드가 깨졌어요.", talk: "네, 알겠어요." };
const events: HubEvent[] = Object.values(texts).map((text, n) => ({ ts: ts(n), kind: "out", source: "orchestrator", target: "main", text }));
for (const e of events) emit("outbox", e);
events.push({ ts: ts(9), kind: "out", source: "orchestrator", target: "main", text: texts.emoji, spec: deriveSpec(texts.emoji) });
const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? events : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor } = on(view);
const md = (n: number) => `document.querySelector('[data-ts="${ts(n)}"] .md')`;
const page = async <T>(expr: string) => JSON.parse((await view.evaluate(`JSON.stringify(${expr})`)) as string) as T;
// What the first line of an answer shows: its status tag, the words after it, and whether the tag sits in that line as [done] puts it.
const first = (n: number) => page<[string, string, boolean]>(`(() => { const p = ${md(n)}.firstElementChild, tag = p.querySelector(":scope > .st-tag");
	return [tag?.textContent ?? "", p.textContent.slice(tag?.textContent.length ?? 0).trim(), p.firstChild === tag]; })()`);

test("a ✅ or ❌ in front is the status tag, drawn as [done] draws it; an answer with no mark has none", async () => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S`);
	await view.evaluate(`(openTarget("main", "chat"), 0)`);
	await waitFor(`${md(9)} !== null`);
	expect(await first(0)).toEqual(["완료", "점검을 끝냈어요. 점수가 올랐어요.", true]);
	expect(await first(1)).toEqual(await first(0));
	expect(await page<string>(`${md(1)}.innerHTML`)).toBe(await page<string>(`${md(0)}.innerHTML`));
	// The marker wins over the emoji after it, and the emoji goes with it.
	expect(await first(2)).toEqual(["확인 필요", "점검을 끝냈어요. 점수가 올랐어요.", true]);
	expect(await first(3)).toEqual(["실패", "빌드가 깨졌어요.", true]);
	expect(await first(4)).toEqual(["", "네, 알겠어요.", false]);
	expect(await page<string>(`${md(9)}.innerHTML`)).toBe(await page<string>(`${md(1)}.innerHTML`));
});
