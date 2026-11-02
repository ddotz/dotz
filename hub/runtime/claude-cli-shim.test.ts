// The Claude sign-in wrapper against the output `claude auth login --claudeai` (Claude Code 2.1.316) really writes, recorded
// 2026-11-02 with a throwaway CLAUDE_CONFIG_DIR (URL shortened), and senpi 2026.10.31-2's own success test.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeShimEnv, realClaude, successLineSplitter } from "./claude-cli-shim.ts";

const BEFORE_PASTE = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=s\nPaste code here if prompted > ";
const AFTER_PASTE = "Login successful.\n";
const SENPI_SUCCESS_LINE = /^Login successful\.$/m;
const SENPI_MANUAL_URL_LINE = /If the browser didn't open, visit: (https:\/\/\S+)\r?\n/;

const dir = mkdtempSync(join(tmpdir(), "dotz-claude-shim-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the stock output fails senpi's success test, and passes it once the wrapper ends the prompt line", () => {
	expect(SENPI_SUCCESS_LINE.test(BEFORE_PASTE + AFTER_PASTE)).toBe(false);
	const split = successLineSplitter();
	const out = split(BEFORE_PASTE) + split(AFTER_PASTE);
	expect(SENPI_SUCCESS_LINE.test(out)).toBe(true);
	expect(SENPI_MANUAL_URL_LINE.exec(out)?.[1]).toBe("https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=s");
	expect(out).toBe(`${BEFORE_PASTE}\n${AFTER_PASTE}`);
});

test("output that already has the line break (browser callback, a fixed CLI) and other output pass through unchanged", () => {
	const split = successLineSplitter();
	expect(split(BEFORE_PASTE) + split(`\n${AFTER_PASTE}`)).toBe(`${BEFORE_PASTE}\n${AFTER_PASTE}`);
	expect(successLineSplitter()(`${BEFORE_PASTE}${AFTER_PASTE}`)).toBe(`${BEFORE_PASTE}\n${AFTER_PASTE}`);
	expect(successLineSplitter()("2.1.316 (Claude Code)\n")).toBe("2.1.316 (Claude Code)\n");
	expect(successLineSplitter()(AFTER_PASTE)).toBe(AFTER_PASTE);
});

test("the wrapper runs the real CLI with the same arguments, stdin and exit code", async () => {
	const fake = join(dir, "fake-claude.ts");
	const seen = join(dir, "seen.txt");
	writeFileSync(
		fake,
		`process.stdout.write(${JSON.stringify(BEFORE_PASTE)});
for await (const line of console) {
	if (process.argv.includes("--fail")) process.exit(3);
	await Bun.write(${JSON.stringify(seen)}, process.argv.slice(2).join(" ") + "|" + line);
	process.stdout.write(${JSON.stringify(AFTER_PASTE)});
	process.exit(0);
}
`,
	);
	const real = join(dir, "claude-real");
	writeFileSync(real, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`);
	chmodSync(real, 0o755);
	const env = claudeShimEnv({ CLAUDE_CODE_EXECUTABLE: real, PATH: "" }, join(dir, "agent"), join(dir, "shim"));
	expect(env.CLAUDE_CODE_EXECUTABLE).toBe(join(dir, "shim", "claude"));
	const run = async (args: string[]) => {
		const p = Bun.spawn([env.CLAUDE_CODE_EXECUTABLE!, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		p.stdin.write("code#state\n");
		await p.stdin.end();
		return { out: await new Response(p.stdout).text(), code: await p.exited };
	};
	const ok = await run(["auth", "login", "--claudeai"]);
	expect(ok.code).toBe(0);
	expect(ok.out).toBe(`${BEFORE_PASTE}\n${AFTER_PASTE}`);
	expect(await Bun.file(seen).text()).toBe("auth login --claudeai|code#state");
	expect((await run(["--fail"])).code).toBe(3);
});

test("the real CLI is an explicit override, else claude on PATH, else the newest OmO runtime's bundled copy", () => {
	const agent = join(dir, "agent2");
	const rel = join("node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`);
	for (const [id, age] of [["old", 100], ["new", 10]] as const) {
		mkdirSync(join(agent, "runtime", id, rel), { recursive: true });
		const f = join(agent, "runtime", id, rel, "claude");
		writeFileSync(f, "");
		const t = Date.now() / 1000 - age;
		utimesSync(f, t, t);
	}
	const shim = join(dir, "shim2");
	expect(realClaude({ PATH: "" }, agent, shim)).toBe(join(agent, "runtime", "new", rel, "claude"));
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "claude"), "");
	chmodSync(join(bin, "claude"), 0o755);
	expect(realClaude({ PATH: bin }, agent, shim)).toBe(join(bin, "claude"));
	expect(realClaude({ PATH: bin, CLAUDE_CODE_EXECUTABLE: join(agent, "runtime", "old", rel, "claude") }, agent, shim)).toBe(join(agent, "runtime", "old", rel, "claude"));
	expect(realClaude({ PATH: bin, CLAUDE_CODE_EXECUTABLE: join(shim, "claude") }, agent, shim)).toBe(join(bin, "claude"));
	expect(claudeShimEnv({ PATH: "" }, join(dir, "none"), shim)).toEqual({});
});
