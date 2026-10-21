// Custom plugins (hub/plugins.ts): the loader, the four hooks and the failure policy, with a neutral fixture plugin written to a throwaway data dir.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins, pluginClaim, pluginDeny, pluginThread, startPlugins, type PluginContext } from "./plugins.ts";
import { inboxText } from "./intake.ts";

const data = mkdtempSync(join(tmpdir(), "dotz-plugins-"));
const dir = join(data, "custom", "plugins");
const logs: string[] = [];
const started: string[] = [];

const FIXTURE = `export default {
	name: "fixture",
	start(ctx) { ctx.ensureWatch({ name: "fixture-watch", command: "true" }); ctx.log("fixture started"); },
	claim(id) {
		if (id === "raw-channel") return { raw: m => globalThis.__fixtureRaw?.push(m.content) };
		if (id.startsWith("topic-")) return { thread: "topic " + id, parent: "parent-channel" };
	},
	thread({ thread, text }) {
		if (!thread.startsWith("topic-")) return undefined;
		return { parentName: "Fixtures", note: "[fixture note] " + text.toUpperCase() };
	},
	deny(command) { if (/\\bfixture-send\\b/.test(command)) return "fixture-send needs an OK first"; },
};
`;

beforeAll(async () => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "10-fixture.ts"), FIXTURE);
	writeFileSync(join(dir, "20-throws-on-load.ts"), `throw new Error("boom on load");\n`);
	writeFileSync(join(dir, "30-not-a-plugin.js"), `export default 42;\n`);
	writeFileSync(join(dir, "40-throws-in-hooks.ts"), `export default { start() { throw new Error("no start"); }, claim() { throw new Error("no claim"); }, thread() { throw new Error("no thread"); }, deny() { throw new Error("no deny"); } };\n`);
	writeFileSync(join(dir, "10-fixture.test.ts"), `throw new Error("a plugin's own test is not a plugin");\n`);
	writeFileSync(join(dir, "types.d.ts"), `export {};\n`);
	await loadPlugins(data, line => logs.push(line));
});
afterAll(async () => {
	await loadPlugins(join(data, "none"));
});

const ctx: PluginContext = {
	dataDir: data,
	log: line => logs.push(line),
	postTo: async () => undefined,
	ack: () => undefined,
	ensureWatch: spec => void started.push(String(spec.name)),
	approveWatch: () => undefined,
};

test("loads *.ts and *.js plugins in name order; a plugin that fails to load, is not an object, or is a test/type file is skipped and logged", () => {
	expect(logs.find(l => l.startsWith("plugins:"))).toBe("plugins: fixture, 40-throws-in-hooks");
	expect(logs.some(l => l.includes("20-throws-on-load.ts not loaded") && l.includes("boom on load"))).toBe(true);
	expect(logs.some(l => l.includes("30-not-a-plugin.js not loaded"))).toBe(true);
	expect(logs.some(l => l.includes("test.ts") || l.includes("types.d.ts"))).toBe(false);
});

test("the claim hook answers for its channels; a throwing sibling plugin is logged, not fatal", () => {
	const raw = pluginClaim("raw-channel");
	expect(raw && "raw" in raw).toBe(true);
	expect(pluginClaim("topic-1")).toEqual({ thread: "topic topic-1", parent: "parent-channel" });
	expect(pluginClaim("other")).toBeUndefined();
	expect(logs.some(l => l.includes("plugin 40-throws-in-hooks: claim failed"))).toBe(true);
});

test("the thread hook's note reaches the orchestrator's inbox turn; its parent name replaces the parent's", () => {
	const reply = pluginThread({ thread: "topic-1", text: "hello" });
	expect(reply).toEqual({ parentName: "Fixtures", note: "[fixture note] HELLO" });
	expect(pluginThread({ thread: "plain", text: "hello" })).toBeUndefined();
	const text = inboxText({ channel: "th:topic-1", thread_name: "t", parent_name: reply!.parentName, text: "hello", plugin_note: reply!.note });
	expect(text).toContain("Fixtures");
	expect(text.split("\n")).toContain("[fixture note] HELLO");
	expect(inboxText({ channel: "th:plain", text: "hello" })).not.toContain("[fixture note]");
});

test("the deny hook blocks with the plugin's reason; other commands pass", () => {
	expect(pluginDeny("run fixture-send now", data)).toBe("Blocked by dotz (custom plugin fixture): fixture-send needs an OK first.");
	expect(pluginDeny("ls", data)).toBeUndefined();
});

test("the Claude deny hook process loads the plugins too", async () => {
	const hook = join(import.meta.dir, "runtime", "claude-deny-hook.ts");
	const run = async (command: string) => {
		const p = Bun.spawn(["bun", hook], { env: { ...process.env, DOTZ_DIR: data }, stdin: new Blob([JSON.stringify({ tool_name: "Bash", tool_input: { command } })]), stdout: "pipe", stderr: "pipe" });
		const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
		return { err, code };
	};
	const blocked = await run("fixture-send --now");
	expect(blocked.code).toBe(2);
	expect(blocked.err).toContain("fixture-send needs an OK first");
	expect((await run("echo ok")).code).toBe(0);
});

test("start runs once with the context; a plugin whose start throws is dropped, the others stay", () => {
	startPlugins(ctx);
	expect(started).toEqual(["fixture-watch"]);
	expect(logs.some(l => l.includes("plugin 40-throws-in-hooks: start failed, skipped"))).toBe(true);
	logs.length = 0;
	expect(pluginClaim("topic-2")).toBeDefined();
	expect(logs).toEqual([]);
});
