import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHub, json } from "./test-web.ts";

// A mail conversation opens where it is read top-down (the first unread message, else the start of the mail), and a mail that arrived as plain
// text is laid out: headings, a two-column list, a table, lists, folded quotes, links. The parser is pure (web/js/11-mailtext.js); the opening
// and the drawing run headless (Bun.WebView) against a small fake hub. Set MAIL_SHOTS=<dir> to keep screenshots.
const SHOTS = process.env.MAIL_SHOTS ?? "";
const mtParse = new Function(`${readFileSync(join(import.meta.dir, "..", "web", "js", "11-mailtext.js"), "utf8")}\nreturn mtParse;`)() as (raw: string) => any[];

const REPORT = `Secure Mail
스팸 리포트 메일입니다.
읽기를 원하시는 메일은 제목 왼쪽의 "복구" 버튼을 누르세요.
| 요약 정보
리포팅 대상 시간: 2026년 10월 22일 00시 00분 ~ 2026년 10월 22일 23시 59분
발송 시간: 2026년 10월 23일 01시 00분
사용자 계정: user@example.com
| 상세 내역
구분 | 정상 | 스팸 | 바이러스 | 합계
수신 | 5 | 1 | 0 | 6
발신 | 12 | 0 | 0 | 12
================================
[안내]
- 스팸으로 분류된 메일은 격리함에 7일 동안 보관됩니다.
- 복구 요청은 아래 주소에서 할 수 있습니다.
1. 링크를 엽니다.
2. 복구할 메일을 고릅니다.
복구 주소: https://example.com/restore/abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789.
문의: support@example.com 으로 보내 주세요.

> 지난 보고서에서
> 두 건을 옮겼습니다.

-----Original Message-----
보낸 사람: Alex Sender <sender@example.com>
받는 사람: user@example.com
제목: 이전 보고서
지난 보고서 내용입니다.`;

test("mtParse lays plain text out as headings, a key list, a table, lists, rules, quotes and a folded tail", () => {
	const b = mtParse(REPORT);
	expect(b.map(x => x.t)).toEqual(["p", "h", "kv", "h", "table", "hr", "h", "ul", "ol", "kv", "quote", "fold"]);
	expect(b[0].lines).toEqual(["Secure Mail", "스팸 리포트 메일입니다.", '읽기를 원하시는 메일은 제목 왼쪽의 "복구" 버튼을 누르세요.']);
	expect([b[1].text, b[3].text, b[6].text]).toEqual(["요약 정보", "상세 내역", "안내"]);
	expect(b[2].rows.map((r: string[]) => r[0])).toEqual(["리포팅 대상 시간", "발송 시간", "사용자 계정"]);
	expect(b[2].rows[0][1]).toBe("2026년 10월 22일 00시 00분 ~ 2026년 10월 22일 23시 59분");
	expect(b[4].head).toEqual(["구분", "정상", "스팸", "바이러스", "합계"]);
	expect(b[4].rows).toEqual([["수신", "5", "1", "0", "6"], ["발신", "12", "0", "0", "12"]]);
	expect(b[7].items).toHaveLength(2);
	expect([b[8].t, b[8].items]).toEqual(["ol", ["링크를 엽니다.", "복구할 메일을 고릅니다."]]);
	expect(b[9].rows.map((r: string[]) => r[0])).toEqual(["복구 주소", "문의"]);
	expect(b[10].blocks[0].lines).toEqual(["지난 보고서에서", "두 건을 옮겼습니다."]);
	expect(b[11].blocks[0].rows.map((r: string[]) => r[0])).toEqual(["보낸 사람", "받는 사람", "제목"]);
	expect(b[11].blocks[1].lines).toEqual(["지난 보고서 내용입니다."]);
	expect(mtParse(REPORT)).toBe(b);
});

