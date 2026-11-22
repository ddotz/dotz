import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import dotz from "./index.ts";

type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };

const HUB_TOKEN = "hub-token-value-never-printed";
const MAIL_CODE = "482913";
const ENV_KEYS = ["DOTZ_ALLOW_LIVE", "DOTZ_ORCHESTRATOR", "DOTZ_RUNTIME", "DOTZ_PORT"];

let saved: Record<string, string | undefined>;
let server: Server<unknown>;
let ownerRequests: Record<string, unknown>[];
let mailRequests: Record<string, unknown>[];
let mailAnswer: () => Response;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	const data = process.env.DOTZ_DIR!;
	mkdirSync(join(data, "secrets"), { recursive: true });
	writeFileSync(join(data, "secrets", "hub-token"), HUB_TOKEN);
	ownerRequests = [];
	mailRequests = [];
	mailAnswer = () => Response.json({ ok: true, id: "m1", take: "/api/auth/m1/take" });
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (request.method === "POST" && path === "/api/auth/mail-code") {
				mailRequests.push(await request.json());
				return mailAnswer();
			}
			if (request.method === "POST") {
				ownerRequests.push(await request.json());
				return Response.json({ id: "o1" });
			}
			return Response.json({ status: "entered", take: "/api/auth/o1/take" });
		},
	});
	Object.assign(process.env, { DOTZ_ALLOW_LIVE: "1", DOTZ_ORCHESTRATOR: "1", DOTZ_RUNTIME: "omo", DOTZ_PORT: String(server.port) });
});

afterEach(() => {
	void server.stop(true);
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function authTool(): Promise<Tool> {
	const tools: Tool[] = [];
	const host = new Proxy({ registerTool: (tool: Tool) => tools.push(tool) } as Record<string, unknown>, {
		get: (target, key) => (key in target ? target[key as string] : key === "then" || key === "zod" ? undefined : () => undefined),
	});
	await dotz(host);
	return tools.find(tool => tool.name === "dotz_auth")!;
}

test("a mail code found by the gateway comes back as a take command only, and the owner is not asked", async () => {
	const tool = await authTool();
	const out = (await tool.execute("c1", { site: "example.com", kind: "otp", purpose: "sign in", from_mail: "example.com", mail_account: "me@example.com", mail_minutes: 5 })).content[0]!.text;
	expect(out).toContain("/api/auth/m1/take");
	expect(out).toContain('$(cat ');
	expect(out).not.toContain(MAIL_CODE);
	expect(out).not.toContain(HUB_TOKEN);
	expect(ownerRequests).toHaveLength(0);
	expect(mailRequests).toEqual([{ site: "example.com", from: "example.com", account: "me@example.com", minutes: 5 }]);
});

test("a mail miss or an older gateway without the endpoint falls back to asking the owner, with the reason in the purpose", async () => {
	const tool = await authTool();
	mailAnswer = () => Response.json({ ok: false, reason: "not-found", detail: "받은 메일이 없어요" });
	const out = (await tool.execute("c2", { site: "example.com", kind: "otp", purpose: "sign in", from_mail: "example.com" })).content[0]!.text;
	expect(ownerRequests).toHaveLength(1);
	expect(ownerRequests[0]!.purpose).toBe("sign in (메일에서 못 찾음: 받은 메일이 없어요)");
	expect(ownerRequests[0]!.kind).toBe("otp");
	expect(out).toContain("/api/auth/o1/take");

	mailAnswer = () => Response.json({ error: "not found" }, { status: 404 });
	await tool.execute("c3", { site: "example.com", kind: "otp", purpose: "sign in", from_mail: "example.com" });
	expect(ownerRequests).toHaveLength(2);
	expect(String(ownerRequests[1]!.purpose)).toStartWith("sign in (메일에서 못 찾음: ");
});

test("an otp without from_mail asks the owner as before, and a non-otp kind never looks at mail", async () => {
	const tool = await authTool();
	await tool.execute("c4", { site: "example.com", kind: "otp", purpose: "second factor" });
	await tool.execute("c5", { site: "example.com", kind: "approve", purpose: "push", from_mail: "example.com" });
	expect(mailRequests).toHaveLength(0);
	expect(ownerRequests.map(body => body.purpose)).toEqual(["second factor", "push"]);
});
