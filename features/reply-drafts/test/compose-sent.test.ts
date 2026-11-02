import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMailCli } from "../../../hub/mail-cli.ts";
import { runDraft } from "../bin/draft.ts";
import { paths } from "../lib/settings.ts";
import { stagedFiles } from "../lib/staged.ts";
import { listDrafts } from "../lib/store.ts";
import { enable, pick, setupEnv } from "./helpers.ts";

// A mail the owner wrote in the app (hub/mail-manual.ts) is sent by the same CLI as every other draft (features/reply-drafts/bin/draft.ts,
// not hub/mail-cli.ts). Once it went out the gateway must hear it, so the mail app lists it under 보낸 메일 at once — with its files.
const env = setupEnv();
const files = mkdtempSync(join(tmpdir(), "rd-sent-"));
afterAll(() => {
	env.cleanup();
	rmSync(files, { recursive: true, force: true });
});
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files")]) rmSync(p, { force: true, recursive: true });
});

const sheet = join(files, "견적서.pdf");
writeFileSync(sheet, "pdf bytes");
const harness = () => {
	const argvs: string[][] = [];
	const posts: { path: string; body: any }[] = [];
	return {
		argvs,
		posts,
		deps: {
			run: async (argv: string[]) => (argvs.push(argv), { code: 0, stdout: "", stderr: "" }),
			hub: { post: async (path: string, body?: unknown) => (posts.push({ path, body }), { status: 200 }) },
		},
	};
};

describe("a mail written in the app", () => {
	test("sending it tells the gateway, so it is listed under 보낸 메일 with its file", async () => {
		enable(env);
		const h = harness();
		await runMailCli(["compose", "--app", "mail", "--to", "lee@example.com", "--subject", "견적 문의", "--attach", sheet], "견적서 보내드립니다.", h.deps);
		const d = listDrafts()[0]!;
		pick(env, d.id, 1);
		const out = await runDraft(["send", d.id], "", h.deps);
		expect(out.code).toBe(0);
		expect(h.argvs.at(-1)!.slice(0, 4)).toEqual(["zele", "mail", "send", "--to"]);
		expect(h.posts).toContainEqual({ path: "/api/mail/compose", body: { ref: d.id, source: "zele", state: "sent" } });
		expect(stagedFiles(d.id).map(f => f.name)).toEqual(["견적서.pdf"]);
	});

	test("a refused send tells nobody, and a reply draft still goes through the follow-up route only", async () => {
		enable(env);
		const h = harness();
		await runMailCli(["compose", "--app", "mail", "--to", "lee@example.com", "--subject", "견적 문의"], "견적서 보내드립니다.", h.deps);
		const d = listDrafts()[0]!;
		h.posts.length = 0;
		expect((await runDraft(["send", d.id], "", h.deps)).code).toBe(1);
		expect(h.posts).toEqual([]);
		expect(h.argvs).toEqual([]);
	});
});
