import { describe, expect, test } from "bun:test";
import { withConnection } from "./integrations.ts";
import { appConnection, connectionText, watchConnection } from "./watch-status.ts";

const NOW = Date.parse("2026-10-26T11:45:00Z");
const w = (name: string, state: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ name, ...extra, state: { fails: 0, ...state } });
const item = (own: string[]) => ({ key: "mail", own, needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 0 } });

describe("an app's connection from the watches it owns", () => {
	test("a login keeper whose check says DOTZ_DISCONNECTED (exit 0, the alert went elsewhere) is disconnected since the time it names", () => {
		const keeper = w("kdb-login", { last: "DOTZ_DISCONNECTED since=2026-10-23T12:29:18.300Z\nwaiting for the owner's approval", lastRun: "2026-10-26T11:43:34.697Z" });
		expect(watchConnection(keeper)).toEqual({ state: "disconnected", since: "2026-10-23T12:29:18.300Z", reason: "login" });
		const out = withConnection(item(["kdb-login"]), [keeper], "Asia/Seoul");
		expect(out.state).toBe("disconnected");
		expect(out.since).toBe("2026-10-23T12:29:18.300Z");
		expect(out.hint).toBe("연결 끊김 · 10월 23일 21:29부터 · 다시 로그인 필요");
	});

	test("a watch failing twice in a row is disconnected since its first failure, whether or not an alert went out", () => {
		const since = NOW - 3 * 3600_000;
		const login = w("webmail-work", { fails: 5, failSince: since, kind: "webmail-login" });
		expect(watchConnection(login)).toEqual({ state: "disconnected", since: new Date(since).toISOString(), reason: "login" });
		const session = w("webmail-work-session", { fails: 2, failSince: since, kind: "fail" }, { session: { url: "https://m.example", refresh_hours: 6 } });
		expect(watchConnection(session).reason).toBe("login");
		const net = w("webmail-work", { fails: 3, failSince: since, kind: "network" });
		expect(watchConnection(net).reason).toBe("check");
		expect(connectionText(watchConnection(net), "Asia/Seoul")).toBe("연결 끊김 · 10월 26일 17:45부터 · 확인이 계속 실패해요");
	});

	test("one failure, a passing check or an owner-paused watch is connected", () => {
		expect(watchConnection(w("a", { fails: 1, failSince: NOW, kind: "network" })).state).toBe("connected");
		expect(watchConnection(w("a", { last: "logged in" })).state).toBe("connected");
		expect(watchConnection(w("a", { fails: 9, failSince: NOW }, { paused: true })).state).toBe("connected");
	});

	test("a watch stopped until approval, or waiting for the owner's approval, is disconnected", () => {
		expect(watchConnection(w("a", { fails: 1, failSince: NOW, kind: "approval", approvalAskedAt: NOW })).state).toBe("disconnected");
		expect(watchConnection(w("a", { fails: 1, failSince: NOW, kind: "login", paused: "login" })).state).toBe("disconnected");
	});

	test("the app takes the earliest outage of its watches; only its own watches count", () => {
		const a = w("x-1", { fails: 2, failSince: NOW - 1000, kind: "network" }), b = w("x-2", { fails: 2, failSince: NOW - 5000, kind: "webmail-login" });
		expect(appConnection([a, b])).toEqual({ state: "disconnected", since: new Date(NOW - 5000).toISOString(), reason: "login" });
		const out = withConnection(item(["mine"]), [a, w("mine", { last: "ok" })]);
		expect(out.state).toBe("connected");
		expect(out.hint).toBeUndefined();
	});
});
