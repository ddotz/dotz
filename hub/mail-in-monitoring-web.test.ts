import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// A mail opened from 모니터링 stays in 모니터링 (tab, list, address, back) and its original is drawn for real: the HTML body in a sandboxed frame, else laid-out text.
// Headless (Bun.WebView), against a small fake hub. Set MAIL_SHOTS=<dir> to keep screenshots.
const SHOTS = process.env.MAIL_SHOTS ?? "";
const json = (v: unknown, status = 200) => Response.json(v, { status });
const now = new Date().toISOString();
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));

// What the hub would have stored for the HTML mail, plus things a sloppy poster could leave behind: the web must not trust the stored body.
const HTML_BODY = `<div><h2 style="color:#1a5fd0">월간 점검 보고서</h2><p>이번 달 점검이 <b>끝났어요</b>. 자세한 내용은 <a href="https://example.com/report">보고서</a>를 확인해 주세요.</p>
<table style="border-collapse:collapse;width:100%" border="1" cellpadding="6"><tr style="background:#eef3ff"><th>항목</th><th>결과</th></tr><tr><td>스팸 차단</td><td style="color:#0a8754">정상</td></tr><tr><td>백업</td><td>완료</td></tr></table>
<p><img src="/api/mail/fx-1/files/0" width="40" height="40" alt="inline"><img data-rsrc="https://img.example.test/banner.png" alt="remote"></p>
<script>window.__pwn = 1</script><img src="x" onerror="window.__pwn = 2"><a href="javascript:window.__pwn=3">bad</a></div>`;
const TEXT_BODY = "안녕하세요.\n목요일 회의를 금요일로 옮기려 합니다.\n일정표: https://example.com/plan 참고해 주세요.\n\n항목 | 시간\n회의 | 15:00\n점검 | 17:00\n\n> 지난 메일 인용\n\n감사합니다.";
const MAIL = (n: number, subject: string, html: boolean) => ({ subject, from: "Alex Sender <sender@example.com>", source: "fx", at: now, summary: "요약\n내용이 있어요.", ...(html ? { html: true, attachments: [{ name: "report.pdf", type: "application/pdf", size: 2048 }] } : {}), n });

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
		if (url.pathname === "/api/conversations") {
			return json({ items: [
				{ target: "mail:fx-1", unread: 0, last: { ts: now, text: "월간 점검 보고서", from: "bot" }, mail: MAIL(1, "월간 점검 보고서", true) },
				{ target: "mail:fx-2", unread: 0, last: { ts: new Date(Date.now() - 60_000).toISOString(), text: "회의 일정 변경", from: "bot" }, mail: MAIL(2, "회의 일정 변경", false) },
			] });
		}
		if (url.pathname === "/api/history") {
			const t = url.searchParams.get("target") ?? "";
			const html = t === "mail:fx-1";
			const subject = html ? "월간 점검 보고서" : "회의 일정 변경";
			return json({ target: t, events: [{ ts: now, kind: "mail", source: "fx", channel: t, conv: t, mail: t.slice(5), subject, from: "Alex Sender <sender@example.com>", ...(html ? { html: true, attachments: [{ name: "report.pdf", type: "application/pdf", size: 2048 }] } : {}), text: `Alex Sender <sender@example.com> · ${subject}\n\n요약\n내용이 있어요.\n\n원문\n${html ? "점검이 끝났어요." : TEXT_BODY}` }] });
		}
		if (url.pathname === "/api/mail/fx-1/body") return new Response(HTML_BODY, { headers: { "content-type": "text/html; charset=utf-8" } });
		if (url.pathname === "/api/mail/fx-1/files/0") return new Response(PNG, { headers: { "content-type": "image/png" } });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
});

const until = (cond: string, what: string) => `new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = (${cond}); } catch {} if (ok) res(true); else if (Date.now() - t0 > 10000) rej(new Error(${JSON.stringify(what)})); else requestAnimationFrame(tick); }; tick(); })`;
async function open(width: number, hash: string) {
	const v = new Bun.WebView({ width, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), true)`);
	await v.navigate(`http://127.0.0.1:${server.port}/?light#${hash}`);
	await v.evaluate(until(`typeof go === "function" && typeof INTG !== "undefined" && CV.loaded`, "page not ready"));
	return v;
}
const ev = async (v: InstanceType<typeof Bun.WebView>, code: string) => JSON.parse((await v.evaluate(`JSON.stringify(${code})`)) as string);

