import { afterAll, describe, expect, test } from "bun:test";
import { cardBlock } from "./choices.ts";
import { doctorKo } from "./doctor-text.ts";
import { lineSubject } from "./doctor-types.ts";
import { emit } from "./events.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { fakeHub, idleState, json, on } from "./test-web.ts";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const EDIT_ID = "prompt:review:a1b2c3", WATCH_ID = "watches:sample-shop";
const FROM = "- 게이트웨이는 launchctl kickstart 전에 `git push` 하고 ~/Code/dotz/hub/main.ts 를 확인해요.";
const TO = "- 게이트웨이는 launchctl kickstart 전에 `git push` 하지 말고 ~/Code/dotz/hub/main.ts 를 확인해요.";
const EDIT_EV = ["낡은 줄 · RULES.md 7번째 줄", `전: ${FROM}`, `후: ${TO}`];
const WATCH_PATH = "~/Code/sample-shop/hub/watch.ts", WATCH_EV = [`멈춘 곳: ${WATCH_PATH} 에서 3번 실패했어요`];
const OPTS = (a: string, b: string) => [{ name: a, result: `${a}를 골라요` }, { name: b, result: `${b}를 골라요` }];
const EDIT_SUBJECT = lineSubject(doctorKo, "/Users/runner/.dotz/RULES.md", FROM, "고칠까요?");
const EDIT_TEXT = `[ask] 아침 점검이에요.\n\n${cardBlock({ subject: EDIT_SUBJECT, question: "고칠까요?", evidence: EDIT_EV, options: OPTS("고쳐요", "그대로 둬요") })}`;
const WATCH_TEXT = `[ask] 모니터가 멈췄어요.\n\n${cardBlock({ subject: "샘플 상점 모니터", question: "다시 볼까요?", evidence: WATCH_EV, options: OPTS("다시 봐요", "그만 봐요") })}`;
const EDIT_EVENT = { ts: minutesAgo(20), kind: "out", source: "gateway", target: "alert", wk: "doctor", text: EDIT_TEXT, card_ids: [EDIT_ID], card_meta: { [EDIT_ID]: { edit: { file: "/Users/runner/.dotz/RULES.md", line: 7, from: FROM, to: TO }, keep: [2] } } };
const WATCH_EVENT = { ts: minutesAgo(10), kind: "out", source: "gateway", target: "alert", nk: "alert", text: WATCH_TEXT, card_ids: [WATCH_ID] };

resetNoticesForTest();
emit("outbox", EDIT_EVENT);
emit("outbox", WATCH_EVENT);
const hub = fakeHub({
	state: () => idleState(),
	api: (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/notices" && req.method === "GET") return json(listNotices(300));
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => {
	hub.stop();
	resetNoticesForTest();
});
const { waitFor, ev, run } = on(view);
const noticeOf = (id: string) => listNotices(300).items.find(n => n.decision?.card_id === id)!;
const asStored = (sel: string) => `(b => { const c = b.cloneNode(true); for (const k of c.querySelectorAll("code")) k.replaceWith("\`" + k.textContent + "\`"); document.body.append(c); const t = c.innerText; c.remove(); return t; })(document.querySelector(${JSON.stringify(sel)}))`;
const sheetOf = async (id: string, more: boolean) => {
	await run(`noticeSheetOpen(${JSON.stringify(noticeOf(id).id)})`);
	await waitFor(`document.querySelector(".fs-body .ds-t")`);
	if (more) await run(`const d = document.querySelector(".ds-more"); if (d) d.open = true`);
	const out = { title: await ev<string>(`document.querySelector(".fs-body .ds-t").textContent`), body: await ev<string>(asStored(".fs-body")) };
	await run(`ntSheetClose(false)`);
	return out;
};

describe("a card that proposes an instruction edit shows the file's own words on the page", () => {
	test("the API body carries the stored quote lines and title of the edit card, and the monitor card's path said plainly", () => {
		const edit = noticeOf(EDIT_ID), watch = noticeOf(WATCH_ID);
		expect(edit.decision!.evidence).toEqual(EDIT_EV);
		expect(edit.title).toBe(`${EDIT_SUBJECT} · 고칠까요?`);
		expect(edit.title).toContain("'게이트웨이는 launchctl");
		expect(watch.decision!.evidence![0]).not.toContain(WATCH_PATH);
	});

	test("the sheet, with 자세히 보기 closed and open, shows the before and after and the title quote as the card stores them", async () => {
		await view.navigate(`${hub.origin}/`);
		await waitFor(`typeof openTarget === "function" && S && NT.loaded`);
		for (const more of [false, true]) {
			const { title, body } = await sheetOf(EDIT_ID, more);
			expect(title).toBe(`${EDIT_SUBJECT} · 고칠까요?`);
			for (const line of EDIT_EV) expect(body.split("\n")).toContain(line);
		}
	});

	test("the backticked command in the quote is drawn as code with its words", async () => {
		await run(`noticeSheetOpen(${JSON.stringify(noticeOf(EDIT_ID).id)})`);
		await waitFor(`document.querySelector(".fs-body .ds-t")`);
		expect(await ev<string[]>(`[...document.querySelectorAll(".fs-body code")].map(c => c.textContent)`)).toEqual(["git push", "git push"]);
		await run(`ntSheetClose(false)`);
	});

	test("the monitor card's sheet still says its path plainly", async () => {
		const { body } = await sheetOf(WATCH_ID, true);
		expect(body).not.toContain(WATCH_PATH);
		expect(body).toContain("watch.ts");
	});

	test("the notices list names the edit card by its stored title", async () => {
		await run(`go("notices")`);
		const sel = `.nsc-r[data-nid="${noticeOf(EDIT_ID).id}"] .hd`;
		await waitFor(`document.querySelector(${JSON.stringify(sel)})`);
		expect(await ev<string>(`document.querySelector(${JSON.stringify(sel)}).title`)).toBe(`${EDIT_SUBJECT} · 고칠까요?`);
		expect(await ev<string>(`document.querySelector(${JSON.stringify(sel)}).textContent`)).toBe(`${EDIT_SUBJECT} · 고칠까요?`);
	});
});
