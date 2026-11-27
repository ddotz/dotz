// Which hub events become a phone notification, and where a tap on it leads.
import { expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cardBlock } from "./choices.ts";
import { CONFIG_FILE, NAME, paths } from "./config.ts";
import { DOCTOR_LOOK_EN, DOCTOR_LOOK_KO, doctorEn, doctorKo } from "./doctor-text.ts";
import { emit, lastEventId, recentEvents, replayAfter } from "./events.ts";
import { allNotices, dismissNotice, laterNotice, type Notice, onDecision, setWatchLabelResolver, sweepQuestions } from "./notices.ts";
import { type RouteInput, route } from "./notify-route.ts";
import { answersReach, classify, decisionPush, LONG_TURN_MS, notify, noticePush, pushRoute, resetPushDedupeForTest, setRelayPeers, startPush, withdraw } from "./push.ts";
import { flush } from "./runtime/test-clock.ts";
import { b64u } from "./webpush.ts";

const ev = (e: Record<string, unknown>) => ({ ts: "2026-10-20T00:00:00Z", kind: "out", source: "orchestrator", text: "", ...e });
let started = false;
const startOnce = () => {
	if (!started) startPush({ subject: () => "mailto:t@example.com" });
	started = true;
};
async function pushesOf(lane: string, run: () => unknown): Promise<Array<Record<string, unknown>>> {
	const got: Array<Record<string, unknown>> = [];
	startOnce();
	setRelayPeers(async () => [{ name: "me", host: "me.example.net", url: "https://me.example.net", self: true }, { name: "peer", host: "peer.example.net", url: "https://peer.example.net", self: false }]);
	const real = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: { body?: string }) => {
		const sent = String(url).endsWith("/api/push/relay") && init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		if (sent?.via === "app" && String(sent.url).includes(`#chat/lane:${lane}`)) got.push(sent);
		return Response.json({ served: [] });
	}) as unknown as typeof fetch;
	try {
		await run();
		await flush(30);
	} finally {
		globalThis.fetch = real;
		setRelayPeers(async () => []);
	}
	return got;
}
const cardsOf = (n: number) => Array.from({ length: n }, (_, i) => `결정: ${i + 1}번 규칙 줄을 제안대로 고칠까요?\n**1) 고쳐요**\n제안한 대로 글을 고쳐요.\n**2) 그대로 둬요**\n글은 지금 그대로 남아요.`).join("\n\n");
const ask = (lane: string, ts: string, text: string) => emit("outbox", { ts, kind: "out", source: `lane:${lane}`, target: `lane:${lane}`, text });
const opened: Notice[] = [];
onDecision(n => void opened.push(n));
const cardsIn = (lane: string) => opened.filter(n => n.decision?.to === `lane:${lane}`);
const settle = (lane: string) => cardsIn(lane).forEach(n => dismissNotice(n.id));

test("a web answer notifies only when it finishes work or needs the owner; a quick reply does not", () => {
	expect(classify(ev({ target: "web", text: "네, 맞아요" }), 5_000)).toBeUndefined();
	expect(classify(ev({ target: "web", text: "다 했어요" }), LONG_TURN_MS)).toMatchObject({ kind: "result", title: `${NAME} · 완료`, url: "/?m=2026-10-20T00%3A00%3A00Z#chat/main", body: "다 했어요" });
	expect(classify(ev({ target: "web", text: "[done] 배포 끝" }), 5_000)).toMatchObject({ title: `${NAME} · 완료` });
	expect(classify(ev({ target: "web", text: "[ask] 어느 쪽?" }))).toMatchObject({ kind: "ask", body: "어느 쪽?" });
});

test("a push body never shows the \"For <bot>:\" line of a report", () => {
	const text = `끝났어요\n\nFor ${NAME}: 후속 없음`;
	expect(classify(ev({ target: "web", text }), LONG_TURN_MS)?.body).toBe("끝났어요");
	expect(classify(ev({ target: "web", text: `[done] ${text}` }))?.body).toBe("끝났어요");
});

