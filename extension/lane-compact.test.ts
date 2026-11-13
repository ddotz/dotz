import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What the extension sends into a lane's session after a compaction: the footer text the gateway wrote for the lane (hub/lanefooter.ts,
// identity included), delivered with the next turn, once, and nothing for the lane's task workers.
const SCRIPT = `
const handlers = {}; const sent = [];
const base = { on: (n, f) => (handlers[n] ??= []).push(f), sendMessage: (m, o) => sent.push({ content: String(m.content), deliverAs: o?.deliverAs }) };
const pi = new Proxy(base, { get: (t, p) => (p in t ? t[p] : p === "zod" ? undefined : () => undefined) });
(await import("./extension/index.ts")).default(pi);
for (const f of handlers.session_compact ?? []) f({}, { agent: { kind: "main" } });
console.log(JSON.stringify(sent));
process.exit(0);`;

function compactMessages(env: Record<string, string>): { content: string; deliverAs?: string }[] {
	const base = { ...process.env, DOTZ_RUNTIME: "omo" } as Record<string, string | undefined>;
	for (const k of ["DOTZ_ORCHESTRATOR", "DOTZ_CONV", "DOTZ_LANE", "OMO_SENPI_TASK_DEPTH"]) delete base[k];
	Object.assign(base, env);
	const r = Bun.spawnSync([process.execPath, "-e", SCRIPT], { cwd: join(import.meta.dir, ".."), env: base as Record<string, string>, stdout: "pipe", stderr: "pipe" });
	return JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "[]");
}

test("a lane re-reads its identity and footer for the next turn after a compaction; its task worker gets nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-lane-compact-"));
	try {
		writeFileSync(join(dir, "state.json"), JSON.stringify({ open_tasks: [{ id: "task-1", what: "orchestrator only" }] }));
		const contract = join(dir, "contract.md");
		writeFileSync(contract, "---\n[dotz lane alpha] footer marker 91c2\nIdentity: voice marker 7f3a, address the owner as Owner\n");
		const env = { DOTZ_DIR: dir, DOTZ_LANE: "alpha", DOTZ_LANE_CONTRACT: contract };

		const reread = (e: Record<string, string>) => compactMessages(e).filter(m => m.content.includes("[dotz lane alpha]")); // the guard sends its own state note too
		const lane = reread(env);
		expect(lane).toHaveLength(1);
		expect(lane[0]!.deliverAs).toBe("nextTurn");
		expect(lane[0]!.content.split("voice marker 7f3a")).toHaveLength(2); // one copy of the identity
		expect(lane[0]!.content).toContain("[dotz lane alpha] footer marker 91c2");
		expect(lane[0]!.content).not.toContain("orchestrator only"); // not the orchestrator's state

		expect(reread({ ...env, OMO_SENPI_TASK_DEPTH: "1" })).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
