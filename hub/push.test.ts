// Which hub events become a phone notification, and where a tap on it leads.
import { expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { emit, lastEventId, recentEvents, replayAfter } from "./events.ts";
import { type Notice, onDecision, setWatchLabelResolver } from "./notices.ts";
import { classify, decisionPush, LONG_TURN_MS, pushRoute, startPush } from "./push.ts";
import { b64u } from "./webpush.ts";

const ev = (e: Record<string, unknown>) => ({ ts: "2026-10-20T00:00:00Z", kind: "out", source: "orchestrator", text: "", ...e });

test("a web answer notifies only when it finishes work or needs the owner; a quick reply does not", () => {
	expect(classify(ev({ target: "web", text: "네, 맞아요" }), 5_000)).toBeUndefined();
	expect(classify(ev({ target: "web", text: "다 했어요" }), LONG_TURN_MS)).toMatchObject({ kind: "answer", title: "dotz · 완료", url: "/#chat/main", body: "다 했어요" });
	expect(classify(ev({ target: "web", text: "[done] 배포 끝" }), 5_000)).toMatchObject({ title: "dotz · 완료" });
	expect(classify(ev({ target: "web", text: "[ask] 어느 쪽?" }))).toMatchObject({ kind: "ask", body: "어느 쪽?" });
});

test("a project's answers notify like the main chat's and open that project's chat; a thread of it does too", () => {
	const CH = "ch:1561565203714408448";
	expect(classify(ev({ target: CH, text: "네, 맞아요" }), 5_000)).toBeUndefined();
	expect(classify(ev({ target: CH, text: "다 했어요" }), LONG_TURN_MS)).toMatchObject({ kind: "answer", title: "dotz · 완료", url: `/#chat/${CH}`, tag: `answer:${CH}` });
	expect(classify(ev({ target: CH, text: "[ask] 어느 쪽?" }))).toMatchObject({ kind: "ask", url: `/#chat/${CH}` });
	expect(classify(ev({ target: "th:42", channel: CH, text: "[done] 끝" }))).toMatchObject({ title: "dotz · 완료", url: `/#chat/${CH}` });
	expect(classify(ev({ target: CH, source: "gateway", text: "[done] 끝" }))).toBeUndefined();
	expect(classify(ev({ target: "th:42", text: "[done] 끝" }))).toBeUndefined(); // a thread of no known project stays on Discord
});

test("a lane's worklog entry notifies once as a start; its later edits do not", () => {
	expect(classify(ev({ target: "worklog", update_key: "lane:custom-ui", text: "[run] 맞춤 화면 레인 시작했어요." }))).toMatchObject({ kind: "lane", title: "custom-ui · 시작" });
	expect(classify(ev({ target: "worklog", update_key: "lane:custom-ui", text: "[run] 테스트 돌리는 중" }))).toBeUndefined();
	expect(classify(ev({ target: "worklog", update_key: "lane:custom-ui", text: "[done] 끝났어요" }))).toBeUndefined();
	expect(classify(ev({ target: "web", update_key: "progress", text: "[run] 시작했어요" }))).toBeUndefined();
});

test("alerts notify only when critical or when the owner is needed", () => {
	expect(classify(ev({ source: "gateway", target: "alert", text: "뙃쥐: 사용량 한도(429)로 멈춤." }))).toMatchObject({ kind: "usage", title: "dotz · 경고" });
	expect(classify(ev({ source: "gateway", target: "alert", text: "토큰 누수 점검 (10-19): 경고 3건" }))).toBeUndefined();
	expect(classify(ev({ target: "alert", reply_to: "1", text: "ㅇㅋ 형, 바로 할게요." }))).toBeUndefined();
	expect(classify(ev({ target: "alert", text: "어제 영어 답변이 또 나왔어요. 고칠 곳을 정리했어요." }))).toBeUndefined();
	expect(classify(ev({ target: "alert", text: "형, 주간 사용량이 2%만 남아서 레인 실행이 막혔어요." }))).toMatchObject({ kind: "usage" });
	expect(classify(ev({ target: "alert", text: "[ask] 전달 경로를 고칠까요?" }))).toMatchObject({ kind: "ask" });
});

test("lane [ask]/[done]/[fail] lines notify and open that lane; progress does not", () => {
	expect(classify(ev({ source: "lane:ui-pwa", target: "lane:ui-pwa", text: "[ask] 머지할까?" }))).toMatchObject({ kind: "ask", url: "/#chat/lane:ui-pwa" });
	expect(classify(ev({ kind: "lane_report", source: "lane:x", lane: "x", text: "[done] 끝" }))).toMatchObject({ kind: "lane", title: "x · 완료" });
	expect(classify(ev({ source: "lane:x", target: "lane:x", text: "[fail] 테스트 실패" }))).toMatchObject({ kind: "lane", title: "x · 실패" });
	expect(classify(ev({ source: "lane:x", target: "lane:x", text: "[run] 빌드 중", update_key: "progress" }))).toBeUndefined();
	expect(classify(ev({ source: "lane:x", target: "lane:x", text: "그냥 메모" }))).toBeUndefined();
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

test("a notification carries the id (ts) of the event it is about", () => {
	expect(classify(ev({ ts: "2026-10-21T04:16:20.125Z", target: "web", text: "[done] 끝" }))).toMatchObject({ ts: "2026-10-21T04:16:20.125Z" });
	expect(classify(ev({ ts: "2026-10-21T04:16:21.000Z", source: "lane:x", target: "lane:x", text: "[ask] 머지할까?" }))).toMatchObject({ ts: "2026-10-21T04:16:21.000Z" });
});

test("the push for an out message leaves only after the message is persisted and broadcast, and carries its id", async () => {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const endpoint = "https://push.example.net/order";
	await pushRoute(new Request("http://x/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 5)) } } }) }), new URL("http://x/api/push/subscribe"));
	startPush({ subject: () => "mailto:t@example.com" });
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
	expect(classify(ev({ source: "gateway", target: "alert", text: "5h 한도 90%" }))).toMatchObject({ kind: "usage" });
	expect(classify(ev({ target: "chat", text: "디코 답변" }))).toBeUndefined();
	expect(classify(ev({ kind: "message", source: "web", text: "안녕" }))).toBeUndefined();
});

test("a decision notice pushes as 답변이 필요해요 with its id, the decision line and at most two option buttons", () => {
	const fresh: Notice[] = [];
	onDecision(n => fresh.push(n));
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "web", text: "[ask] 어떻게 할까요?\n결정: 배포 방식\n**1) 지금 바로** ← 추천\n**2) 밤에**\n**3) 하지 않기**" });
	const n = fresh.find(x => x.title === "배포 방식")!;
	expect(n).toBeDefined();
	expect(decisionPush(n)).toEqual({ kind: "ask", title: "답변이 필요해요", body: "배포 방식", url: "/#chat/main", tag: `decision:${n.id}`, ts: n.at, id: n.id, actions: [{ action: "opt:1", title: "1) 지금 바로" }, { action: "opt:2", title: "2) 밤에" }] });
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "lane:fix-ui", target: "lane:fix-ui", text: "[ask] 어느 쪽으로 이어갈까요?" });
	const lane = fresh.find(x => x.title === "어느 쪽으로 이어갈까요?")!;
	const m = decisionPush(lane);
	expect(m).toMatchObject({ title: "답변이 필요해요", url: "/#chat/lane:fix-ui", id: lane.id });
	expect(m.actions).toBeUndefined();   // an open question has no options (a yes / no one gets 1) 네 2) 아니요, ask-options.ts): a tap opens the detail
	// the store is shared with other test files: answer both so no pinned decision is left behind
	emit("inbox", { ts: new Date().toISOString(), kind: "message", source: "web", channel: "web", text: "1" });
	emit("inbox", { ts: new Date().toISOString(), kind: "lane_message", source: "web", lane: "fix-ui", text: "네" });
});

test("an answer in a monitor's or app's settings conversation notifies like any answer, titled with its label and opening that conversation", () => {
	setWatchLabelResolver(name => (name === "login-cartier-com" ? "까르띠에 로그인 유지" : name));
	const conv = "settings:w:login-cartier-com";
	expect(classify(ev({ target: conv, text: "원인을 찾았어요. 로그인이 풀렸어요." }), 5_000)).toBeUndefined();
	expect(classify(ev({ target: conv, text: "원인을 찾았어요. 로그인이 풀렸어요." }), LONG_TURN_MS)).toMatchObject({ kind: "answer", title: "까르띠에 로그인 유지 · 완료", url: `/#chat/${conv}`, tag: `answer:${conv}` });
	expect(classify(ev({ target: conv, text: "[fail] 다시 로그인하지 못했어요" }), 5_000)).toMatchObject({ kind: "answer", title: "까르띠에 로그인 유지 · 실패" });
	expect(classify(ev({ target: conv, text: "[ask] 다시 로그인할까요?" }))).toMatchObject({ kind: "ask", title: "까르띠에 로그인 유지 · 확인 필요" });
	expect(classify(ev({ source: "gateway", target: conv, text: "받았어요" }), LONG_TURN_MS)).toBeUndefined();
	setWatchLabelResolver(name => name);
});
