import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// A mail's original is one scroll with the page (no scroller of its own, the frame exactly as tall as its document), every mail view names
// 보낸 사람 / 받는 사람 / 참조, and mails from the same sender get a thread: a panel beside the conversation at 1024px and up, one row that opens
// the same list on a phone. Headless (Bun.WebView) against a fake hub. Set MAIL_THREAD_SHOTS=<dir> to keep screenshots.
const SHOTS = process.env.MAIL_THREAD_SHOTS ?? "";
const json = (v: unknown, status = 200) => Response.json(v, { status });
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
const BODY = `<div><h2 style="color:#1a5fd0">월간 점검 보고서</h2>${Array.from({ length: 14 }, (_, i) => `<p>${i + 1}번째 문단이에요. 이번 달 점검 결과와 다음 달 계획을 함께 적었습니다. 확인해 주세요.</p>`).join("")}
<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>항목</th><th>결과</th><th>담당</th><th>기한</th><th>비고</th><th>링크</th></tr><tr><td>스팸 차단</td><td>정상</td><td>보안팀</td><td>금요일</td><td>없음</td><td>report-2026-10.pdf</td></tr></table>
<p><img src="/api/mail/fx-4/files/0" width="32" height="32" alt="inline"></p></div>`;

const now = Date.now();
const at = (min: number) => new Date(now - min * 60_000).toISOString();
const FROM = "Alex Sender <sender@example.com>";
const TO = "나 <me@example.com>, 팀 <team@example.com>, 기록 <log@example.com>";
const CC = "Lee <lee@example.com>, Park <park@example.com>";
const MAILS = [
	{ key: "fx-1", subject: "1주 차 점검", at: at(300), summary: "요약\n첫 주 점검이 끝났어요." },
	{ key: "fx-2", subject: "2주 차 점검", at: at(200), summary: "요약\n둘째 주 점검이 끝났어요." },
	{ key: "fx-3", subject: "3주 차 점검", at: at(100), summary: "요약\n셋째 주 점검이 끝났어요." },
	{ key: "fx-4", subject: "월간 점검 보고서", at: at(0), summary: "요약\n이번 달 점검이 끝났어요. 금요일까지 확인이 필요해요." },
	{ key: "fx-9", subject: "다른 사람의 메일", at: at(50), summary: "요약\n다른 사람이 보냈어요.", from: "Other <other@example.com>", to: "나 <me@example.com>" },
	// Sent mail: one to the same person (in the thread), one to someone else with the open mail's subject (not in it: same subject is not same person).
	{ key: "fx-7", subject: "점검 결과 회신", at: at(400), summary: "요약\n내가 회신했어요.", from: "나 <me@example.com>", to: "Alex Sender <sender@example.com>", dir: "out" },
	{ key: "fx-8", subject: "월간 점검 보고서", at: at(450), summary: "요약\n다른 사람에게 보냈어요.", from: "나 <me@example.com>", to: "Third <third@example.com>", dir: "out" },
];
const card = (m: (typeof MAILS)[number]) => ({ subject: m.subject, from: m.from ?? FROM, to: m.to ?? TO, ...(m.from ? {} : { cc: CC }), ...(m.dir ? { dir: m.dir } : {}), source: "fx", at: m.at, summary: m.summary, html: m.key === "fx-4" });
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
		if (url.pathname === "/api/monitors") return json({ items: [] });
		if (url.pathname === "/api/integrations") return json({ items: [{ key: "mail", label: "메일", icon: "mail", conv: ["mail:"], unread: 0, notices: [] }] });
		if (url.pathname === "/api/conversations") return json({ items: MAILS.map(m => ({ target: `mail:${m.key}`, unread: 0, last: { ts: m.at, text: m.subject, from: "bot" }, mail: card(m) })) });
		if (url.pathname === "/api/history") {
			const t = url.searchParams.get("target") ?? "";
			const m = MAILS.find(x => `mail:${x.key}` === t);
			if (!m) return json({ target: t, events: [] });
			const c = card(m);
			return json({ target: t, events: [{ ts: m.at, kind: "mail", source: "fx", channel: t, conv: t, mail: m.key, subject: m.subject, from: c.from, to: c.to, cc: c.cc, html: !!c.html, text: `${c.from} · ${m.subject}\n\n${m.summary}\n\n원문\n점검 결과입니다.` }] });
		}
		const body = /^\/api\/mail\/([a-z0-9._-]+)\/body$/.exec(url.pathname);
		if (body) return new Response(BODY, { headers: { "content-type": "text/html; charset=utf-8" } });
		if (/^\/api\/mail\/[a-z0-9._-]+\/files\/0$/.test(url.pathname)) return new Response(PNG, { headers: { "content-type": "image/png" } });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
});

