import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, DATA_DIR, HUB_TOKEN, paths, updateModels } from "./config.ts";
import { emit, tailEvents } from "./events.ts";
import type { MailDeps } from "./mail.ts";
import { AGENT_AUTHOR } from "./entry-check.ts";
import { activeGrant, noteModelChange, readModelPicks } from "./model-guard.ts";
import { makeRoute } from "./routes.ts";
import { routeSettings } from "./routes-settings.ts";

// An agent process holds the hub token. A model or thinking change it asks for needs an owner message that says so; the owner's own paths stay open.
// Time is the fake clock of the test preload (Date.now() is fixed), so message ages and grant expiry are exact.
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailDeps: () => ({}) as MailDeps });
const GRANTS = join(DATA_DIR, "state", "expensive-grants.json");
const PICKS = join(DATA_DIR, "state", "model-picks.json");
const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const FABLE = "anthropic/claude-fable-5-2";
const HOUR = 3_600_000;

const asAgent = (method: string, path: string, body: unknown) =>
	route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }));
// The owner's web page sends no token; routeSettings is the part of the chain behind the owner check.
const asOwner = async (method: string, path: string, body: unknown) => {
	const url = new URL(`http://hub.test${path}`);
	return (await routeSettings(new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url, url.pathname.split("/").filter(Boolean)))!;
};
let n = 0;
const say = (text: string, extra: Record<string, unknown> = {}, ageMs = 0): string => {
	const mid = `mid-${++n}`;
	emit("inbox", { ts: new Date(Date.now() - ageMs).toISOString(), kind: "message", source: "web", mid, text, ...extra });
	return mid;
};
const stored = () => JSON.parse(readFileSync(CONFIG_FILE, "utf8")).models.orchestrator as { model: string; thinking: string };
const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});

beforeEach(() => {
	updateModels("orchestrator", { model: "anthropic/test-orch", thinking: "low" });
	rmSync(GRANTS, { force: true });
	rmSync(PICKS, { force: true });
});

