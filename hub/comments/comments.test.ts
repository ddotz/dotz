import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runComments } from "../../features/comments/bin/comments.ts";
import { type Comment, type CommentAdapter, commentId, mergeComments, type RawComment, type SourceConfig } from "./contract.ts";
import { createEngine, type DraftModel } from "./engine.ts";
import { bunExec, parseRss, websiteAdapter } from "./adapters/website.ts";
import { createCommentsWeb } from "./web.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const reply = (body: string, extra: object = {}) => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body, questions: [], ...extra })}\n\`\`\``;
const raw = (native: string, o: Partial<RawComment> = {}): RawComment => ({ native, thread: "p1", author: "A", text: `question ${native}?`, postTitle: "Post one", at: NOW - 1000, ...o });
const src = (o: Partial<SourceConfig> = {}): SourceConfig => ({ key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false, ...o });

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comments-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(sources: SourceConfig[], opts: { model?: DraftModel; collector?: string; clock?: () => number } = {}) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: Object.fromEntries(sources.map(s => [s.key, s])) }));
	const state = { pages: [] as RawComment[][], listCalls: 0, posted: [] as { id: string; text: string }[], failReply: undefined as string | undefined, hold: undefined as Promise<void> | undefined };
	const adapter: CommentAdapter = {
		kind: "youtube",
		async list() {
			state.listCalls++;
			return { comments: state.pages.shift() ?? [], cursor: String(state.listCalls) };
		},
		async reply(_s, c, text) {
			if (state.hold) await state.hold;
			if (state.failReply) return { ok: false, reason: state.failReply };
			state.posted.push({ id: c.id, text });
			return { ok: true, ref: "ref1" };
		},
		posts: async () => [{ id: "p1", title: "Post one" }],
	};
	const prompts: { system: string; user: string }[] = [];
	const model: DraftModel = opts.model ?? (async (system, user) => (prompts.push({ system, user }), { text: reply("고마워요, 곧 알려 드릴게요."), inputTokens: 900, outputTokens: 40 }));
	const events: Record<string, unknown>[] = [];
	const engine = createEngine({ dir, now: opts.clock ?? (() => NOW), collector: opts.collector ?? "mac-a", adapters: { youtube: adapter, website: adapter }, model, broadcast: e => events.push(e) });
	return { engine, state, prompts, events };
}

