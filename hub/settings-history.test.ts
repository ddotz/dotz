import { describe, expect, test } from "bun:test";
import { isSettingsTarget } from "./app-settings.ts";
import { HUB_TOKEN } from "./config.ts";
import { emit } from "./events.ts";
import { readOf } from "./reads.ts";
import { makeRoute } from "./routes.ts";

// The history and the read position of a settings conversation (settings:<app>, settings:w:<watch>) go through the same two routes as every other
// conversation: the web's 모니터링 opens them, and a peer's go through /api/peer/proxy to these same routes. Placeholders only.
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const call = (method: string, path: string, body?: object) =>
	route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
const WATCH = "settings:w:nas-php-node-patch";
const APP = "settings:kakao";
const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 3, min)).toISOString();

describe("settings targets", () => {
	test("the name form: an app or a watch, nothing else", () => {
		for (const t of [WATCH, APP, "settings:mail-2", "settings:w:kakao-new"]) expect(isSettingsTarget(t)).toBe(true);
		for (const t of ["settings:", "settings:w:", "settings:../x", "settings:a b", "main", "mail:x", "ch:1"]) expect(isSettingsTarget(t)).toBe(false);
	});

	test("GET /api/history answers a watch's and an app's settings conversation with its messages", async () => {
		emit("inbox", { ts: at(1), kind: "message", source: "web", channel: WATCH, author: "owner", text: "왜 실패했어?" });
		emit("outbox", { ts: at(2), kind: "out", source: "orchestrator", target: WATCH, text: "로그인이 풀렸어요" });
		emit("outbox", { ts: at(3), kind: "out", source: "orchestrator", target: APP, text: "카카오 설정이에요" });
		for (const [t, text] of [[WATCH, "로그인이 풀렸어요"], [APP, "카카오 설정이에요"]] as const) {
			const r = await call("GET", `/api/history?target=${encodeURIComponent(t)}&limit=30`);
			expect(r.status).toBe(200);
			const body = (await r.json()) as { target: string; events: { text?: string }[] };
			expect(body.target).toBe(t);
			expect(body.events.map(e => e.text)).toContain(text);
		}
		const own = (await (await call("GET", `/api/history?target=${encodeURIComponent(WATCH)}`)).json()) as { events: { text?: string }[] };
		expect(own.events.map(e => e.text)).not.toContain("카카오 설정이에요");
	});

	test("an unknown kind of target is still refused", async () => {
		expect((await call("GET", "/api/history?target=settings:")).status).toBe(400);
		expect((await call("GET", "/api/history?target=nope:x")).status).toBe(400);
	});

	test("POST /api/read moves the position of a settings conversation", async () => {
		const r = await call("POST", "/api/read", { target: WATCH, ts: at(2) });
		expect(r.status).toBe(200);
		expect(readOf(WATCH)).toBe(at(2));
	});
});