test("a project's answers notify like the main chat's and open that project's chat; a thread of it does too", () => {
	const CH = "ch:1500000000001908448";
	expect(classify(ev({ target: CH, text: "네, 맞아요" }), 5_000)).toBeUndefined();
	expect(classify(ev({ target: CH, text: "다 했어요" }), LONG_TURN_MS)).toMatchObject({ kind: "result", title: `${NAME} · 완료`, url: `/?m=2026-10-20T00%3A00%3A00Z#chat/${CH}`, tag: `answer:${CH}` });
	expect(classify(ev({ target: CH, text: "[ask] 어느 쪽?" }))).toMatchObject({ kind: "ask", url: `/?m=2026-10-20T00%3A00%3A00Z#chat/${CH}` });
	expect(classify(ev({ target: "th:42", channel: CH, text: "[done] 끝" }))).toMatchObject({ title: `${NAME} · 완료`, url: `/?m=2026-10-20T00%3A00%3A00Z#chat/${CH}` });
	expect(classify(ev({ target: CH, source: "gateway", text: "[done] 끝" }))).toBeUndefined();
	expect(classify(ev({ target: "th:42", text: "[done] 끝" }))).toBeUndefined(); // a thread of no known project stays on Discord
});

test("a lane's worklog entry never notifies from the event: its start is routine progress, its [done]/[fail] comes as a bell notice", () => {
	expect(classify(ev({ target: "worklog", update_key: "lane:custom-ui", text: "[run] 맞춤 화면 레인 시작했어요." }))).toBeUndefined();
	expect(classify(ev({ target: "worklog", update_key: "lane:custom-ui", text: "[run] 테스트 돌리는 중" }))).toBeUndefined();
	expect(classify(ev({ target: "worklog", update_key: "lane:custom-ui", text: "[done] 끝났어요" }))).toBeUndefined();
	expect(classify(ev({ target: "web", update_key: "progress", text: "[run] 시작했어요" }))).toBeUndefined();
});

test("alerts notify only when critical or when the owner is needed", () => {
	expect(classify(ev({ source: "gateway", target: "alert", text: "뙃쥐: 사용량 한도(429)로 멈춤." }))).toMatchObject({ kind: "alert", title: `${NAME} · 경고` });
	expect(classify(ev({ source: "gateway", target: "alert", text: "토큰 누수 점검 (10-19): 경고 3건" }))).toBeUndefined();
	expect(classify(ev({ target: "alert", reply_to: "1", text: "ㅇㅋ 형, 바로 할게요." }))).toBeUndefined();
	expect(classify(ev({ target: "alert", text: "어제 영어 답변이 또 나왔어요. 고칠 곳을 정리했어요." }))).toBeUndefined();
	expect(classify(ev({ target: "alert", text: "형, 주간 사용량이 2%만 남아서 레인 실행이 막혔어요." }))).toMatchObject({ kind: "alert" });
	expect(classify(ev({ target: "alert", text: "[ask] 전달 경로를 고칠까요?" }))).toMatchObject({ kind: "ask" });
});

test("lane [ask]/[done]/[fail] lines notify and open that lane; progress does not", () => {
	expect(classify(ev({ source: "lane:ui-pwa", target: "lane:ui-pwa", text: "[ask] 머지할까?" }))).toMatchObject({ kind: "ask", url: "/?m=2026-10-20T00%3A00%3A00Z#chat/lane:ui-pwa" });
	expect(classify(ev({ kind: "lane_report", source: "lane:x", lane: "x", text: "[done] 끝" }))).toMatchObject({ kind: "result", title: expect.stringMatching(/^(?!x · ).+ · 완료$/) });
	expect(classify(ev({ source: "lane:x", target: "lane:x", text: "[fail] 테스트 실패" }))).toMatchObject({ kind: "alert", title: expect.stringMatching(/^(?!x · ).+ · 실패$/) });
	expect(classify(ev({ source: "lane:x", target: "lane:x", text: "[run] 빌드 중", update_key: "progress" }))).toBeUndefined();
	expect(classify(ev({ source: "lane:x", target: "lane:x", text: "그냥 메모" }))).toBeUndefined();
});