describe("comment ids and collection", () => {
	test("the id is the same on every machine and a second list of the same comments adds nothing", async () => {
		const a = setup([src()], { collector: "mac-a" });
		a.state.pages = [[raw("c1"), raw("c2")], [raw("c1"), raw("c2"), raw("c3")]];
		const first = await a.engine.collect({ force: true });
		const second = await a.engine.collect({ force: true });
		expect(first.added.map(c => c.id)).toEqual([commentId("youtube", "c1"), commentId("youtube", "c2")]);
		expect(second.added.map(c => c.id)).toEqual([commentId("youtube", "c3")]);
		expect(a.engine.store.comments()).toHaveLength(3);

		const dirB = mkdtempSync(join(tmpdir(), "comments-b-"));
		try {
			mkdirSync(dirB, { recursive: true });
			writeFileSync(join(dirB, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: src() } }));
			const b = createEngine({ dir: dirB, now: () => NOW, collector: "mac-b", adapters: { youtube: { kind: "youtube", list: async () => ({ comments: [raw("c1")] }), reply: async () => ({ ok: true }) } } });
			await b.collect({ force: true });
			const merged = mergeComments(a.engine.store.comments(), b.store.comments());
			expect(merged.map(c => c.id).sort()).toEqual([commentId("youtube", "c1"), commentId("youtube", "c2"), commentId("youtube", "c3")]);
			expect(merged.find(c => c.native === "c1")!.collector).toBe("mac-a");
		} finally {
			rmSync(dirB, { recursive: true, force: true });
		}
	});

	test("a source the owner did not choose is never read, and an unchosen post is ignored", async () => {
		const t = setup([src({ watch: [] }), src({ key: "other", watch: ["p9"] })]);
		t.state.pages = [[raw("c1", { thread: "p1" }), raw("c2", { thread: "p9" })]];
		const r = await t.engine.collect({ force: true });
		expect(t.state.listCalls).toBe(1);
		expect(r.added.map(c => c.native)).toEqual(["c2"]);
		const off = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
		writeFileSync(join(dir, "config.json"), JSON.stringify({ ...off, enabled: false }));
		await t.engine.collect({ force: true });
		expect(t.state.listCalls).toBe(1);
	});

	test("a source is not read again before its interval", async () => {
		let now = NOW;
		const t = setup([src()], { clock: () => now });
		await t.engine.collect();
		await t.engine.collect();
		expect(t.state.listCalls).toBe(1);
		now += 6 * 60_000;
		await t.engine.collect();
		expect(t.state.listCalls).toBe(2);
	});

	test("a failing source records its reason and does not stop the others", async () => {
		const t = setup([src()]);
		t.engine.store.saveConfig({ enabled: true, sources: { youtube: src(), bad: src({ key: "bad" }) } });
		const r = await t.engine.collect({ force: true });
		expect(r.errors).toEqual({});
		const eng = createEngine({ dir, now: () => NOW, collector: "x", adapters: { youtube: { kind: "youtube", list: async () => { throw new Error("quota"); }, reply: async () => ({ ok: true }) } } });
		const bad = await eng.collect({ force: true });
		expect(Object.values(bad.errors)).toEqual(["quota", "quota"]);
		expect(eng.store.cursors().youtube?.error).toBe("quota");
	});
});

describe("drafts only on request", () => {
	test("collecting makes no model call; a request makes exactly one, with a small context and measured tokens", async () => {
		const t = setup([src()]);
		t.state.pages = [[raw("c1"), raw("c2", { parent: "c1", author: "me", mine: true, text: "thanks!" })]];
		await t.engine.collect({ force: true });
		expect(t.prompts).toHaveLength(0);
		const step = await t.engine.makeDraft(commentId("youtube", "c1"));
		expect(step.ok).toBe(true);
		expect(t.prompts).toHaveLength(1);
		const user = t.prompts[0]!.user;
		expect(user).toContain("Post one");
		expect(user).toContain("question c1?");
		if (step.ok) expect(step.draft.tokens).toEqual({ in: 900, out: 40 });
		expect(t.engine.tokenStats()).toEqual({ drafts: 1, avgIn: 900, avgOut: 40 });
	});

	test("tokens are estimated and marked when the model reports none", async () => {
		const t = setup([src()], { model: async () => ({ text: reply("네, 감사합니다.") }) });
		t.state.pages = [[raw("c1")]];
		await t.engine.collect({ force: true });
		const step = await t.engine.makeDraft(commentId("youtube", "c1"));
		expect(step.ok && step.draft.tokens?.estimated).toBe(true);
		expect(step.ok && step.draft.tokens!.in).toBeGreaterThan(50);
	});

	test("per-source auto-draft drafts only new comments that need a reply, never the owner's own", async () => {
		const t = setup([src({ autoDraft: true, autoSince: NOW - 5000 })]);
		t.state.pages = [[raw("c1"), raw("c2", { mine: true }), raw("old", { at: NOW - 999999 })]];
		const r = await t.engine.collect({ force: true });
		expect(r.drafted.map(d => d.commentId)).toEqual([commentId("youtube", "c1")]);
		expect(t.prompts).toHaveLength(1);
	});

	test("a skip from the model makes no draft", async () => {
		const t = setup([src()], { model: async () => ({ text: `\`\`\`json\n${JSON.stringify({ action: "skip", reason: "spam", to: "", body: "", questions: [] })}\n\`\`\`` }) });
		t.state.pages = [[raw("c1")]];
		await t.engine.collect({ force: true });
		const step = await t.engine.makeDraft(commentId("youtube", "c1"));
		expect(step.ok).toBe(false);
		expect(t.engine.store.drafts()).toHaveLength(0);
	});
});

