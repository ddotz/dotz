import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, realSetTimeout } from "../hub/runtime/test-clock.ts";
import { type ConnectTarget, type ConnectUI, connectAll, gatewayUp, type OwnerStep, switchAccess } from "./connect.ts";

const TOKEN = "hub-secret-token";
const OWNER: OwnerStep = { label: "Discord 승인", hint: "열린 창에서 승인한 뒤 계속을 눌러 주세요." };
const CHOICES = [{ id: "g1", label: "내 서버" }, { id: "g2", label: "다른 서버" }];

type View = { state: string; step?: { id: string; title: string; detail: string } | null; owner?: OwnerStep | null; error?: string | null; url?: string | null; choices?: { id: string; label: string }[] };
const view = (state: string, extra: Partial<View> = {}): View => ({ state, step: null, owner: null, error: null, url: null, ...extra });
const running = (title: string): View => view("running", { step: { id: "s", title, detail: `${title} 중이에요` } });
const waiting = (choices?: View["choices"]): View => view("waiting", { owner: OWNER, ...(choices ? { choices } : {}) });

type Queue = { start: View[]; poll: View[]; cont: View[] };
type Call = { method: string; path: string; body: unknown };

const calls: Call[] = [];
const queues = new Map<string, Queue>();
let forbid = false;
let server: ReturnType<typeof Bun.serve>;
let dir: string;

const next = (list: View[]): View => (list.length > 1 ? list.shift()! : list[0]!);

function engine(key: string, queue: Partial<Queue>): void {
	queues.set(key, { start: [view("idle")], poll: [view("idle")], cont: [view("idle")], ...queue });
}

async function handle(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const text = await req.text();
	calls.push({ method: req.method, path: url.pathname, body: text ? JSON.parse(text) : undefined });
	if (forbid || req.headers.get("x-dotz-token") !== TOKEN) return Response.json({ error: "forbidden" }, { status: 403 });
	const parts = url.pathname.split("/").filter(Boolean);
	if (url.pathname === "/api/web-access/onboard" && req.method === "POST") return Response.json(next(queues.get("web-access")!.start));
	if (url.pathname === "/api/web-access" && req.method === "PUT") return Response.json({ mode: "tailscale" });
	if (parts[0] === "api" && parts[1] === "onboarding" && queues.has(parts[2]!)) {
		const queue = queues.get(parts[2]!)!;
		if (parts[3] === "start" && req.method === "POST") return Response.json(next(queue.start));
		if (parts[3] === "continue" && req.method === "POST") return Response.json(next(queue.cont));
		if (parts.length === 3 && req.method === "GET") return Response.json(next(queue.poll));
	}
	return Response.json({ error: "not found" }, { status: 404 });
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-connect-"));
	mkdirSync(join(dir, "secrets"));
	writeFileSync(join(dir, "secrets", "hub-token"), `${TOKEN}\n`);
	server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
});
afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

async function settle<T>(work: Promise<T>): Promise<T> {
	let finished = false;
	const tracked = work.finally(() => void (finished = true));
	while (!finished) {
		await advance(1000);
		await new Promise<void>(r => realSetTimeout(r, 2));
	}
	return tracked;
}

type Events = string[];
function ui(events: Events, script: { waiting?: ("continue" | "later" | string)[]; failed?: ("retry" | "later")[] } = {}): ConnectUI {
	const answers = [...(script.waiting ?? [])];
	const failures = [...(script.failed ?? [])];
	return {
		step: (t, title, detail) => void events.push(`step ${t} ${title}|${detail}`),
		waiting: async (t, owner, choices) => {
			events.push(`waiting ${t} ${owner.label}${choices ? ` [${choices.map(c => c.id)}]` : ""}`);
			const a = answers.shift() ?? "continue";
			if (a === "later") return { action: "later" };
			return a === "continue" ? { action: "continue" } : { action: "continue", choice: a };
		},
		done: (t, url) => void events.push(`done ${t} ${url ?? ""}`),
		failed: async (t, error, owner) => {
			events.push(`failed ${t} ${error}${owner ? ` @${owner.label}` : ""}`);
			return failures.shift() ?? "later";
		},
	};
}

