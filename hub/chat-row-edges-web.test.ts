// Edges of drawing a conversation's rows (chat-ui audit 2026-11-16, Bundle F): a conversation of rows that draw nothing keeps its empty state, a mail
// without a subject is its text, two events of one ms and one opening are two rows, and a page merged into 알림 after the owner moved on still keeps
// only the newest version of a keyed post. Headless (Bun.WebView), small fake hub, demo data only.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, type View } from "./test-web.ts";

const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 1, m)).toISOString();
const SAME = at(2);
const histories: Record<string, unknown[]> = {
	"ch:7001": [{ ts: at(0), kind: "schedule", source: "gateway", channel: "ch:7001", text: "데모 점검을 다시 해요" }],
	"ch:7002": [
		{ ts: at(1), kind: "mail", source: "mail", channel: "ch:7002", text: "제목 없는 데모 메일 본문" },
		{ ts: SAME, kind: "out", source: "gateway", target: "ch:7002", id: "g1", text: "데모 알림 줄" },
		{ ts: SAME, kind: "out", source: "gateway", target: "ch:7002", id: "g2", text: "데모 알림 줄" },
	],
};
const project = (id: string, name: string) => ({ key: `ch:${id}`, name, pinned: false, lanes: [], newest: 0, channel: { id, name }, recordKey: `ch:${id}` });
const hub = fakeHub({
	stream: "fake",
	state: () => ({ name: "dotz", orchestrator: { status: "idle" }, runs: {}, lanes: [], terminals: {}, channels: { work: { "7001": "데모 하나", "7002": "데모 둘" } }, discord: {}, notices_unread: 0, work: [], work_now: Date.now() }),
	api: (_req, url) => {
		const p = url.pathname, t = url.searchParams.get("target") || "";
		if (p === "/api/history") return json({ target: t, events: url.searchParams.get("before") ? [] : histories[t] || [] });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/integrations") return json({ items: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: [project("7001", "데모 하나"), project("7002", "데모 둘")], routines: [], links: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());

const until = (v: View, cond: string) => v.evaluate(`new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = (${cond}); } catch {} if (ok) res(true); else if (Date.now() - t0 > 8000) rej(new Error("timeout")); else requestAnimationFrame(tick); }; tick(); })`);
const read = async <T>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const open = async (t: string) => {
	const v = await hub.view({ width: 390, height: 844 });
	await v.navigate(`${hub.origin}/#chat/${t}`);
	await until(v, `typeof go === "function" && CV.loaded && current === "chat" && target === "${t}" && ts("${t}").hLoaded && CV.full`);
	return v;
};

test("a conversation whose only row draws nothing shows the empty state and no day divider", async () => {
	const v = await open("ch:7001");
	const got = await read<{ empty: number; dividers: number; rows: number }>(v, `return { empty: tl.querySelectorAll(".empty").length, dividers: tl.querySelectorAll(".a-div").length, rows: tl.querySelectorAll("[data-ts]").length }`);
	expect(got).toEqual({ empty: 1, dividers: 0, rows: 0 });
}, 60_000);

test("a mail without a subject is its text, and two events of one ms and one opening are two rows", async () => {
	const v = await open("ch:7002");
	const got = await read<{ mail: { md: boolean; card: boolean; text: string }; same: number; keys: number }>(v, `
		const m = tl.querySelector('[data-ts="${at(1)}"]');
		return { mail: { md: m.classList.contains("md"), card: !!m.closest(".rc") || m.classList.contains("rc"), text: m.textContent.trim() },
			same: tl.querySelectorAll('[data-ts="${SAME}"]').length, keys: new Set(ts("ch:7002").msgs.map(msgKey)).size };`);
	expect(got).toEqual({ mail: { md: true, card: false, text: "제목 없는 데모 메일 본문" }, same: 2, keys: 3 });
}, 60_000);

test("a page merged into 알림 while another conversation is open keeps only the newest version of a keyed post", async () => {
	const v = await open("ch:7002");
	const texts = await read<string[]>(v, `
		const s = ts("alert");
		chatMerge(s, { events: [
			{ ts: "${at(10)}", kind: "out", source: "gateway", target: "alert", update_key: "demo", text: "v1" },
			{ ts: "${at(11)}", kind: "out", source: "gateway", target: "alert", update_key: "demo", text: "v2" },
		] });
		return s.msgs.filter(e => e.update_key === "demo").map(e => e.text);`);
	expect(texts).toEqual(["v2"]);
}, 60_000);
