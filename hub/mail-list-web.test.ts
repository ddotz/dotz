import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The mail rows of the 모니터링 tab (web/js/30-monitoring.js monConvNode) in a headless browser: compact, the summary visible,
// 본문 and 첨부 on the right, the suggestion slot only with data. Set MAIL_SHOTS=<dir> to keep screenshots.
const SHOTS = process.env.MAIL_SHOTS ?? "";
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

async function open(width: number) {
	const v = new Bun.WebView({ width, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), true)`);
	await v.navigate(`http://127.0.0.1:${server.port}/?light#monitoring/notice`);
	await v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("page not ready")), 10000); const done = () => { if (typeof go === "function" && current !== "monitoring") go("monitoring", "notice"); if (document.querySelector("#mon-tl") && NT.loaded && NM.loaded) { clearTimeout(t); o.disconnect(); res(true); } }; const o = new MutationObserver(done); o.observe(document.documentElement, { subtree: true, childList: true }); done(); })`);
	return v;
}

const now = new Date().toISOString();
const MAILS = [
	{ t: "mail:fx-1", m: { subject: "월간 점검 보고서 확인 요청", from: "Alex Sender <sender@example.com>", source: "fx", at: now, summary: "요약\n이번 달 점검이 끝났어요. 스팸 차단은 정상이고 금요일까지 결과 확인이 필요해요.", attachments: [{ name: "점검보고서-2026-10.pdf", type: "application/pdf", size: 482113 }, { name: "차트.png", type: "image/png", size: 20480 }] }, unread: 1 },
	{ t: "mail:fx-2", m: { subject: "회의 일정 변경", from: "Kim <kim@example.com>", source: "fx", at: now, preview: "안녕하세요.\n목요일 회의를 금요일 오후로 옮기려고 합니다.\n가능하신지 알려 주세요." }, unread: 0 },
	{ t: "mail:fx-3", m: { subject: "긴 요약 메일", from: "Lee <lee@example.com>", source: "fx", at: now, summary: "첫째 줄 내용입니다. 둘째 문장입니다. 셋째 문장입니다. 넷째 문장입니다. 다섯째 문장입니다. 여섯째 문장입니다. 일곱째 문장입니다. 여덟째 문장입니다. 아홉째 문장입니다. 열째 문장입니다. 열한째 문장입니다. 열두째 문장입니다.", suggest: { label: "답장 초안" } }, unread: 0 },
];
const draw = `(() => {
	const rows = ${JSON.stringify(MAILS)}.map(({ t, m, unread }) => { MAILS.set(t, m); CONV.set(t, { ts: m.at, text: m.subject, from: "bot" }); ts(t).unread = unread; return monConvNode(t, "메일"); });
	document.querySelector("#mon-tl").replaceChildren(...rows);
	return true;
})()`;

for (const width of [1440, 390]) {
	test(`mail rows at ${width}px are compact, show the summary and keep 본문 / 첨부 on the right`, async () => {
		const v = await open(width);
		await v.evaluate(draw);
		const got = JSON.parse((await v.evaluate(`JSON.stringify((() => {
			const rows = [...document.querySelectorAll("#mon-tl > .bm.rc.mr")];
			const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
			return { n: rows.length, h: rows.map(r => r.getBoundingClientRect().height), src: rows.map(r => r.querySelector(".rc-src").textContent), title: rows.map(r => r.querySelector(".rc-title").textContent),
				sum: rows.map(r => r.querySelector(".mr-sum")?.textContent ?? null), sumH: rows.map(r => r.querySelector(".mr-sum")?.getBoundingClientRect().height ?? 0),
				btns: rows.map(r => [...r.querySelectorAll(".mr-btn")].map(b => ({ label: b.getAttribute("aria-label"), title: b.title, n: b.querySelector(".mr-n")?.textContent ?? null, ...box(b) }))),
				rowBox: rows.map(box), mainBox: rows.map(r => box(r.querySelector(".mr-main"))), slot: rows.map(r => r.querySelector("[data-slot=suggest]")?.textContent ?? null),
				old: [...document.querySelectorAll("#mon-tl button")].filter(b => b.textContent === "메일 열기").length, over: document.documentElement.scrollWidth > innerWidth };
		})())`)) as string) as any;
		expect(got.n).toBe(3);
		expect(got.src).toEqual(["Alex Sender", "Kim", "Lee"]);
		expect(got.title[0]).toBe("월간 점검 보고서 확인 요청");
		expect(got.sum[0]).toBe("이번 달 점검이 끝났어요. 스팸 차단은 정상이고 금요일까지 결과 확인이 필요해요.");
		expect(got.sum[1]).toBe("안녕하세요. 목요일 회의를 금요일 오후로 옮기려고 합니다. 가능하신지 알려 주세요.");
		for (const h of got.sumH) expect(h).toBeLessThanOrEqual(60);
		for (const r of got.h) expect(r).toBeLessThan(width === 390 ? 190 : 150);
		expect(got.btns.map((b: any[]) => b.map(x => x.label))).toEqual([["메일 본문과 대화 열기", "첨부파일 2개 보기"], ["메일 본문과 대화 열기"], ["메일 본문과 대화 열기"]]);
		expect(got.btns[0][1].n).toBe("2");
		for (const [i, row] of got.btns.entries()) for (const b of row) {
			expect(b.w).toBeGreaterThanOrEqual(40);
			expect(b.h).toBeGreaterThanOrEqual(36);
			expect(b.x).toBeGreaterThan(got.mainBox[i].x + got.mainBox[i].w - 1);
			expect(b.x + b.w).toBeLessThanOrEqual(got.rowBox[i].x + got.rowBox[i].w + 0.5);
			if (width === 390) expect(b.h).toBeGreaterThanOrEqual(40);
		}
		expect(got.slot).toEqual([null, null, "답장 초안"]);
		expect(got.old).toBe(0);
		expect(got.over).toBe(false);
		if (SHOTS) {
			mkdirSync(SHOTS, { recursive: true });
			await Bun.write(`${SHOTS}/mail-list-${width}.png`, await v.screenshot());
		}

		const files = JSON.parse((await v.evaluate(`new Promise(res => {
			const row = document.querySelector("#mon-tl > .bm.rc.mr"), btn = row.querySelectorAll(".mr-btn")[1];
			btn.click();
			res(JSON.stringify({ expanded: btn.getAttribute("aria-expanded"), links: [...row.querySelectorAll(".mr-fn")].map(a => [a.getAttribute("href"), a.target, a.textContent]), dl: [...row.querySelectorAll(".mr-dl")].map(a => [a.getAttribute("href"), a.download]),
				tap: [...row.querySelectorAll(".mr-fn, .mr-dl")].map(a => Math.round(a.getBoundingClientRect().height)), over: document.documentElement.scrollWidth > innerWidth }));
		})`)) as string) as any;
		expect(files.expanded).toBe("true");
		expect(files.links).toEqual([["/api/mail/fx-1/files/0", "_blank", "점검보고서-2026-10.pdf471KB"], ["/api/mail/fx-1/files/1", "_blank", "차트.png20KB"]]);
		expect(files.dl).toEqual([["/api/mail/fx-1/files/0?dl=1", "점검보고서-2026-10.pdf"], ["/api/mail/fx-1/files/1?dl=1", "차트.png"]]);
		for (const h of files.tap) expect(h).toBeGreaterThanOrEqual(40);
		expect(files.over).toBe(false);
		if (SHOTS) await Bun.write(`${SHOTS}/mail-list-${width}-files.png`, await v.screenshot());
	}, 30_000);
}
