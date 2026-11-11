// A usage limit that is over is noticed without a restart or a new login: after a 리셋권 spent here, and while a session is paused (a reset made
// elsewhere), by the usage read dotz already has. A fake `omo --mode rpc`, injected usage and sessions, throwaway state files; no sleeps.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chain, clock, resetFallbackState } from "./fallback.ts";
import { msg } from "./i18n.ts";
import { limitAlertsFile, noteBlock } from "./limit-alert.ts";
import { liftEnv, resetLiftMemory, checkUsageLimit, liftUsageLimit, scopeBlocksModels } from "./limit-lift.ts";
import { armLimitWatch, limitWatchArmed, LIMIT_WATCH_MS } from "./limit-watch.ts";
import { omoRpcCommand, omoUnblockAccount } from "./runtime/omo-login.ts";
import { advance, flush } from "./runtime/test-clock.ts";

const dir = mkdtempSync(join(tmpdir(), "dotz-limit-lift-"));
const asked = join(dir, "asked.log");
const fake = join(dir, "fake-omo.ts");
// Answers a prompt like OmO's /claude-account unblock: a notify frame, then the handled response. FAKE_ANSWER picks the notify text.
writeFileSync(fake, `import { appendFileSync } from "node:fs";
const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
for await (const line of console) {
	const c = JSON.parse(line);
	if (c.type !== "prompt") continue;
	appendFileSync(${JSON.stringify(asked)}, c.message + "\\n");
	out({ type: "extension_ui_request", id: "n", method: "notify", message: process.env.FAKE_ANSWER ?? "Unblocked Anthropic Subscription account: acct-a. The next turn may use it." });
	out({ id: c.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
}
`);
const realArgv = omoRpcCommand.argv;
const real = { ...liftEnv };
const T0 = Date.parse("2026-11-11T03:00:00Z");
let calls: string[] = [];
let told: { agent: string; text: string }[] = [];
let stateFiles: string[] = [];
let paused = true;
let usable = true;
let spentScopes: string[] = [];
let sessionModel = "anthropic-subscription/claude-main-model";
const session = { liftLimit: () => (calls.push("session lifted"), paused && ((paused = false), true)), limitPaused: () => paused, limitModel: () => sessionModel };
const realNow = clock.now;
beforeEach(() => {
	calls = [];
	told = [];
	stateFiles = [];
	rmSync(limitAlertsFile(), { force: true });
	paused = true;
	usable = true;
	spentScopes = [];
	sessionModel = "anthropic-subscription/claude-main-model";
	resetFallbackState();
	resetLiftMemory();
	clock.now = () => T0;
	writeFileSync(asked, "");
	omoRpcCommand.argv = () => [process.execPath, fake];
	delete process.env.FAKE_ANSWER;
	Object.assign(liftEnv, {
		usage: async () => (calls.push("usage read"), { account: "acct-a", omo: true, usable, spentScopes }),
		unblock: async (a: string) => (calls.push(`omo unblock ${a}`), "unblocked"),
		sessions: () => [session],
		lanes: { paused: () => 0, models: () => [], lift: () => 0 },
		refresh: (a?: string) => void calls.push(`refresh ${a}`),
		stateFiles: () => stateFiles,
		tell: (agent: string, text: string) => void told.push({ agent, text }),
	});
});
afterEach(() => {
	Object.assign(liftEnv, real);
	omoRpcCommand.argv = realArgv;
	clock.now = realNow;
	resetFallbackState();
	rmSync(limitAlertsFile(), { force: true });
});

const subscription = () => new Chain("anthropic-subscription/claude-opus-5-5", [{ model: "anthropic/claude-sonnet-5-5", when: "quota" as const }], "medium");

test("lifting clears the subscription's quota block, OmO's block, the paused session and reads the usage again, in that order", async () => {
	subscription().fail("quota", T0 + 72 * 3_600_000, T0);
	expect(subscription().down(0, T0)?.why).toBe("quota");
	await liftUsageLimit("acct-a", "test");
	expect(subscription().down(0, T0)).toBeUndefined();
	expect(calls).toEqual(["omo unblock acct-a", "session lifted", "refresh acct-a"]);
});

