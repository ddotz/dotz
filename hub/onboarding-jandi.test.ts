import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAME } from "./config.ts";
import { msg } from "./i18n.ts";
import { createJandiStore } from "./onboarding-jandi.ts";
import { createOnboarding, type OnboardDeps, onboardingRoute, type OnboardView } from "./onboarding.ts";
import { readSecretFile } from "./secretbox.ts";

// The JANDI connect flow end to end against made-up data: a fake browser answers `login-capture`, a fake fetch answers JANDI's web API.
const API = "https://i1.jandi.com/";
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Capture = { ok: boolean; data?: Record<string, unknown>; waiting?: string };
type Shape = { teams?: { teamId: number; memberId: number; teamName: string }[]; roomType?: string; denyToken?: boolean; noBot?: boolean };

function jandiFetch(shape: Shape = {}) {
	const calls: string[] = [];
	const teams = shape.teams ?? [{ teamId: 11, memberId: 21, teamName: "Alpha" }];
	const doFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith(API)) throw new Error(`unexpected network call ${url}`);
		const path = url.slice(API.length);
		calls.push(path);
		if (path === "inner-api/token") {
			const body = JSON.parse(String(init?.body)) as { refresh_token?: string };
			if (shape.denyToken || !String(body.refresh_token).startsWith("rt-")) return Response.json({}, { status: 400 });
			return Response.json({ access_token: "at-1", refresh_token: "rt-rotated", expires_in: 3600 });
		}
		if ((init?.headers as Record<string, string> | undefined)?.Authorization !== "bearer at-1") return new Response(null, { status: 401 });
		if (path === "start-api/v4/account") return Response.json({ memberships: teams });
		const team = /^start-api\/v4\/teams\/(\d+)(\/me)?$/.exec(path);
		if (team) {
			const t = teams.find(x => x.teamId === Number(team[1]));
			if (!t) return Response.json({}, { status: 404 });
			if (team[2]) return Response.json({ member: { id: t.memberId } });
			return Response.json({ members: [{ id: t.memberId, type: "user" }, ...(shape.noBot ? [] : [{ id: t.teamId * 10 + 1, type: "bot", entityId: t.teamId * 10 + 5 }])] });
		}
		const room = /^room-api\/v2\/teams\/(\d+)\/rooms\/(\d+)$/.exec(path);
		if (room) {
			const t = teams.find(x => x.teamId === Number(room[1]))!;
			return Response.json({ type: shape.roomType ?? "chat", companionId: t.teamId * 10 + 1, members: [t.memberId, t.teamId * 10 + 1] });
		}
		return Response.json({}, { status: 404 });
	};
	return { calls, fetch: doFetch as typeof fetch };
}

function setup(capture: Capture[], shape: Shape = {}, jandi?: unknown) {
	const dir = mkdtempSync(join(tmpdir(), "onboard-jandi-"));
	dirs.push(dir);
	mkdirSync(join(dir, "secrets"), { recursive: true, mode: 0o700 });
	if (jandi !== undefined) {
		mkdirSync(join(dir, "messengers"), { recursive: true });
		writeFileSync(join(dir, "messengers", "jandi.json"), JSON.stringify(jandi));
	}
	const net = jandiFetch(shape);
	const browserCalls: { action: string; arg?: Record<string, unknown> }[] = [];
	const timers: (() => void)[] = [];
	const said: { target: string; text: string }[] = [];
	let restarts = 0;
	const deps: OnboardDeps = {
		dir,
		fetch: net.fetch,
		browser: {
			async run(action, arg) {
				browserCalls.push({ action, ...(arg ? { arg } : {}) });
				return action === "login-capture" ? (capture.shift() ?? { ok: false }) : { ok: true };
			},
		},
		exec: async () => ({ code: 0, out: "" }),
		restart: async () => void restarts++,
		jandi: createJandiStore(dir),
		after: (_ms, fn) => void timers.push(fn),
		say: async (target, text) => void said.push({ target, text }),
	};
	const svc = createOnboarding(deps);
	const run = async (f: () => OnboardView): Promise<OnboardView> => {
		f();
		await svc.idle("jandi");
		return svc.view("jandi");
	};
	const fire = async () => {
		timers.shift()!();
		await svc.idle("jandi");
		return svc.view("jandi");
	};
	return { dir, svc, net, browserCalls, timers, said, restarts: () => restarts, run, fire };
}

const cookie = (token = "rt-first"): Capture => ({ ok: true, data: { refresh_token: token } });
const savedConfig = (dir: string) => JSON.parse(readFileSync(join(dir, "messengers", "jandi.json"), "utf8"));

