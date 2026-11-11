import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// An app that belongs to another computer is drawn in the same frame as the same app on this one (owner 2026-11-11; docs/web-app-design.md 앱 틀): the app's panel at the 채팅 list box, its screen
// at the 채팅 content box. Two fake gateways serve the same demo data: one as this computer's own, one as a peer's snapshot (/api/monitoring/peers, read and answered through /api/peer/proxy).
// The measured boxes of the two are compared with each other, never with pinned numbers. Names and texts are placeholders.
const SHOTS = process.env.PEER_SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const MINI = "http://mini.test";
const now = new Date(Date.now() - 5 * 60_000).toISOString();
const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const MAIL_T = "mail:acme-1";
const MAILS = [MAIL_T, "mail:acme-2"];
const mail = (key: string) => ({ key, subject: "견적 요청", from: "Kim <kim@example.com>", source: "acme", at: now, summary: "다음 주까지 견적을 받고 싶어요.", reply: "none", unread: true });
const conv = (t: string) => ({ target: t, mail: mail(t.slice(5)), last: { ts: now, text: "견적 요청 메일", via: "acme" }, unread: 1 });
const app = (key: string, label: string, icon: string, extra: object = {}) => ({ key, label, icon, kind: "app", unread: 1, notices: [], needs: { drafts: 0, unread: 1, sentToday: 0 }, ...extra });
const BOXES = [{ id: "base", name: "일반", icon: "mail", base: true }, { id: "biz", name: "업무", icon: "mail" }];
const MAIL_APP = app("mail", "메일", "mail", { app: "mail", account: "acme@example.com", boxes: BOXES, conv: ["mail:"] });
const YT_APP = app("youtube", "유튜브", "youtube", { conv: [] });
const WATCH = { name: "디스크 점검", watch: "disk-check", kind: "watch", every: "10분마다", last_run: now, last_result: "ok", next_run: later(5), fails: 0 };
const COMMENTS = [{ id: "cm:youtube:c1", parent: null, author: "가나", text: "영상 잘 봤어요", at: Date.parse(now), mine: false, needsReply: true }];

// The routes both computers answer: this computer's own, and the same ones behind /api/peer/proxy.
function appApi(p: string, search: string): Response | undefined {
	if (/^\/api\/integrations\/[a-z]+(~[a-z0-9]+)?\/settings$/.test(p)) return json({ key: "x", fields: [{ key: "label", label: "앱 이름", type: "text", help: "", max: 30, switch: true, value: "앱" }] });
	if (p === "/api/history") return json({ target: new URLSearchParams(search).get("target"), events: [] });
	if (p.startsWith("/api/mail/") && p.endsWith("/body")) return json({ key: p.split("/")[3], text: "견적서를 보내 주세요.", html: "" });
	if (p === "/api/comments/sources") return json({ on: true, sources: [{ key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false, autoSend: false, error: null, ranAt: Date.parse(now) }] });
	if (p === "/api/comments/threads") return json({ threads: [{ source: "youtube", thread: "v1", title: "첫 번째 영상", link: "https://video.example/v1", lastAt: Date.parse(now), lastText: "영상 잘 봤어요", lastAuthor: "가나", unread: 1, drafts: 0 }] });
	if (p === "/api/comments/thread/youtube/v1") return json({ source: { key: "youtube", kind: "youtube", label: "유튜브 댓글" }, thread: { id: "v1", title: "첫 번째 영상", link: "https://video.example/v1" }, comments: COMMENTS, read: null, drafts: [], sends: [] });
	if (p === "/api/comments/drafts") return json({ drafts: [], sends: [] });
	if (p.startsWith("/api/comments/")) return json({});
	return undefined;
}
const data = () => ({ monitors: [WATCH], notices: [], integrations: [MAIL_APP, YT_APP], conversations: MAILS.map(conv) });

function gateway(peer: boolean) {
	const d = data();
	return fakeHub({
		stream: "fake",
		api: async (req, url) => {
			const p = url.pathname;
			if (p === "/api/peers") return json(peer ? [{ name: "맥북", url: "http://self.test", self: true, online: true }, { name: "맥미니", url: MINI, self: false, online: true }] : []);
			if (p === "/api/monitoring/peers") return json(peer ? [{ name: "맥미니", url: MINI, online: true, stale: false, items: { name: "맥미니", rev: "r1", ...d } }] : []);
			if (p === "/api/peer/proxy") return appApi(url.searchParams.get("p")?.split("?")[0] ?? "", (url.searchParams.get("p") ?? "").split("?")[1] ?? "") ?? json({});
			if (p === "/api/activity") return json({ items: [], more: false, history: false });
			if (p === "/api/notices") return json({ unread: 0, items: peer ? [] : d.notices });
			if (p === "/api/monitors") return json({ items: peer ? [] : d.monitors });
			if (p === "/api/integrations") return json({ items: peer ? [] : d.integrations });
			if (p === "/api/conversations") return json({ items: peer ? [] : d.conversations });
			return appApi(p, url.search);
		},
	});
}
const local = gateway(false), peer = gateway(true);
afterAll(() => { local.stop(); peer.stop(); });