test("only the subscription's usage-limit block goes: an API key's quota block and an error block stay", async () => {
	const keyed = new Chain("anthropic-subscription/claude-opus-5-5", [{ model: "openai/gpt-5", key_file: "k-a", when: "quota" as const }], "medium");
	keyed.active = 1;
	keyed.fail("quota", T0 + 3_600_000, T0);
	const sub = subscription();
	sub.fail("error", T0 + 600_000, T0);
	await liftUsageLimit(undefined, "test");
	expect(keyed.down(1, T0)?.why).toBe("quota");
	expect(sub.down(0, T0)?.why).toBe("error");
});

test("a usage report under its limit lifts a paused session once; a try that fails anyway waits for the recorded time", async () => {
	expect(await checkUsageLimit()).toBe(true);
	expect(calls).toContain("session lifted");
	// the lifted session hit the limit again at once and is paused: not lifted a second time, however often it is asked
	paused = true;
	calls = [];
	clock.now = () => T0 + 5 * 60_000;
	for (let i = 0; i < 3; i++) expect(await checkUsageLimit()).toBe(false);
	expect(calls).toEqual([]);
	// the pause ends by its timer, a turn works; the next limit is a new episode and is lifted again
	paused = false;
	expect(await checkUsageLimit()).toBe(false);
	paused = true;
	expect(await checkUsageLimit()).toBe(true);
});

test("a window still full lifts nothing, and an unreadable usage lifts nothing", async () => {
	usable = false;
	expect(await checkUsageLimit()).toBe(false);
	liftEnv.usage = async () => undefined;
	expect(await checkUsageLimit()).toBe(false);
	expect(calls).toEqual(["usage read"]);
});

test("nothing paused: no usage read at all", async () => {
	paused = false;
	expect(await checkUsageLimit()).toBe(false);
	expect(calls).toEqual([]);
});

test("the owner's 재개 forgets the limit but leaves the session to the restart it makes itself", async () => {
	subscription().fail("quota", T0 + 72 * 3_600_000, T0);
	expect(await checkUsageLimit(false)).toBe(true);
	expect(subscription().down(0, T0)).toBeUndefined();
	expect(calls).not.toContain("session lifted");
});

test("the watch timer exists only while something is paused: armed by the pause, one usage read per tick, gone at the first tick that finds nothing", async () => {
	const { setLimitWatch } = await import("./limit-watch.ts");
	let ticks = 0;
	setLimitWatch({ paused: () => (paused ? 1 : 0), tick: async () => void ticks++ });
	expect(limitWatchArmed()).toBe(false);
	armLimitWatch();
	armLimitWatch();
	expect(limitWatchArmed()).toBe(true);
	await advance(LIMIT_WATCH_MS * 3);
	await flush();
	expect(ticks).toBe(3);
	paused = false;
	await advance(LIMIT_WATCH_MS);
	await flush();
	expect(limitWatchArmed()).toBe(false);
	expect(ticks).toBe(3);
	await advance(LIMIT_WATCH_MS * 4);
	expect(ticks).toBe(3);
	setLimitWatch(undefined);
});

test("OmO's own unblock command is sent for that account, and its answer is read", async () => {
	expect(await omoUnblockAccount("acct-a", 10_000)).toBe("unblocked");
	expect(readFileSync(asked, "utf8")).toBe("/claude-account unblock acct-a\n");
	process.env.FAKE_ANSWER = "Account acct-a has no usage block to lift.";
	expect(await omoUnblockAccount("acct-a", 10_000)).toBe("no-block");
	// a name that could carry more than a name is never sent
	writeFileSync(asked, "");
	expect(await omoUnblockAccount("acct-a; rm -rf x", 10_000)).toBe("failed");
	expect(readFileSync(asked, "utf8")).toBe("");
});

test("a model-scoped weekly window used up: no lift for a session on that model, a lift for a session on another model", async () => {
	spentScopes = ["main"];
	expect(await checkUsageLimit()).toBe(false);
	expect(calls).toEqual(["usage read"]);
	sessionModel = "anthropic-subscription/claude-other-model";
	calls = [];
	expect(await checkUsageLimit()).toBe(true);
	expect(calls).toContain("session lifted");
});