describe("JANDI connect flow", () => {
	test("a login ends with the chat with yourself saved, sealed, and the adapter restarted once", async () => {
		const t = setup([cookie()]);
		expect((await t.run(() => t.svc.start("jandi"))).step?.id).toBe("notice");
		const view = await t.run(() => t.svc.continue("jandi"));
		expect(view.state).toBe("done");
		const sc = savedConfig(t.dir);
		expect(sc.enabled).toBe(true);
		expect(sc.self_chat).toMatchObject({ enabled: true, team_id: 11, member_id: 21, bot_id: 111, room_id: 115, keyword: /^\S{1,30}$/.test(NAME) ? NAME : "dotz", reply_prefix: `[${NAME}]` });
		expect(sc.rooms.some((r: { kind: string }) => r.kind === "main")).toBe(true);
		expect(JSON.parse(readSecretFile(join(t.dir, "secrets", "jandi-session"))).refresh_token).toBe("rt-rotated");
		expect(t.restarts()).toBe(1);
		const state = readFileSync(join(t.dir, "onboarding", "jandi.json"), "utf8");
		expect(state).not.toContain("rt-");
		expect(t.browserCalls.filter(c => c.action === "login-capture")).toHaveLength(1);
	});

	test("a login that is not there yet waits and rechecks by itself; only the first wait is said to the asking chat", async () => {
		const t = setup([{ ok: true, waiting: "login" }, { ok: true, waiting: "login" }, cookie()]);
		t.svc.start("jandi", { notify: "discord:main" });
		await t.svc.idle("jandi");
		await t.run(() => t.svc.continue("jandi"));
		expect(t.svc.view("jandi").step?.id).toBe("login");
		expect(t.timers).toHaveLength(1);
		expect((await t.fire()).step?.id).toBe("login");
		expect((await t.fire()).state).toBe("done");
		expect(t.said.map(s => s.target)).toEqual(["discord:main", "discord:main", "discord:main"]); // notice, login, done
		expect(JSON.stringify(t.said)).not.toContain("rt-");
	});

	test("several teams ask once with choices and the pick decides the team", async () => {
		const teams = [{ teamId: 11, memberId: 21, teamName: "Alpha" }, { teamId: 12, memberId: 22, teamName: "Beta" }];
		const t = setup([cookie(), cookie()], { teams });
		await t.run(() => t.svc.start("jandi"));
		const asked = await t.run(() => t.svc.continue("jandi"));
		expect(asked.state).toBe("waiting");
		expect(asked.step?.id).toBe("team");
		expect(asked.choices).toEqual([{ id: "11", label: "Alpha" }, { id: "12", label: "Beta" }]);
		expect(existsSync(join(t.dir, "secrets", "jandi-session"))).toBe(false);
		const done = await t.run(() => t.svc.continue("jandi", { choice: "12" }));
		expect(done.state).toBe("done");
		expect(savedConfig(t.dir).self_chat).toMatchObject({ team_id: 12, member_id: 22 });
		expect(existsSync(join(t.dir, "secrets", "jandi-pending"))).toBe(false);
	});

	test("a room that is not the chat with the JANDI bot saves nothing", async () => {
		const t = setup([cookie()], { roomType: "group" });
		await t.run(() => t.svc.start("jandi"));
		const view = await t.run(() => t.svc.continue("jandi"));
		expect(view.state).toBe("failed");
		expect(existsSync(join(t.dir, "secrets", "jandi-session"))).toBe(false);
		expect(existsSync(join(t.dir, "messengers", "jandi.json"))).toBe(false);
		expect(t.restarts()).toBe(0);
	});

	test("a team without the JANDI bot fails plainly and saves nothing", async () => {
		const t = setup([cookie()], { noBot: true });
		await t.run(() => t.svc.start("jandi"));
		expect((await t.run(() => t.svc.continue("jandi"))).state).toBe("failed");
		expect(existsSync(join(t.dir, "secrets", "jandi-session"))).toBe(false);
	});

	test("a session JANDI refuses fails without leaking the token", async () => {
		const t = setup([cookie("rt-SECRETVALUE")], { denyToken: true });
		await t.run(() => t.svc.start("jandi"));
		const view = await t.run(() => t.svc.continue("jandi"));
		expect(view.state).toBe("failed");
		expect(JSON.stringify(view)).not.toContain("SECRETVALUE");
	});

	test("Aside not answering stops with a plain error and stores nothing", async () => {
		const t = setup([]);
		await t.run(() => t.svc.start("jandi"));
		const view = await t.run(() => t.svc.continue("jandi")); // the fake browser answers { ok: false }
		expect(view.state).toBe("failed");
		expect(existsSync(join(t.dir, "secrets", "jandi-session"))).toBe(false);
	});

	test("the wait ends after the give-up limit: the tab is closed and the flow fails", async () => {
		const t = setup(Array.from({ length: 400 }, () => ({ ok: true, waiting: "login" }) as Capture));
		await t.run(() => t.svc.start("jandi"));
		let view = await t.run(() => t.svc.continue("jandi"));
		for (let i = 0; i < 400 && view.state === "waiting"; i++) view = await t.fire();
		expect(view.state).toBe("failed");
		expect(t.browserCalls.some(c => c.action === "login-close")).toBe(true);
	});

	test("cancel closes the login tab", async () => {
		const t = setup([{ ok: true, waiting: "login" }]);
		await t.run(() => t.svc.start("jandi"));
		await t.run(() => t.svc.continue("jandi"));
		t.svc.cancel("jandi");
		await t.svc.idle("jandi");
		expect(t.browserCalls.some(c => c.action === "login-close")).toBe(true);
		expect(t.svc.view("jandi").state).toBe("idle");
	});

	test("a reconnect keeps keyword, prefix, peers and interval, and clears the expiry mark", async () => {
		const old = {
			enabled: true,
			rooms: [{ id: "m1", name: "메인", kind: "main", outgoing_token: "", incoming_url: "" }],
			self_chat: { enabled: true, team_id: 11, room_id: 115, member_id: 21, bot_id: 111, keyword: "곰돌", reply_prefix: "[곰]", session_secret: "jandi-session", interval_ms: 5000, peers: [{ name: "집", keyword: "home", reply_prefix: "[집]" }] },
		};
		const t = setup([cookie()], {}, old);
		mkdirSync(join(t.dir, "messengers"), { recursive: true });
		writeFileSync(join(t.dir, "messengers", "jandi-session.json"), JSON.stringify({ lost_at: 1 }));
		const view = await t.run(() => t.svc.start("jandi")); // configured: no notice
		expect(view.state).toBe("done");
		const sc = savedConfig(t.dir).self_chat;
		expect(sc).toMatchObject({ keyword: "곰돌", reply_prefix: "[곰]", interval_ms: 5000, peers: [{ keyword: "home" }] });
		expect(existsSync(join(t.dir, "messengers", "jandi-session.json"))).toBe(false);
		expect(savedConfig(t.dir).rooms).toHaveLength(1);
	});

	test("the routes pass the asking chat and the team choice from the JSON body", async () => {
		const teams = [{ teamId: 11, memberId: 21, teamName: "Alpha" }, { teamId: 12, memberId: 22, teamName: "Beta" }];
		const t = setup([cookie()], { teams });
		const post = async (path: string, body: unknown) => {
			const url = new URL(`http://hub/api/onboarding/jandi/${path}`);
			await onboardingRoute(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, t.svc);
			await t.svc.idle("jandi");
			return t.svc.view("jandi");
		};
		await post("start", { notify: "discord:main" });
		await post("continue", {});
		const done = await post("continue", { choice: "12" });
		expect(done.state).toBe("done");
		expect(t.said.every(s => s.target === "discord:main")).toBe(true);
		expect(t.said.length).toBeGreaterThan(1);
	});

	test("saved webhook rooms without a self chat finish at once without a login", async () => {
		const rooms = [{ id: "m1", name: "메인", kind: "main", outgoing_token: "out-token-1234", incoming_url: "https://wh.jandi.com/in/1" }];
		const t = setup([], {}, { enabled: false, rooms });
		const view = await t.run(() => t.svc.start("jandi"));
		expect(view.state).toBe("done");
		expect(t.browserCalls).toEqual([]);
		expect(savedConfig(t.dir).enabled).toBe(true);
	});
});

