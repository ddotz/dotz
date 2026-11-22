import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sendWith } from "../lib/senders.ts";
import type { DraftRec } from "../lib/store.ts";
import type { Runner } from "../lib/tone.ts";
import { setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	mkdirSync(join(env.dir, "custom", "webmail", "corp"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "webmail", "corp", "spec.json"), "{}");
});

const rec = (): DraftRec =>
	({ id: "RWM001", kind: "mail", app: "mail", source: "corp", mailId: "m1", ref: "k1", to: "kim@example.com", subject: "Re: 문의", body: "확인했어요", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { text: "x", from: "Kim <kim@example.com>" } }) as unknown as DraftRec;

const site = (o: { draft?: number; approve?: number; send?: [number, string] }, calls: string[][]): Runner => async argv => {
	calls.push(argv.slice(3));
	if (argv[3] === "draft") return { code: o.draft ?? 0, stdout: o.draft ? "" : "초안 저장: d-7", stderr: o.draft ? "boom" : "" };
	if (argv[3] === "approve") return { code: o.approve ?? 0, stdout: "", stderr: o.approve ? "boom" : "" };
	if (argv[3] === "discard") return { code: 0, stdout: "", stderr: "" };
	const [code, stdout] = o.send ?? [0, "보냈어요"];
	return { code, stdout, stderr: "" };
};

describe("sendWith: a webmail draft that was not sent is not left behind", () => {
	test("the approval names the draft it was written for", async () => {
		const calls: string[][] = [];
		await sendWith(rec(), site({}, calls));
		expect(calls).toEqual([["draft", "kim@example.com", "Re: 문의", "확인했어요"], ["approve", "d-7"], ["send", "d-7"]]);
	});

	test("a send that surely did not leave discards the draft", async () => {
		const calls: string[][] = [];
		const o = await sendWith(rec(), site({ send: [1, "전송 실패"] }, calls));
		expect({ sent: o.sent, last: calls.at(-1) }).toEqual({ sent: "no", last: ["discard", "d-7"] });
	});

	test("a refused approval discards the draft", async () => {
		const calls: string[][] = [];
		await sendWith(rec(), site({ approve: 1 }, calls));
		expect(calls.at(-1)).toEqual(["discard", "d-7"]);
	});

	test("a draft that was never made, a mail that went out and one that may have gone out discard nothing", async () => {
		for (const o of [{ draft: 1 }, {}, { send: [3, "끊김"] as [number, string] }]) {
			const calls: string[][] = [];
			await sendWith(rec(), site(o, calls));
			expect(calls.some(c => c[0] === "discard")).toBe(false);
		}
	});
});