const run = (targets: ConnectTarget[], events: Events, script?: Parameters<typeof ui>[1], extra: { hostname?: string } = {}) => {
	calls.length = 0;
	return settle(connectAll({ dir, port: server.port!, targets, ui: ui(events, script), pollMs: 1, ...extra }));
};
const seen = (): string[] => calls.map(c => `${c.method} ${c.path}`);

describe("connectAll", () => {
	test("start, running, waiting with choices, continue with the picked choice, done with the url", async () => {
		engine("discord", { start: [running("봇 만들기")], poll: [running("봇 초대"), waiting(CHOICES)], cont: [view("done", { url: "https://discord.com/channels/1" })] });
		const events: Events = [];
		const result = await run(["discord"], events, { waiting: ["g2"] });
		expect(result.discord).toBe("done");
		expect(seen()).toEqual(["POST /api/onboarding/discord/start", "GET /api/onboarding/discord", "GET /api/onboarding/discord", "POST /api/onboarding/discord/continue"]);
		expect(calls.at(-1)!.body).toEqual({ choice: "g2" });
		expect(events).toEqual(["step discord 봇 만들기|봇 만들기 중이에요", "step discord 봇 초대|봇 초대 중이에요", "waiting discord Discord 승인 [g1,g2]", "done discord https://discord.com/channels/1"]);
	});

	test("a continue without a choice sends an empty body, not a choice", async () => {
		engine("slack", { start: [waiting()], cont: [view("done")] });
		const events: Events = [];
		await run(["slack"], events);
		expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/onboarding/slack/continue", body: {} });
		expect(events.at(-1)).toBe("done slack ");
	});

	test("a failed flow shows its error and owner step, retry starts it again, then it can finish", async () => {
		engine("telegram", { start: [view("failed", { error: "토큰이 거절됐어요", owner: OWNER }), view("done", { url: "https://t.me/bot" })] });
		const events: Events = [];
		const result = await run(["telegram"], events, { failed: ["retry"] });
		expect(result.telegram).toBe("done");
		expect(seen()).toEqual(["POST /api/onboarding/telegram/start", "POST /api/onboarding/telegram/start"]);
		expect(events).toEqual(["failed telegram 토큰이 거절됐어요 @Discord 승인", "done telegram https://t.me/bot"]);
	});

	test("choosing later on a failure is later, not failed, and sends nothing more", async () => {
		engine("jandi", { start: [view("failed", { error: "연결 실패" })] });
		const result = await run(["jandi"], [], { failed: ["later"] });
		expect(result.jandi).toBe("later");
		expect(seen()).toEqual(["POST /api/onboarding/jandi/start"]);
	});

	test("later leaves the flow waiting on the gateway (no continue) and the next target still runs", async () => {
		engine("discord", { start: [waiting(CHOICES)] });
		engine("slack", { start: [view("done", { url: "https://slack.example" })] });
		const events: Events = [];
		const result = await run(["discord", "slack"], events, { waiting: ["later"] });
		expect([result.discord, result.slack, result.telegram]).toEqual(["later", "done", "later"]);
		expect(seen()).toEqual(["POST /api/onboarding/discord/start", "POST /api/onboarding/slack/start"]);
	});

	test("a 403 is failed with a plain Korean reason and the engine is not asked again", async () => {
		engine("discord", { start: [view("done")] });
		forbid = true;
		const events: Events = [];
		const result = await run(["discord"], events);
		forbid = false;
		expect(result.discord).toBe("failed");
		expect(seen()).toEqual(["POST /api/onboarding/discord/start"]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatch(/^failed discord 게이트웨이가 이 요청을 받아주지 않아요/);
	});

	test("an unreachable gateway is failed", async () => {
		const events: Events = [];
		const result = await settle(connectAll({ dir, port: 1, targets: ["discord"], ui: ui(events), pollMs: 1 }));
		expect(result.discord).toBe("failed");
		expect(events[0]).toMatch(/^failed discord 게이트웨이에 연결하지 못했어요/);
	});

	test("a wrong token file is refused by the gateway and reported as failed", async () => {
		const other = mkdtempSync(join(tmpdir(), "dotz-connect-bad-"));
		mkdirSync(join(other, "secrets"));
		writeFileSync(join(other, "secrets", "hub-token"), "not-the-token");
		engine("discord", { start: [view("done")] });
		const result = await settle(connectAll({ dir: other, port: server.port!, targets: ["discord"], ui: ui([]), pollMs: 1 }));
		rmSync(other, { recursive: true, force: true });
		expect(result.discord).toBe("failed");
	});

	test("web-access starts at /api/web-access/onboard with the hostname, then polls and continues on the onboarding routes", async () => {
		engine("web-access", { start: [running("터널 준비")], poll: [waiting()], cont: [view("done", { url: "https://dotz.example.com" })] });
		const events: Events = [];
		const result = await run(["web-access"], events, undefined, { hostname: "dotz.example.com" });
		expect(result["web-access"]).toBe("done");
		expect(seen()).toEqual(["POST /api/web-access/onboard", "GET /api/onboarding/web-access", "POST /api/onboarding/web-access/continue"]);
		expect(calls[0]!.body).toEqual({ mode: "cloudflare", hostname: "dotz.example.com" });
		expect(events.at(-1)).toBe("done web-access https://dotz.example.com");
	});

	test("web-access without a hostname sends no hostname key", async () => {
		engine("web-access", { start: [view("done")] });
		await run(["web-access"], []);
		expect(calls[0]!.body).toEqual({ mode: "cloudflare" });
	});

	test("a retry of web-access goes through the onboard route again, with the hostname", async () => {
		engine("web-access", { start: [view("failed", { error: "x" }), view("done")] });
		await run(["web-access"], [], { failed: ["retry"] }, { hostname: "dotz.example.com" });
		expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(["POST /api/web-access/onboard", "POST /api/web-access/onboard"]);
		expect(calls[1]!.body).toEqual({ mode: "cloudflare", hostname: "dotz.example.com" });
	});
});

describe("switchAccess", () => {
	test("tailscale is a PUT of the mode, local goes through the onboard route", async () => {
		engine("web-access", { start: [view("done")] });
		calls.length = 0;
		expect(await switchAccess({ dir, port: server.port!, mode: "tailscale" })).toEqual({ ok: true });
		expect(await switchAccess({ dir, port: server.port!, mode: "local" })).toEqual({ ok: true });
		expect(calls.map(c => `${c.method} ${c.path} ${JSON.stringify(c.body)}`)).toEqual(['PUT /api/web-access {"mode":"tailscale"}', 'POST /api/web-access/onboard {"mode":"local"}']);
	});

	test("a refusal comes back as ok false with a reason", async () => {
		forbid = true;
		const r = await switchAccess({ dir, port: server.port!, mode: "tailscale" });
		forbid = false;
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/받아주지 않아요/);
	});
});

describe("gatewayUp", () => {
	const answer = (status: number): Response => new Response("{}", { status });

	test("asks GET /api/peer-info on the given port", async () => {
		const urls: string[] = [];
		const ok = await settle(gatewayUp({ port: 7420, seconds: 1, fetch: (async (input: RequestInfo | URL) => (urls.push(String(input)), answer(200))) as typeof fetch }));
		expect([ok, urls]).toEqual([true, ["http://127.0.0.1:7420/api/peer-info"]]);
	});

	test("keeps trying until the gateway answers within the time", async () => {
		let tries = 0;
		const flaky = (async () => {
			if (++tries < 3) throw new Error("ECONNREFUSED");
			return answer(200);
		}) as unknown as typeof fetch;
		expect(await settle(gatewayUp({ port: 7420, seconds: 5, fetch: flaky }))).toBe(true);
		expect(tries).toBe(3);
	});

	test("is false when it never answers ok", async () => {
		expect(await settle(gatewayUp({ port: 7420, seconds: 0, fetch: (async () => answer(503)) as unknown as typeof fetch }))).toBe(false);
	});
});