describe("I1: a model change by an agent names an owner message", () => {
	test("token without owner_message is refused and nothing is stored", async () => {
		const r = await asAgent("PUT", "/api/models", { target: "orchestrator", model: OPUS });
		expect(r.status).toBe(403);
		expect(stored().model).toBe("anthropic/test-orch");
	});

	test("token with an id that is in no inbox is refused", async () => {
		const r = await asAgent("PUT", "/api/models", { target: "orchestrator", model: OPUS, owner_message: "no-such-message" });
		expect(r.status).toBe(403);
		expect(stored().model).toBe("anthropic/test-orch");
	});

	test("token with an owner message that names the model is accepted and stored", async () => {
		const mid = say("메인 모델을 오퍼스로 바꿔줘");
		const r = await asAgent("PUT", "/api/models", { target: "orchestrator", model: OPUS, owner_message: mid });
		expect(r.status).toBe(200);
		expect(stored().model).toBe(OPUS);
	});

	test("message_id of a Discord message works like mid", async () => {
		emit("inbox", { ts: new Date(Date.now()).toISOString(), kind: "message", source: "discord", message_id: "dc-77", text: "use sonnet please" });
		const r = await asAgent("PUT", "/api/models", { target: "orchestrator", model: SONNET, owner_message: "dc-77" });
		expect(r.status).toBe(200);
		expect(stored().model).toBe(SONNET);
	});

	test("owner without a token needs no owner_message", async () => {
		const r = await asOwner("PUT", "/api/models", { target: "orchestrator", model: SONNET });
		expect(r.status).toBe(200);
		expect(stored().model).toBe(SONNET);
	});

	test("a thinking change needs the level named in the message", async () => {
		const wrong = await asAgent("PUT", "/api/models", { target: "orchestrator", thinking: "high", owner_message: say("opus로 바꿔줘") });
		expect(wrong.status).toBe(403);
		expect(stored().thinking).toBe("low");
		const right = await asAgent("PUT", "/api/models", { target: "orchestrator", thinking: "high", owner_message: say("thinking high로 올려줘") });
		expect(right.status).toBe(200);
		expect(stored().thinking).toBe("high");
	});

	describe("a message that does not count", () => {
		const refused = async (mid: string) => {
			const r = await asAgent("PUT", "/api/models", { target: "orchestrator", model: OPUS, owner_message: mid });
			expect(r.status).toBe(403);
			expect(stored().model).toBe("anthropic/test-orch");
		};
		test("it names another model", () => refused(say("sonnet으로 바꿔줘")));
		test("it is older than 24 hours", () => refused(say("opus로 바꿔줘", {}, 25 * HOUR)));
		test("it is from the gateway", () => refused(say("opus로 바꿔줘", { source: "gateway" })));
		test("it came from a peer gateway", () => refused(say("opus로 바꿔줘", { via: "other-box" })));
		test("it is not a message event", () => refused(say("opus로 바꿔줘", { kind: "read" })));
	});

	test("a lane target takes only a message of that lane", async () => {
		const body = (mid: string) => ({ target: "lane:alpha", worker_model: SONNET, by: "lane", owner_message: mid });
		const main = await asAgent("PUT", "/api/target", body(say("워커는 소넷으로")));
		expect(main.status).toBe(403);
		const other = await asAgent("PUT", "/api/target", body(say("워커는 소넷으로", { kind: "lane_message", lane: "beta" })));
		expect(other.status).toBe(403);
	});

	test("lane-cli shape (by lane) without owner_message is refused", async () => {
		const r = await asAgent("PUT", "/api/target", { target: "lane:alpha", worker_model: SONNET, by: "lane" });
		expect(r.status).toBe(403);
	});

	test("PUT /api/target changes main only with an owner message", async () => {
		const bare = await asAgent("PUT", "/api/target", { target: "main", model: OPUS });
		expect(bare.status).toBe(403);
		expect(stored().model).toBe("anthropic/test-orch");
		const r = await asAgent("PUT", "/api/target", { target: "main", model: OPUS, owner_message: say("메인은 opus로") });
		expect(r.status).toBe(200);
		expect(stored().model).toBe(OPUS);
	});

	test("/model and /effort by command follow the same rule", async () => {
		const bare = await asAgent("POST", "/api/command", { text: `/model orchestrator ${OPUS}` });
		expect(bare.status).toBe(403);
		const level = await asAgent("POST", "/api/command", { text: "/effort orchestrator high" });
		expect(level.status).toBe(403);
		expect(stored()).toEqual({ model: "anthropic/test-orch", thinking: "low" });
		const ok = await asAgent("POST", "/api/command", { text: `/model orchestrator ${OPUS}`, owner_message: say("opus 써줘") });
		expect(ok.status).toBe(200);
		expect(stored().model).toBe(OPUS);
	});

	test("a message an agent posts itself with the token never counts as the owner's", async () => {
		const posted = await asAgent("POST", "/api/message", { text: "메인 모델을 오퍼스로 바꿔줘 (self-posted)" });
		expect(posted.status).toBe(200);
		const e = tailEvents(paths.inbox).findLast(x => String(x.text ?? "").includes("(self-posted)"));
		expect(e?.author).toBe(AGENT_AUTHOR);
		const mid = String(e?.mid ?? e?.message_id ?? "");
		expect(mid).not.toBe("");
		const r = await asAgent("PUT", "/api/models", { target: "orchestrator", model: OPUS, owner_message: mid });
		expect(r.status).toBe(403);
		expect(stored().model).toBe("anthropic/test-orch");
	});

	test("inherit (a conversation back on main's model) by the token needs an owner message too", async () => {
		const r = await asAgent("PUT", "/api/target", { target: "ch:42", inherit: true });
		expect(r.status).toBe(403);
	});

	test("viewing and the fallback chain stay open to the token", async () => {
		expect((await asAgent("POST", "/api/command", { text: "/effort orchestrator" })).status).toBe(200);
		expect((await asAgent("PUT", "/api/models", { target: "orchestrator", fallback: [] })).status).toBe(200);
	});
});