describe("the send gate", () => {
	async function drafted(o: Partial<SourceConfig> = {}) {
		const t = setup([src(o)]);
		t.state.pages = [[raw("c1")]];
		await t.engine.collect({ force: true });
		const step = await t.engine.makeDraft(commentId("youtube", "c1"));
		if (!step.ok) throw new Error(step.reason);
		return { ...t, code: step.draft.code };
	}

	test("posts after the owner's 보내기, goes sending -> sent, and a second send is refused", async () => {
		const t = await drafted();
		const first = t.engine.send(t.code, { by: "owner" });
		expect(first.ok && first.reply.state).toBe("sending");
		const dup = t.engine.send(t.code, { by: "owner" });
		expect(dup).toEqual({ ok: false, reason: "이미 보내는 중이에요" });
		if (first.ok) expect((await first.done).state).toBe("sent");
		expect(t.state.posted).toEqual([{ id: commentId("youtube", "c1"), text: "고마워요, 곧 알려 드릴게요." }]);
		expect(t.engine.send(t.code, { by: "owner" }).ok).toBe(false);
		expect(t.state.posted).toHaveLength(1);
		expect(t.events.some(e => e.kind === "comment_send" && e.state === "sent")).toBe(true);
	});

	test("a failed post shows the reason and may be tried again once", async () => {
		const t = await drafted();
		t.state.failReply = "403 forbidden";
		const first = t.engine.send(t.code, { by: "owner" });
		expect(first.ok && (await first.done)).toMatchObject({ state: "failed", reason: "403 forbidden" });
		expect(t.engine.store.drafts()[0]!.status).toBe("pending");
		t.state.failReply = undefined;
		const again = t.engine.send(t.code, { by: "owner" });
		expect(again.ok && (await again.done).state).toBe("sent");
		expect(t.state.posted).toHaveLength(1);
	});

	test("a rule send needs the owner's per-source rule, a matching comment and a clean draft", async () => {
		const off = await drafted();
		expect(off.engine.send(off.code, { by: "rule" })).toEqual({ ok: false, reason: "자동 보내기 규칙에 맞지 않아요" });
		expect(off.state.posted).toHaveLength(0);
		const on = await drafted({ autoSend: { on: true, match: ["question"], max_per_day: 1 } });
		const r = on.engine.send(on.code, { by: "rule" });
		expect(r.ok && (await r.done).via).toBe("rule");
		const other = await drafted({ autoSend: { on: true, match: ["nothing-matches"], max_per_day: 5 } });
		expect(other.engine.send(other.code, { by: "rule" }).ok).toBe(false);
	});

	test("auto-send in a collect run goes through the gate and respects the daily cap", async () => {
		const t = setup([src({ autoDraft: true, autoSince: 0, autoSend: { on: true, match: ["question"], max_per_day: 1 } })]);
		t.state.pages = [[raw("c1"), raw("c2")]];
		const r = await t.engine.collect({ force: true });
		expect(r.sent).toHaveLength(1);
		expect(t.state.posted).toHaveLength(1);
		expect(r.drafted).toHaveLength(2);
	});

	test("the CLI sends only for the owner's pick of exactly that draft code, once", async () => {
		const t = await drafted();
		const inbox = join(dir, "inbox.jsonl");
		const refused = await runComments(["send", t.code], t.engine, inbox);
		expect(refused.code).toBe(1);
		expect(t.state.posted).toHaveLength(0);
		const pick = (id: string, label: string, source = "web") => appendFileSync(inbox, `${JSON.stringify({ ts: new Date(NOW + 5000 + Date.now() % 1000).toISOString(), kind: "message", source, text: `1) ${label}`, picks: [{ q: `이 답글 올릴까요? (${id})`, n: 1, label }] })}\n`);
		pick("Dother00", "보내기");
		expect((await runComments(["send", t.code], t.engine, inbox)).code).toBe(1);
		pick(t.code, "보내기", "lane_message");
		expect((await runComments(["send", t.code], t.engine, inbox)).code).toBe(1);
		expect(t.state.posted).toHaveLength(0);
		pick(t.code, "보내기");
		const ok = await runComments(["send", t.code], t.engine, inbox);
		expect(ok.code).toBe(0);
		expect((await runComments(["send", t.code], t.engine, inbox)).code).toBe(1);
		expect(t.state.posted).toHaveLength(1);
	});

	test("a dropped or revised draft cannot be sent", async () => {
		const t = await drafted();
		expect(t.engine.drop(t.code).ok).toBe(true);
		expect(t.engine.send(t.code, { by: "owner" })).toEqual({ ok: false, reason: "이 초안은 더 이상 보낼 수 없어요" });
		const t2 = await drafted();
		const revised = await t2.engine.revise(t2.code, "더 짧게");
		expect(revised.ok).toBe(true);
		expect(t2.engine.send(t2.code, { by: "owner" }).ok).toBe(false);
		expect(t2.engine.store.drafts().filter(d => d.status === "pending")).toHaveLength(1);
	});
});

