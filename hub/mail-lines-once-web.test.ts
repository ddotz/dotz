// 할 일 / 직접 답할 것 are on screen once: the opened mail draws them under its summary, so a draft unfolded beside it leaves them out, and a draft
// card that stands alone (the 메일 list, the quick-review sheet) keeps them; 답장 대기 draws the queue card, which has none. Headless against a fake hub. Set MAIL_LINES_SHOTS=<dir> to keep screenshots.
import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const SHOTS = process.env.MAIL_LINES_SHOTS ?? "";
const now = new Date().toISOString();
const FROM = "Alex Sender <sender@example.com>";
const SUMMARY = "이번 달 점검이 끝났고 결과 확인을 부탁해요.";
const LINES = { todo: ["보고서 확인", "금요일까지 회신"], questions: ["다음 점검 날짜는요?", "담당자는 누구인가요?"] };
const OPTS = [{ n: 1, label: "보내기", desc: "", rec: true }, { n: 2, label: "고치기", desc: "", rec: false, detail: true }, { n: 3, label: "보내지 않기", desc: "", rec: false }];
const conv = (key: string) => ({ target: `mail:${key}`, unread: 0, read: now, last: { ts: now, text: "월간 점검 보고서", from: "bot" }, mail: { subject: "월간 점검 보고서", from: FROM, to: "me@example.com", source: "fx", at: now, summary: SUMMARY, ...LINES } });
const notice = (id: string, key: string, state: string) => ({ id, ts: now, updated: now, kind: "decision", tone: "ask", title: "이 답장 보낼까요?", text: "이 답장 보낼까요?", open: `mail:${key}`, src: `mail:${key}`, at: now, read: state !== "open",
	decision: { options: OPTS, to: `mail:${key}`, reply_to: now, group: 1, state, ...(state === "open" ? {} : { answer: "1) 보내기", answered_at: now }),
		draft: { brief: { from: FROM, summary: SUMMARY, ...LINES }, toLabel: "받는이", to: FROM, subject: "Re: 월간 점검 보고서", body: "안녕하세요, Alex님.\n\n보내 주신 보고서는 잘 받았습니다.\n\n감사합니다." } } });
const NOTICES = [notice("sent", "fx-1", "answered"), notice("wait", "fx-2", "open")];
const hub = fakeHub({
	api: (_req, url) => {
		const t = url.searchParams.get("target") ?? "";
		if (url.pathname === "/api/notices") return json({ items: NOTICES, unread: 0 });
		if (url.pathname === "/api/conversations") return json({ items: [conv("fx-1"), conv("fx-2")] });
		if (url.pathname === "/api/integrations") return json({ items: [{ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: NOTICES.map(n => n.id), unread: 0 }], available: [] });
		if (url.pathname === "/api/history") return json({ target: t, events: t.startsWith("mail:") ? [{ ts: now, kind: "mail", source: "fx", channel: t, conv: t, mail: t.slice(5), subject: "월간 점검 보고서", from: FROM, to: "me@example.com", text: `${FROM} · 월간 점검 보고서\n\n${SUMMARY}\n\n원문\n보고서를 보내 드립니다.` }] : [] });
	},
});
afterAll(() => hub.stop());

const blocks = (root: string) => `[...document.querySelector(${JSON.stringify(root)}).querySelectorAll('[data-k="mail-lines"]')].filter(x => x.getClientRects().length).length`;
async function open(width: number, theme: string) {
	const v = await hub.view({ width, height: 900 });
	await v.navigate(`${hub.origin}/`);
	await v.evaluate(`(localStorage.setItem("dotz-theme", ${JSON.stringify(theme)}), true)`);
	await v.navigate(`${hub.origin}/?${theme}#monitoring/i:mail`);
	const { waitFor } = on(v);
	await waitFor(`typeof go === "function" && NT.loaded && CV.loaded && MAILS.has("mail:fx-1")`);
	return { v, waitFor };
}
const openMail = async ({ v, waitFor }: Awaited<ReturnType<typeof open>>, key: string) => {
	await v.evaluate(`(go("monitoring", "c:mail:${key}"), 0)`);
	await waitFor(`current === "chat" && !!document.querySelector('#tl .mopen [data-k="mail-lines"]')`);
};

for (const [width, theme] of [[1280, "light"], [1280, "dark"], [390, "light"], [390, "dark"]] as const) {
	test(`an opened mail at ${width}px ${theme} shows its lines once, with a draft unfolded under it`, async () => {
		const page = await open(width, theme), { v, waitFor } = page;
		await openMail(page, "fx-1");
		await waitFor(`document.querySelector('#tl .ms-card[data-nid="sent"] .ms-line')`);
		await v.evaluate(`(document.querySelector('#tl .ms-card[data-nid="sent"] .ms-line').click(), 0)`);
		await waitFor(`document.querySelector('#tl .ms-card[data-nid="sent"] .dr-body')`);
		expect(await v.evaluate(blocks("#v-chat"))).toBe(1);
		expect(await v.evaluate(blocks("#tl .mopen"))).toBe(1);
		expect(await v.evaluate(`document.querySelector('#tl .ms-card .dc-brief').textContent.includes(${JSON.stringify(SUMMARY)})`)).toBe(true);
		expect(await v.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
		if (SHOTS) { await v.resize(width, width === 390 ? 1500 : 1100); await Bun.write(`${SHOTS}/after-${width}-${theme}.png`, await v.screenshot()); }
	}, 30_000);
}

test("a draft card that stands alone shows the lines once: the 메일 list and the quick-review sheet over its own mail", async () => {
	const page = await open(1280, "light"), { v, waitFor } = page;
	expect(await v.evaluate(`(() => { const c = monNoticeNode(ntById("wait"), []); c.id = "alone"; document.body.append(c); const n = ${blocks("#alone")}; c.remove(); return n; })()`)).toBe(1);
	await openMail(page, "fx-2");
	await v.evaluate(`(noticeSheetOpen("wait"), 0)`);
	await waitFor(`DK.box && DK.box.querySelector(".fs-body .rq-brief")`);
	expect(await v.evaluate(`DK.box.querySelectorAll('[data-k="mail-lines"]').length`)).toBe(1);
}, 30_000);
