// A comment source's fixed reply / mail template (SourceConfig.template, off by default): the engine uses the text as is (the model never writes or rewrites it),
// the riding mail keeps what step 1 stores and passes the one check of step 3 (`rec.check`), a banned phrase in a template is a warning when it is saved.
// Everything is injected: nothing is posted or sent.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toneFile } from "../../features/reply-drafts/lib/settings.ts";
import { getDraft } from "../../features/reply-drafts/lib/store.ts";
import { enable, fakeModel, j, setupEnv } from "../../features/reply-drafts/test/helpers.ts";
import { type CommentAdapter, type SourceConfig } from "./contract.ts";
import { createEngine } from "./engine.ts";
import { realMailLink } from "./mail-link.ts";

const env = setupEnv();
const lib = mkdtempSync(join(tmpdir(), "tpl-lib-"));
afterAll(() => {
	env.cleanup();
	rmSync(lib, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-26T00:00:00.000Z");
const ASKS = "문서 부탁드립니다. a@example.com 입니다";
const BOX_RULE = "메일함A는 두 줄로 답해요";
const TEMPLATE = { reply: "{author}님, 메일로 보내드릴게요", mail: "{author}님, {title} 자료 보내드려요" };
const mailJson = (body: string) => j({ action: "draft", reason: "asks", to: "a@example.com", subject: "자료", body, questions: [] });

let dirs: string[] = [];
beforeEach(() => {
	for (const p of [join(env.dir, "custom")]) rmSync(p, { force: true, recursive: true });
	enable(env, { attachFolders: { mail: lib } });
	mkdirSync(join(env.dir, "custom"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "mailboxes.json"), JSON.stringify({ rev: 1, accounts: { mail: { boxes: [{ id: "base", name: "일반", base: true }, { id: "b-a", name: "메일함A", how: BOX_RULE, conds: { from: ["a@example.com"], subj: [], body: [], src: [] } }] } }, pins: {} }));
	for (const file of [toneFile({ app: "mail", room: "b-a" }), toneFile({ app: "mail" })]) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "## 예시\n\n- 네 보내드렸어요\n\n## 금지\n\n- 무조건\n");
	}
});
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

// One source of a fake platform with one material-request comment; the mail link is the real one (a compose draft of the reply-drafts store).
function world(template: SourceConfig["template"], mailBody = "자료 드려요") {
	const dir = mkdtempSync(join(tmpdir(), "tpl-"));
	dirs.push(dir);
	const source: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: true, autoMail: true, mailApp: "mail", ...(template ? { template } : {}) };
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: [{ native: "c1", thread: "p1", author: "팬", text: ASKS, postTitle: "글A", at: NOW - 1000 }], cursor: "1" }),
		reply: async () => ({ ok: true, ref: "r1" }),
		posts: async () => [],
	};
	const writer = fakeModel([mailJson(mailBody)]);
	const replier = fakeModel([j({ action: "draft", reason: "asks", to: "", body: "모델이 쓴 답글", questions: [] })]);
	const link = realMailLink({ call: writer.call, run: async () => ({ code: 1, stdout: "", stderr: "" }) });
	const engine = createEngine({ dir, now: () => NOW, collector: "mac-a", adapters: { youtube: adapter }, model: async (system, user) => ({ text: await replier.call(system, user) }), style: () => ({ rules: [], corrections: [], forbidden: ["무조건"], samples: [] }), mail: link });
	const drafted = async () => {
		await engine.collect({ force: true });
		const d = engine.store.drafts().find(x => x.status === "pending")!;
		return { d, mail: getDraft(d.mail!)! };
	};
	return { engine, link, writer, replier, drafted };
}

describe("a template-made riding mail", () => {
	test("revised, it keeps the request text, the post title and the mailbox rule of its first write", async () => {
		const t = world(TEMPLATE);
		const { d, mail } = await t.drafted();
		expect(mail.body).toBe("팬님, 글A 자료 보내드려요");
		expect(mail.box).toBe("b-a");
		const r = await t.engine.revise(d.code, "더 짧게", "mail");
		if (!r.ok) throw new Error(r.reason);
		const prompt = t.writer.calls.at(-1)!.user;
		for (const s of [ASKS, "글A", "무조건", "request for material"]) expect(prompt).toContain(s);
		const revised = getDraft(r.draft.mail!)!;
		expect(revised.box).toBe("b-a");
		expect(revised.request).toBe(ASKS);
	});
});

describe("saving a template", () => {
	test("with a phrase the target's rules ban warns, and a clean one does not", () => {
		const t = world(undefined);
		t.engine.update("youtube", { template: { reply: "무조건 보내드려요", mail: "{author}님, 무조건 드려요" } });
		expect(t.engine.templateWarnings("youtube")).toEqual(["답글 틀에 금지 표현이 있어요: 무조건", "메일 틀에 금지 표현이 있어요: 무조건"]);
		t.engine.update("youtube", { template: TEMPLATE });
		expect(t.engine.templateWarnings("youtube")).toEqual([]);
	});
});

describe("a template-made draft and a model-made draft", () => {
	test("leave the same check result, and no model call writes the template text", async () => {
		const banned = { reply: "{author}님, 무조건 보내드려요", mail: "{author}님, 무조건 드려요" };
		const fixed = world(banned);
		const made = await fixed.drafted();
		const written = world(undefined, "팬님, 무조건 드려요");
		const model = await written.drafted();
		expect(made.mail.check).toEqual({ refuse: [], warn: ["it uses the forbidden expression '무조건'"], judged: [] });
		expect(made.mail.check).toEqual(model.mail.check);
		expect(made.mail.body).toBe("팬님, 무조건 드려요");
		expect(made.d.text).toBe("팬님, 무조건 보내드려요");
		expect(made.d.notes.filter(n => n.includes("무조건"))).toHaveLength(2);
		expect(fixed.writer.calls).toEqual([]);
		expect(fixed.replier.calls).toEqual([]);
		expect(written.writer.calls.length).toBeGreaterThan(0);
	});
});
