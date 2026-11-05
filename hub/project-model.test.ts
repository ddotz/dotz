// A project conversation keeps its own model and effort (ConvMeta.ownModel, the composer chips and /model there): main and every
// other project stay as they are, a project with no choice inherits main's, and nothing here spawns a process.
import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, orchestratorModel, selectorOf } from "./config.ts";
import { changeTarget, modelsView, runCommand, setModel, targetView } from "./control.ts";
import { convs } from "./convsessions.ts";
import "./outbound.ts";
import { omoSelector } from "./runtime/omo.ts";
import { safeDir } from "./session-key.ts";

const spy = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response("").body, exited: Promise.resolve(0), kill() {} })) as unknown as typeof Bun.spawn);
const mainBefore = selectorOf(orchestratorModel());
afterAll(async () => {
	await setModel("orchestrator", mainBefore);
	spy.mockRestore();
});

const A = "ch:1001", B = "ch:2002", SONNET = "anthropic/claude-sonnet-5-5", HAIKU = "anthropic/claude-haiku-5-5";
const view = async (t: string) => (await targetView(t)) as { model: string; thinking: string; own?: boolean; inherited?: string };
const pinFile = (key: string) => join(DATA_DIR, "conv-sessions", safeDir(key), "worker-pin");

test("a project's choice changes neither main nor another project, and an unset project inherits", async () => {
	const main = { ...orchestratorModel() };
	const r = (await changeTarget(A, { model: SONNET, thinking: "low" })) as { applied: string; target: string };
	expect(r).toMatchObject({ target: A, applied: "next-turn" });
	expect(await view(A)).toMatchObject({ model: SONNET, thinking: "low", own: true });
	expect(orchestratorModel()).toEqual(main);
	expect(await view("main")).toMatchObject(main);
	expect(await view(B)).toMatchObject({ ...main, own: false, inherited: selectorOf(main) });
	expect((await modelsView()).conversations).toEqual({ [A]: { own: `${SONNET}:low`, active: "" } });
	expect(convs.get(A)!.o.orchestratorPid()).toBeUndefined();
	expect(convs.get(B)).toBeUndefined();
});

test("main's next change reaches an inheriting project, not one with its own model; its workers stay on main's", async () => {
	await setModel("orchestrator", HAIKU, "medium");
	expect(await view(B)).toMatchObject({ model: HAIKU, thinking: "medium", own: false });
	expect(await view(A)).toMatchObject({ model: SONNET, thinking: "low", own: true });
	expect(readFileSync(pinFile(A), "utf8").trim()).toBe(omoSelector(`${HAIKU}:medium`));
});

test("slash commands in a project behave as its chip; a named target is still main's", async () => {
	const main = { ...orchestratorModel() };
	expect((await runCommand("/effort high", B)).tone).toBe("ok");
	expect(await view(B)).toMatchObject({ model: main.model, thinking: "high", own: true });
	expect(orchestratorModel()).toEqual(main);
	await runCommand(`/model ${SONNET} xhigh`, B);
	expect(await view(B)).toMatchObject({ model: SONNET, thinking: "xhigh", own: true });
	await runCommand("/model orchestrator low", B);
	expect(orchestratorModel().thinking).toBe("low");
	expect(await view(B)).toMatchObject({ model: SONNET, thinking: "xhigh", own: true });
	await runCommand("/model inherit", B);
	expect(await view(B)).toMatchObject({ model: main.model, thinking: "low", own: false });
});

test("back to inherit from the chip: the stored choice and the worker pin go", async () => {
	expect(existsSync(pinFile(A))).toBe(true);
	await changeTarget(A, { inherit: true });
	expect((await view(A)).own).toBe(false);
	expect(existsSync(pinFile(A))).toBe(false);
	expect(JSON.parse(readFileSync(join(DATA_DIR, "conv-sessions", safeDir(A), "state.json"), "utf8")).ownModel).toBeUndefined();
});