test("a spent scope with the paused session's model unreadable is never called over; a lane's models count for the lane role", async () => {
	spentScopes = ["main"];
	sessionModel = "";
	expect(await checkUsageLimit()).toBe(false);
	expect(scopeBlocksModels(["fable"], ["Anthropic/Claude-Fable-5"])).toBe(true);
	expect(scopeBlocksModels(["fable"], ["anthropic/claude-opus-5"])).toBe(false);
	expect(scopeBlocksModels(["fable"], [])).toBe(true);
	expect(scopeBlocksModels([], [])).toBe(false);
	expect(scopeBlocksModels(["claude sonnet 5.5"], ["anthropic-subscription/claude-sonnet-5-5"])).toBe(true);
	expect(scopeBlocksModels(["fable 5"], ["anthropic-subscription/claude-sonnet-5-5"])).toBe(false);
	expect(scopeBlocksModels(["claude code"], ["anthropic-subscription/claude-sonnet-5-5"])).toBe(false);
});

// The pause alert of an episode (hub/limit-alert.ts) is what makes the lift worth telling; the counts of sessions and lanes it resumed are not.
const pauseAlert = (agent = "orchestrator") => noteBlock(agent, "acct-a", "limit", T0);

test("a paused session going on after a spent reset tells the owner once, where the pause alert went, saying the reset was spent", async () => {
	expect(pauseAlert().alert).toBe(true);
	await liftUsageLimit("acct-a", "limit reset spent here", true, true);
	expect(told).toEqual([{ agent: "orchestrator", text: msg().limitLiftedReset }]);
	expect(msg().limitLiftedReset).not.toBe(msg().limitLifted);
});

test("a lift that counts nothing still tells when the pause alert is the latest word; with no pause alert it tells nothing", async () => {
	paused = false;
	await liftUsageLimit("acct-a", "limit reset spent here", true, true);
	expect(told).toEqual([]);
	pauseAlert();
	await liftUsageLimit("acct-a", "limit reset spent here", true, true);
	expect(told.map(t => t.text)).toEqual([msg().limitLiftedReset]);
});

test("the reset path and the usage-report path of one episode tell once; a later pause is a new episode and is told again", async () => {
	pauseAlert();
	await liftUsageLimit("acct-a", "limit reset spent here", true, true);
	paused = true;   // the report is read while the session is paused: the episode is already over, so it adds nothing
	expect(await checkUsageLimit()).toBe(true);
	expect(told).toHaveLength(1);
	// the lifted session paused again at once (the try failed anyway, and is not tried twice); then the pause ends and a turn works.
	// The next limit is a new episode with a new pause alert, and a new notice
	paused = true;
	expect(await checkUsageLimit()).toBe(false);
	paused = false;
	expect(await checkUsageLimit()).toBe(false);
	paused = true;
	expect(pauseAlert().alert).toBe(true);
	expect(await checkUsageLimit()).toBe(true);
	expect(told).toHaveLength(2);
	expect(told[1].text).toBe(msg().limitLifted);
});

test("the usage-report path tells too, and a lane's pause alert is answered in that lane", async () => {
	pauseAlert("lane:web-i18n");
	expect(await checkUsageLimit()).toBe(true);
	expect(told).toEqual([{ agent: "lane:web-i18n", text: msg().limitLifted }]);
});

test("a restart after an announced lift tells nothing again, and the saved usage-limit pause is gone from the state file (a billing/auth pause stays)", async () => {
	const limitFile = join(dir, "orchestrator.json");
	const ownerFile = join(dir, "conv-state.json");
	writeFileSync(limitFile, JSON.stringify({ pausedUntil: "2026-11-16T01:00:59.769Z", apiSince: "x" }));
	writeFileSync(ownerFile, JSON.stringify({ pausedUntil: "2026-11-16T01:00:59.769Z", pausedKind: "owner", pausedAuth: 5 }));
	stateFiles = [limitFile, ownerFile, join(dir, "missing.json")];
	pauseAlert();
	await liftUsageLimit("acct-a", "limit reset spent here", true, true);
	expect(JSON.parse(readFileSync(limitFile, "utf8"))).toEqual({ apiSince: "x" });
	expect(JSON.parse(readFileSync(ownerFile, "utf8")).pausedKind).toBe("owner");
	// the gateway restarts: the start check finds a paused session and lifts again, with no pause alert left
	paused = true;
	expect(await checkUsageLimit()).toBe(true);
	expect(told).toHaveLength(1);
});