test("a session's untagged report that answers the owner after a long turn notifies as its answer", () => {
	const report = (extra: Record<string, unknown>) => ev({ kind: "lane_report", source: "lane:x", lane: "x", text: "리포트가 완성됐어요", ...extra });
	expect(classify(report({ answering: true }), LONG_TURN_MS)).toMatchObject({ kind: "result", title: expect.stringMatching(/^(?!x · ).+ · 완료$/), url: "/?m=2026-10-20T00%3A00%3A00Z#chat/lane:x", tag: "lane:x", body: "리포트가 완성됐어요" });
	expect(classify(report({ answering: true }), LONG_TURN_MS - 1)).toBeUndefined();
	expect(classify(report({}), LONG_TURN_MS)).toBeUndefined();
	expect(classify(report({ answering: true, text: "[run] 아직 하는 중" }), LONG_TURN_MS)).toBeUndefined();
});

test("a subscription the push service reports gone (410) is dropped", async () => {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const endpoint = "https://push.example.net/gone";
	const call = (path: string, method: string, body?: unknown) => pushRoute(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL(`http://x${path}`));
	await call("/api/push/subscribe", "POST", { subscription: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 3)) } } });
	const q = `/api/push?endpoint=${encodeURIComponent(endpoint)}`;
	expect(await (await call(q, "GET"))!.json()).toMatchObject({ subscribed: true });
	const real = globalThis.fetch;
	globalThis.fetch = (async () => new Response(null, { status: 410 })) as unknown as typeof fetch;
	try {
		expect((await call("/api/push/test", "POST", { endpoint }))!.status).toBe(502);
	} finally {
		globalThis.fetch = real;
	}
	expect(await (await call(q, "GET"))!.json()).toMatchObject({ subscribed: false });
});

test("a send whose connection breaks (ECONNRESET) is tried once more and the subscription stays", async () => {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const endpoint = "https://push.example.net/reset";
	const call = (path: string, method: string, body?: unknown) => pushRoute(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL(`http://x${path}`));
	await call("/api/push/subscribe", "POST", { subscription: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 4)) } } });
	const real = globalThis.fetch;
	let tries = 0;
	globalThis.fetch = (async () => {
		if (++tries === 1) throw new Error("ECONNRESET: The socket connection was closed unexpectedly");
		return new Response(null, { status: 201 });
	}) as unknown as typeof fetch;
	try {
		expect((await call("/api/push/test", "POST", { endpoint }))!.status).toBe(200);
	} finally {
		globalThis.fetch = real;
	}
	expect(tries).toBe(2);
	expect(await (await call(`/api/push?endpoint=${encodeURIComponent(endpoint)}`, "GET"))!.json()).toMatchObject({ subscribed: true });
});

test("a subscription the push service swapped (pushsubscriptionchange) replaces the old one and keeps its device and app role", async () => {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const keys = { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 6)) };
	const oldEp = "https://fcm.example.net/old", newEp = "https://jmt.example.net/new", did = "dev-swap-0001";
	const call = (path: string, method: string, body?: unknown) => pushRoute(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL(`http://x${path}`));
	setRelayPeers(async () => []);
	await call("/api/push/subscribe", "POST", { subscription: { endpoint: oldEp, keys }, did, app: true });
	expect((await call("/api/push/subscribe", "POST", { subscription: { endpoint: newEp, keys }, replaces: oldEp }))!.status).toBe(200);
	expect(await (await call(`/api/push?endpoint=${encodeURIComponent(newEp)}`, "GET"))!.json()).toMatchObject({ subscribed: true, app: true, did });
	expect(await (await call(`/api/push?endpoint=${encodeURIComponent(oldEp)}`, "GET"))!.json()).toMatchObject({ subscribed: false });
	await call("/api/push/unsubscribe", "POST", { endpoint: newEp });
});

