import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cardBlock } from "./choices.ts";
import { DOCTOR_LOOK_KO, doctorKo as t, doctorLookAsk, isDoctorLook } from "./doctor-text.ts";
import { emit } from "./events.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { fakeHub, idleState, inbox, json, on } from "./test-web.ts";

const DAY = "11월 24일";
const RESTARTED = t.restarts({ all: 5, update: 2, owner: 1, orchestrator: 1, unexplained: 1 }), WATCH = t.watchFailing("Sample-2", 6, "11월 23일 21:00"), STUCK = `${t.sessionsStuck("sample", 1, 3)} ${t.todo.sessions}`;
const told = (n: number) => [t.toldPart, `- ${RESTARTED}${DOCTOR_LOOK_KO}`, `- ${STUCK}`, `- ${WATCH}${DOCTOR_LOOK_KO}`, t.lookHint, t.healthy(["디스크"])].slice(0, n + 3);
const ROW = [`${t.head(DAY)} · ${t.told(3)}`, ...told(3)].join("\n");
const CARD = cardBlock({ subject: t.diskSubject, question: t.diskQuestion, evidence: ["남은 공간 9GB (4%)"], options: [{ name: t.diskCleanName, result: t.diskCleanResult }, { name: t.diskKeepName, result: t.diskKeepResult }] });
const WITH_CARD = `${[`${t.head(DAY)} · ${t.told(3)} · ${t.decide(1)}`, ...told(3)].join("\n")}\n\n${t.decidePart}\n\n${CARD}`;
const OTHER = `백업이 끝났어요\n- 정리 작업이 돌았어요${DOCTOR_LOOK_KO}\n- 남은 공간 12GB`;
const STRUCK = "오래된 ~~규칙~~ 줄이 남아 있어요", PATHL = "큰 세션: ~/Code/sample-a 3개가 쌓였어요";
const MARKS = [`${t.head(DAY)} · ${t.told(2)}`, t.toldPart, `- ${STRUCK}${DOCTOR_LOOK_KO}`, `- ${PATHL}${DOCTOR_LOOK_KO}`, t.lookHint].join("\n");
const SUBS = [t.restartLine("11월 24일 03:10", t.restartUnasked), t.restartLine("11월 24일 05:40", t.restartUnasked)], WHY = t.lastReason("로그인 화면에서 멈췄어요");
const SUBBED = [`${t.head(DAY)} · ${t.told(2)}`, t.toldPart, `- ${RESTARTED}${DOCTOR_LOOK_KO}`, ...SUBS.map(s => `  - ${s}`), `- ${WATCH}${DOCTOR_LOOK_KO}`, `  - ${WHY}`, t.lookHint].join("\n");
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const TS = { row: minutesAgo(40), marks: minutesAgo(38), other: minutesAgo(35), quote: minutesAgo(30), own: minutesAgo(25), card: minutesAgo(20), subbed: minutesAgo(18), main: minutesAgo(15), lane: minutesAgo(12), work: minutesAgo(10) };
const out = (ts: string, target: string, text: string, source = "gateway", wk?: string) => ({ ts, kind: "out", source, target, ...(wk ? { wk } : {}), text });
const ALERT = [
	out(TS.row, "alert", ROW, "gateway", "doctor"),
	out(TS.marks, "alert", MARKS, "gateway", "doctor"),
	out(TS.other, "alert", OTHER),
	out(TS.quote, "alert", `아침 점검 내용을 다시 붙여 둘게요.\n\n${ROW}`, "orchestrator"),
	{ ts: TS.own, kind: "message", source: "web", channel: "web:alert", author: "local", mid: "own1", text: `제가 붙여 넣은 글이에요.\n\n${ROW}` },
	out(TS.card, "alert", WITH_CARD, "gateway", "doctor"),
];
const MAIN = [out(TS.main, "web", `메인 대화에서 아침 점검을 인용해요.\n\n${ROW}`, "orchestrator")];
const WORKLOG = [out(TS.lane, "worklog", `[done] 샘플 세션 보고예요.\n\n${ROW}`, "lane:sample"), out(TS.work, "worklog", ROW, "gateway", "doctor")];
const reply = (line: string) => doctorLookAsk.ko(DAY, line);

