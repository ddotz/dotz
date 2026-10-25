import { afterAll, expect, test } from "bun:test";
import { fakeHub, idleState, json, run, waitFor } from "./test-web.ts";

// The owner on the MacBook writes in a mail conversation of the Mac mini whose bot is paused. The page reads that conversation through the proxy and never
// gets the mini's events on its own stream, so the notice the mini writes afterwards has to arrive by the page's repeated read; the composer says the bot is
// paused. Headless; the two gateways are fixtures.
const MINI = "http://mini.test";
const T = "mail:kdb-66931568";
const THREAD = "th:1563113405412282505";
const MAIL = { key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], unread: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } };
const asked = { ts: "2026-10-23T12:50:00.000Z", kind: "message", source: "web", channel: THREAD, conv: T, author: "hyuns", mid: "m1", text: "답장 초안 작성해." };
const history: Record<string, unknown>[] = [asked];
const PAUSED_OUT = "지금 모델 제공자 결제/인증 문제로 멈춰 있어요. 해결되면 받은 메시지부터 이어서 처리할게요.";
const miniBot = { status: "rate-limited", pauseKind: "owner" };
const localBot = { status: "rate-limited", pauseKind: "rate" };
const peers = () => [{ name: "맥미니", url: MINI, online: true, stale: false, items: { name: "맥미니", rev: "r1", monitors: [], notices: [], integrations: [MAIL], available: [], conversations: [{ target: T, mail: { key: "kdb-66931568", subject: "견적 요청", from: "Kim", source: "kdb", at: asked.ts }, last: { text: "메일 본문", via: "kdb" }, unread: 0 }], orchestrator: miniBot } }];

const hub = fakeHub({
	state: idleState({ orchestrator: localBot }),
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/peers") return json([{ name: "맥북", url: hub.origin, self: true, online: true }, { name: "맥미니", url: MINI, self: false, online: true }]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitoring/peers") return json(peers());
		if (p === "/api/peer/proxy" && (url.searchParams.get("p") ?? "").startsWith("/api/history")) return json({ target: T, events: history });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/monitors" || p === "/api/notices" || p === "/api/integrations" || p === "/api/conversations") return json({ items: [], unread: 0 });
	},
});
afterAll(() => hub.stop());

test("a peer's mail conversation gets the mini's later notice and held state, and the composer says its bot is paused", async () => {
	const v = await hub.view({ width: 1280, height: 800 }, "/");
	await waitFor(v, "S && PR.fresh");
	await run(v, "go('monitoring')");
	await waitFor(v, `PQ.loaded && PQ.of.has(${JSON.stringify(T)})`);
	await run(v, `setTarget(${JSON.stringify(T)})`);
	await waitFor(v, `$("#tl").textContent.includes("답장 초안 작성해.")`);
	await waitFor(v, `!$("#pausenote").hidden && $("#pausenote span").textContent === "맥미니 봇이 멈춰 있어요: 로그인 필요" && !$("#pausenote .pn-go")`);   // a peer's bot is resumed on that computer: no button here
	expect(await v.evaluate(`$("#tl").textContent.includes("멈춰 있어요")`)).toBe(false);

	history.push(
		{ ts: "2026-10-23T12:50:01.000Z", kind: "delivery", source: "gateway", target: THREAD, conv: T, ref: "m1", state: "held", text: "" },
		{ ts: "2026-10-23T12:50:02.000Z", kind: "out", source: "gateway", target: THREAD, conv: T, text: PAUSED_OUT, reply_to: "m1" },
	);
	await waitFor(v, `$("#tl").textContent.includes(${JSON.stringify(PAUSED_OUT)}) && $("#tl").textContent.includes(DELIV_LABEL.held)`);
}, 30_000);

test("a conversation of this computer reads its own bot's pause from the orchestrator status", async () => {
	const v = await hub.view({ width: 1280, height: 800 }, "/");
	await waitFor(v, "S && PR.fresh");
	await waitFor(v, `!$("#pausenote").hidden && $("#pausenote span").textContent === "맥북 봇이 멈춰 있어요: 사용량 한도" && $("#pausenote .pn-go").textContent === "지금 다시 시도"`);
	await run(v, "go('monitoring')");
	await waitFor(v, `PQ.loaded && PQ.of.has(${JSON.stringify(T)})`);
	await run(v, "setTarget('lane:x')");
	await waitFor(v, `$("#pausenote").hidden`);
}, 30_000);