const until = (cond: string, what: string) => `new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = (${cond}); } catch {} if (ok) res(true); else if (Date.now() - t0 > 10000) rej(new Error(${JSON.stringify(what)})); else requestAnimationFrame(tick); }; tick(); })`;
async function openPage(width: number, hash: string) {
	const v = new Bun.WebView({ width, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), true)`);
	await v.navigate(`http://127.0.0.1:${server.port}/?light#${hash}`);
	await v.evaluate(until(`typeof go === "function" && typeof INTG !== "undefined" && CV.loaded && MAILS.size >= 5`, "page not ready"));
	return v;
}
const ev = async (v: InstanceType<typeof Bun.WebView>, code: string) => JSON.parse((await v.evaluate(`JSON.stringify(${code})`)) as string);
const openMail = async (v: InstanceType<typeof Bun.WebView>, key: string) => {
	await v.evaluate(`go("monitoring", "c:mail:${key}")`);
	await v.evaluate(until(`current === "chat" && !!document.querySelector("#tl .mhd") && (document.querySelector("#tl iframe.mb-frame") ? (document.querySelector("#tl iframe.mb-frame").style.height || "") !== "" : !!document.querySelector("#tl .mb-txt"))`, `${key} original not drawn`));
};

test("at 1280px the original is the page's own scroll, the header names everyone, and the thread panel sits beside it", async () => {
	const v = await openPage(1280, "monitoring/i:mail");
	await openMail(v, "fx-4");

	const page = await ev(v, `(() => {
		const frame = document.querySelector("#tl iframe.mb-frame");
		const scrollers = [...document.querySelectorAll("*")].filter(e => {
			const ov = getComputedStyle(e).overflowY;
			if (ov !== "auto" && ov !== "scroll") return false;
			if (e.closest("#timeline, #mail-thread, #chat-convo")) return false;
			return e.scrollHeight > e.clientHeight + 1;
		}).map(e => e.className || e.tagName);
		const rows = [...document.querySelectorAll("#tl .mhd .mhd-r")].map(r => r.textContent);
		const more = [...document.querySelectorAll("#tl .mhd .mhd-more")].map(b => b.textContent);
		const thr = document.querySelector("#mail-thread");
		const tlBox = document.querySelector("#timeline").getBoundingClientRect(), thBox = thr && thr.getBoundingClientRect();
		const thrRows = [...document.querySelectorAll("#mail-thread .mth-row")];
		return { frameH: parseFloat(frame.style.height), frameW: Math.round(frame.getBoundingClientRect().width), rows, more, scrollers,
			thr: thr ? !thr.hidden : false, thrDisplay: thr ? getComputedStyle(thr).display : "none", beside: !!thBox && thBox.left >= tlBox.right - 1 && thBox.width > 200, thrHead: thr && thr.querySelector(".mth-ht") && thr.querySelector(".mth-ht").textContent, thrN: thr && thr.querySelector(".mth-n") && thr.querySelector(".mth-n").textContent,
			thrSubj: thrRows.map(r => r.querySelector(".mth-subj").textContent), thrOn: thrRows.map(r => r.className.includes("on")), thrSum: thrRows.map(r => !!r.querySelector(".mth-sum")),
			mobileRow: !!document.querySelector("#tl .mth-m"), mobileShown: !!document.querySelector("#tl .mth-m") && getComputedStyle(document.querySelector("#tl .mth-m")).display !== "none" };
	})()`);

	// only the conversation itself scrolls; nothing inside the mail (the frame included) has a scrollbar of its own
	expect(page.scrollers).toEqual([]);
	expect(page.frameH).toBeGreaterThan(600);
	// the frame is as tall as the document it holds: measure the same srcdoc offscreen at the same width
	const measured = await v.evaluate(`new Promise(res => { const f = document.createElement("iframe"); f.sandbox = "allow-same-origin"; f.style.cssText = "position:fixed;left:-99999px;top:0;width:${page.frameW}px;height:10px;border:0"; f.onload = () => { const d = f.contentDocument; res(Math.max(d.documentElement.scrollHeight, d.body.scrollHeight)); }; f.srcdoc = document.querySelector("#tl iframe.mb-frame").srcdoc; document.body.append(f); })`);
	expect(Math.abs((measured as number) - page.frameH)).toBeLessThanOrEqual(2);

	expect(page.rows.length).toBe(3);
	expect(page.rows[0]).toContain("보낸 사람");
	expect(page.rows[0]).toContain("Alex Sender");
	expect(page.rows[0]).toContain("sender@example.com");
	expect(page.rows[1]).toContain("받는 사람");
	expect(page.rows[1]).toContain("me@example.com");
	expect(page.rows[2]).toContain("참조");
	expect(page.rows[2]).toContain("lee@example.com");
	// Node.append(null) becomes the text "null": every row is built from real nodes only
	expect(page.rows.join(" ")).not.toContain("null");
	// three recipients: two shown, the rest behind 외 1명
	expect(page.more).toEqual(["외 1명"]);

	expect(page.thr).toBe(true);
	expect(page.thrDisplay).toBe("flex");
	expect(page.beside).toBe(true);
	expect(page.thrHead).toBe("이 사람과 주고받은 메일");
	expect(page.thrN).toBe("5");
	expect(page.thrSubj).toEqual(["월간 점검 보고서", "3주 차 점검", "2주 차 점검", "1주 차 점검", "점검 결과 회신"]);
	expect(page.thrOn).toEqual([true, false, false, false, false]);
	expect(page.thrSum).toEqual([true, true, true, true, true]);
	expect(page.mobileShown).toBe(false);

	// the header's 외 1명 opens the rest
	await v.evaluate(`document.querySelector("#tl .mhd-more").click()`);
	const expanded = await ev(v, `[...document.querySelectorAll("#tl .mhd .mhd-r")].map(r => r.textContent)`);
	expect(expanded[1]).toContain("team@example.com");
	expect(expanded[1]).toContain("log@example.com");

	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		await Bun.write(`${SHOTS}/mail-thread-1280.png`, await v.screenshot());
	}

	// a row of the panel opens that mail
	await v.evaluate(`document.querySelectorAll("#mail-thread .mth-row")[1].click()`);
	await v.evaluate(until(`location.hash === "#monitoring/c:mail%3Afx-3"`, "the panel row did not open fx-3"));
	await v.evaluate(until(`document.querySelector("#tl .rc-title") && document.querySelector("#tl .rc-title").textContent === "3주 차 점검"`, "fx-3 not drawn"));
	const after = await ev(v, `({ hash: location.hash, on: [...document.querySelectorAll("#mail-thread .mth-row.on")].map(r => r.dataset.t), title: document.querySelector("#tl .rc-title") && document.querySelector("#tl .rc-title").textContent })`);
	expect(after.hash).toBe("#monitoring/c:mail%3Afx-3");
	expect(after.on).toEqual(["mail:fx-3"]);
	expect(after.title).toBe("3주 차 점검");
	// a text mail shows the same header
	expect(await ev(v, `[...document.querySelectorAll("#tl .mhd .mhd-r")].map(r => r.textContent)`)).toEqual(["보낸 사람Alex Sender <sender@example.com>", "받는 사람나 <me@example.com>, 팀 <team@example.com> 외 1명", "참조Lee <lee@example.com>, Park <park@example.com>"]);
}, 30_000);