test("the service worker subscribes again on pushsubscriptionchange and names the endpoint it replaces", async () => {
	const on: Record<string, (ev: unknown) => void> = {};
	const posts: Array<{ url: string; body: unknown }> = [];
	const key = new Uint8Array([4, 1, 2]);
	const self = {
		addEventListener: (t: string, fn: (ev: unknown) => void) => void (on[t] = fn),
		registration: { pushManager: { subscribe: async (o: { applicationServerKey: unknown }) => ({ toJSON: () => ({ endpoint: "https://jmt.example.net/fresh", key: o.applicationServerKey === key }) }) } },
	};
	const fetchStub = async (url: string, init?: { body?: string }) => {
		posts.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
		return new Response("{}");
	};
	new Function("self", "fetch", readFileSync(new URL("../web/sw.js", import.meta.url), "utf8"))(self, fetchStub);
	let done: Promise<unknown> = Promise.resolve();
	on.pushsubscriptionchange!({ oldSubscription: { endpoint: "https://fcm.example.net/stale", options: { applicationServerKey: key } }, newSubscription: null, waitUntil: (p: Promise<unknown>) => void (done = p) });
	await done;
	expect(posts).toEqual([{ url: "/api/push/subscribe", body: { subscription: { endpoint: "https://jmt.example.net/fresh", key: true }, replaces: "https://fcm.example.net/stale" } }]);
});

test("Discord pings the owner only when no device takes this gateway's conversation (대화) notifications", () => {
	const on = { did: "dev-aaaaaaaa" };
	const never = () => false;
	expect(answersReach([], never)).toBe(false);
	expect(answersReach([on], never)).toBe(true);
	expect(answersReach([on], never, false)).toBe(false);
	expect(answersReach([on], did => did === "dev-aaaaaaaa")).toBe(false);
	expect(answersReach([{}], never)).toBe(true);
});

test("a notification carries the id (ts) of the event it is about", () => {
	expect(classify(ev({ ts: "2026-10-21T04:16:20.125Z", target: "web", text: "[done] 끝" }))).toMatchObject({ ts: "2026-10-21T04:16:20.125Z" });
	expect(classify(ev({ ts: "2026-10-21T04:16:21.000Z", source: "lane:x", target: "lane:x", text: "[ask] 머지할까?" }))).toMatchObject({ ts: "2026-10-21T04:16:21.000Z" });
});

test("the push for an out message leaves only after the message is persisted and broadcast, and carries its id", async () => {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const endpoint = "https://push.example.net/order";
	await pushRoute(new Request("http://x/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 5)) } } }) }), new URL("http://x/api/push/subscribe"));
	startOnce();
	const ts = "2026-10-21T04:16:20.125Z", before = lastEventId();
	let seen: { persisted: boolean; recent: boolean; replayable: boolean } | undefined;
	const real = globalThis.fetch;
	const sent = new Promise<void>(done => {
		globalThis.fetch = (async () => {
			seen = { persisted: readFileSync(paths.outbox, "utf8").includes(ts), recent: recentEvents().some(e => e.ts === ts), replayable: (replayAfter(before) ?? []).some(f => f.includes(ts)) };
			done();
			return new Response(null, { status: 201 });
		}) as unknown as typeof fetch;
	});
	try {
		emit("outbox", { ts, kind: "out", source: "orchestrator", target: "web", text: "[done] 배포 끝났어요" });
		await sent;
	} finally {
		globalThis.fetch = real;
	}
	expect(seen).toEqual({ persisted: true, recent: true, replayable: true });
});

test("gateway alerts notify as usage; Discord-bound answers and inbox messages do not", () => {
	expect(classify(ev({ source: "gateway", target: "alert", text: "5h 한도 90%" }))).toMatchObject({ kind: "alert" });
	expect(classify(ev({ target: "chat", text: "디코 답변" }))).toBeUndefined();
	expect(classify(ev({ kind: "message", source: "web", text: "안녕" }))).toBeUndefined();
});

test("a decision notice pushes as 답변이 필요해요 with its id, the decision line and at most two option buttons", () => {
	const fresh: Notice[] = [];
	onDecision(n => fresh.push(n));
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "web", text: "[ask] 어떻게 할까요?\n결정: 배포 방식\n**1) 지금 바로**\n**2) 밤에**\n**3) 하지 않기**" });
	const n = fresh.find(x => x.title === "배포 방식")!;
	expect(n).toBeDefined();
	expect(decisionPush(n)).toEqual({ kind: "ask", title: "답변이 필요해요", body: "배포 방식", url: `/?m=${encodeURIComponent(n.at!)}&n=${n.id}#chat/main`, tag: `decision:${n.id}`, ts: n.at, id: n.id, actions: [{ action: "opt:1", title: "1) 지금 바로" }, { action: "opt:2", title: "2) 밤에" }] });
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "lane:fix-ui", target: "lane:fix-ui", text: "[ask] 어느 쪽으로 이어갈까요?" });
	const lane = fresh.find(x => x.title === "어느 쪽으로 이어갈까요?")!;
	const m = decisionPush(lane);
	expect(m).toMatchObject({ title: "답변이 필요해요", url: `/?m=${encodeURIComponent(lane.at!)}&n=${lane.id}#chat/lane:fix-ui`, id: lane.id });
	expect(m.actions).toBeUndefined();   // an open question has no options (a yes / no one gets 1) 네 2) 아니요, ask-options.ts): a tap opens the detail
	// the store is shared with other test files: answer both so no pinned decision is left behind
	emit("inbox", { ts: new Date().toISOString(), kind: "message", source: "web", channel: "web", text: "1" });
	emit("inbox", { ts: new Date().toISOString(), kind: "lane_message", source: "web", lane: "fix-ui", text: "네" });
});

