import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import dotz from "./index.ts";

type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };

const HUB_TOKEN = "hub-token-value-never-printed";
const TYPED_VALUE = "correct-horse-battery-staple";
const ENV_KEYS = ["DOTZ_ALLOW_LIVE", "DOTZ_ORCHESTRATOR", "DOTZ_RUNTIME", "DOTZ_PORT"];

let saved: Record<string, string | undefined>;
let server: Server<unknown>;
let posted: string[];
let answer: Record<string, unknown>;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	const data = process.env.DOTZ_DIR!;
	mkdirSync(join(data, "secrets"), { recursive: true });
	writeFileSync(join(data, "secrets", "hub-token"), HUB_TOKEN);
	posted = [];
	answer = { status: "entered", path: join(data, "secrets", "example.json") };
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			if (request.method === "POST") {
				posted.push(await request.text());
				return Response.json({ id: "a1" });
			}
			return Response.json(answer);
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

test("dotz_auth never carries the value the owner types: the request holds no value and the answer is a path and a pipe, so omp's secret redaction has nothing to change in the flow", async () => {
	const tool = await authTool();
	const secret = (await tool.execute("c1", { site: "example.com", kind: "secret", fields: ["username", "password"], purpose: "sign in" })).content[0]!.text;
	expect(secret).toContain("secrets-cli.ts get example.json");
	expect(secret).not.toContain(TYPED_VALUE);
	answer = { status: "entered", take: "/api/auth/a1/take" };
	const otp = (await tool.execute("c2", { site: "example.com", kind: "otp", purpose: "second factor" })).content[0]!.text;
	expect(otp).toContain('$(cat ');
	expect(otp).toContain("/api/auth/a1/take");
	expect(otp).not.toContain(HUB_TOKEN);
	expect(posted).toHaveLength(2);
	for (const body of posted) {
		expect(body).not.toContain(TYPED_VALUE);
		expect(Object.keys(JSON.parse(body)).sort()).toEqual(expect.arrayContaining(["site", "kind", "purpose"]));
	}
});
