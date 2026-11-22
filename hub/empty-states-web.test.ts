import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DmState } from "../features/youtube-instagram/lib/ig-dm.ts";
import { createIgDmWeb } from "./ig-dm-web.ts";
import { ev, fakeHub, inbox, json, run, waitFor, type View } from "./test-web.ts";

// Every empty state is the one card emptyNode() builds (web/js/05-command-palette.js; docs/ui-spec.md 빈 화면), in a headless browser against a fake hub with nothing in it: each
// empty screen is opened at a phone and a desktop width, and a reply queue that failed to load is asked again by its 다시 시도. Screenshots go to the folder EMPTY_SHOTS names,
// if set. Names and texts are placeholders.
const SHOTS = process.env.EMPTY_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const app = (key: string, label: string, icon = key) => ({ key, label, icon, kind: "app", conv: [], notices: [], unread: 0, needs: { drafts: 0, unread: 0, sentToday: 0 } });
const APPS = [app("kakao", "카카오톡", "chat"), app("youtube", "유튜브"), app("instagram", "인스타그램"), app("website", "웹사이트"), { ...app("mail", "메일"), conv: ["mail:"] }];
const ROOMS = [100, 200, 300].map(n => ({ chatId: String(n), name: `방 ${n}`, kind: "group", watched: false, autoDraft: false, unread: 0, lastAt: Date.UTC(2026, 9, 22, 1, 29) }));
const SOURCES = ["youtube", "instagram"].map(k => ({ key: k, kind: k, label: `${k} 댓글`, watch: ["*"], autoDraft: false, autoSend: false, error: null, ranAt: Date.UTC(2026, 9, 22, 3, 0) }));
const PROJECT = { key: "ch:8000", channel: { id: "8000", name: "프로젝트 1" }, name: "프로젝트 1", pinned: false, recordKey: "ch:8000", record: { title: "프로젝트 1", purpose: "첫 프로젝트", updated: "2026-10-25T09:00:00.000Z" }, lanes: [] };
const WATCH = { name: "disk-check", watch: "disk-check", kind: "watch", every: "10분마다", fails: 0 };
const DM: DmState = { perm: "ok", convs: {} };
const dmWeb = createIgDmWeb({ enabled: () => true, account: () => ({ id: "17841", username: "owner_ig" }), read: () => DM, sync: async () => ({ perm: DM.perm, fetched: 0 }) });
let monitors: object[] = [];
let queueFail = false;
const queueRequests = inbox<string>();

const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: monitors });
		if (p === "/api/integrations") return json({ items: APPS });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: ROOMS });
		if (p === "/api/comments/sources") return json({ on: true, sources: SOURCES });
		if (p === "/api/comments/threads") return json({ threads: [] });
		if (p === "/api/reply/queue") { queueRequests.push(`${req.method} ${p}`); return queueFail ? json({ error: "no" }, 500) : json({ items: [], counts: {}, triageMin: 1, undoSec: 10 }); }
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: [PROJECT], routines: [], links: [] });
		return dmWeb.route(req, url, p.split("/").filter(Boolean));
	},
});
afterAll(() => hub.stop());
beforeEach(() => { monitors = []; queueFail = false; });

async function boot(width: number): Promise<View> {
	const v = await hub.view({ width, height: width < 600 ? 844 : 800 });
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && RQ.loaded && INTG.loaded`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	return v;
}
// A shot waits until the screen is settled, read off what is drawn: the open app's ⋯ settings button (it appears only once the app-settings read has landed and the
// head or app bar was repainted for it) is on screen, and the DM refresh button no longer reads 불러오는 중….
const LOADED = `(app => !app || [...document.querySelectorAll('[data-as-more="' + app + '"]')].some(n => n.getClientRects().length > 0))(monDetailApp())
	&& (b => !b || b.textContent !== TX("common.loading"))(document.querySelector("#dm-refresh"))`;
const shot = async (v: View, name: string) => { if (SHOTS) { await waitFor(v, LOADED); await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`); await Bun.write(join(SHOTS, name), await v.screenshot()); } };
// Page code: the node `sel` finds reads as the page's own text `tx` (white space aside: a long sentence is cut into phrases, web/js/01-phrase-wrap.js).
const says = (sel: string, tx: string) => `((document.querySelector(${JSON.stringify(sel)}) || {}).textContent || "").replace(/\\s/g, "") === ${tx}.replace(/\\s/g, "")`;
const onScreen = (v: View, selectors: string[]) => ev<{ notSharedCard: string[]; found: number[] }>(v, `(() => { const seen = n => n.getClientRects().length > 0;
	return { notSharedCard: [...document.querySelectorAll(".empty, #kk-empty, #cm-empty, #dm-empty, #kk-nomatch")].filter(n => seen(n) && !n.matches("div.card.empty")).map(n => n.outerHTML.slice(0, 120)),
		found: ${JSON.stringify(selectors)}.map(s => [...document.querySelectorAll(s)].filter(seen).length) }; })()`);

