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
	// Live shape: the hub summarizes after the mail is posted, so the summary is on the list's record only and the mail event's text has none.
	{ key: "fx-live", live: true, subject: "견적 회신 요청", at: at(60), summary: "견적서를 보냈다는 메일이에요.\n**금요일까지 회신**해 주세요.", from: "Live <live@example.com>", to: "나 <me@example.com>", body: "안녕하세요. 견적서를 첨부합니다." },
	{ key: "fx-same", live: true, subject: "본문이 요약인 메일", at: at(70), summary: "본문 첫 줄이에요.", from: "Same <same@example.com>", to: "나 <me@example.com>", body: "본문 첫 줄이에요. 뒤에 더 있어요." },
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
			return json({ target: t, events: [{ ts: m.at, kind: "mail", source: "fx", channel: t, conv: t, mail: m.key, subject: m.subject, from: c.from, to: c.to, cc: c.cc, html: !!c.html, text: m.live ? `${c.from} · ${m.subject}\n\n원문\n${m.body}` : `${c.from} · ${m.subject}\n\n${m.summary}\n\n원문\n점검 결과입니다.`, ...(m.live ? { preview: m.body } : {}) }] });
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
	await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), localStorage.removeItem("dz-mth-open"), true)`);
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

	// the panel is folded at the start (the mail body keeps the room); the chip at the end of the recipients line opens it
	expect(await ev(v, `({ hidden: document.querySelector("#mail-thread").hidden, chip: document.querySelector("#tl .mth-mb").getAttribute("aria-expanded") })`)).toEqual({ hidden: true, chip: "false" });
	// the screen's entrance motion (a rise) moves the whole view by a pixel or two while it runs: measure once it ended
	await v.evaluate(until(`document.getAnimations().length === 0`, "the entrance motion did not end"));

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
		return { frameH: parseFloat(frame.style.height), frameW: Math.round(frame.getBoundingClientRect().width), rows, more, scrollers };
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

	// the chip opens the panel beside the mail
	await v.evaluate(`document.querySelector("#tl .mth-mb").click()`);
	await v.evaluate(until(`!document.querySelector("#mail-thread").hidden`, "the chip did not open the panel"));
	const pan = await ev(v, `(() => {
		const thr = document.querySelector("#mail-thread"), tlBox = document.querySelector("#timeline").getBoundingClientRect(), thBox = thr.getBoundingClientRect(), thrRows = [...document.querySelectorAll("#mail-thread .mth-row")];
		return { thr: !thr.hidden, thrDisplay: getComputedStyle(thr).display, beside: thBox.left >= tlBox.right - 1 && thBox.width > 200, thrHead: thr.querySelector(".mth-ht") && thr.querySelector(".mth-ht").textContent, thrN: thr.querySelector(".mth-n") && thr.querySelector(".mth-n").textContent,
			thrSubj: thrRows.map(r => r.querySelector(".mth-subj").textContent), thrOn: thrRows.map(r => r.className.includes("on")), thrSum: thrRows.map(r => !!r.querySelector(".mth-sum")) };
	})()`);
	expect(pan.thr).toBe(true);
	expect(pan.thrDisplay).toBe("flex");
	expect(pan.beside).toBe(true);
	expect(pan.thrHead).toBe("이 사람과 주고받은 메일");
	expect(pan.thrN).toBe("5");
	expect(pan.thrSubj).toEqual(["월간 점검 보고서", "3주 차 점검", "2주 차 점검", "1주 차 점검", "점검 결과 회신"]);
	expect(pan.thrOn).toEqual([true, false, false, false, false]);
	expect(pan.thrSum).toEqual([true, true, true, true, true]);
	// the chip stays in the recipients line at this width and follows the panel; the phone's inline list stays folded
	expect(await ev(v, `({ chip: document.querySelector("#tl .mth-mb").getAttribute("aria-expanded"), list: document.querySelector("#tl .mth-m .mth-list").hidden })`)).toEqual({ chip: "true", list: true });

	// the header's 외 1명 opens the rest
	await v.evaluate(`document.querySelector("#tl .mhd-more").click()`);
	const expanded = await ev(v, `[...document.querySelectorAll("#tl .mhd .mhd-r")].map(r => r.textContent)`);
	expect(expanded[1]).toContain("team@example.com");
	expect(expanded[1]).toContain("log@example.com");

	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		await Bun.write(`${SHOTS}/mail-thread-1280.png`, await v.screenshot());
	}

	// the panel's own × folds it again, the chip opens it again
	await v.evaluate(`document.querySelector("#mail-thread .mth-x").click()`);
	expect(await ev(v, `({ hidden: document.querySelector("#mail-thread").hidden, chip: document.querySelector("#tl .mth-mb").getAttribute("aria-expanded") })`)).toEqual({ hidden: true, chip: "false" });
	await v.evaluate(`document.querySelector("#tl .mth-mb").click()`);
	await v.evaluate(until(`!document.querySelector("#mail-thread").hidden`, "the chip did not reopen the panel"));

	// a row of the panel opens that mail
	await v.evaluate(`document.querySelectorAll("#mail-thread .mth-row")[1].click()`);
	await v.evaluate(until(`location.hash === "#monitoring/c:mail%3Afx-3"`, "the panel row did not open fx-3"));
	// the conversation is named after the mail, so its head says the subject and the open card does not say it again
	await v.evaluate(until(`document.querySelector("#tl .mopen") && document.querySelector("#thead .val") && document.querySelector("#thead .val").textContent === "3주 차 점검"`, "fx-3 not drawn"));
	const after = await ev(v, `({ hash: location.hash, on: [...document.querySelectorAll("#mail-thread .mth-row.on")].map(r => r.dataset.t), title: document.querySelector("#thead .val").textContent, cardTitle: !!document.querySelector("#tl .mopen .rc-title") })`);
	expect(after.hash).toBe("#monitoring/c:mail%3Afx-3");
	expect(after.on).toEqual(["mail:fx-3"]);
	expect(after.title).toBe("3주 차 점검");
	expect(after.cardTitle).toBe(false);
	// a text mail shows the same header
	expect(await ev(v, `[...document.querySelectorAll("#tl .mhd .mhd-r")].map(r => r.textContent)`)).toEqual(["보낸 사람Alex Sender <sender@example.com>", "받는 사람나 <me@example.com>, 팀 <team@example.com> 외 1명", "참조Lee <lee@example.com>, Park <park@example.com>"]);
}, 30_000);

test("at 390px the thread is a chip at the end of the recipients line that opens the same list", async () => {
	const v = await openPage(390, "monitoring/i:mail");
	await openMail(v, "fx-4");
	const box = await ev(v, `(() => {
		const m = document.querySelector("#tl .mth-mb"), p = document.querySelector("#mail-thread");
		return { row: m && m.getAttribute("aria-label"), count: m && m.textContent, panel: p ? getComputedStyle(p).display : "none", expanded: m && m.getAttribute("aria-expanded"), list: [...document.querySelectorAll("#tl .mth-m .mth-row")].length,
			listHidden: document.querySelector("#tl .mth-m .mth-list").hidden, over: document.documentElement.scrollWidth > innerWidth };
	})()`);
	expect(box.row).toBe("이 사람과 주고받은 메일 5");
	expect(box.count).toBe("5");
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
	await v.evaluate(until(`document.querySelector("#tl .mopen") && document.querySelector("#thead .val") && document.querySelector("#thead .val").textContent === "1주 차 점검" && !document.querySelector("#tl .mopen .rc-title")`, "fx-1 not drawn"));
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
	await v.evaluate(`document.querySelector("#tl .mth-mb").click()`);
	await v.evaluate(until(`!document.querySelector("#mail-thread").hidden`, "the chip did not open the panel"));
	const got = await ev(v, `(() => { const t = document.querySelector("#timeline").getBoundingClientRect(), p = document.querySelector("#mail-thread"), b = p.getBoundingClientRect(); return { display: getComputedStyle(p).display, beside: b.left >= t.right - 1, w: Math.round(t.width), over: document.documentElement.scrollWidth > innerWidth }; })()`);
	expect(got.display).toBe("flex");
	expect(got.beside).toBe(true);
	expect(got.w).toBeGreaterThan(400);
	expect(got.over).toBe(false);
}, 30_000);

test("a sender or recipient given by name only is shown by name, and the body's own pictures are not listed as files", async () => {
	const v = await openPage(390, "monitoring/i:mail");
	const got = await ev(v, `(() => {
		const head = mailHeadNode({ from: "Jisoo Han (KR - A", to: "이서준", cc: "Park <park@example.com>" }), quoted = mailHeadNode({ from: String.fromCharCode(34) + "이서준" + String.fromCharCode(34) + " <gm.lee@example.com>" });
		const files = mailFilesNode("fx-1", [{ name: "image001.png", size: 10, inline: true }, { name: "견적서.pdf", size: 2048 }]);
		const none = mailFilesNode("fx-1", [{ name: "image001.png", size: 10, inline: true }]);
		return { rows: [...head.querySelectorAll(".mhd-r")].map(r => r.textContent), quoted: quoted.querySelector(".mhd-r").textContent, quotedRows: quoted.querySelectorAll(".mhd-r").length, emptyRows: mailHeadNode({}).querySelectorAll(".mhd-r").length, files: files ? [files.querySelector(".mr-fh").textContent, ...[...files.querySelectorAll("a")].map(a => a.textContent + "|" + a.getAttribute("href"))] : null, none };
	})()`);
	expect(got.rows).toEqual(["보낸 사람Jisoo Han (KR - A", "받는 사람이서준", "참조Park <park@example.com>"]);
	expect(got.quoted).toBe("보낸 사람이서준 <gm.lee@example.com>");
	// a person nobody is known for has no row at all (no "-" placeholder)
	expect([got.quotedRows, got.emptyRows]).toEqual([1, 0]);
	expect(got.files[0]).toBe("첨부 1개");
	expect(got.files[1]).toStartWith("견적서.pdf");
	expect(got.files[1]).toContain("/api/mail/fx-1/files/1");
	expect(got.none).toBe(null);
}, 30_000);

test("an opened mail whose summary is only on its record (the live shape) draws the block under the recipients, and a summary that is its own body does not", async () => {
	const v = await openPage(1280, "monitoring/i:mail");
	await openMail(v, "fx-live");
	const live = await ev(v, `(() => { const b = document.querySelector("#tl .mopen .msum"); return { text: b && b.textContent, bold: b ? [...b.querySelectorAll("b")].map(x => x.textContent) : [], secs: document.querySelectorAll("#tl .mopen > .rc-sec").length, order: b && !!(b.nextElementSibling || {}).matches && b.nextElementSibling.matches(".rc-raw") }; })()`);
	expect(live).toEqual({ text: "요약 · 견적서를 보냈다는 메일이에요. 금요일까지 회신해 주세요.", bold: ["금요일까지 회신"], secs: 0, order: true });
	await openMail(v, "fx-same");
	expect(await ev(v, `({ sum: document.querySelectorAll("#tl .mopen .msum").length, secs: document.querySelectorAll("#tl .mopen > .rc-sec").length })`)).toEqual({ sum: 0, secs: 0 });
}, 30_000);

test("the opened mail's summary: two sentences with the to-do in bold, an older one-line or sectioned summary still draws, and a mail's text is never parsed as HTML", async () => {
	const v = await openPage(1280, "monitoring/i:mail");
	const got = await ev(v, `(() => {
		const split = t => mailSumSplit(t);
		const n = mailSumBlock("<img src=x onerror=alert(1)>예요.\\n**<u>금요일까지 회신</u>**해 주세요.");
		return {
			one: split("견적서를 보냈다는 메일이에요."),
			two: split("메일이에요.\\n**금요일까지 회신**해 주세요."),
			old: split("**요약**\\n• 첫째예요\\n• 둘째예요\\n\\n**첨부**\\n• a.pdf\\n\\n**할 일**\\n• 금요일까지 회신\\n"),
			none: split("**요약**\\n• 첫째예요\\n\\n**할 일**\\n• 없음\\n"),
			bold: [...n.querySelectorAll("b")].map(b => b.textContent), children: n.querySelectorAll("img, u").length, text: n.textContent,
		};
	})()`);
	expect(got.one).toEqual({ about: "견적서를 보냈다는 메일이에요.", todo: "" });
	expect(got.two).toEqual({ about: "메일이에요.", todo: "**금요일까지 회신**해 주세요." });
	expect(got.old).toEqual({ about: "첫째예요 둘째예요", todo: "**금요일까지 회신**" });
	expect(got.none).toEqual({ about: "첫째예요", todo: "" });
	expect(got.bold).toEqual(["<u>금요일까지 회신</u>"]);
	expect(got.children).toBe(0);
	expect(got.text).toBe("요약 · <img src=x onerror=alert(1)>예요. <u>금요일까지 회신</u>해 주세요.");
}, 30_000);