for (const width of [1440, 390]) {
	test(`a mail opened from 모니터링 stays in 모니터링 at ${width}px, and its HTML original is drawn in a sandboxed frame`, async () => {
		const v = await open(width, "monitoring/i:mail");
		await v.evaluate(until(`current === "monitoring" && document.querySelectorAll("#mon-tl .mr").length === 2`, "mail rows not drawn"));
		await v.evaluate(`document.querySelector("#mon-tl .mr").click()`);
		await v.evaluate(until(`current === "chat" && document.querySelector("#tl iframe.mb-frame") && document.querySelector("#chat-convo .cv-row")`, "mail conversation not drawn"));
		const s = await ev(v, `({ hash: location.hash, cur: current, ctx: monCtx, on: [...document.querySelectorAll("#nav .ni.on")].map(b => b.dataset.view), chatHidden: document.querySelector("#v-chat").hidden, monHidden: document.querySelector("#v-monitoring").hidden,
			title: document.querySelector("#title").textContent, back: !document.querySelector("#back").hidden,
			side: [...document.querySelectorAll("#chat-convo .cv-row")].map(r => r.dataset.k || r.dataset.t), sideSel: [...document.querySelectorAll("#chat-convo .cv-row.on")].map(r => r.dataset.k), sideLabel: document.querySelector("#chat-convo").getAttribute("aria-label") })`);
		expect(s.hash).toBe("#monitoring/c:mail%3Afx-1");
		expect(s.on).toEqual(["monitoring"]);
		expect([s.cur, s.chatHidden, s.monHidden]).toEqual(["chat", false, true]);
		expect(s.side).toContain("i:mail");
		expect(s.side).not.toContain("main");
		expect(s.sideLabel).toBe("모니터링 목록");
		if (width === 390) expect([s.title, s.back]).toEqual(["월간 점검 보고서", true]);
		else expect([s.title, s.sideSel]).toEqual(["모니터링", ["i:mail"]]);

		await v.evaluate(until(`(document.querySelector("#tl iframe.mb-frame")?.style.height || "") !== ""`, "frame height not measured"));
		const f = await ev(v, `(() => { const fr = document.querySelector("#tl iframe.mb-frame"), d = fr.srcdoc; return { sandbox: fr.getAttribute("sandbox"), h: parseFloat(fr.style.height), w: fr.getBoundingClientRect().width,
			table: d.includes("<table"), th: d.includes("<th>항목</th>"), style: d.includes("color:#1a5fd0"), script: /<script|onerror|javascript:/i.test(d), pwn: window.__pwn ?? null,
			csp: d.includes("default-src 'none'") && d.includes("img-src data:;"), inlined: /<img[^>]+src="data:image\\/png;base64,/.test(d), remote: /\ssrc="https?:/.test(d), base: d.includes('<base target="_blank">'),
			links: [...new DOMParser().parseFromString(d, "text/html").querySelectorAll("a[href]")].map(a => [a.getAttribute("href"), a.getAttribute("rel"), a.getAttribute("target")]),
			bar: document.querySelector(".mb-bar").textContent, files: document.querySelector(".mr-files")?.textContent ?? "", filesAfter: !!(document.querySelector(".rc-raw").compareDocumentPosition(document.querySelector(".mr-files")) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`);
		expect(f.sandbox).not.toContain("allow-scripts");
		expect(f.sandbox).not.toContain("allow-same-origin");
		expect(f.h).toBeGreaterThan(150);
		expect([f.table, f.th, f.style, f.csp, f.inlined, f.base]).toEqual([true, true, true, true, true, true]);
		expect([f.script, f.pwn, f.remote]).toEqual([false, null, false]);
		expect(f.links).toEqual([["https://example.com/report", "noopener noreferrer", "_blank"]]);
		expect(f.bar).toContain("바깥 이미지 1개를 막았어요");
		expect(f.files).toContain("report.pdf");
		expect(f.filesAfter).toBe(true);
		expect(f.w).toBeGreaterThan(width === 390 ? 250 : 500);
		if (SHOTS) {
			mkdirSync(SHOTS, { recursive: true });
			await Bun.write(`${SHOTS}/mail-in-monitoring-${width}.png`, await v.screenshot());
		}

		await v.evaluate(`document.querySelector(".mb-bar button").click()`);
		await v.evaluate(until(`document.querySelector("#tl iframe.mb-frame").srcdoc.includes(' src="https://img.example.test/banner.png"')`, "remote images not switched on"));
		expect(await ev(v, `document.querySelector("#tl iframe.mb-frame").srcdoc.slice(0, 400)`)).toContain("img-src data: https: http:;");
		await v.evaluate(`document.querySelector(".mb-bar button").click()`);
		await v.evaluate(until(`!document.querySelector("#tl iframe.mb-frame").srcdoc.includes(' src="https://img.example.test/banner.png"')`, "remote images not switched off"));

		if (width === 390) {
			await v.evaluate(`document.querySelector("#back").click()`);
			await v.evaluate(until(`current === "monitoring" && !MON.list && MON.sel === "i:mail" && location.hash === "#monitoring/i%3Amail"`, "back did not return to the mail list of 모니터링"));
			expect(await ev(v, `({ hash: location.hash, on: [...document.querySelectorAll("#nav .ni.on")].map(b => b.dataset.view) })`)).toEqual({ hash: "#monitoring/i%3Amail", on: ["monitoring"] });
			await v.evaluate(`history.back()`);
			await v.evaluate(until(`current === "monitoring" && MON.list`, "browser back did not return to the 모니터링 list"));
		} else {
			await v.evaluate(`document.querySelector('#nav .ni[data-view="chat"]').click()`);
			await v.evaluate(until(`current === "chat" && !monCtx && target === MAIN`, "the 채팅 tab did not open the chat"));
			expect(await ev(v, `[...document.querySelectorAll("#nav .ni.on")].map(b => b.dataset.view)`)).toEqual(["chat"]);
		}
	}, 30_000);
}