describe("web routes", () => {
	test("threads, status counts, draft on request, send once with 202, read clears unread", async () => {
		const t = setup([src()]);
		t.state.pages = [[raw("c1"), raw("c2", { thread: "p2", postTitle: "Post two" })]];
		await t.engine.collect({ force: true });
		const web = createCommentsWeb({ engine: t.engine, broadcast: e => t.events.push(e) });
		const call = async (method: string, path: string, body?: object) => {
			const url = new URL(`http://x${path}`);
			const res = await web.route(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), url, url.pathname.split("/").filter(Boolean));
			return { status: res!.status, json: (await res!.json()) as any };
		};
		const threads = await call("GET", "/api/comments/threads?app=youtube");
		expect(threads.json.threads.map((x: any) => [x.thread, x.unread]).sort()).toEqual([["p1", 1], ["p2", 1]]);
		expect(t.engine.needs()).toEqual({ youtube: { drafts: 0, unread: 2 } });

		const id = commentId("youtube", "c1");
		expect((await call("POST", `/api/comments/comment/${encodeURIComponent(id)}/draft`)).status).toBe(202);
		await web.idle();
		const view = await call("GET", "/api/comments/thread/youtube/p1");
		expect(view.json.drafts).toHaveLength(1);
		expect(t.engine.needs().youtube).toEqual({ drafts: 1, unread: 2 });
		const code = view.json.drafts[0].code;
		const sent = await call("POST", `/api/comments/drafts/${code}/send`, { text: "고친 글이에요" });
		expect(sent.status).toBe(202);
		expect((await call("POST", `/api/comments/drafts/${code}/send`, {})).status).toBe(409);
		await web.idle();
		expect(t.state.posted).toEqual([{ id, text: "고친 글이에요" }]);
		expect((await call("GET", "/api/comments/thread/youtube/p1")).json.sends[0]).toMatchObject({ state: "sent" });
		expect((await call("POST", "/api/comments/thread/youtube/p1/read")).status).toBe(200);
		expect(t.engine.needs().youtube!.unread).toBe(1);
		expect((await call("GET", "/api/comments/thread/youtube/p404")).status).toBe(404);
	});

	test("one website app per source: threads and counts narrow to the sources asked for", async () => {
		const t = setup([src({ key: "site-a", kind: "website", label: "A" }), src({ key: "site-b", kind: "website", label: "B" })]);
		t.state.pages = [[raw("a1", { thread: "pa" })], [raw("b1", { thread: "pb" }), raw("b2", { thread: "pb" })]];
		await t.engine.collect({ force: true });
		const web = createCommentsWeb({ engine: t.engine, broadcast: () => {} });
		const threads = async (q: string) => {
			const url = new URL(`http://x/api/comments/threads?${q}`);
			const res = await web.route(new Request(url), url, ["api", "comments", "threads"]);
			return ((await res!.json()) as { threads: { source: string; thread: string }[] }).threads.map(x => `${x.source}/${x.thread}`).sort();
		};
		expect(await threads("app=site")).toEqual(["site-a/pa", "site-b/pb"]);
		expect(await threads("app=site&source=site-b")).toEqual(["site-b/pb"]);
		expect(await threads("app=site&source=site-a,site-b")).toEqual(["site-a/pa", "site-b/pb"]);
		expect(t.engine.needs()).toEqual({ site: { drafts: 0, unread: 3 } });
		expect(t.engine.sourceNeeds()).toEqual({ "site-a": { drafts: 0, unread: 1 }, "site-b": { drafts: 0, unread: 2 } });
	});

	test("everything is refused while the feature is off", async () => {
		const t = setup([src()]);
		t.engine.store.saveConfig({ enabled: false, sources: { youtube: src() } });
		const web = createCommentsWeb({ engine: t.engine, broadcast: () => {} });
		const url = new URL("http://x/api/comments/threads?app=youtube");
		const res = await web.route(new Request(url), url, ["api", "comments", "threads"]);
		expect(res!.status).toBe(409);
	});
});

