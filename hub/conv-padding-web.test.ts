import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, type View } from "./test-web.ts";

// Every conversation screen keeps its messages, divider and composer at the same inner insets as the general chat window.
// Compares computed boxes between surfaces at the same width (not a pinned number). Headless (Bun.WebView), small fake hub, demo data only.
const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 1, m)).toISOString();
const MD = "첫 문단이에요. 줄이 길어지면 아래로 이어지도록 조금 길게 써요. 데모용 글이에요.\n\n- 첫째 항목이에요.\n- 둘째 항목이에요.\n\n마지막 문단이에요.";
const hist = (t: string) => {
	const ev: Record<string, unknown>[] = [];
	if (t.startsWith("mail:")) ev.push({ ts: at(0), kind: "mail", source: "fx", channel: t, conv: t, mail: t.slice(5), subject: "데모 제목", from: "Alex Sender <sender@example.com>", text: "Alex Sender <sender@example.com> · 데모 제목\n\n요약\n내용이 있어요.\n\n원문\n데모 본문이에요." });
	ev.push({ ts: at(1), kind: "out", source: "orchestrator", target: t, text: "이전 답변이에요." });
	ev.push({ ts: at(2), kind: "message", source: "owner", target: t, channel: "web", text: "데모 질문이에요." });
	ev.push({ ts: at(3), kind: "out", source: "orchestrator", target: t, text: MD });
	ev.push({ ts: at(4), kind: "out", source: "orchestrator", target: t, text: MD });
	return ev;
};
const TARGETS = ["main", "lane:demo", "ch:7001", "mail:fx-1"];
const hub = fakeHub({
	stream: "fake",
	state: () => ({ name: "dotz", orchestrator: { status: "idle" }, runs: {}, lanes: [{ name: "demo", status: "working", live: true, session: "demo", home: "ch:7001" }], terminals: {}, channels: { work: { "7001": { name: "데모 프로젝트" } } }, discord: {}, notices_unread: 0, work: [], work_now: Date.now() }),
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/history") { const t = url.searchParams.get("target") ?? "main"; return json({ target: t, events: url.searchParams.get("before") ? [] : hist(t) }); }
		if (p === "/api/conversations") return json({ items: TARGETS.map(t => ({ target: t, unread: 2, read: at(2), last: { ts: at(4), text: "마지막 줄", from: "bot" }, ...(t.startsWith("mail:") ? { mail: { subject: "데모 제목", from: "Alex Sender <sender@example.com>", source: "fx", at: at(0), summary: "요약\n내용이 있어요.", n: 1 } } : {}) })) });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/integrations") return json({ items: [{ key: "mail", label: "메일", icon: "mail", conv: ["mail:"], unread: 0, notices: [] }] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: [{ key: "ch:7001", name: "데모 프로젝트", pinned: false, lanes: [], newest: 0, channel: { id: "7001", name: "데모 프로젝트" }, recordKey: "ch:7001" }], routines: [], links: [] });
		return undefined;
	},
});
afterAll(() => hub.stop());

// Insets of the first message text, the read divider and the composer's input row from the conversation column (.chatbox), measured on real boxes.
const PAGE = `(() => {
	const col = document.querySelector("#v-chat .chatbox").getBoundingClientRect();
	const ink = e => { const r = document.createRange(); r.selectNodeContents(e); const rs = [...r.getClientRects()].filter(x => x.width > 0); return { left: Math.min(...rs.map(x => x.left)), right: Math.max(...rs.map(x => x.right)) }; };
	const inset = b => ({ l: +(b.left - col.left).toFixed(1), r: +(col.right - b.right).toFixed(1) });
	const msg = [...document.querySelectorAll("#tl > .bm:not(.rc)")].find(e => e.getClientRects().length && e.querySelector(".md"));
	return JSON.stringify({ msg: inset(ink(msg.querySelector(".md > p, .md"))), divider: inset(document.querySelector("#tl .cv-new").getBoundingClientRect()), send: inset(document.querySelector("#send").getBoundingClientRect()) });
})()`;
const until = (v: View, cond: string, what: string) => v.evaluate(`new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = (${cond}); } catch {} if (ok) res(true); else if (Date.now() - t0 > 8000) rej(new Error(${JSON.stringify(what)})); else requestAnimationFrame(tick); }; tick(); })`);

type Insets = { msg: { l: number; r: number }; divider: { l: number; r: number }; send: { l: number; r: number } };
const SURFACES = [
	{ name: "chat", hash: "#chat", ready: `target === "main"` },
	{ name: "project chat", hash: "#chat/ch:7001", ready: `target === "ch:7001"` },
	{ name: "session chat", hash: "#chat/lane:demo", ready: `target === "lane:demo"` },
	{ name: "mail conversation", hash: "#monitoring/c:mail%3Afx-1", ready: `monCtx === "mail:fx-1"` },
];

for (const width of [1280, 390]) {
	test(`conversation insets match the general chat at ${width}px`, async () => {
		const got: Record<string, Insets> = {};
		for (const s of SURFACES) {
			const v = await hub.view({ width, height: 900 });
			await v.navigate(`${hub.origin}/?s=${encodeURIComponent(s.name)}${s.hash}`);
			await until(v, `typeof go === "function" && CV.loaded && current === "chat" && ${s.ready} && document.querySelectorAll("#tl > .bm:not(.rc) .md").length >= 2 && document.querySelector("#tl .cv-new")`, `ready ${s.name}`);
			await until(v, `document.getAnimations().every(a => a.playState !== "running")`, `settled ${s.name}`);
			got[s.name] = JSON.parse((await v.evaluate(PAGE)) as string) as Insets;
		}
		const ref = got.chat as Insets;
		for (const s of SURFACES.slice(1)) expect({ surface: s.name, ...got[s.name] }).toEqual({ surface: s.name, ...ref });
	}, 60_000);
}
