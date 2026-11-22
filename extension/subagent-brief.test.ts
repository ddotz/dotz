import { expect, test } from "bun:test";
import { GUARD_DEFAULTS } from "./guard-config.ts";
import { installSubagentBrief } from "./subagent-brief.ts";

const call = (config = { ...GUARD_DEFAULTS, defer_to_installed: false }) => {
	let handler: (event: unknown, ctx: unknown) => unknown = () => undefined;
	installSubagentBrief({ on: (name, fn) => void (name === "tool_call" && (handler = fn)) }, config);
	return (toolName: string, input: unknown) => handler({ toolName, input }, { agent: { kind: "sub" }, cwd: process.cwd() }) as { block?: boolean; reason?: string; input?: { tasks: { task: string }[] } } | undefined;
};

test("a subagent's own task call is checked like the main agent's: no done-condition is refused, a good brief gets the budget line", () => {
	const check = call();
	expect(check("task", { tasks: [{ task: "fix the parser" }] })?.reason).toContain("no observable done-condition");
	const ok = check("task", { tasks: [{ task: "fix the parser\nAcceptance: bun test passes" }] });
	expect(ok?.block).toBeUndefined();
	expect(ok?.input?.tasks[0]?.task).toContain("Acceptance: bun test passes");
	expect(check("bash", { command: "ls" })).toBeUndefined();
});

test("nothing is installed while the guard is off", () => {
	const check = call({ ...GUARD_DEFAULTS, enabled: false });
	expect(check("task", { tasks: [{ task: "fix the parser" }] })).toBeUndefined();
});