// steps: page code and the state it must reach, in order. cards: selectors that each find exactly one card on screen. inMonitoring: the empty cards the whole 모니터링 view holds.
type Scene = { name: string; steps: [code: string, ready: string][]; cards: string[]; inMonitoring?: number; before?: () => void; after?: (v: View) => Promise<unknown> };
const FEED = "#mon-tl > .card.empty", QUEUE = `#v-monitoring .rq-ls > .card.empty[role="status"]`, RETRY = `${QUEUE} button[data-k="retry"]`;
const SCENES: Scene[] = [
	// 감시 소식 with no monitor at all: the overview's compact line over the feed's card
	{ name: "mon-notice", steps: [[`go("monitoring", "notice")`, `MON.sel === "notice" && ${says(`${FEED}.compact`, `TX("mon.ov.empty")`)} && ${says(`${FEED}:not(.compact)`, `TX("mon.empty.none")`)}`]], cards: [`${FEED}.compact`, `${FEED}:not(.compact)`], inMonitoring: 2 },
	{ name: "mon-app", steps: [[`go("monitoring", "i:website")`, `MON.sel === "i:website" && ${says(FEED, `TX("mon.empty.none")`)}`]], cards: [FEED], inMonitoring: 1 },
	{ name: "mon-replies", steps: [[`go("monitoring", "replies")`, `MON.sel === "replies" && ${says(QUEUE, "RQ_EMPTY[RQ.tab]")}`]], cards: [QUEUE], inMonitoring: 1 },
	{ name: "chat-none", steps: [[`go("chat", "main")`, `current === "chat" && ${says("#tl .card.empty", `TX("chat.empty.none")`)}`]], cards: ["#tl .card.empty"] },
	{ name: "notices-empty", steps: [[`go("notices")`, says("#v-notices .card.empty", `TX("misc.nsc.empty")`)]], cards: ["#v-notices .card.empty"] },
	{ name: "projects-filter", steps: [[`go("projects"); PJ.view = "done"; pjPaintChips(); pjPaintRows()`, says("#pl-list > .card.empty", `TX("project.empty.done")`)]], cards: ["#pl-list > .card.empty"] },
	{ name: "kakao-empty", steps: [[`go("monitoring", "i:kakao")`, says("#kk-empty", `TX("apps.kk.add_prompt")`)]], cards: ["#kk-empty"] },
	{ name: "kakao-nomatch", steps: [[`document.querySelector("#kk-add-btn").click()`, `document.querySelector("#kk-q")`], [`const i = document.querySelector("#kk-q"); i.value = "zzz"; i.dispatchEvent(new Event("input", { bubbles: true }))`, `document.querySelector("#kk-nomatch")`]],
		cards: ["#kk-empty", `#kk-nomatch[role="status"]`], after: async v => { await run(v, `document.querySelector("#kk-add .fs-x").click()`); await waitFor(v, `!document.querySelector("#kk-add")`); } },
	{ name: "comments-empty", steps: [[`go("monitoring", "i:youtube")`, `document.querySelector('#cm-empty button[data-k="pick-open"]')`]], cards: ["#cm-empty"] },
	{ name: "dm-empty", steps: [[`go("monitoring", "i:instagram")`, `document.querySelector('#cm .cm-tabs [data-tab="dm"]')`], [`document.querySelector('#cm .cm-tabs [data-tab="dm"]').click()`, `document.querySelector("#dm-empty")`]], cards: ["#dm-empty"] },
	{ name: "mon-mail", steps: [[`go("monitoring", "i:mail")`, `MON.sel === "i:mail" && ${says(FEED, `TX("mon.empty.none")`)}`]], cards: [FEED] },
	{ name: "mon-watch", before: () => { monitors = [WATCH]; }, steps: [[`loadMonitors()`, `monItems().some(i => i.key === "m:disk-check")`], [`go("monitoring", "m:disk-check")`, `MON.sel === "m:disk-check" && document.querySelector(${JSON.stringify(FEED)})`]], cards: [FEED] },
];

for (const width of [390, 1280])
	test(`every empty screen shows the one shared card at ${width}px`, async () => {
		const v = await boot(width);
		for (const s of SCENES) {
			s.before?.();
			for (const [code, ready] of s.steps) { await run(v, code); await waitFor(v, ready); }
			expect({ scene: s.name, ...(await onScreen(v, s.cards)) }).toEqual({ scene: s.name, notSharedCard: [], found: s.cards.map(() => 1) });
			if (s.inMonitoring) expect({ scene: s.name, n: await ev<number>(v, `document.querySelectorAll("#v-monitoring .card.empty").length`) }).toEqual({ scene: s.name, n: s.inMonitoring });
			await shot(v, `${s.name}-${width}.png`);
			await s.after?.(v);
		}
	}, 60_000);

for (const width of [390, 1280])
	test(`a reply queue that failed to load offers 다시 시도, which asks the queue again, at ${width}px`, async () => {
		queueFail = true;
		const v = await boot(width);
		await run(v, `go("monitoring", "replies")`);
		await waitFor(v, `document.querySelector(${JSON.stringify(RETRY)})`);
		expect(await onScreen(v, [QUEUE])).toEqual({ notSharedCard: [], found: [1] });
		await shot(v, `mon-replies-fail-${width}.png`);
		const before = queueRequests.length;
		queueFail = false;
		const asked = queueRequests.until(a => a.length > before, 5000, "다시 시도 asks the reply queue again");
		await run(v, `document.querySelector(${JSON.stringify(RETRY)}).click()`);
		await asked;
		expect(queueRequests.slice(before)).toEqual(["GET /api/reply/queue"]);
		await waitFor(v, `!document.querySelector(${JSON.stringify(RETRY)}) && ${says(QUEUE, "RQ_EMPTY[RQ.tab]")}`);
	}, 40_000);
