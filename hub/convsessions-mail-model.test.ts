// A mail conversation's model: its own pick (the composer chip) > the mail app's 이 메일에서 쓸 모델 (custom/apps.json mail.conv_model) > main's.
// The real control and registry with an isolated data dir; nothing spawns.
import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeSettings } from "./app-settings.ts";
import { DATA_DIR, orchestratorModel, selectorOf } from "./config.ts";
import { changeTarget, modelsView, setModel, targetView } from "./control.ts";
import { convs } from "./convsessions.ts";
import { workersOf } from "./lanegates.ts";
import "./outbound.ts";
import { omoSelector } from "./runtime/omo.ts";
import { safeDir } from "./session-key.ts";

const spy = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response("").body, exited: Promise.resolve(0), kill() {} })) as unknown as typeof Bun.spawn);
const mainBefore = selectorOf(orchestratorModel());
afterAll(async () => {
	await setModel("orchestrator", mainBefore);
	spy.mockRestore();
});

const A = "mail:k-own", B = "mail:k-inherit", OPUS = "anthropic/claude-opus-5-5", SONNET = "anthropic/claude-sonnet-5-5";
type V = { model: string; thinking: string; own?: boolean; inherited?: string };
const view = async (t: string) => (await targetView(t)) as V;
const dir = (key: string) => join(DATA_DIR, "conv-sessions", safeDir(key));
const setMailDefault = (selector: string) => {
	const file = join(DATA_DIR, "custom", "apps.json");
	mkdirSync(join(DATA_DIR, "custom"), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ mail: { conv_model: selector } })}\n`);
};

test("with no mail default a mail conversation inherits main's model", async () => {
	const main = { ...orchestratorModel() };
	expect(await view(B)).toMatchObject({ ...main, own: false, inherited: selectorOf(main) });
	expect(convs.kindModel(B)).toBeUndefined();
});

test("picking a model from a mail conversation's chip saves it for that conversation alone", async () => {
	const main = { ...orchestratorModel() };
	const r = (await changeTarget(A, { model: SONNET, thinking: "low" })) as { applied: string; target: string };
	expect(r).toMatchObject({ target: A, applied: "next-turn" });
	expect(await view(A)).toMatchObject({ model: SONNET, thinking: "low", own: true });
	expect(JSON.parse(readFileSync(join(dir(A), "state.json"), "utf8")).ownModel).toBe(`${SONNET}:low`);
	expect(orchestratorModel()).toEqual(main);
	expect((await modelsView()).conversations[A]).toEqual({ own: `${SONNET}:low`, active: "" });
});

test("the mail default decides an unpicked mail conversation, survives main's change, and loses to a conversation's own pick", async () => {
	setMailDefault(`${OPUS}:medium`);
	expect(await view(B)).toMatchObject({ model: OPUS, thinking: "medium", own: false, inherited: `${OPUS}:medium` });
	convs.ensure(B);
	const inheriting = convs.get(B)!;
	await setModel("orchestrator", SONNET, "high");
	expect(await view(B)).toMatchObject({ model: OPUS, thinking: "medium", own: false });
	expect(inheriting.o.orch.activeModel).not.toBe(`${SONNET}:high`);
	// The workers stay on what main's workers are, not on the mail model.
	expect(readFileSync(join(dir(B), "worker-pin"), "utf8").trim()).toBe(omoSelector(workersOf(`${SONNET}:high`)));
	// The pick made earlier wins.
	expect(await view(A)).toMatchObject({ model: SONNET, thinking: "low", own: true });
	// Back to the default from the chip: the pick and the pin go, the conversation reads the mail default.
	await changeTarget(A, { inherit: true });
	expect(await view(A)).toMatchObject({ model: OPUS, thinking: "medium", own: false });
	expect(JSON.parse(readFileSync(join(dir(A), "state.json"), "utf8")).ownModel).toBeUndefined();
});

test("changing the mail setting reaches the inheriting mail conversations, and clearing it hands them back to main", async () => {
	const seen: string[] = [];
	const live = convs.get(B)!;
	const wrapped = live.o.applyModelChange;
	live.o.applyModelChange = () => (seen.push("applied"), wrapped());
	writeSettings(DATA_DIR, "mail", { conv_model: "" });
	convs.followKind("mail");
	expect(seen).toEqual(["applied"]);
	expect(await view(B)).toMatchObject({ ...orchestratorModel(), own: false });
	expect(existsSync(join(dir(B), "worker-pin"))).toBe(false);
});
