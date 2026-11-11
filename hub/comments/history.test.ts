// The owner's past replies read back from the platform (adapter.history, engine.refreshPast): the adapters' rows, the pair file, the one-source-per-run schedule,
// the identity step and what a history read must never do (store a comment, draft, post, open a message room).
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runWatch } from "../../features/comments/bin/watch.ts";
import { loadPairs } from "../../features/reply-drafts/lib/settings.ts";
import { type Comment, type CommentAdapter, commentId, type RawComment, type SourceConfig } from "./contract.ts";
import { createEngine, type DraftModel } from "./engine.ts";
import { instagramAdapter, youtubeAdapter, type InstagramApi, type YoutubeApi } from "./adapters/google-meta.ts";
import { websiteAdapter } from "./adapters/website.ts";
import { PAST_TARGET, type PastPair } from "./past.ts";
import { realEngine } from "./real.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const DAY = 86_400_000;
const json = (o: object) => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "r", to: "", questions: [], body: "ok", ...o })}\n\`\`\``;
const src = (o: Partial<SourceConfig> = {}): SourceConfig => ({ key: "youtube", kind: "youtube", label: "y", watch: ["*"], autoDraft: false, ...o });
const pairRows = (n: number, at = NOW - DAY): RawComment[] =>
	Array.from({ length: n }, (_, i): RawComment[] => [
		{ native: `q${i}`, thread: "p", author: "A", text: `question ${i}?`, postTitle: "P", at: at - i * 1000 },
		{ native: `a${i}`, thread: "p", parent: `q${i}`, author: "me", text: `answer ${i}`, postTitle: "P", at: at - i * 1000 + 1, mine: true },
	]).flat();

let dir: string;
let before: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "history-"));
	before = process.env.DOTZ_DIR;
	process.env.DOTZ_DIR = dir;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (before === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = before;
});

function setup(sources: SourceConfig[], o: { history?: CommentAdapter["history"]; kind?: "youtube" | "website"; model?: DraftModel; list?: RawComment[]; identity?: (replies: string[], where: string) => Promise<unknown> } = {}) {
	const state = { now: NOW, historyCalls: [] as { key: string; target: number; deadline: number }[], identityCalls: [] as { replies: string[]; where: string }[], events: [] as Record<string, unknown>[], prompts: [] as string[], listed: o.list ?? [] };
	const files = new Map<string, PastPair[]>();
	const marks: Record<string, string> = {};
	const kind = o.kind ?? "youtube";
	const history: CommentAdapter["history"] | undefined = o.history && (async (s, opts) => (state.historyCalls.push({ key: s.key, ...opts }), o.history!(s, opts)));
	const adapter: CommentAdapter = { kind, list: async () => ({ comments: state.listed }), reply: async () => ({ ok: true }), ...(history ? { history } : {}) };
	const engine = createEngine({
		dir: join(dir, "custom", "comments"),
		now: () => state.now,
		collector: "m",
		adapters: { youtube: adapter, website: adapter },
		model: o.model ?? (async (_s, user) => (state.prompts.push(user), { text: json({}) })),
		broadcast: e => state.events.push(e),
		pairs: { load: k => files.get(k) ?? [], save: (k, l) => void files.set(k, l) },
		learned: { read: () => ({ ...marks }), mark: (m, at) => m.forEach(x => (marks[x] = at.toISOString())) },
		identity: async (_s, replies, where) => o.identity?.(replies, where) ?? state.identityCalls.push({ replies, where }),
	});
	engine.store.saveConfig({ enabled: true, sources: Object.fromEntries(sources.map(s => [s.key, s])) });
	return { engine, state, files, marks };
}
const due = (state: { now: number }) => ({ deadline: state.now + 400_000 });

