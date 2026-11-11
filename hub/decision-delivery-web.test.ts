import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, on, run } from "./test-web.ts";

// What the owner reads under his answer to a decision while the assistant has not taken it yet. Both an answer given on the card's buttons (the
// record in the conversation, it carries `picks`) and one typed in the chat (a plain bubble) follow the hub's delivery events. The record names the
// plain reason a waiting answer waits for; the bubble keeps the chat's own line. The page's own TX() gives the expected line, so no wording is pinned.
const WAITING = ["queued", "compacting", "held", "update"] as const;
const AT = "2026-11-11T11:20:00.000Z";
const owner = (mid: string, extra: object = {}) => ({ ts: AT, kind: "message", source: "web", channel: "web", author: "local", text: `답 ${mid}`, mid, ...extra });
const picked = (mid: string) => owner(mid, { picks: [{ q: "공지 형태", n: 1, label: "짧게" }] });
const delivery = (ref: string, state: string) => ({ ts: AT, kind: "delivery", source: "gateway", target: "web", ref, state, text: "" });

const history: object[] = [
	...WAITING.flatMap(s => [picked(`r-${s}`), owner(`b-${s}`), delivery(`r-${s}`, s), delivery(`b-${s}`, s)]),
	picked("r-steered"), delivery("r-steered", "steered"),
	picked("r-none"), owner("b-none"),
	picked("r-live"),
];
const hub = fakeHub({
	stream: "fake",
	api: req => {
		const url = new URL(req.url);
		if (url.pathname === "/api/history") return json({ target: "main", events: url.searchParams.get("target") === "main" ? history : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		return undefined;
	},
});
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 844 });
const { waitFor } = on(view);

async function open() {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S`);
	await run(view, `openTarget("main", "chat")`);
	await waitFor(`DELIV.nodes.has("r-live") && DELIV.nodes.has("b-none")`);
	await hub.streamConnected();
}
// The meta line of an owner message and the line the page itself builds for a key.
const line = (mid: string) => ev<string>(view, `DELIV.nodes.get(${JSON.stringify(mid)}).mt.textContent`);
const tx = (key: string) => ev<string>(view, `TX(${JSON.stringify(key)})`);

test("a decision record names the reason a waiting answer waits, and the chat bubble of a typed answer shows the delivery line", async () => {
	await open();
	for (const s of WAITING) {
		expect((await line(`r-${s}`)).endsWith(await tx(`decision.deliv.${s}`))).toBe(true);
		expect((await line(`b-${s}`)).endsWith(await tx(`home.deliv.${s}`))).toBe(true);
	}
	// A state that is no wait reads as it does on any message.
	expect((await line("r-steered")).endsWith(await tx("home.deliv.steered"))).toBe(true);
}, 30_000);

test("an answer nobody has a delivery state for shows only its base line, and a live delivery event reaches the record without a reload", async () => {
	await open();
	for (const mid of ["r-none", "b-none"]) expect(await ev<boolean>(view, `DELIV.nodes.get(${JSON.stringify(mid)}).mt.textContent === DELIV.nodes.get(${JSON.stringify(mid)}).base`)).toBe(true);
	expect(await ev<boolean>(view, `DELIV.nodes.get("r-none").mt.classList.contains("dv")`)).toBe(false);
	hub.push(delivery("r-live", "compacting"));
	await waitFor(`DELIV.nodes.get("r-live").mt.classList.contains("dv")`);
	expect((await line("r-live")).endsWith(await tx("decision.deliv.compacting"))).toBe(true);
}, 30_000);
