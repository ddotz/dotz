import { afterAll, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { mailText } from "./mail.ts";
import { fakeHub, json } from "./test-web.ts";

// A new mail's offered reply draft in its mail conversation, in a headless browser against a fixture history (nothing is sent):
// the mail card first, then the bot's "[ask] 답장 초안을 만들었어요" with the quoted draft and 보내기 / 고치기 / 보내지 않기.
// Screenshots: /tmp/dotz-mail-draft-offer.png (390x844) and /tmp/dotz-mail-draft-offer-desktop.png (1280x1700, tall enough for the whole conversation).
const KEY = "zele-abc123";
const TARGET = `mail:${KEY}`;
const DRAFT_BODY = "안녕하세요.\n목요일 오후 3시 괜찮습니다.\n감사합니다.";
const OFFER = `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "kim@example.com", subject: "Re: 회의 일정 문의", body: DRAFT_BODY, ref: "RABC234", question: "이 답장 보낼까요?" })}`;
const MAIL = { from: "kim@example.com", subject: "회의 일정 문의", body: "안녕하세요.\n이번 주 목요일 오후에 회의 가능할까요?" };
const events = [
	{ ts: "2026-10-22T08:10:00.000Z", kind: "mail", source: "zele", channel: TARGET, conv: TARGET, mail: KEY, subject: MAIL.subject, from: MAIL.from, text: mailText({ ...MAIL, summary: "이번 주 목요일 오후 회의가 가능한지 묻는 메일이에요" }) },
	{ ts: "2026-10-22T08:10:20.000Z", kind: "out", source: "orchestrator", target: TARGET, conv: TARGET, text: OFFER },
];
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === TARGET ? events : [] });
		if (url.pathname === "/api/conversations") {
			return json({ items: [{ target: TARGET, mail: { subject: MAIL.subject, from: MAIL.from, source: "zele", at: events[0]!.ts }, last: { ts: events[1]!.ts, text: OFFER, from: "bot" }, unread: 0, read: events[1]!.ts }] });
		}
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
afterAll(() => hub.stop());

async function shoot(width: number, height: number, file: string) {
	const view = await hub.view({ width, height });
	const waitFor = (expr: string, ms = 10_000) =>
		view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof openTarget === "function" && S`);
	await view.evaluate(`(openTarget(${JSON.stringify(TARGET)}, "chat"), 0)`);
	await waitFor(`document.body.textContent.includes("목요일 오후 3시 괜찮습니다.") && document.body.textContent.includes("회의 일정 문의")`);
	await waitFor(`document.querySelectorAll(".dcm-row").length === 3`);
	const seen = JSON.parse(
		await view.evaluate(`JSON.stringify({
			options: [...document.querySelectorAll(".dcm-row")].map(b => b.querySelector(".dc-lb").textContent.replace("추천", "").trim()),
			text: document.body.innerText,
			over: document.documentElement.scrollWidth > innerWidth,
		})`),
	) as { options: string[]; text: string; over: boolean };
	expect(seen.options).toEqual(["보내기", "고치기", "보내지 않기"]);
	for (const part of ["답장 초안을 만들었어요", "kim@example.com", "Re: 회의 일정 문의", "안녕하세요.", "목요일 오후 3시 괜찮습니다.", "감사합니다.", "이 답장 보낼까요?"]) expect(seen.text).toContain(part);
	expect(seen.over).toBe(false);
	await Bun.write(file, await view.screenshot());
}

test("a mail conversation shows the mail card, then the offered reply draft with its three options, at 390px", async () => {
	await shoot(390, 844, "/tmp/dotz-mail-draft-offer.png");
}, 30_000);

test("the same conversation at desktop width", async () => {
	await shoot(1280, 1700, "/tmp/dotz-mail-draft-offer-desktop.png");
}, 30_000);
