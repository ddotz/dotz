import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, inbox, json, on, run } from "./test-web.ts";

const A = "http://a.test", B = "http://b.test", C = "http://c.test";
const solo = [{ name: "맥미니", url: A, self: true, online: true }];
const trio = [
	{ name: "맥미니", url: A, self: true, online: true },
	{ name: "맥북", url: B, self: false, online: true, unread: 0, need: 0 },
	{ name: "노트", url: C, self: false, online: false, unread: 0, need: 0 },
];
const fleet = [
	{ name: "맥미니", url: A, self: true, online: true, state: "idle", load: null },
	{ name: "맥북", url: B, self: false, online: true, state: "busy", load: { v: 1, name: "맥북", at: 1, sessions: { live: 0, cap: 4, reason: "" }, lanes: { active: 1, cap: 3, waiting: 0 }, waitlist: 0, paused: false, working: true, running: [{ lane: "a", title: "빌드 확인" }] }, sent: [{ lane: "fleet-a1", title: "문서 정리" }, { lane: "fleet-a2", title: "빌드 확인" }] },
	{ name: "노트", url: C, self: false, online: false, state: "offline", load: null, sent: [] },
];
let peers: object[] = trio;
const posts = inbox<Record<string, unknown>>();
const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		if (url.pathname === "/api/peers") return json(peers);
		if (url.pathname === "/api/fleet") return json(fleet);
		if (url.pathname === "/api/message" && req.method === "POST") { posts.push((await req.json()) as Record<string, unknown>); return json({ ok: true }); }
		return undefined;
	},
});
const v = await hub.view({ width: 390, height: 844 });
const { waitFor } = on(v);
afterAll(() => hub.stop());

const open = async (list: object[], count: number) => {
	peers = list;
	const up = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await up;
	await waitFor(`PR.fresh && PR.list.length === ${count}`);
};
const chip = () => ev<{ hidden: boolean; text: string }>(v, `({ hidden: $("#c-pc").hidden, text: $("#c-pc").textContent })`);
const send = async (text: string) => {
	const before = posts.length;
	await run(v, `ta.value = ${JSON.stringify(text)}; sendChat()`);
	return (await posts.until(p => p.length > before, 10_000, "a POST /api/message"))[before]!;
};

test("the computer chip is hidden with one computer", async () => {
	await open(solo, 1);
	expect((await chip()).hidden).toBe(true);
});

test("with two computers the chip shows this computer, lists the others with their state, and the pick rides on the next message only", async () => {
	await open(trio, 3);
	const here = await ev<string>(v, `TX("chat.chip.pc_here")`);
	expect(await chip()).toEqual({ hidden: false, text: here });
	await run(v, `$("#c-pc").click()`);
	await waitFor(`document.querySelectorAll(".menu .mi").length === 3`);
	const items = await ev<{ label: string; off: boolean }[]>(v, `[...document.querySelectorAll(".menu .mi")].map(b => ({ label: b.querySelector(".ml").textContent, off: b.classList.contains("off") }))`);
	expect(items.map(i => i.off)).toEqual([false, false, true]);
	expect(items[1]!.label).toContain(await ev<string>(v, `prFleetWord("busy")`));
	expect(items[2]!.label).toContain(await ev<string>(v, `prFleetWord("offline")`));
	await run(v, `document.querySelectorAll(".menu .mi")[2].click()`);
	expect((await chip()).text).toBe(here);
	await run(v, `document.querySelectorAll(".menu .mi")[1].click()`);
	await waitFor(`$("#c-pc").textContent === "맥북"`);
	const first = await send("문서 정리해 줘");
	expect(first.computer).toBe("맥북");
	await waitFor(`$("#c-pc").textContent === ${JSON.stringify(here)}`);
	const second = await send("한 번 더");
	expect("computer" in second).toBe(false);
});

test("the sheet's quiet line names what this computer sent there, each title once", async () => {
	await open(trio, 3);
	await run(v, "prOpen()");
	await waitFor(`document.querySelectorAll(".pr-sheet .tag").length === 3`);
	const subs = await ev<string[]>(v, `[...document.querySelectorAll(".pr-sheet .pr-row:not(.pr-manage)")].map(r => r.querySelector(".pr-sub") ? r.querySelector(".pr-sub").textContent : "")`);
	expect(subs[1]).toBe("빌드 확인, 문서 정리");
	expect(subs[2]).toBe("");
	await run(v, "prClose(false)");
});