test("an answer in a monitor's or app's settings conversation notifies like any answer, titled with its label and opening that conversation", () => {
	setWatchLabelResolver(name => (name === "login-boutique-com" ? "부티크 로그인 유지" : name));
	const conv = "settings:w:login-boutique-com";
	expect(classify(ev({ target: conv, text: "원인을 찾았어요. 로그인이 풀렸어요." }), 5_000)).toBeUndefined();
	expect(classify(ev({ target: conv, text: "원인을 찾았어요. 로그인이 풀렸어요." }), LONG_TURN_MS)).toMatchObject({ kind: "result", title: "부티크 로그인 유지 · 완료", url: `/?m=2026-10-20T00%3A00%3A00Z#chat/${conv}`, tag: `answer:${conv}` });
	expect(classify(ev({ target: conv, text: "[fail] 다시 로그인하지 못했어요" }), 5_000)).toMatchObject({ kind: "alert", title: "부티크 로그인 유지 · 실패" });
	expect(classify(ev({ target: conv, text: "[ask] 다시 로그인할까요?" }))).toMatchObject({ kind: "ask", title: "부티크 로그인 유지 · 확인 필요" });
	expect(classify(ev({ source: "gateway", target: conv, text: "받았어요" }), LONG_TURN_MS)).toBeUndefined();
	setWatchLabelResolver(name => name);
});

test("an all-clear or a repeated gateway alert does not notify; a new failure and a question still do", () => {
	for (const text of ["땃쥐: 모델 제공자가 다시 연결됐어요. 멈춰 있던 일을 이어서 처리해요.", "땃쥐: API 키 사용 끝: 오케스트레이터가 x(구독)으로 돌아왔어요.", "땃쥐: 원래 모델(claude-opus-5-5)로 되돌렸어요", "[kakao-new] 다시 정상이에요"])
		expect(classify(ev({ source: "gateway", target: "alert", text }))).toBeUndefined();
	expect(classify(ev({ source: "gateway", target: "alert", text: "땃쥐: 모델 제공자 오류(timeout)", repeat: true }))).toBeUndefined();
	expect(classify(ev({ source: "gateway", target: "alert", text: "땃쥐: 모델 제공자 오류(timeout)" }))).toMatchObject({ kind: "alert" });
	expect(classify(ev({ source: "gateway", target: "alert", text: "[ask] 땃쥐: 모델 오류가 계속돼요.", repeat: true }))).toMatchObject({ kind: "ask" });
});

