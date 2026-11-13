// The quick chat's chips before its first message: the model list every device reads carries its default, and a model or effort picked then is
// stored for it and is what its session starts on. Nothing here spawns a process.
import { afterAll, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR } from "./config.ts";
import { changeTarget, modelsView, sessionModel, targetView } from "./control.ts";
import { convs } from "./convsessions.ts";
import "./outbound.ts";
import { QUICK, safeDir } from "./session-key.ts";

const spy = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response("").body, exited: Promise.resolve(0), kill() {} })) as unknown as typeof Bun.spawn);
afterAll(() => spy.mockRestore());
cfg.conversations = { ...cfg.conversations, quick_chat: true };

const OPUS = "anthropic/claude-opus-5-5";
const stateFile = join(DATA_DIR, "conv-sessions", safeDir(QUICK), "state.json");

test("with no quick conversation yet, the model list carries its default: no pick, not running", async () => {
	expect(convs.get(QUICK)).toBeUndefined();
	const { conversations } = await modelsView();
	expect(conversations[QUICK]).toEqual({ own: "", active: "", kind: expect.stringMatching(/claude-sonnet-5-5:high$/) });
});

test("a model and effort picked before the first message are stored and are what the session starts on", async () => {
	expect(convs.get(QUICK)).toBeUndefined();
	const r = (await changeTarget(QUICK, { model: OPUS, thinking: "low" })) as { applied: string; target: string };
	expect(r).toMatchObject({ target: QUICK, applied: "next-turn" });
	expect(await targetView(QUICK)).toMatchObject({ own: true, model: OPUS, thinking: "low" });
	expect(JSON.parse(readFileSync(stateFile, "utf8")).ownModel).toBe(`${OPUS}:low`);
	expect(sessionModel(QUICK)).toBe(`${OPUS}:low`);
	expect((await modelsView()).conversations[QUICK]).toMatchObject({ own: `${OPUS}:low`, active: "" });
	expect(convs.get(QUICK)!.o.orchestratorPid()).toBeUndefined();
});
