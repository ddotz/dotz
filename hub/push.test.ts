// Which hub events become a phone notification, and where a tap on it leads.
import { expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { classify, LONG_TURN_MS, pushRoute } from "./push.ts";
import { b64u } from "./webpush.ts";

const ev = (e: Record<string, unknown>) => ({ ts: "2026-10-20T00:00:00Z", kind: "out", source: "orchestrator", text: "", ...e });

test("a web answer notifies only when it finishes work or needs the owner; a quick reply does not", () => {
	expect(classify(ev({ target: "web", text: "네, 맞아요" }), 5_000)).toBeUndefined();
	expect(classify(ev({ target: "web", text: "다 했어요" }), LONG_TURN_MS)).toMatchObject({ kind: "answer", title: "dotz · 완료", url: "/#chat/main", body: "다 했어요" });
	expect(classify(ev({ target: "web", text: "[done] 배포 끝" }), 5_000)).toMatchObject({ title: "dotz · 완료" });
	expect(classify(ev({ target: "web", text: "[ask] 어느 쪽?" }))).toMatchObject({ kind: "ask", body: "어느 쪽?" });
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

test("gateway alerts notify as usage; Discord-bound answers and inbox messages do not", () => {
	expect(classify(ev({ source: "gateway", target: "alert", text: "5h 한도 90%" }))).toMatchObject({ kind: "usage" });
	expect(classify(ev({ target: "chat", text: "디코 답변" }))).toBeUndefined();
	expect(classify(ev({ kind: "message", source: "web", text: "안녕" }))).toBeUndefined();
});