test("a push body is plain words: no option lines, no decision label, no small-line mark, no table rule", () => {
	const ask = classify(ev({ target: "web", text: "[ask] 2부를 끝냈어요.\n\n결정: 반영할까요?\n**1) 반영**\n바로 나가요.\n**2) 보류**\n그대로 둬요." }));
	expect(ask?.body).toBe("2부를 끝냈어요.");
	const report = classify(ev({ target: "web", text: "[done] 표예요.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n-# 지난 주 기준이에요" }));
	expect(report?.body).not.toMatch(/-{2,}|-#/);
});

test("a morning doctor message with only told lines pushes its count once and its first headline, never a sub-line; one with a card and any other alert push as before", () => {
	const ko = doctorKo, en = doctorEn, ts = "2026-11-24T00:30:00.000Z", count = new RegExp(ko.told(2), "g");
	const head = ko.restarts({ all: 5, update: 2, owner: 1, orchestrator: 1, unexplained: 1 }), sub = ko.restartLine("11월 24일 03:10", ko.restartUnasked), why = ko.lastReason("로그인 화면에서 멈췄어요");
	const told = [`${ko.head("11월 24일")} · ${ko.told(2)}`, ko.toldPart, `- ${head}${DOCTOR_LOOK_KO}`, `  - ${sub}`, `- ${ko.watchFailing("Sample-2", 6, "11월 23일 21:00")}${DOCTOR_LOOK_KO}`, `  - ${why}`, ko.lookHint].join("\n");
	const doctor = { source: "gateway", target: "alert", wk: "doctor" };
	const body = classify(ev({ ...doctor, ts, text: told }))?.body ?? "";
	expect(body).toBe(`${ko.head("11월 24일")} · ${ko.told(2)} · ${head}`);
	expect([body.match(count)?.length, body.includes(sub), body.includes(`${ko.toldPart} -`)]).toEqual([1, false, false]);
	emit("outbox", { ts, kind: "out", ...doctor, text: told });
	expect(noticePush(allNotices().find(n => n.at === ts)!)?.body).toBe(body);
	const enHead = en.restarts({ all: 5, update: 2, owner: 1, orchestrator: 1, unexplained: 1 });
	const enTold = [`${en.head("November 24")} · ${en.told(1)}`, en.toldPart, `- ${enHead}${DOCTOR_LOOK_EN}`, `  - ${en.restartLine("Nov 24 03:10", en.restartUnasked)}`, en.lookHint].join("\n");
	expect(classify(ev({ ...doctor, text: enTold }))?.body).toBe(`${en.head("November 24")} · ${en.told(1)} · ${enHead}`);
	const card = cardBlock({ subject: ko.diskSubject, question: ko.diskQuestion, evidence: ["남은 공간 9GB (4%)"], options: [{ name: ko.diskCleanName, result: ko.diskCleanResult }, { name: ko.diskKeepName, result: ko.diskKeepResult }] });
	const withCard = `${[`${ko.head("11월 24일")} · ${ko.told(1)} · ${ko.decide(1)}`, ko.toldPart, `- ${head}${DOCTOR_LOOK_KO}`, `  - ${sub}`].join("\n")}\n\n${ko.decidePart}\n\n${card}`;
	expect(classify(ev({ ...doctor, text: withCard }))?.body).toBe(`남은 공간 9GB (4%) ${ko.head("11월 24일")} · ${ko.told(1)} · ${ko.decide(1)} ${ko.toldPart} - ${head} · ${DOCTOR_LOOK_KO.slice(3)} - ${sub} ${ko.decidePart}`);
	expect(classify(ev({ source: "gateway", target: "alert", text: "[fail] 백업이 멈췄어요\n- 디스크가 가득 찼어요\n  - 남은 공간 0GB" }))?.body).toBe("백업이 멈췄어요 - 디스크가 가득 찼어요 - 남은 공간 0GB");
});

test("route() throws on a class it does not know under test (a push of such a class used to vanish without a word)", () => {
	expect(() => route({ cls: "update" } as unknown as RouteInput)).toThrow(/unknown notice class update/);
	expect(() => route({ target: "lane:x", text: "[run] 진행" })).not.toThrow();
});

test("a recall push (it only closes a notification) goes with Urgency low and TTL 300; the notification itself keeps high and 3600", async () => {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const endpoint = "https://push.example.net/recall";
	const call = (path: string, method: string, body?: unknown) => pushRoute(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL(`http://x${path}`));
	setRelayPeers(async () => []);
	await call("/api/push/subscribe", "POST", { subscription: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 7)) } } });
	const real = globalThis.fetch;
	const heads: Array<[string, string]> = [];
	globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
		if (url === endpoint) heads.push([init.headers.Urgency!, init.headers.TTL!]);
		return new Response(null, { status: 201 });
	}) as unknown as typeof fetch;
	try {
		resetPushDedupeForTest();
		await notify({ kind: "alert", title: "t", body: "recall", url: "/#chat/alert", tag: "alert:recall-test" });
		await flush();
		await withdraw(["alert:recall-test"], false);
	} finally {
		globalThis.fetch = real;
		resetPushDedupeForTest();
		await call("/api/push/unsubscribe", "POST", { endpoint });
	}
	expect(heads).toEqual([["high", "3600"], ["low", "300"]]);
});