test("old chat addresses and notice deep links of a mail land in 모니터링", async () => {
	const v = await open(390, "chat/mail:fx-1");
	await v.evaluate(until(`current === "chat" && monCtx === "mail:fx-1"`, "deep link did not open the mail in 모니터링"));
	expect(await ev(v, `({ hash: location.hash, on: [...document.querySelectorAll("#nav .ni.on")].map(b => b.dataset.view), sel: MON.sel })`)).toEqual({ hash: "#monitoring/c:mail%3Afx-1", on: ["monitoring"], sel: "i:mail" });
	await v.evaluate(`go("home")`);
	await v.evaluate(until(`current === "home" && !monCtx`, "home not shown"));
	await v.evaluate(`pushOpen("#chat/mail:fx-2")`);
	await v.evaluate(until(`current === "chat" && monCtx === "mail:fx-2"`, "push deep link did not open the mail in 모니터링"));
	expect(await ev(v, `({ hash: location.hash, on: [...document.querySelectorAll("#nav .ni.on")].map(b => b.dataset.view) })`)).toEqual({ hash: "#monitoring/c:mail%3Afx-2", on: ["monitoring"] });
	await v.evaluate(`go("home")`);
	await v.evaluate(`noticeOpen({ kind: "message", tone: "", src: "mail:fx-1", open: "mail:fx-1", at: ${JSON.stringify(now)}, ts: ${JSON.stringify(now)}, title: "메일", text: "새 메일" })`);
	await v.evaluate(until(`current === "chat" && monCtx === "mail:fx-1"`, "notice tap did not open the mail in 모니터링"));
});

test("a mail without HTML shows its text with paragraphs, links, quotes and a real table", async () => {
	const v = await open(390, "monitoring/c:mail%3Afx-2");
	await v.evaluate(until(`current === "chat" && document.querySelector("#tl .mb-txt")`, "text original not drawn"));
	const t = await ev(v, `(() => { const b = document.querySelector("#tl .mb-txt"); return { frame: !!document.querySelector("#tl iframe"), p: b.querySelectorAll(":scope > p").length, a: [...b.querySelectorAll("a")].map(a => [a.getAttribute("href"), a.getAttribute("rel")]),
		cells: [...b.querySelectorAll("table tr")].map(r => [...r.children].map(c => c.textContent)), quote: b.querySelector("blockquote")?.textContent ?? null, br: b.querySelectorAll("p br").length, over: document.documentElement.scrollWidth > innerWidth }; })()`);
	expect(t.frame).toBe(false);
	expect(t.p).toBe(2);
	expect(t.a).toEqual([["https://example.com/plan", "noopener noreferrer"]]);
	expect(t.cells).toEqual([["항목", "시간"], ["회의", "15:00"], ["점검", "17:00"]]);
	expect(t.quote).toBe("지난 메일 인용");
	expect(t.br).toBeGreaterThanOrEqual(2);
	expect(t.over).toBe(false);
	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		await Bun.write(`${SHOTS}/mail-text-390.png`, await v.screenshot());
	}
});