test("at 390px the thread is one row under the header that opens the same list", async () => {
	const v = await openPage(390, "monitoring/i:mail");
	await openMail(v, "fx-4");
	const box = await ev(v, `(() => {
		const m = document.querySelector("#tl .mth-mb"), p = document.querySelector("#mail-thread");
		return { row: m && m.textContent, panel: p ? getComputedStyle(p).display : "none", expanded: m && m.getAttribute("aria-expanded"), list: [...document.querySelectorAll("#tl .mth-m .mth-row")].length,
			listHidden: document.querySelector("#tl .mth-m .mth-list").hidden, over: document.documentElement.scrollWidth > innerWidth };
	})()`);
	expect(box.row).toContain("이 사람과 주고받은 메일 5");
	expect(box.panel).toBe("none");
	expect(box.expanded).toBe("false");
	expect(box.list).toBe(5);
	expect(box.listHidden).toBe(true);
	expect(box.over).toBe(false);

	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		await Bun.write(`${SHOTS}/mail-thread-390.png`, await v.screenshot());
	}

	await v.evaluate(`document.querySelector("#tl .mth-mb").click()`);
	const shown = await ev(v, `({ expanded: document.querySelector("#tl .mth-mb").getAttribute("aria-expanded"), hidden: document.querySelector("#tl .mth-m .mth-list").hidden, subj: [...document.querySelectorAll("#tl .mth-m .mth-subj")].map(e => e.textContent) })`);
	expect(shown).toEqual({ expanded: "true", hidden: false, subj: ["월간 점검 보고서", "3주 차 점검", "2주 차 점검", "1주 차 점검", "점검 결과 회신"] });
	if (SHOTS) await Bun.write(`${SHOTS}/mail-thread-390-open.png`, await v.screenshot());

	await v.evaluate(`document.querySelectorAll("#tl .mth-m .mth-row")[3].click()`);
	await v.evaluate(until(`location.hash === "#monitoring/c:mail%3Afx-1"`, "the phone thread row did not open fx-1"));
	await v.evaluate(until(`document.querySelector("#tl .rc-title") && document.querySelector("#tl .rc-title").textContent === "1주 차 점검"`, "fx-1 not drawn"));
}, 30_000);

