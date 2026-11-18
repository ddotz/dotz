// Every path from a model's text to the owner's screen ends at one rule (hub/owner-text.ts). This test walks the real tree, so a new path fails here, not on the owner's screen.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths, DATA_DIR, HUB_TOKEN } from "./config.ts";
import * as discordApi from "./discord.ts";
import { loadTree, prodOf } from "./engineering-rules.ts";
import { emit, onEmit, type HubEvent } from "./events.ts";
import { dir, hooks, type Lane } from "./lanestate.ts";
import { report } from "./lanereport.ts";
import { brokenCount, ownerKind, shownEvent } from "./owner-text.ts";
import { SHOT_BULLETS, SHOT_DRAFT } from "./owner-text.fixture.ts";
import { parseDecisions } from "./choices.ts";
import { installFanout, register, unregister, type Adapter, type OutMsg } from "./messenger.ts";
import { makeRoute } from "./routes.ts";
import { flush } from "./runtime/test-clock.ts";

const prod = prodOf(loadTree(join(import.meta.dir, "..")));
const source = (path: string) => prod.find(f => f.path === path)!.text;

// The event kinds in the store. Text the owner reads as the assistant's passes ownerText; the rest is owner input, outside mail or machine records (text one
// session handed to another is kept as written, behind a fold). A new kind must be placed here.
const NOT_ASSISTANT_TEXT = ["delivery", "handed", "lane_message", "lane_start", "mail", "message", "schedule", "watch"];
// Discord writers that take no model text: the form message, a thread's or a parked lane's gateway line. send, edit and progress are what carries model text.
const DISCORD_GATEWAY_WRITERS = ["createThread", "editRich", "postRich", "postTo", "releaseLane"];
const DISCORD_OWNER_WRITERS = ["edit", "progress", "send"];
const fnBody = (text: string, name: string) => text.slice(text.search(new RegExp(`export (?:async )?function ${name}\\b`)), text.indexOf("\n}\n", text.search(new RegExp(`export (?:async )?function ${name}\\b`))));