resetNoticesForTest();
emit("outbox", ALERT.at(-1)!);
const TWO = [{ name: "지워요", result: "그 줄을 지워요" }, { name: "그대로 둬요", result: "아무것도 바꾸지 않아요" }];
const TITLES = [[t.diskSubject, t.diskQuestion], ["RULES.md 12줄 '항상 한국어로 답하기'", "지울까요?"], ["샘플-2 가격 모니터링 로그인", "다시 로그인하고 이어서 볼까요?"]] as const;
for (const [i, [subject, question]] of TITLES.slice(1).entries()) emit("outbox", out(minutesAgo(50 + i), "web", `[ask] ${question}\n${cardBlock({ subject, question, options: TWO })}`, "orchestrator"));
type Sent = { text: string; cid?: string; conv?: string; mode?: string };
const sent = inbox<Sent>();
const stored: { ts: string; kind: string; source: string; channel: string; text: string; cid?: string }[] = [];
const storedIn = (target: string) => stored.filter(m => m.channel === (target === "main" ? "web" : `web:${target}`));
let refuse = "", down = false, blind = false, working = false, subbed = false;
const hub = fakeHub({
	stream: "fake",
	state: () => idleState({ orchestrator: { status: working ? "working" : "idle" } }),
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") {
			if (blind) return new Response("bad gateway", { status: 502 });
			const target = url.searchParams.get("target") ?? "main", after = url.searchParams.get("after") ?? "";
			const events = [...(target === "alert" ? [...ALERT, ...(subbed ? [out(TS.subbed, "alert", SUBBED, "gateway", "doctor")] : [])] : target === "worklog" ? WORKLOG : target === "main" ? MAIN : []), ...storedIn(target)].filter(e => e.ts > after);
			return json({ target, events });
		}
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/notices" && req.method === "GET") return json(listNotices(300));
		if (p === "/api/message" && req.method === "POST") {
			if (refuse) return json({ error: refuse }, 400);
			if (down) return new Response("bad gateway", { status: 502 });
			const b = (await req.json()) as Sent;
			sent.push(b);
			stored.push({ ts: minutesAgo(0), kind: "message", source: "web", channel: b.conv ? `web:${b.conv}` : "web", text: b.text, ...(b.cid ? { cid: b.cid } : {}) });
			return json({ ok: true });
		}
	},
});
afterEach(() => {
	subbed = false;
});
afterAll(() => {
	hub.stop();
	resetNoticesForTest();
});

type Line = { text: string; btn: string; disabled: boolean; aria: string };
const at = (ts: string) => `document.querySelector('#tl [data-ts="${ts}"]')`;
const LINES = (scope: string) => `[...${scope}.querySelectorAll("li")].map(li => { const b = li.querySelector(".dl-btn"); return { text: [...li.childNodes].filter(n => n.nodeType === 3).map(n => n.data).join("").trim(), btn: b ? b.textContent : "", disabled: b ? b.disabled : false, aria: b ? b.getAttribute("aria-label") : "" }; })`;
const line = (text: string, btn: string) => ({ text, btn, disabled: btn === "보냈어요" || btn === "보내는 중", aria: btn ? `${btn}: ${text}` : "" });
const lines = (a: string, b: string) => [line(RESTARTED, a), line(STUCK, ""), line(WATCH, b)];
const cardId = () => listNotices(300).items.find(n => n.kind === "decision" && n.title.startsWith(t.diskSubject))!.id;
const BTNS = (scope: string) => `${scope}.querySelectorAll(".dl-btn").length`;