describe("after a failure, and what the owner must answer", () => {
	test("a failed room check starts over from the login on restart or continue, instead of asking for a token it no longer has", async () => {
		for (const again of ["start", "continue"] as const) {
			const t = setup([cookie(), cookie()], { noBot: true });
			await t.run(() => t.svc.start("jandi"));
			expect((await t.run(() => t.svc.continue("jandi"))).state).toBe("failed");
			let view = await t.run(() => t.svc[again]("jandi"));
			if (view.step?.id === "notice") view = await t.run(() => t.svc.continue("jandi"));
			expect(view.error ?? "").not.toBe(msg().connect.jandi.noToken);
			expect(t.browserCalls.filter(c => c.action === "login-capture")).toHaveLength(2);
		}
	});

	test("the notice and the team question are marked manual, so the web's auto continue never answers for the owner", async () => {
		const t = setup([cookie()], { teams: [{ teamId: 11, memberId: 21, teamName: "Alpha" }, { teamId: 12, memberId: 22, teamName: "Beta" }] });
		expect((await t.run(() => t.svc.start("jandi"))).manual).toBe(true);
		const team = await t.run(() => t.svc.continue("jandi"));
		expect(team.step?.id).toBe("team");
		expect(team.manual).toBe(true);
		expect((await t.run(() => t.svc.continue("jandi", { choice: "12" }))).manual).toBeUndefined();
	});

	test("the login wait is not manual: the owner's login moves it on", async () => {
		const t = setup([{ ok: true, waiting: "login" }]);
		await t.run(() => t.svc.start("jandi"));
		expect((await t.run(() => t.svc.continue("jandi"))).manual).toBeUndefined();
	});
});