type Box = { x: number; r: number; y: number; w: number };
const box = (v: View, sel: string) => ev<Box | null>(v, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), w: Math.round(b.width), r: Math.round(b.right), y: Math.round(b.top) }; })()`);
const still = (v: View) => waitFor(v, `document.getAnimations().length === 0`);

type Side = "local" | "peer";
const key = (side: Side, inst: string) => (side === "local" ? `i:${inst}` : `p:${MINI}|i:${inst}`);
async function boot(side: Side, width: number, inst: string): Promise<View> {
	const hub = side === "local" ? local : peer;
	const v = await hub.view({ width, height: 900 });
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && INTG.loaded`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("monitoring")`);
	await waitFor(v, `PQ.loaded && monItems().some(i => i.key === ${JSON.stringify(key(side, inst))})`);
	return v;
}
type Shape = { panel: Box | null; content: Box | null; row: Box | null };
// the boxes measured are drawn: a peer's reads come back through the proxy later than this computer's own, so the wait is for the measured parts themselves
const drawn = (v: View, sels: string[]) => waitFor(v, sels.map(s => `(e => !!e && e.getBoundingClientRect().width > 0)(document.querySelector(${JSON.stringify(s)}))`).join(" && "));
const shape = async (v: View, panel: string, content: string, row: string): Promise<Shape> => ({ panel: await box(v, panel), content: await box(v, content), row: await box(v, row) });
// one picture per theme; the page goes back to light afterwards
const shoot = async (v: View, name: string) => {
	if (!SHOTS) return;
	for (const theme of ["light", "dark"]) {
		await run(v, `if (dotzTheme.get() !== "${theme}") dotzTheme.toggle()`);
		await Bun.write(join(SHOTS, `${name}-${theme}.png`), await v.screenshot());
	}
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
};

type Sel = [panel: string, content: string, row: string];
type Flow = { inst: string; list: string; open: string; opened: string; screen: { wide: Sel; narrow: Sel }; item: { wide: Sel; narrow: Sel } };
const FLOWS: Record<string, Flow> = {
	mail: {
		inst: "mail",
		list: `!MON.list && document.querySelector("#mon-tl .bm.mr[data-t]")`,
		open: `document.querySelector("#mon-tl .bm.mr[data-t] .rc-title").click()`,
		opened: `current === "chat" && target === ${JSON.stringify(MAIL_T)} && document.querySelector("#chat-convo") && !document.querySelector("#timeline:empty")`,
		screen: { wide: ["#mx-pane", "#mon-head", "#mon-tl .bm.mr"], narrow: ["#mon-tl .mx-tabs", "#mon-tl", "#mon-tl .bm.mr"] },
		item: { wide: ["#chat-convo", "#v-chat .chatbox", "#chat-convo .mx-pr"], narrow: ["#v-chat", "#v-chat .chatbox", "#timeline"] },
	},
	youtube: {
		inst: "youtube",
		list: `!$("#cm").hidden && CM.loaded && document.querySelector("#cm-rooms .kk-row")`,
		open: `document.querySelector("#cm-rooms .kk-row").click()`,
		opened: `CM.open && !CM.loading && document.querySelector("#cm-in .kk-m, #cm-in .cm-c")`,
		screen: { wide: ["#cm-rooms", "#mon-head", "#cm-rooms .kk-row"], narrow: ["#cm-rooms", "#cm-rooms", "#cm-rooms .kk-row"] },
		item: { wide: ["#cm-rooms", "#cm-chat", "#cm-rooms .kk-row"], narrow: ["#cm-chat", "#cm-chat", "#cm-in .kk-m, #cm-in .cm-c"] },
	},
};

describe.each(Object.entries(FLOWS))("%s of another computer", (name, f) => {
	describe.each([1280, 390])("at %i", width => {
		test("the list and the opened item stand in the same boxes as on this computer", async () => {
			const seen = {} as Record<Side, { list: Shape; open: Shape }>;
			const wide = width >= 1100;
			for (const side of ["local", "peer"] as const) {
				const v = await boot(side, width, f.inst);
				await run(v, `go("monitoring", ${JSON.stringify(key(side, f.inst))})`);
				await waitFor(v, f.list);
				await drawn(v, wide ? f.screen.wide : f.screen.narrow);
				await still(v);
				const list = await shape(v, ...(wide ? f.screen.wide : f.screen.narrow));
				await shoot(v, `${name}-${side}-${width}`);
				await run(v, f.open);
				await waitFor(v, f.opened);
				await drawn(v, wide ? f.item.wide : f.item.narrow);
				await still(v);
				seen[side] = { list, open: await shape(v, ...(wide ? f.item.wide : f.item.narrow)) };
				await shoot(v, `${name}-${side}-${width}-open`);
			}
			for (const s of [seen.local.list, seen.local.open]) expect(Object.values(s).every(b => b !== null && b.w > 0)).toBe(true);
			expect(seen.peer.list).toEqual(seen.local.list);
			expect(seen.peer.open).toEqual(seen.local.open);
		}, 60_000);
	});
});

test("a peer's mailbox buttons stay in the panel, disabled, with the reason; this computer's are enabled", async () => {
	const states = {} as Record<Side, { disabled: boolean; title: string }>;
	for (const side of ["local", "peer"] as const) {
		const v = await boot(side, 1280, "mail");
		await run(v, `go("monitoring", ${JSON.stringify(key(side, "mail"))})`);
		await waitFor(v, `document.querySelector("#mx-pane .mx-add")`);
		states[side] = await ev(v, `(b => ({ disabled: b.disabled, title: b.title }))(document.querySelector("#mx-pane .mx-add"))`);
	}
	expect(states.local).toEqual({ disabled: false, title: "" });
	expect(states.peer.disabled).toBe(true);
	expect(states.peer.title).toContain("맥미니");
}, 60_000);
