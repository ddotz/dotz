import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

// Paths where a repaint, a re-entry or a sheet could replace or unfocus the field the owner is typing in (phone keyboard drops). Each test types into a
// field with value + input events, triggers the path, and asserts the same node is still in the page and still has the focus.
const ASK = "[ask] 확인\n결정: 확인\n**1) 확인됨**\n잘 열려요\n**2) 안 됨**\n어디가 안 되는지 적어 주세요\n";
const history = [
	{ ts: "2026-10-22T08:10:00.000Z", kind: "message", source: "web", channel: "web", text: "확인해 줘" },
	{ ts: "2026-10-22T08:19:17.721Z", kind: "out", source: "orchestrator", target: "web", reply_to: "ec330340", text: ASK },
];
const STATE: { auth: object[]; lanes: object[]; status: string } = { auth: [], lanes: [], status: "idle" };
let appFields: object[] = [];
const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/state") return json({ name: "땅콩", orchestrator: { status: STATE.status }, lanes: STATE.lanes, terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, auth: STATE.auth });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? history : [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/integrations/mail/settings") return json({ fields: appFields });
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor, run, ev } = on(view);

type Held = { same: boolean; focus: boolean; connected: boolean; value: string };
const held = (sel: string) => ev<Held>(`(() => { const n = window.__f; return { same: !!n && document.querySelector(${JSON.stringify(sel)}) === n, focus: document.activeElement === n, connected: !!n && n.isConnected, value: n ? n.value : "" }; })()`);
const typeInto = (sel: string, text: string) => run(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); window.__f = t; })()`);

beforeEach(async () => {
	STATE.auth = []; STATE.lanes = []; STATE.status = "idle";
	appFields = [];
	const opened = hub.nextStream();
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof S === "object" && S && typeof openTarget === "function"`);
	await opened;
});

describe("paths that may unfocus the field being typed in", () => {
	test("composer: going to the chat that is already open keeps the composer node and its focus on a touch screen", async () => {
		await run(`const mm = matchMedia.bind(window); window.matchMedia = q => /pointer:\\s*coarse/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q)`);
		await run(`go("chat", "main")`);
		await waitFor(`!document.querySelector("#v-chat").hidden`);
		await typeInto("#text", "쓰는 중인 글");
		await run(`go("chat", "main")`);
		expect(await held("#text")).toEqual({ same: true, focus: true, connected: true, value: "쓰는 중인 글" });
	});

	test("login request arriving while typing in the composer does not take the focus", async () => {
		await run(`go("chat", "main")`);
		await waitFor(`!document.querySelector("#v-chat").hidden`);
		await typeInto("#text", "쓰는 중인 글");
		STATE.auth = [{ id: "a1", kind: "form", title: "로그인", purpose: "계정이 필요해요", fields: [{ name: "username", label: "아이디", type: "text" }] }];
		await run(`refreshState()`);
		await waitFor(`S.auth && S.auth.length === 1`);
		expect(await held("#text")).toMatchObject({ same: true, focus: true, value: "쓰는 중인 글" });
		expect(await ev<boolean>(`!document.querySelector(".au")`)).toBe(true);
		await run(`document.querySelector("#text").blur()`);
		await waitFor(`document.querySelector(".au")`);
	});

	test("decision note: state refresh, toast, notice and a report from another session keep the note field", async () => {
		await run(`openTarget("main", "chat")`);
		await waitFor(`document.querySelectorAll("#dcard .dc-row").length === 2`);
		await run(`document.querySelectorAll("#dcard .dc-row")[1].click()`);
		await waitFor(`document.querySelector("#dcard .dc-note")`);
		await typeInto("#dcard .dc-note", "여기가 안 열려요");
		const each = async () => expect(await held("#dcard .dc-note")).toEqual({ same: true, focus: true, connected: true, value: "여기가 안 열려요" });
		STATE.status = "working";
		await run(`refreshState()`);
		await waitFor(`!document.querySelector("#working").hidden`);
		await each();
		await run(`toast("저장했어요"); notify({ kind: "lane_report", lane: "x", text: "서브 작업이 끝났어요", ts: new Date().toISOString() })`);
		await waitFor(`document.querySelector(".snack")`);
		await each();
		STATE.lanes = [{ name: "x", title: "x", status: "idle", live: true, alive: true }];
		await run(`refreshState()`);
		await waitFor(`S.lanes.length === 1`);
		await each();
	});

	test("command palette: state refresh, toast and notice keep the search field", async () => {
		await run(`openPalette()`);
		await waitFor(`document.querySelector("dialog.pal .pal-in")`);
		await typeInto("dialog.pal .pal-in", "검");
		STATE.status = "working";
		await run(`refreshState(); toast("저장했어요"); notify({ kind: "lane_report", lane: "x", text: "서브 작업이 끝났어요", ts: new Date().toISOString() })`);
		await waitFor(`!document.querySelector("#working").hidden`);
		expect(await held("dialog.pal .pal-in")).toEqual({ same: true, focus: true, connected: true, value: "검" });
	});

	test("account alias dialog: a repaint of the accounts lists keeps the alias field", async () => {
		await run(`go("settings")`);
		await waitFor(`current === "settings" && !!ACC`);   // the accounts arrive after the screen does
		await run(`ACC.accounts = [{ name: "a", label: "a" }, { name: "b", label: "b" }]; accDialog(ACC.accounts[0])`);
		await waitFor(`document.querySelector("dialog[open] input.fi")`);
		await typeInto("dialog[open] input.fi", "회사");
		STATE.status = "working";
		await run(`refreshState(); accPaint(); renderSettings(); toast("저장했어요")`);
		await waitFor(`!document.querySelector("#working").hidden`);
		expect(await held("dialog[open] input.fi")).toEqual({ same: true, focus: true, connected: true, value: "회사" });
	});

	test("app settings: a field value changed elsewhere repaints the rows without replacing the field being typed in", async () => {
		appFields = [
			{ key: "memo", label: "메모", type: "text", value: "a", section: "advanced" },
			{ key: "every", label: "주기", type: "text", value: "1", section: "advanced" },
		];
		await run(`asScreen("mail")`);
		await waitFor(`document.querySelector('#app-sw [data-k="memo"]')`);
		await typeInto('#app-sw [data-k="memo"]', "쓰는 중");
		appFields = [
			{ key: "memo", label: "메모", type: "text", value: "a", section: "advanced" },
			{ key: "every", label: "주기", type: "text", value: "2", section: "advanced" },
		];
		await run(`window.__loaded = false; asLoad("mail", true).then(() => { window.__loaded = true; })`);
		await waitFor(`window.__loaded`);
		expect(await held('#app-sw [data-k="memo"]')).toEqual({ same: true, focus: true, connected: true, value: "쓰는 중" });
		await run(`window.__f.blur()`);
		await waitFor(`document.querySelector('#app-sw [data-k="every"]').value === "2"`);
	});
});
