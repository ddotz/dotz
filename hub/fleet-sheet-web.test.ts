import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, on, run } from "./test-web.ts";

// The computer sheet (web/js/33-peers.js prSheet) shows each computer's Fleet state as the status pill and, on the quiet line, what runs there.
// /api/fleet is read when the sheet opens and not before; an older gateway's row (legacy) keeps the plain connected pill.
const load = (state: string, running: string[], extra: object = {}) => ({ v: 1, name: "x", at: 1, sessions: { live: 0, cap: 4, reason: "" }, lanes: { active: 0, cap: 3, waiting: 0 }, waitlist: 0, paused: false, working: state === "busy", running: running.map(title => ({ kind: "lane", title, status: "working" })), ...extra });
const A = "http://a.test", B = "http://b.test", C = "http://c.test", D = "http://d.test", E = "http://e.test";
const peers = [
	{ name: "맥미니", url: A, self: true, online: true },
	{ name: "맥북", url: B, self: false, online: true, unread: 0, need: 0 },
	{ name: "서버", url: C, self: false, online: true, unread: 0, need: 0 },
	{ name: "노트", url: D, self: false, online: false, unread: 0, need: 0 },
];
let fleet: object[] = [];
let fleetCalls = 0;
const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		if (url.pathname === "/api/peers") return json(peers);
		if (url.pathname === "/api/fleet") { fleetCalls++; return json(fleet); }
		return undefined;
	},
});
const v = await hub.view({ width: 390, height: 844 });
const { waitFor } = on(v);
afterAll(() => hub.stop());

type Row = { name: string; tag: string; tagClass: string; sub: string };
const rows = () => ev<Row[]>(v, `[...document.querySelectorAll(".pr-sheet .pr-row:not(.pr-manage)")].map(r => {
	const tag = r.querySelector(".tag");
	return { name: r.querySelector(".pr-t").textContent, tag: tag ? tag.textContent : "", tagClass: tag ? tag.className : "", sub: r.querySelector(".pr-sub") ? r.querySelector(".pr-sub").textContent : "" };
})`);
const open = async (list: object[]) => {
	fleet = list;
	const up = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await up;
	await waitFor("PR.fresh && PR.list.length === 4");
	fleetCalls = 0;
};

test("the sheet reads /api/fleet when it opens, and shows one state label per computer with what runs there", async () => {
	await open([
		{ name: "맥미니", url: A, self: true, online: true, state: "busy", load: load("busy", ["정리 작업"]) },
		{ name: "맥북", url: B, self: false, online: true, state: "idle", load: load("idle", []) },
		{ name: "서버", url: C, self: false, online: true, state: "full", load: load("full", ["빌드 확인", "문서 정리"], { paused: true }) },
		{ name: "노트", url: D, self: false, online: false, state: "offline", load: null },
	]);
	expect(fleetCalls).toBe(0);
	await run(v, "prOpen()");
	await waitFor(`document.querySelector(".pr-sheet .tag") !== null && document.querySelectorAll(".pr-sheet .tag").length === 4`);
	expect(fleetCalls).toBe(1);
	const words = await ev<string[]>(v, `["busy", "idle", "full", "offline"].map(s => prFleetWord(s))`);
	expect(new Set(words).size).toBe(4);
	const got = await rows();
	expect(got.map(r => r.tag)).toEqual(words);
	expect(got.map(r => r.tagClass.split(" ").slice(1).join(" "))).toEqual(["pri", "ok", "warn", "off"]);
	expect(got[0]!.sub).toContain("정리 작업");
	expect(got[1]!.sub).toBe("");
	expect(got[2]!.sub).toContain("빌드 확인, 문서 정리");
	expect(got[3]!.sub).toBe("");
	const limit = await ev<string>(v, `TX("misc.pr.fleet.limit")`);
	expect(got[2]!.sub.startsWith(limit)).toBe(true);
	await run(v, "prClose(false)");
});

test("a legacy row keeps the plain connected pill", async () => {
	await open([
		{ name: "맥미니", url: A, self: true, online: true, state: "idle", load: load("idle", []) },
		{ name: "맥북", url: B, self: false, online: true, state: "busy", load: null, legacy: true },
	]);
	await run(v, "prOpen()");
	await waitFor("PR.fleet !== null");
	const on_ = await ev<string>(v, `TX("connect.state.on")`);
	const got = await rows();
	expect(got[1]!.sub).toBe(on_);
	expect(got[1]!.tag).toBe("");
	expect(got[0]!.tag).not.toBe("");
	await run(v, "prClose(false)");
});