describe("I3: expensive-model grants held by the gateway", () => {
	test("/fable-ok typed by the owner grants the conversation it was typed in, and the file keeps it", async () => {
		const r = await asOwner("POST", "/api/command", { text: "/fable-ok", from: "ch:7" });
		expect(r.status).toBe(200);
		const file = readJson(GRANTS) as Record<string, { until: string; by: string }>;
		expect(Object.keys(file)).toEqual(["ch:7"]);
		expect(file["ch:7"].by).toBe("owner");
		expect(Date.parse(file["ch:7"].until)).toBeGreaterThan(Date.now());
		expect(activeGrant("ch:7")?.by).toBe("owner");
		expect(activeGrant("ch:8")).toBeUndefined();
		expect(activeGrant("main")).toBeUndefined();
	});

	test("an expired grant reads as none and is dropped on the next write", async () => {
		const stale = { until: new Date(Date.now() - 1000).toISOString(), by: "owner" };
		const live = { until: new Date(Date.now() + HOUR).toISOString(), by: "owner" };
		await asOwner("POST", "/api/expensive-grant", { conversation: "main" });
		const seeded = readJson(GRANTS) as Record<string, unknown>;
		writeFileSync(GRANTS, JSON.stringify({ ...seeded, "lane:old": stale, "lane:live": live }));
		expect(activeGrant("lane:old")).toBeUndefined();
		expect(activeGrant("lane:live")?.by).toBe("owner");
		expect(activeGrant("lane:live", Date.now() + 2 * HOUR)).toBeUndefined();
		await asOwner("POST", "/api/expensive-grant", { conversation: "ch:3" });
		expect(Object.keys(readJson(GRANTS)).sort()).toEqual(["ch:3", "lane:live", "main"]);
	});

	test("an agent with the token needs an owner message that names an expensive model", async () => {
		const bare = await asAgent("POST", "/api/expensive-grant", { conversation: "main" });
		expect(bare.status).toBe(403);
		const offTopic = await asAgent("POST", "/api/expensive-grant", { conversation: "main", owner_message: say("opus로 해줘") });
		expect(offTopic.status).toBe(403);
		expect(activeGrant("main")).toBeUndefined();
		const mid = say("이번 검수는 페이블로 돌려줘");
		const ok = await asAgent("POST", "/api/expensive-grant", { conversation: "main", owner_message: mid });
		expect(ok.status).toBe(200);
		expect(activeGrant("main")?.by).toBe(`owner-message:${mid}`);
	});

	test("/fable-ok through the command route by the token is refused without an owner message", async () => {
		const r = await asAgent("POST", "/api/command", { text: "/fable-ok", from: "ch:7" });
		expect(r.status).toBe(403);
		expect(activeGrant("ch:7")).toBeUndefined();
	});
});

describe("I6: every model change is logged and recorded with who made it", () => {
	test("the owner's change is recorded as owner and logged", async () => {
		await asOwner("PUT", "/api/models", { target: "orchestrator", model: SONNET, thinking: "high" });
		const pick = readModelPicks().orchestrator;
		expect(pick).toMatchObject({ model: SONNET, thinking: "high", by: "owner" });
		expect(Number.isNaN(Date.parse(pick.at))).toBe(false);
		expect(readJson(PICKS).orchestrator.by).toBe("owner");
		expect(readFileSync(paths.log, "utf8")).toContain(`model change: orchestrator anthropic/test-orch:low -> ${SONNET}:high by owner`);
	});

	test("a change by an agent records the owner message it stands on", async () => {
		const mid = say("opus로 바꿔");
		await asAgent("PUT", "/api/models", { target: "orchestrator", model: OPUS, owner_message: mid });
		const pick = readJson(PICKS).orchestrator;
		expect(pick).toMatchObject({ model: OPUS, by: `owner-message:${mid}` });
		expect(pick.evidence).toContain("opus");
		expect(readFileSync(paths.log, "utf8")).toContain(`by owner-message:${mid}`);
	});

	test("a limit fallback switch is recorded as fallback in the same format", () => {
		noteModelChange("orchestrator", "a/one:high", "b/two:high", "fallback");
		expect(readModelPicks().orchestrator).toMatchObject({ model: "b/two", thinking: "high", by: "fallback" });
		expect(readFileSync(paths.log, "utf8")).toContain("model change: orchestrator a/one:high -> b/two:high by fallback");
	});
});
