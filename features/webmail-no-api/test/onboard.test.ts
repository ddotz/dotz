import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpec, paths, type Ctx } from "../lib/config.ts";
import { loadOnboard, runOnboard, type Io, type LoginResult } from "../lib/onboard.ts";
import { cardFile, personalFeatureFile } from "../bin/setup.ts";
import { card } from "../bin/card.ts";
import type { CapturedRequest } from "../lib/capture.ts";
import { startFakeServer, mkMail } from "./fakeserver.ts";

const prevDir = process.env.DOTZ_DIR;
beforeAll(() => {
	process.env.DOTZ_DIR = mkdtempSync(join(tmpdir(), "wm-onboard-"));
});
afterAll(() => {
	process.env.DOTZ_DIR = prevDir;
});

// A recording the way the live recorder returns it: the list call, and (when a mail was opened) its read call.
async function recordFrom(srv: ReturnType<typeof startFakeServer>, withRead: boolean): Promise<CapturedRequest[]> {
	const get = async (path: string): Promise<CapturedRequest> => {
		const r = await fetch(srv.origin + path, { headers: { cookie: "session=good" } });
		return { url: srv.origin + path, method: "GET", status: r.status, contentType: r.headers.get("content-type") ?? "", responseBody: await r.text() };
	};
	const out = [await get("/mail/mboxes/100/mails")];
	if (withRead) out.push(await get("/mail/mails/2"));
	return out;
}

type Calls = { loginState: number; login: boolean[]; record: number; gateway: { method: string; path: string; body: any }[]; progress: string[] };

function fakeIo(srv: ReturnType<typeof startFakeServer>, over: Partial<Io> & { loginResults?: LoginResult[]; recordings?: (() => Promise<CapturedRequest[]>)[] } = {}): { io: Io; calls: Calls } {
	const calls: Calls = { loginState: 0, login: [], record: 0, gateway: [], progress: [] };
	const ctx: Ctx = { fetch: (...a) => fetch(...a), cookieHeader: srv.cookieHeader, now: () => 1_700_000_000_000, sleep: async () => {}, log: () => {} };
	const io: Io = {
		ctx,
		mailElsewhere: () => undefined,
		asideReady: async () => true,
		loginState: async () => {
			calls.loginState++;
			return "form";
		},
		login: async (_url, allow) => {
			calls.login.push(allow);
			return over.loginResults?.shift() ?? "in";
		},
		record: async () => {
			calls.record++;
			const next = over.recordings?.shift();
			return next ? next() : recordFrom(srv, true);
		},
		gateway: async (method, path, body) => {
			calls.gateway.push({ method, path, body });
			return {};
		},
		progress: async (text) => {
			calls.progress.push(text);
		},
		...over,
	};
	return { io, calls };
}

test("one request runs to the end: one batched ask, an interruption, resume, read probe, watch", async () => {
	const srv = startFakeServer([mkMail(2), mkMail(1)]);
	try {
		const site = "work";
		const { io, calls } = fakeIo(srv, {
			loginResults: ["need-2fa", "in"],
			recordings: [
				async () => {
					throw new Error("aside repl exited");
				},
				() => recordFrom(srv, false),
			],
		});

		let r = await runOnboard(io, { site, url: `${srv.origin}/mail/`, channel: "ch:123" });
		expect(r.status).toBe("waiting");
		expect(r.step).toBe("login");
		expect(r.ask).toContain("2차 인증");
		expect(calls.login).toEqual([false]);
		expect(calls.progress.at(-1)).toContain("❓");

		r = await runOnboard(io, { site, approve: true });
		expect(r.status).toBe("failed");
		expect(r.step).toBe("capture");
		expect(r.message).toContain("이어서");
		expect(loadOnboard(site)?.done).toEqual(["preflight", "login"]);

		const loginChecks = calls.loginState;
		r = await runOnboard(io, { site });
		expect(r.status).toBe("done");
		expect(calls.loginState).toBe(loginChecks);
		expect(loadSpec(site)?.read.path).toBe("/mail/mails/{id}");

		const watches = calls.gateway.filter((c) => c.path === "/api/watches");
		expect(watches).toHaveLength(1);
		expect(watches[0].body.to).toBe("orchestrator");
		expect(watches[0].body.channels).toEqual(["123"]);
		expect(readFileSync(personalFeatureFile(), "utf8")).toMatch(/^enabled: true$/m);
		expect(existsSync(cardFile(site))).toBe(true);
		expect(card(site).상태).toBe("첫 확인을 기다리는 중");
		expect(calls.progress.at(-1)).toContain("연결이 끝났어요");
		expect(calls.progress.at(-1)).not.toContain("⏳");
	} finally {
		srv.close();
	}
});

test("an install that hands mail to another computer stops at preflight", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		const { io } = fakeIo(srv, { mailElsewhere: () => "메일은 다른 컴퓨터 몫" });
		const r = await runOnboard(io, { site: "elsewhere", url: `${srv.origin}/mail/` });
		expect(r.status).toBe("failed");
		expect(r.step).toBe("preflight");
		expect(r.message).toContain("다른 컴퓨터");
	} finally {
		srv.close();
	}
});

test("a site with no JSON calls gets a clear fallback, then a HAR resumes it", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		const html: CapturedRequest = { url: `${srv.origin}/mail/`, status: 200, contentType: "text/html", responseBody: "<html>inbox</html>" };
		const { io, calls } = fakeIo(srv, { recordings: [async () => [html], async () => [html]] });
		let r = await runOnboard(io, { site: "htmlsite", url: `${srv.origin}/mail/` });
		expect(r.status).toBe("failed");
		expect(r.step).toBe("capture");
		expect(r.message).toContain("HTML");
		expect(r.message).toContain("--har");
		expect(calls.record).toBe(2);

		r = await runOnboard(io, { site: "htmlsite", har: await recordFrom(srv, true) });
		expect(r.status).toBe("done");
	} finally {
		srv.close();
	}
});

test("the first run needs the inbox URL", async () => {
	const srv = startFakeServer([]);
	try {
		const { io } = fakeIo(srv);
		const r = await runOnboard(io, { site: "nourl" });
		expect(r.status).toBe("failed");
		expect(r.message).toContain("--url");
		expect(existsSync(paths.onboard("nourl"))).toBe(false);
	} finally {
		srv.close();
	}
});
