// A prompt one session hands to another, and the handback, draw in the receiving conversation as the same collapsed card as the schedule start:
// the conversation it came from in the header, the full text behind the fold. Headless (Bun.WebView), small fake hub, demo data only.
// HANDED_SHOTS=<dir> keeps screenshots of one conversation holding both rows (390 and 1280 wide).
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { fakeHub, json, type View } from "./test-web.ts";

const SHOTS = process.env.HANDED_SHOTS;
const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 1, m)).toISOString();
const SENT = "두 번째 항목을 확인해 주세요. 결과는 이 대화로 돌려주세요.\n\n바뀐 것이 없으면 그렇게만 적어 주세요.";
const BACK = "확인을 마쳤어요. 바뀐 것은 없어요.";
const history = [
	{ ts: at(0), kind: "schedule", source: "schedule", channel: "ch:7001", id: "s1", every: "daily", text: "ch:7001 데모 예약 일을 확인해요" },
	{ ts: at(1), kind: "handed", source: "session", channel: "ch:7001", from: "main", text: SENT },
	{ ts: at(2), kind: "out", source: "orchestrator", target: "ch:7001", text: "받았어요. 확인해 볼게요." },
	{ ts: at(3), kind: "handed", source: "session", channel: "ch:7001", from: "ch:7002", handback: true, text: BACK },
];
const hub = fakeHub({
	stream: "fake",
	state: () => ({ name: "dotz", orchestrator: { status: "idle" }, runs: {}, lanes: [], terminals: {}, channels: { work: { "7001": "데모 프로젝트", "7002": "데모 보조 프로젝트" } }, discord: {}, notices_unread: 0, work: [], work_now: Date.now() }),
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: "ch:7001", events: url.searchParams.get("before") ? [] : history });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/integrations") return json({ items: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: [{ key: "ch:7001", name: "데모 프로젝트", pinned: false, lanes: [], newest: 0, channel: { id: "7001", name: "데모 프로젝트" }, recordKey: "ch:7001" }], routines: [], links: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());

const until = (v: View, cond: string) => v.evaluate(`new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = (${cond}); } catch {} if (ok) res(true); else if (Date.now() - t0 > 8000) rej(new Error("timeout")); else requestAnimationFrame(tick); }; tick(); })`);
const read = async <T>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;

for (const [width, height] of [[390, 844], [1280, 900]] as const) {
	test(`handed text and handback draw as collapsed rows of the receiving conversation at ${width}px`, async () => {
		const v = await hub.view({ width, height });
		await v.navigate(`${hub.origin}/#chat/ch:7001`);
		await until(v, `typeof go === "function" && CV.loaded && current === "chat" && target === "ch:7001" && document.querySelectorAll("#tl .rc").length >= 3`);
		const rows = await read<{ src: string; title: string; raw: string; open: boolean; cls: string }[]>(v, `return [...document.querySelectorAll("#tl .rc")].map(r => ({ cls: r.className, src: (r.querySelector(".rc-src") || {}).textContent || "", title: (r.querySelector(".rc-title") || {}).textContent || "", raw: (r.querySelector(".rc-rawbody") || {}).textContent || "", open: !!(r.querySelector("details.rc-raw") || {}).open }))`);
		expect(rows.length).toBe(3);
		const [schedule, sent, back] = rows as [typeof rows[0], typeof rows[0], typeof rows[0]];
		for (const r of [sent, back]) {
			expect(r.cls).toBe(schedule.cls);
			expect(r.open).toBe(false);
		}
		expect(sent.src).toContain("dotz");
		expect(back.src).toContain("데모 보조 프로젝트");
		expect(sent.title).not.toBe(back.title);
		await v.evaluate(`document.querySelectorAll("#tl .rc details.rc-raw").forEach(d => { d.open = true; d.dispatchEvent(new Event("toggle")); }), 0`);
		await until(v, `[...document.querySelectorAll("#tl .rc .rc-rawbody")].every(b => b.textContent.trim())`);
		const raw = await read<string[]>(v, `return [...document.querySelectorAll("#tl .rc .rc-rawbody")].map(b => b.innerText.replace(/\\s+/g, " ").trim())`);
		expect(raw.at(-2)).toBe(SENT.replace(/\s+/g, " "));
		expect(raw.at(-1)).toBe(BACK);
		await v.evaluate(`timeline.scrollTop = timeline.scrollHeight`);
		if (SHOTS) await Bun.write(join(SHOTS, `handed-rows-${width}.png`), await v.screenshot());
	}, 60_000);
}
