import { afterAll, describe, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// 모니터링 shows this computer's items and every peer's together (web/js/34-peer-monitoring.js): a machine chip on each peer row, '연결 안 됨'
// on a peer that does not answer, the peer's reports in 감시 소식 and the machine name beside each detail title. Headless; the peers are fixtures.
const SNAP = "/tmp/tm-shots";
const MINI = "http://mini.test";
const at = (min: number) => new Date(Date.UTC(2026, 9, 20, 3, min)).toISOString();
const localMon = { name: "local-check", watch: "local-check", kind: "watch", last_run: at(10), last_result: "ok", next_run: at(40), every: "30분" };
const localNote = { id: "ln1", kind: "watch", tone: "ok", title: "orphan report", text: "로컬 소식이에요", ts: at(5), read: false };
const peerMon = { name: "peer-backup", watch: "peer-backup", kind: "watch", last_run: at(30), last_result: "changed", next_run: at(50), every: "1시간" };
const peerNote = { id: "pn1", kind: "watch", tone: "changed", title: "peer backup", text: "백업이 바뀌었어요", ts: at(30), read: false };
const peerFeed = { id: "pn2", kind: "watch", tone: "ok", title: "peer orphan", text: "피어 소식이에요", ts: at(31), read: false };
const peers = [
	{
		name: "맥미니", url: MINI, online: true, stale: false,
		items: {
			name: "맥미니", rev: "r1", monitors: [peerMon], notices: [peerNote, peerFeed],
			integrations: [{ key: "mail", label: "메일", icon: "mail", conv: ["mail:"], unread: 1, notices: [] }],
			conversations: [{ target: "mail:abc", unread: 1, mail: { subject: "회의 일정", from: "민수 <m@example.com>", at: at(20) }, last: { ts: at(20), text: "회의 일정" } }],
		},
	},
	{ name: "서재", url: "http://study.test", online: false, stale: true, items: { name: "서재", rev: "r2", monitors: [{ name: "study-disk", kind: "watch", last_run: at(2), last_result: "ok" }], notices: [], integrations: [], conversations: [] } },
	{ name: "창고", url: "http://store.test", online: false, stale: false, items: null },
];

const json = (v: unknown, status = 200) => Response.json(v, { status });
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 1 });
		if (url.pathname === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }, ...peers.map(p => ({ name: p.name, url: p.url, self: false, online: p.online }))]);
		if (url.pathname === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (url.pathname === "/api/monitors") return json({ items: [localMon] });
		if (url.pathname === "/api/notices") return json({ unread: 1, items: [localNote] });
		if (url.pathname === "/api/integrations" || url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/monitoring/peers") return json(peers);
		if (url.pathname === "/api/peer/proxy") {
			if (req.method === "POST") return json({ error: "peering is off" }, 503);
			return json({ events: [{ ts: at(20), kind: "mail", text: "내일 3시에 만나요", from: "민수" }] });
		}
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const open = async (width: number, height: number): Promise<View> => {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	return v;
};
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const text = (v: View, expr: string) => v.evaluate(expr) as Promise<string>;
const rowOf = (key: string) => `[...document.querySelectorAll("#mon-side .cv-row")].find(r => r.dataset.k === ${JSON.stringify(key)})`;
const boot = async (width: number, height: number) => {
	const v = await open(width, height);
	await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh`);
	await v.evaluate(`(go("monitoring"), 0)`);
	await waitFor(v, `PQ.loaded && ${rowOf(`p:${MINI}|m:peer-backup`)}`);
	return v;
};

describe("merged 모니터링", () => {
	test("peer rows carry the machine chip, an offline peer says 연결 안 됨, the feed lists the peer's report first", async () => {
		const v = await boot(1280, 800);
		expect(await text(v, `${rowOf(`p:${MINI}|m:peer-backup`)}.querySelector(".tag").textContent`)).toBe("맥미니");
		expect(await text(v, `${rowOf(`p:${MINI}|i:mail`)}.querySelector(".tag").textContent`)).toBe("맥미니");
		expect(await text(v, `${rowOf("m:local-check")}.querySelectorAll(".tag").length + ""`)).toBe("0");
		const stale = await text(v, `[...${rowOf("p:http://study.test|m:study-disk")}.querySelectorAll(".tag")].map(t => t.textContent).join(",")`);
		expect(stale).toBe("서재,연결 안 됨");
		expect(await text(v, `${rowOf("p:http://store.test|off")}.querySelector(".cv-n").textContent`)).toBe("창고 · 연결 안 됨");
		await v.evaluate(`(go("monitoring", "notice"), 0)`);
		await waitFor(v, `$("#mon-tl .rc")`);
		const titles = JSON.parse(await text(v, `JSON.stringify([...document.querySelectorAll("#mon-tl .rc")].map(c => c.querySelector(".rc-title").textContent))`));
		expect(titles).toEqual(["피어 소식이에요", "로컬 소식이에요"]);
		expect(await text(v, `$("#mon-tl .rc .rc-hd .tag").textContent`)).toBe("맥미니");
	});

	test("the detail title names the machine that owns the item", async () => {
		const v = await boot(1280, 800);
		await v.evaluate(`(go("monitoring", "m:local-check"), 0)`);
		await waitFor(v, `$("#mon-head .cv-n").firstChild.textContent === "local check"`);
		expect(await text(v, `$("#mon-head .mon-pc").textContent`)).toBe("맥북");
		await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|m:peer-backup`)}), 0)`);
		await waitFor(v, `$("#mon-head .cv-n").firstChild.textContent === "peer backup"`);
		expect(await text(v, `$("#mon-head .mon-pc").textContent`)).toBe("맥미니");
		await waitFor(v, `$("#mon-tl .rc")`);
		expect(await text(v, `$("#mon-tl .rc .rc-title").textContent`)).toBe("백업이 바뀌었어요");
		await v.evaluate(`(go("monitoring", "notice"), 0)`);
		await waitFor(v, `$("#mon-head .mon-pc")`);
		expect(await text(v, `$("#mon-head .mon-pc").textContent`)).toBe("맥북");
	});

	test("a peer conversation reads through the proxy and a reply the peer refuses shows a toast", async () => {
		const v = await boot(1280, 800);
		const key = `p:${MINI}|i:mail`;
		await v.evaluate(`(go("monitoring", ${JSON.stringify(key)}), 0)`);
		await waitFor(v, `$("#mon-head .mon-pc") && $("#mon-tl .rc .btn")`);
		expect(await text(v, `$("#mon-head .mon-pc").textContent`)).toBe("맥미니");
		await v.evaluate(`($("#mon-tl .rc .btn").click(), 0)`);
		await waitFor(v, `$("#mon-tl .pm-msg")`);
		expect(await text(v, `$("#mon-tl .pm-msg").textContent`)).toContain("내일 3시에 만나요");
		await v.evaluate(`($("#mon-tl .pm-ta").value = "네, 갈게요", $("#mon-tl .pm-ta").dispatchEvent(new Event("input")), $("#mon-tl .pm-reply .btn").click(), 0)`);
		await waitFor(v, `$(".snack")`);
		expect(await text(v, `$(".snack").textContent`)).toBe("이 컴퓨터에서는 읽기만 돼요");
	});
});

for (const [name, w, h] of [["390", 390, 844], ["desktop", 1280, 800]] as const) {
	describe(`screenshot at ${w}px`, () => {
		test("모니터링 with a peer item open", async () => {
			const v = await boot(w, h);
			await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|m:peer-backup`)}), 0)`);
			await waitFor(v, `$("#mon-head .mon-pc") && $("#mon-head .mon-pc").textContent === "맥미니" && $("#mon-tl .rc")`);
			if (w >= 1100) await Bun.write(`${SNAP}/monitor-${name}.png`, await v.screenshot());
			else {
				await v.evaluate(`(go("monitoring"), 0)`);
				await waitFor(v, `$("#mon-side .cv-row")`);
				await Bun.write(`${SNAP}/monitor-${name}-list.png`, await v.screenshot());
				await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|m:peer-backup`)}), 0)`);
				await waitFor(v, `$("#mon-head .mon-pc") && $("#mon-tl .rc")`);
				expect(await text(v, `$("#title .mon-pc").textContent`)).toBe("맥미니");
				await Bun.write(`${SNAP}/monitor-${name}.png`, await v.screenshot());
			}
			expect(await Bun.file(`${SNAP}/monitor-${name}.png`).exists()).toBe(true);
		});
	});
}
