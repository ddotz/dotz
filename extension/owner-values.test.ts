// The 2026-10-28 revert: the orchestrator wrote orchestrator.rotate_tokens 700000 into config.json while the owner had set 300K.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installOwnerValues, namesValue } from "./owner-values.ts";

const dir = mkdtempSync(join(tmpdir(), "dotz-owner-values-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup(config: object) {
	const file = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, JSON.stringify(config, null, 2));
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	installOwnerValues({ on: (name, fn) => (handlers[name] ??= []).push(fn) }, file);
	const owner = (text: string) => handlers.context[0]({ messages: [{ role: "user", content: [{ type: "text", text }] }] }, {});
	// One agent tool call that rewrites config.json the way the orchestrator's `edit` did.
	const agentWrites = (id: string, mutate: (c: any) => void) => {
		handlers.tool_call[0]({ toolName: "edit", toolCallId: id, input: { path: file } }, {});
		const c = JSON.parse(readFileSync(file, "utf8"));
		mutate(c);
		writeFileSync(file, JSON.stringify(c, null, 2));
		return handlers.tool_result[0]({ toolName: "edit", toolCallId: id, content: [{ type: "text", text: "edited" }] }, {});
	};
	const disk = () => JSON.parse(readFileSync(file, "utf8"));
	return { owner, agentWrites, disk };
}

test("an agent's unrequested rotate_tokens change is undone and the tool result says so", () => {
	const { owner, agentWrites, disk } = setup({ orchestrator: { runtime: "omo", rotate_tokens: 300000 }, lanes: { runtime: "omo" } });
	owner("야 컨텍스트 한도 왜이래. 이거 1M짜리 모델인데");
	const result = agentWrites("a", c => (c.orchestrator.rotate_tokens = 700000));
	expect(disk().orchestrator).toEqual({ runtime: "omo", rotate_tokens: 300000 });
	expect(result.content.at(-1).text).toContain("orchestrator.rotate_tokens 700000 -> 300000");
});

test("an added key the owner never set is removed again; other keys the call changed stay", () => {
	const { owner, agentWrites, disk } = setup({ orchestrator: { runtime: "omo" }, lanes: {} });
	owner("context limit?");
	agentWrites("b", c => {
		c.orchestrator.rotate_tokens = 700000;
		c.lanes.compact_at = 900000;
		c.ui = { origin_view: true };
	});
	expect(disk()).toEqual({ orchestrator: { runtime: "omo" }, lanes: {}, ui: { origin_view: true } });
});

test("a change the owner's message names goes through", () => {
	const { owner, agentWrites, disk } = setup({ orchestrator: { rotate_tokens: 700000 } });
	owner("야잇 압축기준은 300k로 해야지. 왜 또 700으로 하냐");
	expect(agentWrites("c", c => (c.orchestrator.rotate_tokens = 300000))).toBeUndefined();
	expect(disk().orchestrator.rotate_tokens).toBe(300000);
});

test("number forms", () => {
	for (const t of ["300000", "300,000", "300_000", "300K", "300 k", "30만", "0.3M"]) expect(namesValue(`기준 ${t}로`, 300000)).toBe(true);
	for (const t of ["1300000", "3000k", "700k", "300 tokens? no, 3000000"]) expect(namesValue(t, 300000)).toBe(false);
});