test("mtParse keeps prose as prose: one key line, one pipe line, a time and a lone header at the top stay paragraphs", () => {
	expect(mtParse("참고: 이 메일은 자동으로 보냈습니다.\n내일 10:30 회의 | 확인").map(x => x.t)).toEqual(["p"]);
	expect(mtParse("보낸 사람: A\n받는 사람: B\n제목: 안녕\n\n본문입니다.").map(x => x.t)).toEqual(["kv", "p"]);
	expect(mtParse("").length).toBe(0);
});

const now = Date.now();
const at = (i: number) => new Date(now - (40 - i) * 60_000).toISOString();
const MAILKEY = "fx-3";
const SUBJECT = "[보고] 스팸 리포트 (10/23자 01시)";
const MAIL = { subject: SUBJECT, from: "Admin <admin@example.com>", source: "fx", at: at(0), summary: "요약\n일일 스팸 리포트입니다.", n: 3 };
const first = { ts: at(0), kind: "mail", source: "fx", channel: `mail:${MAILKEY}`, conv: `mail:${MAILKEY}`, mail: MAILKEY, subject: SUBJECT, from: MAIL.from, text: `${MAIL.from} · ${SUBJECT}\n\n요약\n- 일일 스팸 리포트 (10/22분)\n- 수신 6건 중 스팸 1건\n\n할 일\n- 없음\n\n원문\n${REPORT}` };
const replies = Array.from({ length: 24 }, (_, i) => ({ ts: at(i + 1), kind: "out", source: "orchestrator", target: `mail:${MAILKEY}`, text: `답장 ${i + 1}번이에요. 이 메일은 확인이 끝났고 다음에 볼 일은 없어요.` }));
let read = "";
let unread = 0;

const hub = fakeHub({
	api: (_req, url) => {
		const json = (v: unknown) => Response.json(v);
		if (url.pathname === "/api/notices") return json({ items: [], unread: 0 });
		if (url.pathname === "/api/monitors") return json({ items: [] });
		if (url.pathname === "/api/integrations") return json({ items: [{ key: "mail", label: "메일", icon: "mail", conv: ["mail:"], unread: 0, notices: [] }] });
		if (url.pathname === "/api/conversations") return json({ items: [{ target: `mail:${MAILKEY}`, unread, read: read || null, last: { ts: replies.at(-1)!.ts, text: "답장", from: "bot" }, mail: MAIL }] });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === `mail:${MAILKEY}` ? [first, ...replies] : [] });
	},
});
afterAll(() => hub.stop());
const until = (cond: string, what: string) => `new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = (${cond}); } catch {} if (ok) res(true); else if (Date.now() - t0 > 10000) rej(new Error(${JSON.stringify(what)})); else requestAnimationFrame(tick); }; tick(); })`;
const ev = async (v: InstanceType<typeof Bun.WebView>, code: string) => JSON.parse((await v.evaluate(`JSON.stringify(${code})`)) as string);
async function open(width: number) {
	const v = await hub.view({ width, height: 900 });
	await v.navigate(`${hub.origin}/`);
	await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), true)`);
	await v.navigate(`${hub.origin}/?light#monitoring/c:mail%3A${MAILKEY}`);
	await v.evaluate(until(`typeof go === "function" && CV.loaded && current === "chat" && document.querySelector("#tl .mb-txt") && CV.placed`, "mail conversation not drawn"));
	return v;
}
const place = (v: InstanceType<typeof Bun.WebView>) => ev(v, `(() => { const t = document.querySelector("#timeline"), d = document.querySelector("#tl .cv-new"), r = t.getBoundingClientRect(); return { top: t.scrollTop, max: t.scrollHeight - t.clientHeight, div: d ? d.getBoundingClientRect().top - r.top : null, head: document.querySelector("#tl .rc-hd").getBoundingClientRect().top - r.top }; })()`);