describe("engine.refreshPast", () => {
	test("a past reply read back becomes a pair that reaches the draft prompt, and nothing is stored, drafted, posted or announced", async () => {
		const history = async (): Promise<RawComment[]> => [
			{ native: "h1", thread: "p", author: "A", text: "Where can I download the backing track?", postTitle: "P", at: NOW - 9e6 },
			{ native: "h1r", thread: "p", parent: "h1", author: "me", text: "It is linked in the description.", postTitle: "P", at: NOW - 8e6, mine: true },
		];
		const t = setup([src()], { history, list: [{ native: "n1", thread: "p", author: "C", text: "where to download the backing track please", postTitle: "P", at: NOW - 1000 }] });
		const r = await t.engine.refreshPast(due(t.state));
		expect(r).toMatchObject({ key: "youtube", status: "read", pairs: 1 });
		expect(t.state.historyCalls).toEqual([{ key: "youtube", target: PAST_TARGET, deadline: NOW + 400_000 }]);
		expect(t.files.get("youtube")).toHaveLength(1);
		expect(t.engine.store.comments()).toEqual([]);
		expect(t.engine.store.drafts()).toEqual([]);
		expect(t.engine.store.replies()).toEqual([]);
		expect(t.state.events).toEqual([]);
		await t.engine.collect({ force: true });
		expect((await t.engine.makeDraft(commentId("youtube", "n1"))).ok).toBe(true);
		expect(t.state.prompts[0]).toContain("<<<REPLY\nIt is linked in the description.\nREPLY>>>");
	});

	test("an empty history is a success; an adapter without history reads nothing and stays due", async () => {
		const empty = setup([src()], { history: async () => [] });
		expect(await empty.engine.refreshPast(due(empty.state))).toMatchObject({ status: "read", pairs: 0 });
		expect(empty.marks["pairs-youtube@1"]).toBeDefined();
		expect(empty.files.size).toBe(0);
		expect(empty.state.identityCalls).toEqual([]);
		const none = setup([src()]);
		expect(await none.engine.refreshPast(due(none.state))).toBeUndefined();
		expect(none.marks).toEqual({});
	});

	test("at most the newest PAST_TARGET pairs are kept", async () => {
		const t = setup([src()], { history: async () => pairRows(PAST_TARGET + 100) });
		await t.engine.refreshPast(due(t.state));
		const kept = t.files.get("youtube")!;
		expect(kept).toHaveLength(PAST_TARGET);
		expect(kept.some(p => p.reply === "answer 0")).toBe(true);
		expect(kept.some(p => p.reply === `answer ${PAST_TARGET + 99}`)).toBe(false);
	});

	test("a failing source waits 24 h before it is read again", async () => {
		const t = setup([src()], {
			history: async () => {
				throw new Error("site down");
			},
		});
		expect(await t.engine.refreshPast(due(t.state))).toMatchObject({ status: "failed", error: "site down" });
		expect(t.marks["pairs-youtube~tried"]).toBeDefined();
		expect(t.marks["pairs-youtube@1"]).toBeUndefined();
		t.state.now += 3600_000;
		expect(await t.engine.refreshPast(due(t.state))).toBeUndefined();
		expect(t.state.historyCalls).toHaveLength(1);
		t.state.now += 24 * 3600_000;
		await t.engine.refreshPast(due(t.state));
		expect(t.state.historyCalls).toHaveLength(2);
	});

	test("one source per run; a source with nothing chosen is skipped", async () => {
		const t = setup([src({ key: "s0", watch: [] }), src({ key: "s1" }), src({ key: "s2" })], { history: async () => pairRows(2) });
		expect((await t.engine.refreshPast(due(t.state)))?.key).toBe("s1");
		expect((await t.engine.refreshPast(due(t.state)))?.key).toBe("s2");
		expect(await t.engine.refreshPast(due(t.state))).toBeUndefined();
		expect(t.state.historyCalls.map(c => c.key)).toEqual(["s1", "s2"]);
		expect(t.files.has("s0")).toBe(false);
	});

	test("setting a source up reads that source now, even one that failed a minute ago", async () => {
		let fail = true;
		const t = setup([src()], { history: async () => (fail ? Promise.reject(new Error("x")) : pairRows(1)) });
		await t.engine.refreshPast(due(t.state));
		fail = false;
		expect(await t.engine.refreshPast({ ...due(t.state), key: "youtube" })).toMatchObject({ status: "read", pairs: 1 });
		expect(await t.engine.refreshPast({ ...due(t.state), key: "youtube" })).toMatchObject({ status: "known" });
	});

	test("the identity is learned once, and only from 20 replies; a model failure keeps the pairs", async () => {
		const few = setup([src()], { history: async () => pairRows(19) });
		await few.engine.refreshPast(due(few.state));
		expect(few.state.identityCalls).toEqual([]);
		const t = setup([src()], { history: async () => pairRows(25) });
		await t.engine.refreshPast(due(t.state));
		await t.engine.refreshPast(due(t.state));
		expect(t.state.identityCalls).toHaveLength(1);
		expect(t.state.identityCalls[0]!.replies).toHaveLength(25);
		expect(t.state.identityCalls[0]!.replies[0]).toContain("answer 0\n> question 0?");
		expect(t.state.identityCalls[0]!.where).toBe("유튜브 댓글");
		const log = spyOn(console, "error").mockImplementation(() => {});
		const broken = setup([src()], { history: async () => pairRows(25), identity: async () => Promise.reject(new Error("model down")) });
		expect(await broken.engine.refreshPast(due(broken.state))).toMatchObject({ status: "read", pairs: 25 });
		expect(broken.files.get("youtube")).toHaveLength(25);
		expect(broken.marks["pairs-youtube@1"]).toBeDefined();
		expect(log).toHaveBeenCalledTimes(1);
		log.mockRestore();
	});

	test("an unchanged bot draft is not learned, not even when the platform trimmed it; a short real reply stays", async () => {
		const bot = "Thanks a lot for watching, see you next time everyone!";
		const t = setup([src()], {
			history: async () => [
				{ native: "q1", thread: "p", author: "A", text: "nice one", postTitle: "P", at: NOW - 3000 },
				{ native: "r1", thread: "p", parent: "q1", author: "me", text: bot, postTitle: "P", at: NOW - 2900, mine: true },
				{ native: "q2", thread: "p", author: "B", text: "great video", postTitle: "P", at: NOW - 2000 },
				{ native: "r2", thread: "p", parent: "q2", author: "me", text: bot.slice(0, -1), postTitle: "P", at: NOW - 1900, mine: true },
				{ native: "q3", thread: "p", author: "C", text: "thanks", postTitle: "P", at: NOW - 1000 },
				{ native: "r3", thread: "p", parent: "q3", author: "me", text: "Thanks a lot", postTitle: "P", at: NOW - 900, mine: true },
			],
		});
		t.engine.store.putDraft({ code: "D1", commentId: "x", source: "youtube", thread: "p", text: bot, status: "sent", created: NOW, changes: [], clean: true, notes: [] });
		await t.engine.refreshPast(due(t.state));
		expect(t.files.get("youtube")!.map(p => p.reply)).toEqual(["Thanks a lot"]);
	});

	test("a site's private-message source pairs a parentless reply with the message before it; a comment source never does", async () => {
		const rows: RawComment[] = [
			{ native: "m0", thread: "dm:r1", author: "B", text: "hello", postTitle: "x", at: 1000 },
			{ native: "m1", thread: "dm:r1", author: "B", text: "can you send the score?", postTitle: "x", at: 2000 },
			{ native: "m2", thread: "dm:r1", author: "me", text: "Sure, sending it now.", postTitle: "x", at: 3000, mine: true },
		];
		const room = setup([src({ key: "site-a", kind: "website" })], { kind: "website", history: async () => rows });
		await room.engine.refreshPast(due(room.state));
		expect(room.files.get("site-a")).toMatchObject([{ comment: "can you send the score?", reply: "Sure, sending it now." }]);
		const plain = setup([src()], { history: async () => rows });
		await plain.engine.refreshPast(due(plain.state));
		expect(plain.files.has("youtube")).toBe(false);
	});

	test("the watch reads one source after its collect while the run is under budget, and only saves the store's pairs when it is not", async () => {
		const t = setup([src({ key: "s1" }), src({ key: "s2" })], { history: async () => pairRows(1) });
		await runWatch(dir, t.engine, async () => {}, Date.now() + 240_000);
		expect(t.state.historyCalls.map(c => c.key)).toEqual(["s1"]);
		await runWatch(dir, t.engine, async () => {}, Date.now() - 1);
		expect(t.state.historyCalls).toHaveLength(1);
	});
});

