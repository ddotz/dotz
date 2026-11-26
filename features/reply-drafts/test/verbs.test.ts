import { afterAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { runDraft } from "../bin/draft.ts";
import { paths } from "../lib/settings.ts";
import { enable, fakeModel, goodReply, j, seedRules, setupEnv } from "./helpers.ts";

// The five verbs of a session (draft / revise / drop / learn / show) and the older names that route to the same case.
const env = setupEnv();
afterAll(env.cleanup);
const now = () => new Date("2030-03-04T00:00:00Z");
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	for (const p of [paths.toneDir(), paths.ledger(), paths.drafts(), join(env.dir, "custom", "reply-drafts", "learn-log.json")]) rmSync(p, { force: true, recursive: true });
	enable(env);
});

const usage = async () => (await runDraft(["help"], "")).lines.join("\n");

test("the usage lists the five verbs and the sub-actions of a draft, not the older names", async () => {
	const text = await usage();
	for (const verb of ["draft ", "revise ", "drop ", "learn ", "show", "replay ", "attach ", "detach "]) expect(text).toContain(verb);
	for (const old of ["new --mail", "correct --", "tone --", "| status"]) expect(text).not.toContain(old);
});

// The same fixture twice, each from an empty store: the new verb and its older name print and answer alike (a draft's random id aside).
async function same(verb: string[], old: string[], stdin = "", deps: object = {}) {
	const run = async (args: string[]) => {
		for (const p of [paths.toneDir(), paths.ledger(), paths.drafts()]) rmSync(p, { force: true, recursive: true });
		const out = await runDraft(args, stdin, { now, ...deps });
		return { ...out, lines: out.lines.map(l => l.replace(/\b[A-Z0-9]{7}\b/g, "ID")) };
	};
	const a = await run(verb);
	expect(a.code).toBe(0);
	expect(await run(old)).toEqual(a);
	return a;
}

test("draft does what new does", async () => {
	const mail = ["--mail", "m-1", "--from", "kim@example.com", "--subject", "회의 일정 문의"];
	const out = await same(["draft", ...mail], ["new", ...mail], "내일 가능한가요?", { call: fakeModel([j(goodReply)]).call });
	expect(out.lines.join("\n")).toContain("kim@example.com");
});

test("learn does what correct does", async () => {
	const args = ["--app", "install", "--rule", "존댓말로 짧게"];
	expect((await same(["learn", ...args], ["correct", ...args])).lines.join("\n")).toContain("존댓말로 짧게");
});

test("show does what status and tone do: pending drafts, a tone profile, the effective rules, the journal", async () => {
	seedRules("install", { tone: ["답장은 짧게"] });
	await runDraft(["draft", "--mail", "m-2", "--from", "kim@example.com", "--subject", "문의"], "내일 가능한가요?", { call: fakeModel([j(goodReply)]).call });
	for (const [verb, old] of [
		[["show"], ["status"]],
		[["show", "--app", "install"], ["tone", "--app", "install"]],
		[["show", "--app", "mail", "--effective"], ["tone", "--effective", "--app", "mail"]],
		[["show", "--journal"], ["tone", "--journal"]],
	] as const) {
		const a = await runDraft([...verb], "");
		expect(a.code).toBe(0);
		expect(await runDraft([...old], "")).toEqual(a);
	}
	expect((await runDraft(["show", "--app", "install"], "")).lines.join("\n")).toContain("답장은 짧게");
	expect((await runDraft(["show"], "")).lines.join("\n")).toContain("kim@example.com");
});

test("show <id> prints that draft's line only", async () => {
	await runDraft(["draft", "--mail", "m-3", "--from", "kim@example.com", "--subject", "문의"], "내일 가능한가요?", { call: fakeModel([j(goodReply)]).call });
	const [first] = (await runDraft(["show"], "")).lines;
	const id = first!.split(" ")[0]!;
	expect((await runDraft(["show", id], "")).lines).toEqual([first!]);
	expect((await runDraft(["show", "nope"], "")).code).toBe(1);
});