for (const width of [1440, 390]) {
	test(`a mail never opened shows its start, not the bottom, at ${width}px; the original is laid out`, async () => {
		read = ""; unread = 0;
		const v = await open(width);
		await v.evaluate(until(`CV.seen`, "the opening did not settle"));
		const p = await place(v);
		expect(p.max).toBeGreaterThan(300);
		expect(p.top).toBe(0);
		expect(p.head).toBeGreaterThanOrEqual(0);
		expect(await ev(v, `document.querySelector("#chat-jump").hidden`)).toBe(false);
		const t = await ev(v, `(() => { const b = document.querySelector("#tl .mb-txt"), q = s => [...b.querySelectorAll(s)].map(x => x.textContent);
			return { frame: !!document.querySelector("#tl iframe"), h: q(".mt-h"), kv: q(".mb-txt > .mt-kv dt"), th: q("th"), cells: b.querySelectorAll("td").length, li: b.querySelectorAll("li").length, ol: b.querySelectorAll("ol li").length, hr: b.querySelectorAll("hr").length,
				quote: q("blockquote.mt-quote"), fold: q("details.mt-fold > summary"), foldOpen: b.querySelector("details.mt-fold").open,
				a: [...b.querySelectorAll(".mb-txt > :not(details) a, .mb-txt > .mt-kv a")].map(a => [a.getAttribute("href"), a.getAttribute("rel")]), over: document.documentElement.scrollWidth > innerWidth, maxw: Math.round(b.getBoundingClientRect().width) }; })()`);
		expect(t.frame).toBe(false);
		expect(t.h).toEqual(["요약 정보", "상세 내역", "안내"]);
		expect(t.kv).toEqual(["리포팅 대상 시간", "발송 시간", "사용자 계정", "복구 주소", "문의"]);
		expect(t.th).toEqual(["구분", "정상", "스팸", "바이러스", "합계"]);
		expect([t.cells, t.li, t.ol, t.hr]).toEqual([10, 4, 2, 1]);
		expect(t.quote).toHaveLength(1);
		expect(t.fold).toEqual(["이전 메일 4줄 보기"]);
		expect(t.foldOpen).toBe(false);
		expect(t.a.map((x: string[]) => x[0])).toEqual(["mailto:user@example.com", expect.stringMatching(/^https:\/\/example\.com\/restore\/abc[a-z0-9]+$/), "mailto:support@example.com"]);
		expect(t.a.every((x: string[]) => x[1] === "noopener noreferrer")).toBe(true);
		expect(t.over).toBe(false);
		expect(t.maxw).toBeLessThanOrEqual(width === 1440 ? 700 : 390);
		if (SHOTS) {
			mkdirSync(SHOTS, { recursive: true });
			await v.evaluate(`document.querySelector("#tl .mb-txt").scrollIntoView({ block: "start" }), document.querySelector("#timeline").scrollTop -= 90`);
			await v.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
			await Bun.write(`${SHOTS}/mail-text-${width}-body.png`, await v.screenshot());
			await v.evaluate(`(document.querySelector("#timeline").scrollTop = 0, new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
			await Bun.write(`${SHOTS}/mail-text-${width}-top.png`, await v.screenshot());
		}
	}, 30_000);
}

test("a mail with unread replies opens at the first unread one, and sending still jumps to the bottom", async () => {
	read = replies[9]!.ts; unread = 14;
	const v = await open(390);
	await v.evaluate(until(`document.querySelector("#tl .cv-new")`, "divider not drawn"));
	await v.evaluate(until(`CV.seen`, "the opening did not settle"));
	const p = await place(v);
	expect(p.top).toBeGreaterThan(0);
	expect(p.top).toBeLessThan(p.max);
	expect(p.div).toBeGreaterThanOrEqual(0);
	expect(p.div).toBeLessThan(40);
	await v.evaluate(`scrollChat(true)`);
	await v.evaluate(until(`document.querySelector("#timeline").scrollTop >= document.querySelector("#timeline").scrollHeight - document.querySelector("#timeline").clientHeight - 2`, "bottom not reached"));
});