test("a mail with no related mail shows no thread and still names who it is for", async () => {
	const v = await openPage(1280, "monitoring/i:mail");
	await openMail(v, "fx-9");
	const got = await ev(v, `({ panel: !document.querySelector("#mail-thread").hidden, mobile: !!document.querySelector("#tl .mth-m"), rows: [...document.querySelectorAll("#tl .mhd .mhd-r")].map(r => r.textContent), over: document.documentElement.scrollWidth > innerWidth })`);
	expect(got.panel).toBe(false);
	expect(got.mobile).toBe(false);
	expect(got.rows[0]).toContain("Other");
	expect(got.rows[1]).toContain("받는 사람");
	expect(got.rows.some(r => r.includes("참조"))).toBe(false);
	expect(got.over).toBe(false);
}, 30_000);

for (const width of [1280, 390]) {
	test(`mail list rows name the recipient at ${width}px`, async () => {
		const v = await openPage(width, "monitoring/i:mail");
		await v.evaluate(until(`document.querySelectorAll("#mon-tl .mr").length >= 5`, "mail rows not drawn"));
		const got = await ev(v, `(() => { const rows = [...document.querySelectorAll("#mon-tl .mr")]; return { to: rows.map(r => r.querySelector(".mr-to")?.textContent ?? null), h: rows.map(r => Math.round(r.getBoundingClientRect().height)), over: document.documentElement.scrollWidth > innerWidth }; })()`);
		// the first received mail's row (the sent fixtures name a single recipient)
		const recv = got.to.find((t: string | null) => !!t && t.includes("me@example.com")) ?? "";
		expect(recv).toContain("외 1명");
		for (const h of got.h) expect(h).toBeLessThan(width === 390 ? 190 : 150);
		expect(recv).toContain("받는 사람 나 <me@example.com>");
		expect(recv).toContain("참조 Lee <lee@example.com>");
		expect(got.over).toBe(false);
	}, 30_000);
}

test("the thread panel starts at 1024px, the panel and the conversation side by side", async () => {
	const v = await openPage(1024, "monitoring/i:mail");
	await openMail(v, "fx-4");
	const got = await ev(v, `(() => { const t = document.querySelector("#timeline").getBoundingClientRect(), p = document.querySelector("#mail-thread"), b = p.getBoundingClientRect(); return { display: getComputedStyle(p).display, beside: b.left >= t.right - 1, w: Math.round(t.width), over: document.documentElement.scrollWidth > innerWidth }; })()`);
	expect(got.display).toBe("flex");
	expect(got.beside).toBe(true);
	expect(got.w).toBeGreaterThan(400);
	expect(got.over).toBe(false);
}, 30_000);