for (const width of [390, 1280]) {
	describe(`${width}px`, async () => {
		const view = await hub.view({ width, height: 900 });
		const { waitFor, ev, run } = on(view);
		const open = async (t: string, ts: string) => {
			await waitFor(`typeof openTarget === "function" && S`);
			await run(`openTarget(${JSON.stringify(t)}, "chat")`);
			await waitFor(`!!${at(ts)}`);
			if (await ev<boolean>(`${at(ts)}.classList.contains("wl-row") && !${at(ts)}.classList.contains("fr-open")`)) await run(`${at(ts)}.click()`);
			await waitFor(`!${at(ts)}.classList.contains("wl-row") || ${at(ts)}.classList.contains("fr-open")`);
		};
		const openAlert = async () => {
			await open("alert", TS.card);
			await open("alert", TS.row);
		};

		if (width === 1280) test("a pane of the alert conversation draws the same buttons", async () => {
			await view.navigate(`${hub.origin}/`);
			await run(`localStorage.clear()`);
			await view.navigate(`${hub.origin}/?pane#chat`);
			await waitFor(`typeof paneSplit === "function" && !!S && target === "main" && current === "chat" && CV.placed && !!${at(TS.main)}`);
			await run(`paneSplit("alert", "chat", "right")`);
			await waitFor(`!!PN.root && !!PN.root.a`);
			await run(`paneFocus(PN.root.a.id)`);
			await waitFor(`document.querySelectorAll("#split .pane").length === 2 && document.querySelectorAll("#split .pane")[1].querySelectorAll(".dl-btn").length === 6`);
		}, 15_000);

		test("the unfolded told-only row and the bubble with a card draw a button on each marked line, named by its state and line, none on the other, and no hint line", async () => {
			stored.length = 0;
			await view.navigate(`${hub.origin}/`);
			await run(`localStorage.clear()`);
			await view.navigate(`${hub.origin}/`);
			await openAlert();
			for (const ts of [TS.row, TS.card]) {
				expect(await ev<Line[]>(LINES(at(ts)))).toEqual(lines("원인 찾기", "원인 찾기"));
				expect(await ev<string>(`${at(ts)}.textContent`)).not.toContain(t.lookHint);
				expect(await ev<string>(`${at(ts)}.textContent`)).toContain(t.healthy(["디스크"]));
			}
			expect(await ev<boolean>(`parseFloat(getComputedStyle(${at(TS.row)}.querySelector(".dl-btn")).marginLeft) > 0`)).toBe(true);
		});

		const drawn = (ts: string) => `[...${at(ts)}.querySelectorAll("li")].map(li => { const b = li.querySelector(".dl-btn"); return { text: li.textContent.replace(b ? b.textContent : "", "").trim(), btn: b ? b.textContent : "", aria: b ? b.getAttribute("aria-label") : "" }; })`;
		const pathBtn = `[...${at(TS.marks)}.querySelectorAll("li")].find(li => li.textContent.includes("폴더")).querySelector(".dl-btn")`;
		test("a told line whose ~~ the page drops still gets its button, named by its source line", async () => {
			await open("alert", TS.marks);
			const [struck] = await ev<{ text: string; btn: string; aria: string }[]>(drawn(TS.marks));
			expect(struck!.text).toBe("오래된 규칙 줄이 남아 있어요");
			expect([struck!.btn, struck!.aria]).toEqual(["원인 찾기", `원인 찾기: ${STRUCK}`]);
			expect(await ev<string>(`${at(TS.marks)}.textContent`)).not.toContain(t.lookHint);
			expect(await ev<string>(`${at(TS.marks)}.textContent`)).not.toContain(DOCTOR_LOOK_KO.trim());
		});

		test("a told line the Korean display rules draw differently (a ~/path shown as 폴더) gets its button, and the reply quotes the source line", async () => {
			await open("alert", TS.marks);
			const [, path] = await ev<{ text: string; btn: string; aria: string }[]>(drawn(TS.marks));
			expect(path!.text).toContain("폴더");
			expect(path!.text).not.toContain("~/");
			expect([path!.btn, path!.aria]).toEqual(["원인 찾기", `원인 찾기: ${PATHL}`]);
			const before = sent.length;
			await run(`${pathBtn}.click()`);
			expect((await sent.until(a => a.length > before))[before]).toMatchObject({ text: reply(PATHL), conv: "alert" });
			await waitFor(`${pathBtn}.textContent === "보냈어요"`);
			expect(sent.length).toBe(before + 1);
		});

		test("only the gateway's own doctor message gets buttons: a model's quote, the owner's paste, a session report and another gateway alert keep their words", async () => {
			for (const ts of [TS.other, TS.quote, TS.own]) {
				await open("alert", ts);
				expect(await ev<number>(BTNS(at(ts)))).toBe(0);
				expect(await ev<string>(`${at(ts)}.textContent`)).toContain(DOCTOR_LOOK_KO.trim());
			}
			expect(await ev<string>(`${at(TS.other)}.textContent`)).toContain(`정리 작업이 돌았어요${DOCTOR_LOOK_KO}`);
			await open("main", TS.main);
			expect(await ev<number>(BTNS(at(TS.main)))).toBe(0);
			await open("worklog", TS.lane);
			expect(await ev<number>(BTNS(at(TS.lane)))).toBe(0);
			expect(await ev<string>(`${at(TS.lane)}.textContent`)).toContain(DOCTOR_LOOK_KO.trim());
			await open("worklog", TS.work);
			expect(await ev<number>(BTNS(at(TS.work)))).toBe(2);
		});

		test("a tap sends the line's own reply once: while the gateway is unreachable it waits in the outbox reading 보내는 중, and reads 보냈어요 once the gateway has it, also after a reload", async () => {
			await openAlert();
			const before = sent.length;
			down = true;
			await run(`${at(TS.row)}.querySelector(".dl-btn").click()`);
			await waitFor(`OUTBOX.length === 1 && OUTBOX[0].text === ${JSON.stringify(reply(RESTARTED))} && OUTBOX[0].t === "alert"`);
			expect(await ev<boolean>(`${at(TS.row)}.classList.contains("fr-open")`)).toBe(true);
			expect(await ev<Line[]>(LINES(at(TS.row)))).toEqual(lines("보내는 중", "원인 찾기"));
			down = false;
			expect((await sent.until(a => a.length > before))[before]).toMatchObject({ text: reply(RESTARTED), conv: "alert" });
			await waitFor(`${at(TS.row)}.querySelector(".dl-btn").textContent === "보냈어요"`);
			await run(`${at(TS.row)}.querySelector(".dl-btn").click()`);
			expect(await ev<Line[]>(LINES(at(TS.row)))).toEqual(lines("보냈어요", "원인 찾기"));
			await view.navigate(`${hub.origin}/`);
			await openAlert();
			expect(await ev<Line[]>(LINES(at(TS.row)))).toEqual(lines("보냈어요", "원인 찾기"));
			expect(sent.length).toBe(before + 1);
		}, 20_000);

		test("a request the outbox gives up offers 다시 보내기 and leaves the composer as the owner had it; the retry sends it once and the composer does not send it again", async () => {
			const second = `[...${at(TS.row)}.querySelectorAll(".dl-btn")][1]`, before = sent.length, own = "디스크 얘기는 내일 할게요";
			await run(`ta.value = ${JSON.stringify(own)}; saveDraft()`);
			down = true;
			await run(`${second}.click()`);
			await waitFor(`OUTBOX.length === 1 && ${second}.textContent === "보내는 중"`);
			refuse = "보낼 글 목록에서 거절됐어요";
			down = false;
			await waitFor(`OUTBOX.length === 0 && ${second}.textContent === "다시 보내기" && !${second}.disabled`, 20_000);
			expect(await ev<string>(`${second}.getAttribute("aria-label")`)).toBe(`다시 보내기: ${WATCH}`);
			expect(await ev<string[]>(`[ta.value, ts("alert").draft, localStorage.getItem(DRAFT_KEY("alert"))]`)).toEqual([own, own, own]);
			refuse = "";
			await run(`${second}.click()`);
			expect((await sent.until(a => a.length > before))[before]).toMatchObject({ text: reply(WATCH), conv: "alert" });
			await waitFor(`${second}.textContent === "보냈어요"`);
			expect(sent.length).toBe(before + 1);
			await run(`sendChat()`);
			await sent.until(a => a.length > before + 1);
			expect(sent.slice(before).map(s => s.text)).toEqual([reply(WATCH), own]);
			expect(storedIn("alert").filter(m => m.text === reply(WATCH)).length).toBe(1);
		}, 20_000);

		test("a request waiting in the outbox that another device sent meanwhile is not sent again: it leaves the outbox, the other waiting messages go out in their order (also one whose words the owner had sent earlier), and it reads 보냈어요; while the history cannot be read it keeps waiting", async () => {
			refuse = "";
			await run(`localStorage.removeItem("dotz.doctor-look")`);
			stored.length = 0;
			await view.navigate(`${hub.origin}/`);
			await openAlert();
			const first = `${at(TS.row)}.querySelector(".dl-btn")`, before = sent.length, early = "네, 그렇게 해 주세요", late = "나중에 보낼 글이에요";
			stored.push({ ts: minutesAgo(5), kind: "message", source: "web", channel: "web", text: early, cid: "said-before" });
			down = true;
			blind = true;
			await run(`sendMsgOut("main", ${JSON.stringify(early)}, { text: ${JSON.stringify(early)} })`);
			await run(`${first}.click()`);
			await waitFor(`OUTBOX.length === 2 && ${first}.textContent === "보내는 중"`);
			await run(`sendMsgOut("main", ${JSON.stringify(late)}, { text: ${JSON.stringify(late)} })`);
			await waitFor(`OUTBOX.length === 3`);
			stored.push({ ts: minutesAgo(0), kind: "message", source: "web", channel: "web:alert", text: reply(RESTARTED), cid: "other-device" });
			down = false;
			await view.evaluate(`outboxFlush().then(() => 0)`);
			expect(await ev<string[]>(`OUTBOX.map(o => o.t + ":" + o.text)`)).toEqual([`main:${early}`, `alert:${reply(RESTARTED)}`, `main:${late}`]);
			expect(await ev<string>(`${first}.textContent`)).toBe("보내는 중");
			expect(sent.length).toBe(before);
			blind = false;
			await view.evaluate(`outboxFlush().then(() => 0)`);
			await waitFor(`OUTBOX.length === 0 && ${first}.textContent === "보냈어요"`, 15_000);
			expect(sent.slice(before).map(s => s.text)).toEqual([early, late]);
			expect(storedIn("alert").filter(m => m.text === reply(RESTARTED)).length).toBe(1);
		}, 20_000);

		test("a request the outbox gives up after a reload, while another conversation is open, is not left in the alert conversation's draft", async () => {
			await run(`localStorage.removeItem("dotz.doctor-look")`);
			stored.length = 0;
			await view.navigate(`${hub.origin}/`);
			await openAlert();
			const second = `[...${at(TS.row)}.querySelectorAll(".dl-btn")][1]`, before = sent.length;
			down = true;
			await run(`${second}.click()`);
			await waitFor(`OUTBOX.length === 1 && ${second}.textContent === "보내는 중"`);
			await run(`openTarget("main", "chat")`);
			await view.navigate(`${hub.origin}/`);
			await waitFor(`typeof outboxFlush === "function" && !!S && target === "main" && OUTBOX.length === 1`);
			refuse = "보낼 글 목록에서 거절됐어요";
			down = false;
			await view.evaluate(`outboxFlush().then(() => 0)`);
			await waitFor(`OUTBOX.length === 0`, 20_000);
			refuse = "";
			expect(await ev<string[]>(`[ts("alert").draft || "", localStorage.getItem(DRAFT_KEY("alert")) || ""]`)).toEqual(["", ""]);
			expect(sent.length).toBe(before);
			await openAlert();
			expect(await ev<string>(`${second}.textContent`)).toBe("원인 찾기");
		}, 30_000);

		test("a refused send says so and can be tried again", async () => {
			await run(`localStorage.removeItem("dotz.doctor-look")`);
			stored.length = 0;
			await view.navigate(`${hub.origin}/`);
			await openAlert();
			refuse = "잠깐 보낼 수 없어요";
			const first = `${at(TS.card)}.querySelector(".dl-btn")`, before = sent.length;
			await run(`${first}.click()`);
			await waitFor(`${first}.textContent === "다시 보내기" && !${first}.disabled`);
			expect(await ev<string>(`(document.querySelector(".snack.bad") || {}).textContent || ""`)).toContain("잠깐 보낼 수 없어요");
			expect(await ev<boolean>(`!!document.querySelector(".fs-body")`)).toBe(false);
			refuse = "";
			await run(`${first}.click()`);
			expect((await sent.until(a => a.length > before))[before]).toMatchObject({ text: reply(RESTARTED), conv: "alert" });
			await waitFor(`${first}.textContent === "보냈어요"`);
		});

		test("a request another device already sent is not sent again: the drawn button turns to 보냈어요 on a tap", async () => {
			stored.push({ ts: minutesAgo(0), kind: "message", source: "web", channel: "web:alert", text: reply(WATCH) });
			const second = `[...${at(TS.card)}.querySelectorAll(".dl-btn")][1]`, before = sent.length;
			expect(await ev<string>(`${second}.textContent`)).toBe("원인 찾기");
			await run(`${second}.click()`);
			await waitFor(`${second}.textContent === "보냈어요"`);
			expect(sent.length).toBe(before);
		});

		test("the card's sheet on a fresh load shows what this browser sent, and a tap there for a line sent elsewhere sends nothing", async () => {
			await run(`localStorage.removeItem("dotz-target")`);
			await view.navigate(`${hub.origin}/`);
			await waitFor(`typeof noticeSheetOpen === "function" && S`);
			await run(`noticeSheetOpen(${JSON.stringify(cardId())})`);
			await waitFor(`!!document.querySelector(".fs-body .dl-btn")`);
			const sheet = `document.querySelector(".fs-body")`;
			expect(await ev<Line[]>(LINES(sheet))).toEqual(lines("보냈어요", "보냈어요"));
			expect(await ev<string>(`${sheet}.textContent`)).not.toContain(t.lookHint);
			await run(`ntSheetClose(); localStorage.removeItem("dotz.doctor-look")`);
			await view.navigate(`${hub.origin}/`);
			await waitFor(`typeof noticeSheetOpen === "function" && S`);
			await run(`noticeSheetOpen(${JSON.stringify(cardId())})`);
			await waitFor(`!!document.querySelector(".fs-body .dl-btn")`);
			const before = sent.length;
			await run(`${sheet}.querySelector(".dl-btn").click()`);
			await waitFor(`${sheet}.querySelector(".dl-btn").textContent === "보냈어요"`);
			expect(sent.length).toBe(before);
			await run(`ntSheetClose()`);
		});

		test("a conversation that already holds the requests shows them as sent on a fresh load, before any tap", async () => {
			await run(`localStorage.removeItem("dotz.doctor-look")`);
			await view.navigate(`${hub.origin}/`);
			await openAlert();
			expect(await ev<Line[]>(LINES(at(TS.card)))).toEqual(lines("보냈어요", "보냈어요"));
		});

		test("a tap in the work log sends to the work log; while the session works it is steered in", async () => {
			working = true;
			await view.navigate(`${hub.origin}/`);
			await open("worklog", TS.work);
			await waitFor(`isWorking("worklog")`);
			const before = sent.length;
			await run(`${at(TS.work)}.querySelector(".dl-btn").click()`);
			expect((await sent.until(a => a.length > before))[before]).toMatchObject({ text: reply(RESTARTED), conv: "worklog", mode: "steer" });
			working = false;
		});

		test("a card row of the notices screen keeps a short subject whole: the subject keeps up to a third of the row, the question up to two thirds, each gives the other what it does not need, each box is no wider than its text, and the space before · stays", async () => {
			await view.navigate(`${hub.origin}/`);
			await waitFor(`typeof nscGo === "function" && !!S`);
			await run(`nscGo()`);
			const rows = await waitFor(`${TITLES.length} === [...document.querySelectorAll(".nsc-r .hd-q")].filter(h => ${JSON.stringify(TITLES.map(([s, q]) => `${s} · ${q}`))}.includes(h.title)).length`).then(() =>
				ev<{ title: string; row: number; w: number; wFull: number; q: number; qFull: number; space: number; gap: number }[]>(`[...document.querySelectorAll(".nsc-r .hd-q")].map(h => { const w = h.querySelector(".w"), q = h.querySelector(".q"), r = document.createRange(), text = n => { const t = document.createRange(); t.selectNodeContents(n.firstChild); return t.getBoundingClientRect().width; }; r.setStart(q.firstChild, 0); r.setEnd(q.firstChild, 1); const wb = w.getBoundingClientRect(); return { title: h.title, row: h.clientWidth, w: wb.width, wFull: text(w), q: q.getBoundingClientRect().width, qFull: text(q), space: r.getBoundingClientRect().width, gap: q.getBoundingClientRect().left - wb.left - Math.min(wb.width, text(w)) }; })`));
			for (const [subject, question] of TITLES) {
				const r = rows.find(x => x.title === `${subject} · ${question}`)!;
				expect(r.space).toBeGreaterThan(0);
				expect(Math.abs(r.gap)).toBeLessThan(1);
				expect(r.w).toBeLessThan(r.wFull + 1);
				expect(r.q).toBeLessThan(r.qFull + 1);
				expect(r.w).toBeGreaterThanOrEqual(Math.min(r.wFull, Math.floor(r.row / 3)) - 1);
				expect(r.q).toBeGreaterThanOrEqual(Math.min(r.qFull, Math.floor((r.row * 2) / 3)) - 1);
				if (r.wFull + r.qFull <= r.row) expect([r.w, r.q].map(Math.round)).toEqual([r.wFull, r.qFull].map(Math.round));
				else expect(r.w + r.q).toBeGreaterThanOrEqual(r.row - 1);
			}
			const disk = rows.find(x => x.title.startsWith(t.diskSubject))!;
			expect(Math.round(disk.w)).toBe(Math.round(disk.wFull));
		});

		test("a told line's sub-lines are drawn under its headline, indented and quieter, with no button; the headline's button sits on its row and sends one line holding the headline and its sub-lines, which the hub reads as a look-up and which reads 보냈어요 after a reload and in a second tab without being sent again", async () => {
			subbed = true;
			stored.length = 0;
			await view.navigate(`${hub.origin}/`);
			await run(`localStorage.clear()`);
			await view.navigate(`${hub.origin}/`);
			await open("alert", TS.subbed);
			const rows = await ev<{ text: string; sub: boolean; btn: number; left: number; top: number; bottom: number; color: string; b: { top: number; bottom: number; hit: number } | null }[]>(`[...${at(TS.subbed)}.querySelectorAll("li")].map(li => { const r = li.getBoundingClientRect(), b = li.querySelector(".dl-btn"), br = b && b.getBoundingClientRect(), after = b && getComputedStyle(b, "::after"), x = document.createRange(); x.selectNodeContents(li); return { text: [...li.childNodes].filter(n => n.nodeType === 3).map(n => n.data).join("").trim(), sub: li.classList.contains("dl-sub"), btn: li.querySelectorAll(".dl-btn").length, left: x.getClientRects()[0].left, top: r.top, bottom: r.bottom, color: getComputedStyle(li).color, b: br && { top: br.top, bottom: br.bottom, hit: br.height - (after.content === "none" ? 0 : (parseFloat(after.top) || 0) + (parseFloat(after.bottom) || 0)) } }; })`);
			expect(rows.map(r => [r.text, r.sub, r.btn])).toEqual([[RESTARTED, false, 1], [SUBS[0], true, 0], [SUBS[1], true, 0], [WATCH, false, 1], [WHY, true, 0]]);
			const [head, s1, s2, watch, why] = rows as [(typeof rows)[0], (typeof rows)[0], (typeof rows)[0], (typeof rows)[0], (typeof rows)[0]];
			for (const [above, sub] of [[head, s1], [s1, s2], [watch, why]] as const) expect(sub.top).toBeGreaterThanOrEqual(above.bottom - 1);
			for (const sub of [s1, s2, why]) expect(sub.left).toBeGreaterThan(head.left + 8);
			expect(s1.color).not.toBe(head.color);
			for (const line of [head, watch]) {
				expect(line.b!.top).toBeGreaterThanOrEqual(line.top - 1);
				expect(line.b!.bottom).toBeLessThanOrEqual(line.bottom + 1);
				if (width === 390) expect(line.b!.hit).toBeGreaterThanOrEqual(44);
			}
			const asked = reply(`${RESTARTED} (${SUBS.join("; ")})`), first = `${at(TS.subbed)}.querySelector(".dl-btn")`, before = sent.length;
			expect(isDoctorLook(asked)).toBe(true);
			await run(`${first}.click()`);
			expect((await sent.until(a => a.length > before))[before]).toMatchObject({ text: asked, conv: "alert" });
			await waitFor(`${first}.textContent === "보냈어요"`);
			await view.navigate(`${hub.origin}/`);
			await open("alert", TS.subbed);
			expect(await ev<string[]>(`[...${at(TS.subbed)}.querySelectorAll(".dl-btn")].map(b => b.textContent)`)).toEqual(["보냈어요", "원인 찾기"]);
			const other = await hub.view({ width, height: 900 }), tab = on(other);
			await other.navigate(`${hub.origin}/`);
			await tab.run(`localStorage.removeItem("dotz.doctor-look")`);
			await other.navigate(`${hub.origin}/`);
			await tab.waitFor(`typeof openTarget === "function" && S`);
			await tab.run(`openTarget("alert", "chat")`);
			await tab.waitFor(`!!${at(TS.subbed)}`);
			if (await tab.ev<boolean>(`${at(TS.subbed)}.classList.contains("wl-row") && !${at(TS.subbed)}.classList.contains("fr-open")`)) await tab.run(`${at(TS.subbed)}.click()`);
			await tab.waitFor(`${at(TS.subbed)}.querySelector(".dl-btn") && ${at(TS.subbed)}.querySelector(".dl-btn").textContent === "보냈어요"`);
			await tab.run(`${at(TS.subbed)}.querySelector(".dl-btn").click()`);
			expect(await tab.ev<string>(`${at(TS.subbed)}.querySelector(".dl-btn").textContent`)).toBe("보냈어요");
			expect(sent.length).toBe(before + 1);
			expect(storedIn("alert").filter(m => m.text === asked)).toHaveLength(1);
		}, 20_000);
	});
}
