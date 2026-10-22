import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { emit, sseResponse } from "./events.ts";
import { answerDecision, listNotices, markNoticesRead, resolveNotices, unreadCount } from "./notices.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The 모니터링 tab's decision card (30-monitoring.js monNoticeNode) in a headless browser against the real notice store: one [ask] with a choice block
// reaches the page as one notice, and its card, which shows the option buttons, does not print the option lines of the message body again.
const SNAP = "/tmp/dup-shots";
const json = (v: unknown, status = 200) => Response.json(v, { status });
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: unreadCount() });
		if (url.pathname === "/api/notices" && req.method === "GET") return json(listNotices(100));
		if (url.pathname === "/api/notices/read") return json(markNoticesRead(await req.json()));
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
});

test("one answered [ask] with a choice block is one card: lead text, its 결정 line and the buttons, no raw option lines", async () => {
	// leftovers of other test files: decisions with options are closed only by naming them
	resolveNotices({ ids: listNotices(300).items.filter(n => n.decision?.state === "open").map(n => n.id) });
	const at = new Date().toISOString();
	emit("outbox", { ts: at, kind: "out", source: "orchestrator", target: "alert", text: "[ask] 탭 구성을 바꿨어요. 폰에서 확인해 주세요.\n\n결정: 폰 탭 구성 확인\n**1) 확인됨** ← 추천\n폰에서도 잘 보여요\n**2) 안 됨 …**\n어디가 이상한지 적어 주면 바로 고칠게요" });
	const mine = () => listNotices(300).items.filter(n => n.at === at);
	expect(mine()).toHaveLength(1);
	const id = mine()[0]!.id;
	expect((await answerDecision(id, { n: 1 }, async () => {})).status).toBe(200);

	const v = new Bun.WebView({ width: 1440, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), true)`);
	await v.navigate(`http://127.0.0.1:${server.port}/?light#monitoring/notice`);
	await v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("no notice")), 10000); const done = () => { if (typeof go === "function" && current !== "monitoring") go("monitoring", "notice"); if (document.querySelector("#mon-tl") && NT.loaded && NM.loaded && !monRaf && ntById(${JSON.stringify(id)})) { clearTimeout(t); o.disconnect(); res(true); } }; const o = new MutationObserver(done); o.observe(document.documentElement, { subtree: true, childList: true }); done(); })`);
	// the card the tab draws for that notice, placed in the open conversation
	const card = `document.querySelector('#mon-tl .bm[data-nid="${id}"]')`;
	await v.evaluate(`(document.querySelector("#mon-tl").append(monNoticeNode(ntById(${JSON.stringify(id)}))), true)`);
	const got = JSON.parse(
		(await v.evaluate(`JSON.stringify((() => {
			const c = ${card}, body = c.cloneNode(true);
			body.querySelectorAll(".mt, .dcm").forEach(e => e.remove());
			return { same: NT.items.filter(n => n.at === ${JSON.stringify(at)}).length, rows: c.querySelectorAll(".dcm-row").length, on: c.querySelectorAll(".dcm-row.on").length, body: body.innerText };
		})())`)) as string,
	) as { same: number; rows: number; on: number; body: string };
	expect(got.same).toBe(1);
	expect(got.rows).toBe(2);
	expect(got.on).toBe(1);
	const lines = got.body.split("\n").map(l => l.trim()).filter(Boolean);
	expect(lines.some(l => /^\**\d+\)/.test(l))).toBe(false);
	expect(lines.some(l => l.includes("폰에서도 잘 보여요") || l.includes("어디가 이상한지"))).toBe(false);
	expect(lines.some(l => l.includes("탭 구성을 바꿨어요"))).toBe(true);
	expect(lines.some(l => l.includes("결정: 폰 탭 구성 확인"))).toBe(true);
	mkdirSync(SNAP, { recursive: true });
	await v.evaluate(`(${card}.scrollIntoView({ block: "center" }), true)`);
	await Bun.write(`${SNAP}/after.png`, await v.screenshot());
}, 30_000);