describe("website adapter", () => {
	const fixtureDir = () => {
		const read = join(dir, "read.ts");
		const post = join(dir, "post.ts");
		writeFileSync(read, `const i = process.argv.indexOf("--since"); const since = i > 0 ? Number(process.argv[i + 1]) : 0;
const all = [{ id: "1", thread: "post-7", author: "Kim", text: "첫 댓글이에요?", postTitle: "Hello", postLink: "https://site.example/p7", at: "2026-10-22T10:00:00Z" }, { id: "2", thread: "post-7", parent: "1", author: "Owner", mine: true, text: "네!", at: "2026-10-22T11:00:00Z" }, { id: "3", thread: "post-8", author: "Lee", text: "질문 있어요?", postTitle: "Other", at: "2026-10-22T12:00:00Z" }];
console.log(JSON.stringify({ comments: all.filter(c => Number(c.id) > since), cursor: "3" }));\n`);
		writeFileSync(post, `const body = await Bun.stdin.text(); await Bun.write(${JSON.stringify(join(dir, "posted.jsonl"))}, (await Bun.file(${JSON.stringify(join(dir, "posted.jsonl"))}).exists() ? await Bun.file(${JSON.stringify(join(dir, "posted.jsonl"))}).text() : "") + body + "\\n"); console.log(JSON.stringify({ ok: true, ref: "r9" }));\n`);
		return { read, post };
	};
	const site = (read: string, post: string): SourceConfig => ({ key: "site-blog", kind: "website", label: "웹사이트 댓글 (blog)", watch: ["*"], autoDraft: false, site: { read: { kind: "script", command: ["bun", read] }, post: { kind: "script", command: ["bun", post] } } });

	test("reads through a fixture script with a cursor, drafts, and posts through the post script once", async () => {
		const { read, post } = fixtureDir();
		const adapter = websiteAdapter({ exec: bunExec, fetch, secretsDir: dir, siteDir: dir });
		const s = site(read, post);
		writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { [s.key]: s } }));
		const engine = createEngine({ dir, now: () => NOW, collector: "mac-a", adapters: { website: adapter }, model: async () => ({ text: reply("답해 드릴게요."), inputTokens: 500, outputTokens: 20 }) });
		const first = await engine.collect({ force: true });
		expect(first.added.map(c => c.id).sort()).toEqual(["cm:site-blog:1", "cm:site-blog:2", "cm:site-blog:3"]);
		expect((await engine.collect({ force: true })).added).toHaveLength(0);
		expect(engine.needsReply(engine.store.comments().find(c => c.native === "1")!)).toBe(false);
		expect(engine.needsReply(engine.store.comments().find(c => c.native === "3")!)).toBe(true);
		expect(engine.threads("site").map(t => t.thread).sort()).toEqual(["post-7", "post-8"]);
		const step = await engine.makeDraft("cm:site-blog:3");
		if (!step.ok) throw new Error(step.reason);
		const r = engine.send(step.draft.code, { by: "owner" });
		expect(r.ok && (await r.done).state).toBe("sent");
		expect(engine.send(step.draft.code, { by: "owner" }).ok).toBe(false);
		const posted = readFileSync(join(dir, "posted.jsonl"), "utf8").trim().split("\n");
		expect(posted).toHaveLength(1);
		expect(JSON.parse(posted[0]!)).toMatchObject({ commentId: "3", thread: "post-8", text: "답해 드릴게요." });
	});

	test("a failing post script is a failed send with its output as the reason", async () => {
		const { read } = fixtureDir();
		const bad = join(dir, "bad.ts");
		writeFileSync(bad, `console.error("login expired"); process.exit(2);\n`);
		const adapter = websiteAdapter({ exec: bunExec, fetch, secretsDir: dir, siteDir: dir });
		const s = site(read, bad);
		const out = await adapter.reply(s, { id: "cm:site-blog:3", source: s.key, native: "3", thread: "post-8", author: "Lee", text: "?", postTitle: "x", at: 0, mine: false, collector: "m" } as Comment, "hi", "send:1");
		expect(out).toEqual({ ok: false, reason: "login expired" });
	});

	test("an RSS comment feed and a webhook with a bearer secret", async () => {
		const xml = `<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>Comment on Hello World by Kim</title><link>https://site.example/hello/#comment-5</link><dc:creator><![CDATA[Kim]]></dc:creator><pubDate>Thu, 22 Oct 2026 10:00:00 +0000</pubDate><guid isPermaLink="false">https://site.example/?c=5</guid><description><![CDATA[<p>좋은 글 &amp; 감사해요?</p>]]></description></item></channel></rss>`;
		expect(parseRss(xml)).toEqual([{ native: "https://site.example/?c=5", thread: "https://site.example/hello/", author: "Kim", text: "좋은 글 & 감사해요?", postTitle: "Hello World", postLink: "https://site.example/hello/", at: Date.parse("2026-10-22T10:00:00Z") }]);
		mkdirSync(join(dir, "s"), { recursive: true });
		writeFileSync(join(dir, "s", "blog-token"), "tok123\n");
		const seen: { url: string; auth: string | null; body: string }[] = [];
		const fakeFetch = (async (u: URL | string, init?: RequestInit) => {
			seen.push({ url: String(u), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
			return String(u).endsWith("/feed") ? new Response(xml) : Response.json({ ref: "w1" });
		}) as typeof fetch;
		const adapter = websiteAdapter({ exec: bunExec, fetch: fakeFetch, secretsDir: join(dir, "s"), siteDir: dir });
		const s: SourceConfig = { key: "site-blog", kind: "website", label: "w", watch: ["*"], autoDraft: false, site: { read: { kind: "rss", url: "https://site.example/feed" }, post: { kind: "webhook", url: "https://site.example/hook", secret: "blog-token" } } };
		const listed = await adapter.list(s, undefined);
		expect(listed.comments).toHaveLength(1);
		expect((await adapter.list(s, listed.cursor)).comments).toHaveLength(0);
		const out = await adapter.reply(s, { id: "x", source: s.key, native: "5", thread: "t", author: "Kim", text: "?", postTitle: "x", at: 0, mine: false, collector: "m" }, "감사합니다", "send:x");
		expect(out).toEqual({ ok: true, ref: "w1" });
		const hook = seen.find(x => x.url.endsWith("/hook"))!;
		expect(hook.auth).toBe("Bearer tok123");
		expect(JSON.parse(hook.body)).toMatchObject({ sendId: "send:x", commentId: "5", text: "감사합니다" });
	});
});
