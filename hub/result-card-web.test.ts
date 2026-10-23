import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// Result cards (web/js/11-resultcard.js) in a headless browser: a mail and a watch report as the 모니터링 tab draws them. Set RC_SHOTS=<dir> to keep screenshots.
const SHOTS = process.env.RC_SHOTS ?? "";
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
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (url.pathname === "/api/notices") return json({ items: [], unread: 0 });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
});

const MAIL_TEXT = [
	"Alex Sender <sender@example.com> · 월간 점검 보고",
	"",
	"요약",
	"이번 달 점검이 끝났어요. 스팸 차단은 정상이에요.",
	"",
	"할 일",
	"- 금요일까지 결과 확인",
	"- 담당자에게 회신",
	"",
	"원문",
	"안녕하세요, 이번 달 점검 결과를 보내 드립니다.",
	"구분 | 정상 | 스팸 | 바이러스 | 합계",
	"오늘 | 120 | 3 | 0 | 123",
	"어제 | 98 | 5 | 1 | 104",
	"감사합니다.",
].join("\n");

async function open(width: number) {
	const v = new Bun.WebView({ width, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), true)`);
	await v.navigate(`http://127.0.0.1:${server.port}/?light#monitoring/notice`);
	await v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("page not ready")), 10000); const done = () => { if (typeof go === "function" && current !== "monitoring") go("monitoring", "notice"); if (document.querySelector("#mon-tl") && NT.loaded && NM.loaded) { clearTimeout(t); o.disconnect(); res(true); } }; const o = new MutationObserver(done); o.observe(document.documentElement, { subtree: true, childList: true }); done(); })`);
	// The page loads its lists (integrations, conversations, notices) in the background and redraws #mon-tl when each lands. The test
	// draws its own nodes there, so the page stops redrawing the timeline. Frames queued before (they hold the old function, and
	// go() resets monRaf without cancelling its frame) run in the next two frames, before the test draws.
	await v.evaluate(`new Promise(res => { renderMonitoring = () => {}; requestAnimationFrame(() => requestAnimationFrame(() => res(true))); })`);
	return v;
}

const draw = (at: string) => `(() => {
	const mail = msgNode({ kind: "mail", ts: ${JSON.stringify(at)}, source: "test", subject: "월간 점검 보고", from: "Alex Sender <sender@example.com>", text: ${JSON.stringify(MAIL_TEXT)} });
	const watch = monNoticeNode({ id: "w1", kind: "watch", tone: "changed", title: "서버 점검", ts: ${JSON.stringify(at)}, read: true,
		text: "서버 점검: 결과가 바뀌었어요\\n새 소식 3건\\n\`\`\`원문\\nnew=3 last=ok\\nstatus=changed\\n\`\`\`" }, ["서버 점검"]);
	const tl = document.querySelector("#mon-tl");
	tl.replaceChildren(mail, watch);
	return true;
})()`;

for (const width of [390, 1440]) {
	test(`a mail and a watch report are result cards at ${width}px: no run stats, the original folded, the table a table`, async () => {
		const v = await open(width);
		await v.evaluate(draw(new Date().toISOString()));
		const got = JSON.parse(
			(await v.evaluate(`JSON.stringify((() => {
				const cards = [...document.querySelectorAll("#mon-tl > .bm.rc")];
				return { n: cards.length, text: cards.map(c => c.innerText), src: cards.map(c => c.querySelector(".rc-src")?.textContent),
					title: cards.map(c => c.querySelector(".rc-title")?.textContent), sh: [...cards[0].querySelectorAll(".rc-sh")].map(e => e.textContent),
					time: cards.map(c => c.querySelector(".rc-time")?.textContent), open: cards.map(c => c.querySelector(".rc-raw")?.open),
					rawShown: cards.map(c => !!c.querySelector(".rc-rawbody")?.firstChild), work: document.querySelectorAll("#mon-tl details.work").length,
					over: document.documentElement.scrollWidth > innerWidth };
			})())`)) as string,
		) as { n: number; text: string[]; src: string[]; title: string[]; sh: string[]; time: string[]; open: boolean[]; rawShown: boolean[]; work: number; over: boolean };
		expect(got.n).toBe(2);
		expect(got.src).toEqual(["Alex Sender", "서버 점검"]);
		expect(got.title).toEqual(["월간 점검 보고", "결과가 바뀌었어요"]);
		expect(got.sh).toEqual(["요약", "할 일"]);
		expect(got.time.every(t => /\d{1,2}:\d{2}/.test(t))).toBe(true);
		expect(got.open).toEqual([false, false]);
		expect(got.rawShown).toEqual([false, false]);
		expect(got.work).toBe(0);
		expect(got.over).toBe(false);
		for (const t of got.text) expect(t).not.toMatch(/작업|기록 \d|명령 \d|도구 \d|구분 \|/);

		if (SHOTS) {
			mkdirSync(SHOTS, { recursive: true });
			await Bun.write(`${SHOTS}/cards-${width}-collapsed.png`, await v.screenshot());
		}
		const table = JSON.parse(
			(await v.evaluate(`new Promise(res => {
				const d = document.querySelector("#mon-tl > .bm.rc .rc-raw");
				d.addEventListener("toggle", () => res(JSON.stringify({ label: d.querySelector("summary").textContent, th: [...d.querySelectorAll("th")].map(e => e.textContent), rows: d.querySelectorAll("tbody tr").length, pipes: d.querySelector(".rc-rawbody").innerText.includes(" | ") })), { once: true });
				d.open = true;
			})`)) as string,
		) as { label: string; th: string[]; rows: number; pipes: boolean };
		expect(table.label).toBe("원문 접기");
		expect(table.th).toEqual(["구분", "정상", "스팸", "바이러스", "합계"]);
		expect(table.rows).toBe(2);
		expect(table.pipes).toBe(false);
		if (SHOTS) {
			await v.evaluate(`(document.querySelector("#mon-tl > .bm.rc .rc-raw").scrollIntoView({ block: "center" }), true)`);
			await Bun.write(`${SHOTS}/cards-${width}-original.png`, await v.screenshot());
		}
	}, 30_000);
}