describe("the pair file of a real engine", () => {
	test("a store that trims its old rows loses no pair, and an edited mark is never dropped by a re-read", async () => {
		const engine = realEngine(dir, { model: async () => ({ text: "" }) });
		const store = engine.store;
		store.saveConfig({ enabled: true, sources: { youtube: src() } });
		const row = (native: string, text: string, o: Partial<Comment> = {}): Comment => ({ id: commentId("youtube", native), source: "youtube", native, thread: "p", author: "A", text, postTitle: "P", at: NOW - 5000, mine: false, collector: "m", ...o });
		store.addComments([row("q1", "first question?"), row("a1", "first answer", { parent: "q1", mine: true, author: "me", at: NOW - 4000 }), row("q2", "second question?")]);
		store.putReply({ id: "send:q2", commentId: commentId("youtube", "q2"), source: "youtube", thread: "p", text: "second answer", state: "sent", at: NOW - 3000, draft: "D2", via: "owner", collector: "m" });
		store.putDraft({ code: "D2", commentId: commentId("youtube", "q2"), source: "youtube", thread: "p", text: "second answer", status: "sent", created: NOW, changes: ["shorter"], clean: true, notes: [] });
		await engine.refreshPast({ deadline: NOW, read: false });
		const saved = () => Object.fromEntries(loadPairs("youtube").map(p => [p.reply, p]));
		expect(Object.keys(saved()).sort()).toEqual(["first answer", "second answer"]);
		expect(saved()["second answer"]!.edited).toBe(true);
		expect(saved()["first answer"]!.thread).toBe("p");
		writeFileSync(join(dir, "custom", "comments", "comments.json"), "[]");
		writeFileSync(join(dir, "custom", "comments", "drafts.json"), "[]");
		await engine.refreshPast({ deadline: NOW, read: false });
		expect(Object.keys(saved()).sort()).toEqual(["first answer", "second answer"]);
		store.addComments([row("q2", "second question?")]);
		store.putReply({ id: "send:q2", commentId: commentId("youtube", "q2"), source: "youtube", thread: "p", text: "second answer", state: "sent", at: NOW - 3000, draft: "D9", via: "owner", collector: "m" });
		await engine.refreshPast({ deadline: NOW, read: false });
		expect(saved()["second answer"]!.edited).toBe(true);
	});
});