test("PUT /api/push/classes answers an error and leaves a corrupt config.json untouched", async () => {
	const corrupt = '{"notify":{"push":{"ask":false},';
	const saved = readFileSync(CONFIG_FILE, "utf8");
	try {
		writeFileSync(CONFIG_FILE, corrupt);
		const url = new URL("http://x/api/push/classes");
		const r = await pushRoute(new Request(url, { method: "PUT", body: JSON.stringify({ classes: { news: false } }) }), url);
		expect(r!.status).toBeGreaterThanOrEqual(400);
		expect(await r!.json()).toMatchObject({ error: expect.any(String) });
		expect(readFileSync(CONFIG_FILE, "utf8")).toBe(corrupt);
	} finally {
		writeFileSync(CONFIG_FILE, saved);
	}
});

test("a message that opens seven cards is one push: the count in its title, its first line and the first card titles in its body, opening its first card", async () => {
	// Asked now: a card past its expiry (hasExpired) never pushes, so a fixed day breaks this test once it is old enough.
	const ts = new Date().toISOString();
	const pushes = await pushesOf("u7-seven", () => ask("u7-seven", ts, `[ask] 점검: 정할 것이 7가지 있어요.\n- 하루 사이에 4번 다시 시작했어요.\n\n${cardsOf(7)}`));
	const cards = cardsIn("u7-seven");
	expect(cards).toHaveLength(7);
	expect(pushes).toHaveLength(1);
	expect(pushes[0]).toMatchObject({ kind: "ask", title: "답변이 7개 필요해요", url: `/?m=${encodeURIComponent(ts)}&n=${cards[0]!.id}#chat/lane:u7-seven`, tag: `decision-msg:lane:u7-seven@${ts}` });
	expect(String(pushes[0]!.body).split("\n").slice(0, 3)).toEqual(["점검: 정할 것이 7가지 있어요.", "· 1번 규칙 줄을 제안대로 고칠까요?", "· 2번 규칙 줄을 제안대로 고칠까요?"]);
	expect(String(pushes[0]!.body).length).toBeLessThanOrEqual(180);
	settle("u7-seven");
});

test("a message that opens one card pushes that card as before: its title, its decision line and its own tag", async () => {
	const ts = new Date(Date.now() + 1000).toISOString();
	const pushes = await pushesOf("u7-one", () => ask("u7-one", ts, `[ask] 하나만 물을게요.\n\n${cardsOf(1)}`));
	const [card] = cardsIn("u7-one");
	expect(pushes).toHaveLength(1);
	expect(pushes[0]).toMatchObject({ kind: "ask", title: "답변이 필요해요", body: "1번 규칙 줄을 제안대로 고칠까요?", url: `/?m=${encodeURIComponent(ts)}&n=${card!.id}#chat/lane:u7-one`, tag: `decision:${card!.id}`, id: card!.id });
	settle("u7-one");
});

test("a card of a grouped message that comes back after 나중에 pushes alone, as its own card", async () => {
	// 나중에 counts its hour from the real clock, so the message is asked now too: from a fixed day, the other card's own reminder
	// comes due in the same sweep once that day is far enough behind.
	const ts = new Date().toISOString();
	expect(await pushesOf("u7-later", () => ask("u7-later", ts, `[ask] 두 가지예요.\n\n${cardsOf(2)}`))).toHaveLength(1);
	const [card] = cardsIn("u7-later");
	expect(laterNotice(card!.id, { for: "hour" }).status).toBe(200);
	const woke = await pushesOf("u7-later", () => sweepQuestions(new Date(Date.parse(card!.decision!.later_until!) + 1000).toISOString()));
	expect(woke).toHaveLength(1);
	expect(woke[0]).toMatchObject({ title: "답변이 필요해요", body: "1번 규칙 줄을 제안대로 고칠까요?", tag: `decision:${card!.id}` });
	settle("u7-later");
});