describe("the store", () => {
	test("only emit appends to the inbox and the outbox", () => {
		const writers = prod.filter(f => f.path !== "hub/events.ts" && /(?:appendFile|appendFileSync|writeFile|writeFileSync|writeAtomic)\(\s*(?:paths\.(?:inbox|outbox)\b|box\b)/.test(f.text)).map(f => f.path);
		expect(writers).toEqual([]);
	});
	test("every event kind is either shaped or known not to be the assistant's text", () => {
		const kinds = new Set(prod.flatMap(f => [...f.text.matchAll(/\bemit\(\s*"(?:inbox|outbox)",\s*(?:outEvent\()?\{[^}\n]*?kind: "(\w+)"/g)].map(m => m[1]!)));
		const unplaced = [...kinds].filter(k => !ownerKind(k) && !NOT_ASSISTANT_TEXT.includes(k));
		expect(unplaced).toEqual([]);
	});
	test("nothing pushes a message to the page around the store", () => {
		expect(prod.filter(f => /broadcast\(\{[^}\n]*kind: "(?:out|lane_report|result)"/.test(f.text)).map(f => f.path)).toEqual([]);
	});
	test("the routes that serve stored messages shape them", async () => {
		const target = "lane:owner-text-hist", ts = "2026-11-05T08:00:00.000Z";
		appendFileSync(paths.outbox, `${JSON.stringify({ ts, kind: "lane_report", source: target, target, text: SHOT_BULLETS })}\n`);
		const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
		const get = async (query: string) => (await (await route(new Request(`http://hub.test/api/history?target=${target}${query}`, { headers: { "x-dotz-token": HUB_TOKEN } }))).json()) as { events: { text: string }[] };
		for (const query of ["", `&around=${ts}`]) {
			const { events } = await get(query);
			expect(parseDecisions(events.at(-1)!.text).blocks[0]?.options.map(o => o.label)).toEqual(["보내기", "보내지 않기"]);
		}
		expect(readFileSync(paths.outbox, "utf8")).toContain(SHOT_BULLETS.split("\n")[0]!);
	});
});

describe("Discord", () => {
	const discord = source("hub/discord.ts");
	test("every sender that writes a message is placed", () => {
		const names = [...discord.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1]!);
		const writes = names.filter(n => /\b(?:post|postWithFiles)\(|rest\("(?:POST|PATCH)", `\/channels\/\$\{\w+\}\/messages/.test(fnBody(discord, n)));
		expect(writes.filter(n => !DISCORD_OWNER_WRITERS.includes(n) && !DISCORD_GATEWAY_WRITERS.includes(n))).toEqual([]);
	});
	describe("a sender with model text", () => {
		const BROKEN = "[ask] 일이 있어요.\n\n결정: 지금 보낼까요?";
		const requests: { method: string; content: string }[] = [];
		let server: ReturnType<typeof Bun.serve>;
		const was = discordApi.status.enabled;
		beforeAll(() => {
			server = Bun.serve({ port: 0, async fetch(req) { requests.push({ method: req.method, content: (await req.json() as { content: string }).content }); return Response.json({ id: `m${requests.length}` }); } });
			process.env.DOTZ_DISCORD_API = `http://127.0.0.1:${server.port}/api/v10`;
			discordApi.status.enabled = true;
			discordApi.channels.work["333"] = "owner-text";
		});
		afterAll(() => {
			server.stop(true);
			delete process.env.DOTZ_DISCORD_API;
			delete discordApi.channels.work["333"];
			discordApi.status.enabled = was;
		});
		test.each([
			["send", () => discordApi.send("ch:333", BROKEN)],
			["edit", () => discordApi.edit("ch:333", "m0", BROKEN)],
			["progress", () => discordApi.progress("ch:333", "owner-text-key", BROKEN)],
		])("%s passes the rule before the text goes out", async (_name, call) => {
			requests.length = 0;
			expect((await call()).delivered).toBe(true);
			expect(requests).toHaveLength(1);
			expect(requests[0]!.content).toContain("지금 보낼까요?");
			expect(requests[0]!.content).not.toContain("결정:");
		});
	});
	test("no other file talks to Discord's message API", () => {
		expect(prod.filter(f => f.path !== "hub/discord.ts" && /discord(?:app)?\.com\/api[^\n]*messages/.test(f.text)).map(f => f.path)).toEqual([]);
	});
	test("the other messengers read the stored event, so a card shaped by the store reaches them as buttons", async () => {
		const got: OutMsg[] = [];
		const adapter: Adapter = { id: "owner-text-fake", label: "fake", enabled: () => true, status: { state: "ok" }, start() {}, stop() {}, canEdit: false, canButtons: false, deliver: async m => (got.push(m), { delivered: true }) };
		register(adapter);
		installFanout();
		try {
			emit("outbox", { ts: "2026-11-05T07:40:00.000Z", kind: "out", source: "orchestrator", target: "main", text: SHOT_BULLETS });
			await flush();
			expect(got.at(-1)?.options?.map(o => o.label)).toEqual(["보내기", "보내지 않기"]);
		} finally {
			unregister(adapter.id);
		}
	});
});

describe("a real send", () => {
	const seen: HubEvent[] = [];
	onEmit(e => seen.push(e));
	const lane = { name: "owner-text-test", reports: 0 } as unknown as Lane;
	const reports: string[] = [];
	const hook = hooks.report;
	hooks.report = (_l, text) => void reports.push(text);
	mkdirSync(dir(lane.name), { recursive: true });
	afterAll(() => {
		hooks.report = hook;
		rmSync(dir(lane.name), { recursive: true, force: true });
	});
	test("a path that never heard of the rule still stores the card", () => {
		emit("outbox", { ts: "2026-11-05T07:30:00.000Z", kind: "out", source: "gateway", target: "web", text: SHOT_BULLETS });
		expect(parseDecisions(seen.at(-1)!.text).blocks[0]?.options.map(o => o.label)).toEqual(["보내기", "보내지 않기"]);
		expect(readFileSync(paths.outbox, "utf8")).toContain("**1) 보내기**");
	});
	test("a lane's report without [ask] waits for the owner as an ask", () => {
		report(lane, SHOT_BULLETS);
		expect(reports.at(-1)!.startsWith("[ask]")).toBe(true);
		expect(lane.pendingAsk?.text).toBe(reports.at(-1));
	});
	test("a broken decision is counted and written down", () => {
		const before = brokenCount();
		emit("outbox", { ts: "2026-11-05T07:31:00.000Z", kind: "out", source: "lane:x", target: "lane:x", text: "[ask] 일이 있어요.\n\n결정: 지금 보낼까요?" });
		expect(brokenCount()).toBe(before + 1);
		expect(seen.at(-1)!.text).not.toContain("결정:");
		const file = join(DATA_DIR, "ask-broken.jsonl");
		expect(existsSync(file) && readFileSync(file, "utf8")).toContain("지금 보낼까요?");
	});
	test("an old stored message gets its card on the way to the page, the store stays", () => {
		const e = { ts: "1", kind: "lane_report", source: "lane:x", text: SHOT_BULLETS };
		expect(parseDecisions(shownEvent(e).text as string).blocks).toHaveLength(1);
		expect(e.text).toBe(SHOT_BULLETS);
		expect(shownEvent({ ts: "1", kind: "message", source: "web", text: SHOT_BULLETS }).text).toBe(SHOT_BULLETS);
	});
	test("the send approval from a session stays exact", () => {
		report(lane, SHOT_DRAFT);
		expect(reports.at(-1)).toBe(SHOT_DRAFT);
	});
});