describe("adapters' history", () => {
	test("YouTube: the top comment and the channel's replies as rows, with no title lookup", async () => {
		let titles = 0;
		const seen: unknown[] = [];
		const api = {
			channelId: () => "UCme",
			videos: async () => (titles++, {}),
			history: async (id: string, opts: unknown) => (
				seen.push([id, opts]),
				[{ id: "t1", videoId: "v1", author: "A", authorChannelId: "UCfan", text: "q", publishedAt: "2026-10-01T00:00:00Z", replied: true, ownerReplies: [{ id: "r1", parentId: "t1", author: "me", text: "a", publishedAt: "2026-10-02T00:00:00Z" }] }]
			),
		} as unknown as YoutubeApi;
		const rows = await youtubeAdapter(() => api).history!(src(), { target: 5, deadline: 9 });
		expect(seen).toEqual([["UCme", { target: 5, deadline: 9 }]]);
		expect(rows).toMatchObject([{ native: "t1", thread: "v1", mine: false }, { native: "r1", parent: "t1", mine: true, text: "a" }]);
		expect(titles).toBe(0);
	});

	const comment = (id: string, username: string, text: string, timestamp: string) => ({ id, username, text, timestamp, replies: [] });
	const igApi = (reads: string[], o: { bad?: string } = {}) =>
		({
			username: () => "owner_ig",
			media: async () => ["m1", "m2", "m3", "empty"].map(id => ({ id, comments_count: id === "empty" ? 0 : 2, timestamp: "2026-10-01T00:00:00+0000" })),
			comments: async (id: string) => {
				reads.push(id);
				if (id === o.bad) throw new Error("no access");
				return [comment(`${id}c1`, "fan", "where?", "2026-10-01T00:00:00+0000"), comment(`${id}c2`, "owner_ig", "@fan look at the link", "2026-10-01T01:00:00+0000")];
			},
			reply: async () => "x",
		}) as unknown as InstagramApi;

	test("Instagram: an own top-level comment that @mentions an earlier author answers that comment; a media that fails is skipped", async () => {
		const reads: string[] = [];
		const rows = await instagramAdapter(() => igApi(reads, { bad: "m1" })).history!(src({ kind: "instagram", key: "instagram" }), { target: 100, deadline: Date.now() + 1e6 });
		expect(reads).toEqual(["m1", "m2", "m3"]);
		expect(rows.filter(r => r.mine)).toMatchObject([{ native: "m2c2", parent: "m2c1" }, { native: "m3c2", parent: "m3c1" }]);
		expect(rows.filter(r => !r.mine).map(r => r.native)).toEqual(["m2c1", "m3c1"]);
	});

	test("Instagram: stops at the target; every media failing is an error; a passed deadline reads nothing", async () => {
		const reads: string[] = [];
		const a = instagramAdapter(() => igApi(reads));
		await a.history!(src({ kind: "instagram", key: "instagram" }), { target: 2, deadline: Date.now() + 1e6 });
		expect(reads).toEqual(["m1", "m2"]);
		const all = instagramAdapter(() => ({ ...igApi([]), comments: async () => Promise.reject(new Error("down")) }) as unknown as InstagramApi);
		await expect(all.history!(src({ kind: "instagram", key: "instagram" }), { target: 100, deadline: Date.now() + 1e6 })).rejects.toThrow("down");
		const late: string[] = [];
		expect(await instagramAdapter(() => igApi(late)).history!(src({ kind: "instagram", key: "instagram" }), { target: 100, deadline: 0 })).toEqual([]);
		expect(late).toEqual([]);
	});

	const site = (read: object): SourceConfig => src({ key: "site-a", kind: "website", site: { read: read as never, post: { kind: "script", command: ["post"] }, dm: { read: { kind: "script", command: ["{site}/dm.ts"] }, post: { kind: "script", command: ["dm-post"] } } } });
	const body = JSON.stringify({ comments: [{ id: "1", thread: "t", author: "A", text: "q", at: 1 }, { id: "2", thread: "t", parent: "1", author: "me", text: "a", at: 2, mine: true }] });

	test("a site script is read once with --since 1, at most 240 s and never past the deadline; the message inbox is never read", async () => {
		const execs: { argv: string[]; timeout?: number }[] = [];
		const adapter = websiteAdapter({ exec: async (argv, _in, timeout) => (execs.push({ argv, timeout }), { code: 0, stdout: body, stderr: "" }), fetch: (async () => new Response("")) as unknown as typeof fetch, secretsDir: dir, siteDir: "/sites" });
		const rows = await adapter.history!(site({ kind: "script", command: ["bun", "{site}/read.ts"] }), { target: 1000, deadline: Date.now() + 1e7 });
		expect(execs).toEqual([{ argv: ["bun", "/sites/read.ts", "--since", "1"], timeout: 240_000 }]);
		await adapter.history!(site({ kind: "script", command: ["bun", "{site}/read.ts"] }), { target: 1000, deadline: 0 });
		expect(execs[1]!.timeout).toBe(1_000);
		expect(rows).toMatchObject([{ native: "1" }, { native: "2", parent: "1", mine: true }]);
	});

	test("a JSON site gets ?since=1, an RSS feed its normal read, and a failing read throws", async () => {
		const urls: string[] = [];
		const adapter = websiteAdapter({
			exec: async () => ({ code: 3, stdout: "", stderr: "script broke" }),
			fetch: (async (url: URL) => (urls.push(String(url)), new Response(url.pathname.endsWith("rss") ? "<rss></rss>" : body))) as unknown as typeof fetch,
			secretsDir: dir,
			siteDir: "/sites",
		});
		expect(await adapter.history!(site({ kind: "json", url: "https://s.example/api" }), { target: 1, deadline: 0 })).toHaveLength(2);
		await adapter.history!(site({ kind: "rss", url: "https://s.example/rss" }), { target: 1, deadline: 0 });
		expect(urls).toEqual(["https://s.example/api?since=1", "https://s.example/rss"]);
		await expect(adapter.history!(site({ kind: "script", command: ["x"] }), { target: 1, deadline: 0 })).rejects.toThrow("script broke");
	});
});
