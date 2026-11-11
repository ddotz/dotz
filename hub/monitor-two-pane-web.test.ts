import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// A monitor opens like a chat (web/js/30-monitor-chat.js): 채팅's two columns with the list of monitors on the left and its conversation on the right, an
// app keeps its own screen. Run in a headless Bun.WebView; screenshots are written only when MON_SHOTS names a folder.
const SHOTS = process.env.MON_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ts = (m: number) => new Date(Date.UTC(2026, 10, 6, 3, m)).toISOString();
const mon = (name: string, watch: string, extra: object = {}) => ({ name, watch, kind: "watch", every: "60분마다", last_run: ts(0), next_run: ts(60), last_result: "ok", ...extra });
const MONITORS = [
	mon("가격 감시", "price"), mon("배포 상태", "deploy", { scope: "project", project: "dotz", project_title: "도츠" }), mon("메일 확인", "mail-check"),
	{ name: "주간 정리", schedule: "s1", kind: "schedule", every: "매주", next_run: ts(90) },
];
const INTEGRATIONS = [{ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], own: ["mail-check"], needs: { drafts: 0, unread: 0, sentToday: 0 } }];
const said = (t: string) => [{ ts: ts(1), kind: "out", source: "orchestrator", target: t, text: `${t} 대화예요` }];
// Another computer: one watch named like a local one (that conversation stays local) and one of its own.
const peerMon = (name: string, watch: string) => mon(name, watch, { connection: "connected" });
const PEERS = [{ name: "peer-b", url: "http://peer-b.invalid", online: true, stale: false, items: { bot: "맥북봇", monitors: [peerMon("가격 감시", "price"), peerMon("서버 감시", "server")], notices: [], integrations: [], conversations: [] } }];
let peers: typeof PEERS = [];
const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		const p = url.pathname, t = url.searchParams.get("target") ?? "";
		if (p === "/api/history") return json({ target: t, events: said(t) });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [{ target: "web", name: "웹", preview: "안녕하세요", ts: ts(2) }] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: MONITORS });
		if (p === "/api/integrations") return json({ items: INTEGRATIONS });
		if (p === "/api/monitoring/peers") return json(peers);
		return undefined;
	},
});
afterAll(() => hub.stop());

const boot = async (v: View) => {
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && NM.loaded && S`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
};
const box = (sel: string) => `(r => r && r.width ? [Math.round(r.left), Math.round(r.width)] : null)(document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect())`;
const shot = async (v: View, name: string) => {
	if (!SHOTS) return;
	await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`);
	await Bun.write(join(SHOTS, name), await v.screenshot());
};
const openRow = async (v: View, key: string) => {
	const row = `[...document.querySelectorAll('.cv-row[data-k="${key}"]')].find(r => r.offsetWidth)`;
	await waitFor(v, row);
	await run(v, `${row}.click()`);
};
const lastText = `document.querySelector("#tl")?.textContent`;

test("wide: a monitor has 채팅's list and conversation columns, a row switches the conversation, the apps are not listed, 소식 keeps the same columns", async () => {
	const v = await hub.view({ width: 1280, height: 800 });
	await boot(v);
	await run(v, `go("chat", "web")`);
	await waitFor(v, `current === "chat" && ${box("#chat-convo")}`);
	const chat = { list: await ev(v, box("#chat-convo")), conv: await ev(v, box("#timeline")) };
	await shot(v, "chat-1280.png");
	await run(v, `go("monitoring", "list")`);
	await openRow(v, "m:가격 감시");
	await waitFor(v, `target === "settings:w:price" && (${lastText} || "").includes("settings:w:price 대화예요")`);
	await waitFor(v, `document.querySelector('#chat-convo .cv-row.on[data-k="m:가격 감시"]')`);
	expect(await ev(v, `[...document.querySelectorAll("#chat-convo .cv-row[data-k]")].map(r => r.dataset.k)`)).toEqual(["m:배포 상태", "m:가격 감시", "m:주간 정리"]);
	expect(await ev(v, box("#chat-convo"))).toEqual(chat.list);
	expect(await ev(v, box("#timeline"))).toEqual(chat.conv);
	await shot(v, "monitoring-1280.png");
	await openRow(v, "m:배포 상태");
	await waitFor(v, `target === "settings:w:deploy" && (${lastText} || "").includes("settings:w:deploy 대화예요")`);
	await waitFor(v, `document.querySelector('#chat-convo .cv-row.on[data-k="m:배포 상태"]')`);
	await run(v, `document.querySelector('[data-k="mon-log"]').click()`);
	await waitFor(v, `current === "monitoring" && MON.sel === "m:배포 상태" && ${box("#mon-side")}`);
	expect(await ev(v, box("#mon-side"))).toEqual(chat.list);
	expect(await ev(v, box("#mon-timeline"))).toEqual(chat.conv);
	await shot(v, "monitoring-log-1280.png");
	await openRow(v, "m:주간 정리");
	await waitFor(v, `current === "monitoring" && MON.sel === "m:주간 정리" && document.querySelector("#v-monitoring.mon-two")`);
	expect(await ev(v, box("#mon-side"))).toEqual(chat.list);
	await run(v, `go("monitoring")`);
	await openRow(v, "i:mail");
	await waitFor(v, `MON.sel === "i:mail"`);
	expect(await ev(v, `document.querySelector("#v-monitoring").classList.contains("mon-two")`)).toBe(false);
});

test("another computer's monitor opens its conversation; one named like a local watch opens its reports, never the local conversation", async () => {
	peers = PEERS;
	const v = await hub.view({ width: 1280, height: 800 });
	await boot(v);
	await run(v, `pqLoad()`);
	await waitFor(v, `PQ.loaded && PQ.list.length === 1`);
	await run(v, `go("monitoring", "list")`);
	const key = (name: string) => `monItems().find(i => i.pc && i.name === "${name}").key`;
	await waitFor(v, `monItems().some(i => i.pc)`);
	await openRow(v, await ev<string>(v, key("서버 감시")));
	await waitFor(v, `target === "settings:w:server" && document.querySelector("#v-chat").classList.contains("mon-two")`);
	await run(v, `go("monitoring", "list")`);
	const same = await ev<string>(v, key("가격 감시"));
	await openRow(v, same);
	await waitFor(v, `current === "monitoring" && MON.sel === ${JSON.stringify(same)}`);
	peers = [];
});

test("phone: the list, then the conversation, then back to the list", async () => {
	const v = await hub.view({ width: 390, height: 844 });
	await boot(v);
	await run(v, `go("chat", "web")`);
	await waitFor(v, `current === "chat" && ${box("#timeline")}`);
	const conv = await ev(v, box("#timeline"));
	await shot(v, "chat-390.png");
	await run(v, `go("monitoring", "list")`);
	await waitFor(v, `${box("#mon-side")}`);
	await shot(v, "monitoring-list-390.png");
	await openRow(v, "m:가격 감시");
	await waitFor(v, `target === "settings:w:price" && (${lastText} || "").includes("settings:w:price 대화예요")`);
	expect(await ev(v, box("#timeline"))).toEqual(conv);
	expect(await ev(v, `!!document.querySelector("#chat-convo")?.offsetWidth`)).toBe(false);
	await shot(v, "monitoring-390.png");
	await run(v, `document.querySelector("#back").click()`);
	await waitFor(v, `current === "monitoring" && MON.list && ${box("#mon-side")}`);
});
