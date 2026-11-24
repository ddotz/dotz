import { afterAll, describe, expect, test } from "bun:test";
import { cardBlock } from "./choices.ts";
import { DOCTOR_LOOK_KO, doctorKo as t, doctorLookAsk } from "./doctor-text.ts";
import { emit } from "./events.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { fakeHub, idleState, inbox, json, on } from "./test-web.ts";

const DAY = "11월 24일";
const RESTARTED = t.restarts({ all: 5, update: 2, owner: 1, orchestrator: 1, unexplained: 1 }), WATCH = t.watchFailing("Sample-2", 6, "11월 23일 21:00", ""), STUCK = `${t.sessionsStuck("sample", 1, 3)} ${t.todo.sessions}`;
const told = (n: number) => [t.toldPart, `- ${RESTARTED}${DOCTOR_LOOK_KO}`, `- ${STUCK}`, `- ${WATCH}${DOCTOR_LOOK_KO}`, t.lookHint, t.healthy(["디스크"])].slice(0, n + 3);
const ROW = [`${t.head(DAY)} · ${t.told(3)}`, ...told(3)].join("\n");
const CARD = cardBlock({ subject: t.diskSubject, question: t.diskQuestion, evidence: ["남은 공간 9GB (4%)"], options: [{ name: t.diskCleanName, result: t.diskCleanResult }, { name: t.diskKeepName, result: t.diskKeepResult }] });
const WITH_CARD = `${[`${t.head(DAY)} · ${t.told(3)} · ${t.decide(1)}`, ...told(3)].join("\n")}\n\n${t.decidePart}\n\n${CARD}`;
const OTHER = `백업이 끝났어요\n- 정리 작업이 돌았어요${DOCTOR_LOOK_KO}\n- 남은 공간 12GB`;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const TS = { row: minutesAgo(40), other: minutesAgo(35), quote: minutesAgo(30), own: minutesAgo(25), card: minutesAgo(20), main: minutesAgo(15), lane: minutesAgo(12), work: minutesAgo(10) };
const out = (ts: string, target: string, text: string, source = "gateway", wk?: string) => ({ ts, kind: "out", source, target, ...(wk ? { wk } : {}), text });
const ALERT = [
	out(TS.row, "alert", ROW, "gateway", "doctor"),
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
let refuse = "", down = false, working = false;
const hub = fakeHub({
	stream: "fake",
	state: () => idleState({ orchestrator: { status: working ? "working" : "idle" } }),
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") {
			const target = url.searchParams.get("target") ?? "main", after = url.searchParams.get("after") ?? "";
			const events = [...(target === "alert" ? ALERT : target === "worklog" ? WORKLOG : target === "main" ? MAIN : []), ...storedIn(target)].filter(e => e.ts > after);
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
			await waitFor(`document.querySelectorAll("#split .pane").length === 2 && document.querySelectorAll("#split .pane")[1].querySelectorAll(".dl-btn").length === 4`);
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

		test("a request the outbox gives up offers 다시 보내기, and the retry sends it", async () => {
			const second = `[...${at(TS.row)}.querySelectorAll(".dl-btn")][1]`, before = sent.length;
			down = true;
			await run(`${second}.click()`);
			await waitFor(`OUTBOX.length === 1 && ${second}.textContent === "보내는 중"`);
			refuse = "보낼 글 목록에서 거절됐어요";
			down = false;
			await waitFor(`OUTBOX.length === 0 && ${second}.textContent === "다시 보내기" && !${second}.disabled`, 20_000);
			expect(await ev<string>(`${second}.getAttribute("aria-label")`)).toBe(`다시 보내기: ${WATCH}`);
			refuse = "";
			await run(`${second}.click()`);
			expect((await sent.until(a => a.length > before))[before]).toMatchObject({ text: reply(WATCH), conv: "alert" });
			await waitFor(`${second}.textContent === "보냈어요"`);
			expect(sent.length).toBe(before + 1);
		}, 20_000);

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

		test("a card row of the notices screen keeps a short subject whole: the subject keeps up to a third of the row, the question up to two thirds, each gives the other what it does not need, and the space before · stays", async () => {
			await view.navigate(`${hub.origin}/`);
			await waitFor(`typeof nscGo === "function" && !!S`);
			await run(`nscGo()`);
			const rows = await waitFor(`${TITLES.length} === [...document.querySelectorAll(".nsc-r .hd-q")].filter(h => ${JSON.stringify(TITLES.map(([s, q]) => `${s} · ${q}`))}.includes(h.title)).length`).then(() =>
				ev<{ title: string; row: number; w: number; wFull: number; q: number; qFull: number; space: number }[]>(`[...document.querySelectorAll(".nsc-r .hd-q")].map(h => { const w = h.querySelector(".w"), q = h.querySelector(".q"), r = document.createRange(); r.setStart(q.firstChild, 0); r.setEnd(q.firstChild, 1); return { title: h.title, row: h.clientWidth, w: w.clientWidth, wFull: w.scrollWidth, q: q.clientWidth, qFull: q.scrollWidth, space: r.getBoundingClientRect().width }; })`));
			for (const [subject, question] of TITLES) {
				const r = rows.find(x => x.title === `${subject} · ${question}`)!;
				expect(r.space).toBeGreaterThan(0);
				expect(r.w).toBeGreaterThanOrEqual(Math.min(r.wFull, Math.floor(r.row / 3)) - 1);
				expect(r.q).toBeGreaterThanOrEqual(Math.min(r.qFull, Math.floor((r.row * 2) / 3)) - 1);
				if (r.wFull + r.qFull <= r.row) expect([r.w, r.q]).toEqual([r.wFull, r.qFull]);
				else expect(r.w + r.q).toBeGreaterThanOrEqual(r.row - 1);
			}
			const disk = rows.find(x => x.title.startsWith(t.diskSubject))!;
			expect(disk.w).toBe(disk.wFull);
		});
	});
}
