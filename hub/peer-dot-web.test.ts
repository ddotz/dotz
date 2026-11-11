import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, json, on, run } from "./test-web.ts";

// The phone's bottom tab bar carries the other computers' dot on its Home icon (web/js/33-peers.js prHomeDot), from the same unread / need values as the
// bot name's dot, on every tab; peer_counts frames from the other computer's stream set and clear it at once. A wide screen shows the dot in the brand row instead.
let peers: object[] = [];
const hub = fakeHub({ stream: "fake", api: (_req, url) => (url.pathname === "/api/peers" ? json(peers) : undefined) });
const v = await hub.view({ width: 390, height: 844 });
const { waitFor } = on(v);
afterAll(() => hub.stop());
const self = { name: "맥미니", url: "http://a.test", self: true, online: true };
const other = { name: "맥북", url: "http://b.test", self: false, online: true, unread: 0, need: 0 };
const load = async (list: object[], ready: string) => {
	peers = list;
	const up = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await up;
	await waitFor(ready);
};
const counts = (unread: number, need: number) => hub.push({ kind: "peer_counts", url: other.url, name: other.name, online: true, unread, need });
const homeDot = () => ev<{ shown: boolean; need: boolean; bg: string; label: string | null; right: boolean; above: boolean; size: number }>(v, `(() => {
	const d = document.querySelector("#nav-pc"), ic = document.querySelector('.ni[data-view="home"] .ic').getBoundingClientRect(), r = d.getBoundingClientRect();
	return { shown: !d.hidden && d.offsetParent !== null, need: d.classList.contains("p-need"), bg: getComputedStyle(d).backgroundColor, label: d.parentElement.getAttribute("aria-label"),
		right: r.left > ic.left + ic.width / 2, above: r.top < ic.top + ic.height / 2, size: r.width };
})()`);

test("phone: Home's dot follows the other computer's counts on every tab, with no reload", async () => {
	await load([self, other], "PR.fresh && PR.list.length === 2");
	expect((await homeDot()).shown).toBe(false);
	counts(2, 0);
	await waitFor(`!document.querySelector("#nav-pc").hidden`);
	for (const tab of ["home", "chat", "projects", "monitoring", "settings"]) {
		await run(v, `go("${tab}")`);
		await waitFor(`current === "${tab}"`);
		expect(await homeDot()).toMatchObject({ shown: true, need: false, right: true, above: true, size: 8 });
	}
	const unread = await homeDot();
	counts(0, 0);
	await waitFor(`document.querySelector("#nav-pc").hidden`);
	expect((await homeDot()).shown).toBe(false);
	counts(1, 1);
	await waitFor(`document.querySelector("#nav-pc").classList.contains("p-need")`);
	const asks = await homeDot();
	expect(asks.shown).toBe(true);
	expect(asks.bg).not.toBe(unread.bg);
	expect(asks.label).not.toBe((await ev<{ l: string }>(v, `({ l: document.querySelector('.ni[data-view="settings"]').getAttribute("aria-label") })`)).l);
});

test("phone: one computer has no dot", async () => {
	await load([self], "PR.fresh && PR.list.length === 1");
	expect((await homeDot()).shown).toBe(false);
});

test("a wide screen leaves the dot to the brand row", async () => {
	await load([self, other], "PR.fresh && PR.list.length === 2");
	counts(3, 0);
	await waitFor(`!document.querySelector("#nav-pc").hidden`);
	await v.resize(1280, 800);
	await waitFor(`document.querySelector("#nav-pc").offsetParent === null && document.querySelector("#brand-c").classList.contains("pdot")`);
	await v.resize(390, 844);
});
