// Comments follow the platform: owner replies found later, deleted comments, Instagram reply authors and their re-keying, and the pending drafts
// that settle (reconcile is safe to run again). Fake adapters and stubs only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IgComment, IgMedia } from "../../features/youtube-instagram/lib/instagram.ts";
import type { YtComment } from "../../features/youtube-instagram/lib/youtube.ts";
import { type InstagramApi, instagramAdapter, type YoutubeApi, youtubeAdapter } from "./adapters/google-meta.ts";
import { type Comment, type CommentAdapter, type RawComment, type SourceConfig, type SourceKind, toComment } from "./contract.ts";
import { createEngine, MAIL_KEPT_NOTE } from "./engine.ts";
import { createStore, type Draft } from "./store.ts";

const NOW = Date.parse("2030-06-16T00:00:00.000Z");
const DAY = 24 * 3600 * 1000;
const UNKNOWN = "알 수 없는 사용자";
const draft = (o: Partial<Draft> & Pick<Draft, "code" | "commentId" | "source">): Draft => ({ thread: "p1", text: "곧 보내 드릴게요", status: "pending", created: NOW, changes: [], clean: true, notes: [], ...o });
const raw = (native: string, o: Partial<RawComment> = {}): RawComment => ({ native, thread: "p1", author: "A", text: `question ${native}?`, postTitle: "Post one", at: NOW - DAY, ...o });
const FILES = ["comments", "drafts", "replies", "cursors", "dismissed", "authors"];

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "reconcile-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const snapshot = () => FILES.map(f => (existsSync(join(dir, `${f}.json`)) ? readFileSync(join(dir, `${f}.json`), "utf8") : ""));
const config = (sources: SourceConfig[]) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: Object.fromEntries(sources.map(s => [s.key, s])) }));
};
const source = (key: string, kind: SourceKind, o: Partial<SourceConfig> = {}): SourceConfig => ({ key, kind, label: key, watch: ["*"], autoDraft: false, ...o });

function fake(kind: SourceKind) {
	const st = { pages: [] as RawComment[][], batches: [] as string[][], recheck: undefined as undefined | ((open: Comment[]) => { comments: RawComment[]; gone: string[] }) };
	const adapter: CommentAdapter = {
		kind,
		list: async () => ({ comments: st.pages.shift() ?? [] }),
		reply: async () => ({ ok: true }),
		recheck: async (_s, open) => (st.batches.push(open.map(c => c.native)), st.recheck?.(open) ?? { comments: [], gone: [] }),
	};
	return { st, adapter };
}

function engineWith(adapters: Partial<Record<SourceKind, CommentAdapter>>) {
	const dropped: string[] = [];
	const engine = createEngine({ dir, now: () => NOW, collector: "t", adapters, mail: { compose: async () => ({ ok: false, reason: "n/a" }), send: async () => ({ ok: true, text: "" }), drop: id => dropped.push(id), revise: async () => ({ ok: false, reason: "n/a" }), view: () => undefined } });
	return { engine, dropped };
}

describe("owner replies that come in later close the comment and its draft", () => {
	test("a website comment answered the next day: the read now carries his reply, the draft settles and its mail stays", async () => {
		config([source("site-mapia", "website")]);
		const site = fake("website");
		const { engine, dropped } = engineWith({ website: site.adapter });
		site.st.pages = [[raw("c1", { author: "구독자셋", text: "자료 구입했습니다~ 파일 부탁드립니다! a@naver.com" })]];
		await engine.collect({ force: true });
		engine.store.putDraft(draft({ code: "D2jwqz9", commentId: "cm:site-mapia:c1", source: "site-mapia", mail: "mail1", mailAt: NOW, clean: false }));
		expect(engine.unreplied(engine.store.comments()[0]!)).toBe(true);

		site.st.pages = [[raw("c1.r", { parent: "c1", author: "나", text: "보내 드렸어요", at: NOW - DAY / 2, mine: true })]];
		await engine.collect({ force: true });
		const d = engine.store.drafts()[0]!;
		expect(d).toMatchObject({ code: "D2jwqz9", status: "answered", closedReason: "answered-on-platform" });
		expect(d.mail).toBeUndefined();
		expect(d.notes).toContain(MAIL_KEPT_NOTE);
		expect(dropped).toEqual([]);
		expect(engine.unreplied(engine.store.comments().find(c => c.native === "c1")!)).toBe(false);
		expect(engine.pendingDrafts()).toEqual([]);
	});

	test("an old comment first stored together with his reply is neither unread nor 미답장", async () => {
		config([source("site-mapia", "website")]);
		const site = fake("website");
		const { engine } = engineWith({ website: site.adapter });
		site.st.pages = [[raw("c9", { at: NOW - 9 * DAY }), raw("c9.r", { parent: "c9", author: "나", text: "메일로 보내드렸어요", at: NOW - 8 * DAY, mine: true }), raw("c10", { at: NOW - DAY })]];
		await engine.collect({ force: true });
		expect(engine.needs()["site"]).toMatchObject({ unread: 1, unreplied: 1 });
		expect(engine.unreplied(engine.store.comments().find(c => c.native === "c9")!)).toBe(false);
	});

	test("YouTube: an old thread answered later is found by the re-check, which stores the reply under the comment", async () => {
		config([source("youtube", "youtube")]);
		const state = { threads: {} as Record<string, { videoId: string; replies: { id: string; parentId: string; author: string; text: string; publishedAt: string }[] }>, ids: [] as string[][] };
		const api: YoutubeApi = {
			channelId: () => "UCme",
			threadsSince: async () => ({ comments: [{ id: "hwa", videoId: "p1", author: "@구독자둘", authorChannelId: "UCfan", text: "진짜 직접 만드신 건가요?", publishedAt: new Date(NOW - DAY).toISOString(), replied: false } satisfies YtComment], newest: "n" }),
			uploads: async () => [],
			videos: async ids => Object.fromEntries(ids.map(i => [i, { title: "소개 영상" }])),
			reply: async () => "r",
			ownReplies: async () => [],
			threadsByIds: async (_c, ids) => (state.ids.push(ids), state.threads),
		};
		const { engine } = engineWith({ youtube: youtubeAdapter(() => api) });
		state.threads = { hwa: { videoId: "p1", replies: [] } };
		await engine.collect({ force: true });
		engine.store.putDraft(draft({ code: "Dhwa", commentId: "cm:youtube:hwa", source: "youtube" }));
		expect(await engine.reconcile({ recheck: true })).toEqual({ answered: 0, gone: 0, draftsClosed: 0 });

		state.threads = { hwa: { videoId: "p1", replies: [{ id: "hwa.1", parentId: "hwa", author: "지수", text: "감사합니다", publishedAt: new Date(NOW - DAY + 5 * 60_000).toISOString() }] } };
		expect(await engine.reconcile({ recheck: true })).toEqual({ answered: 1, gone: 0, draftsClosed: 1 });
		expect(engine.store.comments().find(c => c.native === "hwa.1")).toMatchObject({ mine: true, parent: "hwa", thread: "p1", postTitle: "소개 영상" });
		expect(engine.store.drafts()[0]).toMatchObject({ status: "answered", closedReason: "answered-on-platform" });
		expect(engine.needs().youtube?.unreplied).toBe(0);
		expect(state.ids[0]).toEqual(["hwa"]);
	});

	test("YouTube list also stores the owner's replies it already reads", async () => {
		const reply = { id: "t.1", parentId: "t", author: "지수", text: "네", publishedAt: new Date(NOW - 1000).toISOString() };
		const api: YoutubeApi = {
			channelId: () => "UCme",
			threadsSince: async () => ({ comments: [{ id: "t", videoId: "p1", author: "fan", authorChannelId: "UCfan", text: "q", publishedAt: new Date(NOW - 5000).toISOString(), replied: true, ownerReplies: [reply] }] }),
			uploads: async () => [],
			videos: async () => ({}),
			reply: async () => "r",
			ownReplies: async () => [],
		};
		const out = await youtubeAdapter(() => api).list(source("youtube", "youtube"), undefined);
		expect(out.comments.map(c => [c.native, c.parent ?? null, c.mine === true])).toEqual([["t", null, false], ["t.1", "t", true]]);
	});
});

describe("deleted and dismissed comments", () => {
	test("a comment the platform no longer has is gone for good: not unreplied, its draft closes as deleted", async () => {
		config([source("youtube", "youtube")]);
		const yt = fake("youtube");
		const { engine } = engineWith({ youtube: yt.adapter });
		yt.st.pages = [[raw("c1"), raw("c2")]];
		await engine.collect({ force: true });
		engine.store.putDraft(draft({ code: "Dgone", commentId: "cm:youtube:c2", source: "youtube" }));
		yt.st.recheck = open => ({ comments: [], gone: open.filter(c => c.native === "c2").map(c => c.native) });
		expect(await engine.reconcile({ recheck: true })).toEqual({ answered: 0, gone: 1, draftsClosed: 1 });
		expect(engine.store.drafts()[0]).toMatchObject({ status: "answered", closedReason: "deleted" });
		expect(engine.needs().youtube?.unreplied).toBe(1);
		expect(engine.threadView("youtube", "p1")!.comments.find(c => c.id === "cm:youtube:c2")).toMatchObject({ gone: true, unreplied: false, needsReply: false });

		yt.st.pages = [[raw("c2")]];
		yt.st.recheck = undefined;
		await engine.collect({ force: true });
		await engine.reconcile({ recheck: true });
		expect(engine.store.comments().find(c => c.native === "c2")!.gone).toBe(NOW);
	});

	test("a draft of a comment he marked 답장 안 함 closes as dismissed", async () => {
		config([source("youtube", "youtube")]);
		const yt = fake("youtube");
		const { engine } = engineWith({ youtube: yt.adapter });
		yt.st.pages = [[raw("c1")]];
		await engine.collect({ force: true });
		engine.store.putDraft(draft({ code: "Dno", commentId: "cm:youtube:c1", source: "youtube" }));
		engine.noReply("cm:youtube:c1");
		expect((await engine.reconcile()).draftsClosed).toBe(1);
		expect(engine.store.drafts()[0]).toMatchObject({ status: "answered", closedReason: "dismissed" });
	});
});

describe("reconcile is idempotent", () => {
	test("a second run changes nothing, a closed draft is never reopened or sent, and a comment with his reply stays answered", async () => {
		config([source("youtube", "youtube")]);
		const yt = fake("youtube");
		const { engine } = engineWith({ youtube: yt.adapter });
		yt.st.pages = [[raw("c1"), raw("c2"), raw("c3")]];
		await engine.collect({ force: true });
		for (const n of ["c1", "c2", "c3"]) engine.store.putDraft(draft({ code: `D${n}`, commentId: `cm:youtube:${n}`, source: "youtube" }));
		yt.st.recheck = open => ({ comments: open.filter(c => c.native === "c1").map(c => raw("c1.r", { parent: c.native, mine: true, at: NOW - 1000 })), gone: ["c2"] });
		const first = await engine.reconcile({ recheck: true });
		expect(first).toEqual({ answered: 1, gone: 1, draftsClosed: 2 });
		const after = snapshot();
		expect(await engine.reconcile({ recheck: true })).toEqual({ answered: 0, gone: 0, draftsClosed: 0 });
		expect(snapshot()).toEqual(after);

		const statuses = Object.fromEntries(engine.store.drafts().map(d => [d.code, d.status]));
		expect(statuses).toEqual({ Dc1: "answered", Dc2: "answered", Dc3: "pending" });
		expect(engine.restore("Dc1")).toMatchObject({ ok: false });
		expect(engine.drop("Dc1")).toMatchObject({ ok: false });
		expect(engine.send("Dc1", { by: "owner" })).toMatchObject({ ok: false });
		yt.st.pages = [[raw("c1")]];
		await engine.collect({ force: true });
		expect(engine.store.drafts().find(d => d.code === "Dc1")!.status).toBe("answered");
		expect(engine.unreplied(engine.store.comments().find(c => c.native === "c1")!)).toBe(false);
	});

	test("a failing re-check is reported and settles nothing it could not confirm", async () => {
		config([source("youtube", "youtube")]);
		const yt = fake("youtube");
		const { engine } = engineWith({ youtube: yt.adapter });
		yt.st.pages = [[raw("c1")]];
		await engine.collect({ force: true });
		engine.store.putDraft(draft({ code: "Dc1", commentId: "cm:youtube:c1", source: "youtube" }));
		yt.st.recheck = () => {
			throw new Error("youtube http 503");
		};
		const r = await engine.reconcile({ recheck: true });
		expect(r).toMatchObject({ answered: 0, gone: 0, draftsClosed: 0, errors: { youtube: "youtube http 503" } });
		expect(engine.store.drafts()[0]!.status).toBe("pending");
	});

	test("a capped run rotates through the open comments oldest first", async () => {
		config([source("youtube", "youtube")]);
		const yt = fake("youtube");
		const { engine } = engineWith({ youtube: yt.adapter });
		yt.st.pages = [Array.from({ length: 450 }, (_, i) => raw(`c${String(i).padStart(3, "0")}`, { at: NOW - 2 * DAY + i * 1000 }))];
		await engine.collect({ force: true });
		for (let i = 0; i < 2; i++) await engine.reconcile({ recheck: true });
		expect(yt.st.batches.map(b => b.length)).toEqual([200, 200, 200]);
		expect(yt.st.batches[2]![0]).toBe("c400");
		expect(new Set(yt.st.batches.flat()).size).toBe(450);
		expect(yt.st.batches[0]![0]).toBe("c000");
		expect(yt.st.batches[1]![0]).toBe("c200");
	});
});

describe("Instagram reply authors", () => {
	const top = (id: string, username: string, timestamp: string, text: string, o: Partial<IgComment> = {}): IgComment => ({ id, text, username, timestamp, replies: [], ...o });
	function ig(state: { list: IgComment[]; complete: boolean; authors: Record<string, { username?: string; fromId?: string }>; lookups: string[]; withAuthor: boolean }) {
		const store = createStore(dir);
		const api: InstagramApi = {
			username: () => "owner_ig",
			userId: () => "17841",
			media: async (): Promise<IgMedia[]> => [{ id: "m1", caption: "post", comments_count: state.list.length, timestamp: "2030-06-01T00:00:00Z" }],
			comments: async () => state.list,
			read: async () => ({ comments: state.list, complete: state.complete }),
			reply: async () => "ref",
			...(state.withAuthor
				? {
						author: async (id: string) => {
							state.lookups.push(id);
							const a = state.authors[id];
							if (!a) throw new Error("gone");
							return a;
						},
						authorCache: { get: (id: string) => store.authors()[id], put: (e: Record<string, { username?: string; fromId?: string }>) => store.putAuthors(e) },
					}
				: {}),
		};
		return createEngine({ dir, now: () => NOW, collector: "t", adapters: { instagram: instagramAdapter(() => api) } });
	}
	const fresh = () => ({ list: [] as IgComment[], complete: true, authors: {} as Record<string, { username?: string; fromId?: string }>, lookups: [] as string[], withAuthor: true });

	test("issue #31: a reply the comments edge also lists on its own is stored once, under its comment, with its real id, author and time", async () => {
		config([source("instagram", "instagram")]);
		const state = fresh();
		state.list = [
			top("k1", "fan1", "2030-06-15T12:10:00+0000", "자료 부탁드려요", { replies: [{ id: "r1", username: "owner_ig", fromId: "17841", text: "보내 드렸어요", timestamp: "2030-06-15T13:00:00+0000" }, { id: "r2", username: "fan2", text: "저도요", timestamp: "2030-06-15T14:00:00+0000" }] }),
			top("r1", "owner_ig", "2030-06-15T13:00:00+0000", "보내 드렸어요", { fromId: "17841", parentId: "k1" }),
			top("r2", "fan2", "2030-06-15T14:00:00+0000", "저도요"),
			top("r3", "owner_ig", "2030-06-15T15:00:00+0000", "@fan2 보내 드릴게요", { fromId: "17841", parentId: "k1" }),
		];
		const engine = ig(state);
		await engine.collect({ force: true });
		const rows = engine.store.comments().map(c => ({ n: c.native, p: c.parent ?? null, a: c.author, mine: c.mine, at: new Date(c.at).toISOString() }));
		expect(rows).toEqual([
			{ n: "k1", p: null, a: "fan1", mine: false, at: "2030-06-15T12:10:00.000Z" },
			{ n: "r1", p: "k1", a: "owner_ig", mine: true, at: "2030-06-15T13:00:00.000Z" },
			{ n: "r2", p: "k1", a: "fan2", mine: false, at: "2030-06-15T14:00:00.000Z" },
			{ n: "r3", p: "k1", a: "owner_ig", mine: true, at: "2030-06-15T15:00:00.000Z" },
		]);
		expect(engine.unreplied(engine.store.comments()[0]!)).toBe(false);
	});

	test("issue #31: stored twins (`<comment>.<n>` copy and the real reply on its own) become one row under the comment, once", async () => {
		config([source("instagram", "instagram")]);
		const seed = (o: Partial<Comment> & Pick<Comment, "native" | "at">): Comment => ({ id: `cm:instagram:${o.native}`, source: "instagram", thread: "m1", author: UNKNOWN, text: "", postTitle: "post", mine: false, collector: "t", ...o });
		const store = createStore(dir);
		store.addComments([
			seed({ native: "k1", author: "fan1", text: "자료 부탁드려요", at: NOW - 3 * DAY }),
			seed({ native: "k1.0", parent: "k1", text: "❤️", at: NOW - 3 * DAY + 1 }),
			seed({ native: "k1.1", parent: "k1", text: "보내 드렸어요", at: NOW - 3 * DAY + 2 }),
			seed({ native: "k2", author: "fan2", text: "멋져요", at: NOW - 2 * DAY }),
			seed({ native: "k2.0", parent: "k2", text: "❤️", at: NOW - 2 * DAY + 1 }),
			seed({ native: "r1", author: "owner_ig", text: "❤️", mine: true, at: NOW - 3 * DAY + 600_000 }),
			seed({ native: "r2", author: "owner_ig", text: "보내 드렸어요", mine: true, at: NOW - 3 * DAY + 900_000 }),
			seed({ native: "r3", author: "owner_ig", text: "❤️", mine: true, at: NOW - 2 * DAY + 600_000 }),
		]);
		store.putDraft(draft({ code: "Dsyn", commentId: "cm:instagram:k1.1", source: "instagram", thread: "m1", status: "dropped" }));
		store.putDraft(draft({ code: "Dk2", commentId: "cm:instagram:k2", source: "instagram", thread: "m1" }));
		const { engine } = engineWith({});
		expect(await engine.reconcile()).toEqual({ answered: 0, gone: 0, draftsClosed: 1, merged: 3 });
		const rows = engine.store.comments().map(c => [c.native, c.parent ?? null, c.author, c.mine]);
		expect(rows).toEqual([["k1", null, "fan1", false], ["r1", "k1", "owner_ig", true], ["r2", "k1", "owner_ig", true], ["k2", null, "fan2", false], ["r3", "k2", "owner_ig", true]]);
		expect(engine.store.drafts().find(d => d.code === "Dsyn")!.commentId).toBe("cm:instagram:r2");
		expect(engine.store.drafts().find(d => d.code === "Dk2")).toMatchObject({ status: "answered", closedReason: "answered-on-platform" });
		const before = snapshot();
		expect(await engine.reconcile()).toEqual({ answered: 0, gone: 0, draftsClosed: 0 });
		expect(snapshot()).toEqual(before);
	});

	test("issue #31: his reply stored top-level finds its comment by one re-read of its post, never marked gone, and the pass runs once", async () => {
		config([source("instagram", "instagram")]);
		const state = fresh();
		const store = createStore(dir);
		store.addComments([
			{ id: "cm:instagram:k1", source: "instagram", native: "k1", thread: "m1", author: "fan1", text: "고마워요", postTitle: "post", at: NOW - 2 * DAY, mine: false, collector: "t" },
			{ id: "cm:instagram:r9", source: "instagram", native: "r9", thread: "m1", author: "owner_ig", text: "❤️", postTitle: "post", at: NOW - DAY, mine: true, collector: "t" },
		]);
		state.list = [top("k1", "fan1", "2030-06-14T00:00:00+0000", "고마워요", { replies: [{ id: "r9", username: "owner_ig", fromId: "17841", text: "❤️", timestamp: "2030-06-15T00:00:00+0000" }] })];
		let reads = 0;
		const engine = ig({ ...state, list: new Proxy(state.list, { get: (t, p) => (p === "length" && reads++, Reflect.get(t, p)) }) as IgComment[] });
		await engine.reconcile({ recheck: true });
		expect(engine.store.comments().find(c => c.native === "r9")).toMatchObject({ parent: "k1", mine: true });
		expect(engine.store.comments().some(c => c.gone)).toBe(false);
		expect(engine.store.cursors()["instagram#parents"]).toBeDefined();
		reads = 0;
		await engine.reconcile({ recheck: true });
		expect(reads).toBe(0);
	});

	test("his reply without an author is resolved by a single GET, cached for good, and the position-keyed row is replaced with its drafts kept", async () => {
		config([source("instagram", "instagram")]);
		const state = fresh();
		state.withAuthor = false;
		state.list = [top("k1", "fan1", "2030-06-15T12:10:00Z", "자료 부탁드려요", { replies: [{ username: UNKNOWN, text: "보내 드렸어요", timestamp: "2030-06-15T13:00:00Z" }] })];
		const old = ig(state);
		await old.collect({ force: true });
		expect(old.store.comments().map(c => c.id)).toEqual(["cm:instagram:k1", "cm:instagram:k1.0"]);
		expect(old.store.comments()[1]).toMatchObject({ author: UNKNOWN, mine: false });
		old.store.putDraft(draft({ code: "Dk1", commentId: "cm:instagram:k1", source: "instagram", thread: "m1" }));
		old.store.putDraft(draft({ code: "Dold", commentId: "cm:instagram:k1.0", source: "instagram", thread: "m1", status: "dropped" }));

		state.withAuthor = true;
		state.list = [top("k1", "fan1", "2030-06-15T12:10:00Z", "자료 부탁드려요", { replies: [{ id: "r1", username: UNKNOWN, text: "보내 드렸어요", timestamp: "2030-06-15T13:00:00Z" }] })];
		state.authors = { r1: { username: "owner_ig", fromId: "17841" } };
		const engine = ig(state);
		expect(await engine.reconcile({ recheck: true })).toEqual({ answered: 1, gone: 0, draftsClosed: 1 });
		const ids = engine.store.comments().map(c => c.id);
		expect(ids).toEqual(["cm:instagram:k1", "cm:instagram:r1"]);
		expect(engine.store.comments()[1]).toMatchObject({ author: "owner_ig", mine: true, parent: "k1", text: "보내 드렸어요" });
		expect(engine.store.drafts().map(d => [d.code, d.commentId, d.status]).sort()).toEqual([["Dk1", "cm:instagram:k1", "answered"], ["Dold", "cm:instagram:r1", "dropped"]]);
		expect(state.lookups).toEqual(["r1"]);
		expect(engine.store.authors()).toEqual({ r1: { username: "owner_ig", fromId: "17841" } });

		const again = snapshot();
		await engine.reconcile({ recheck: true });
		expect(state.lookups).toEqual(["r1"]);
		expect(snapshot()).toEqual(again);
	});

	test("replaceComments moves the drafts, the send record and 답장 안 함 of a re-keyed comment and drops a duplicate of the new id", () => {
		config([source("instagram", "instagram")]);
		const store = createStore(dir);
		const src = source("instagram", "instagram");
		const row = (native: string, text: string) => toComment(src, { native, thread: "m1", parent: "k1", author: UNKNOWN, text, postTitle: "post", at: NOW - 1000 }, "t");
		store.addComments([row("k1.0", "a"), row("r1", "a"), row("k1.1", "b")]);
		store.putDraft(draft({ code: "D1", commentId: "cm:instagram:k1.0", source: "instagram", thread: "m1" }));
		store.putReply({ id: "send:cm:instagram:k1.0", commentId: "cm:instagram:k1.0", source: "instagram", thread: "m1", text: "x", state: "sent", at: NOW, draft: "D1", via: "owner", collector: "t" });
		store.dismiss("cm:instagram:k1.0", NOW);
		store.replaceComments([{ from: "cm:instagram:k1.0", to: { ...row("r1", "a"), author: "owner_ig", mine: true } }]);
		expect(store.comments().map(c => [c.native, c.author])).toEqual([["r1", "owner_ig"], ["k1.1", UNKNOWN]]);
		expect(store.drafts()[0]!.commentId).toBe("cm:instagram:r1");
		expect(store.replies()[0]).toMatchObject({ id: "send:cm:instagram:r1", commentId: "cm:instagram:r1" });
		expect(Object.keys(store.dismissed())).toEqual(["cm:instagram:r1"]);
	});

	test("a reply stored without an author gets it, and mine, when a later read can name it", async () => {
		config([source("instagram", "instagram")]);
		const state = fresh();
		state.list = [top("k1", "fan1", "2030-06-15T12:10:00Z", "q", { replies: [{ id: "r1", username: UNKNOWN, text: "thanks", timestamp: "2030-06-15T13:00:00Z" }] })];
		const engine = ig(state);
		await engine.collect({ force: true });
		expect(engine.store.comments().find(c => c.native === "r1")).toMatchObject({ author: UNKNOWN, mine: false });
		expect(state.lookups).toContain("r1");

		state.lookups = [];
		state.authors = { r1: { username: "owner_ig", fromId: "17841" } };
		await engine.reconcile({ recheck: true });
		expect(engine.store.comments().find(c => c.native === "r1")).toMatchObject({ author: "owner_ig", mine: true });
		expect(engine.needs().instagram?.unreplied).toBe(0);
		expect(state.lookups).toEqual(["r1"]);
	});

	test("a comment missing from a complete read is gone; from a read that stopped early it is not", async () => {
		config([source("instagram", "instagram")]);
		const state = fresh();
		state.list = [top("k1", "fan1", "2030-06-15T12:10:00Z", "q1"), top("k2", "fan2", "2030-06-15T12:20:00Z", "q2")];
		const engine = ig(state);
		await engine.collect({ force: true });
		state.list = [state.list[0]!];
		state.complete = false;
		expect((await engine.reconcile({ recheck: true })).gone).toBe(0);
		state.complete = true;
		expect((await engine.reconcile({ recheck: true })).gone).toBe(1);
		expect(engine.store.comments().map(c => [c.native, c.gone ?? null])).toEqual([["k1", null], ["k2", NOW]]);
		expect(engine.needs().instagram?.unreplied).toBe(1);
	});
});

describe("issue #32: YouTube replies", () => {
	const VIDEO = "FakeVideo01";
	const HWA = "UgzFakeComment0000001AaABAg", GAME = "UgyFakeComment0000002AaABAg";
	const at = (iso: string) => new Date(iso).toISOString();
	function setup(replies: Record<string, { id: string; parentId: string; author: string; text: string; publishedAt: string }[]>, fail = false) {
		config([source("youtube", "youtube", { autoDraft: true, autoSince: 0 })]);
		const calls: string[][] = [];
		const api: YoutubeApi = {
			channelId: () => "UCme",
			// The InnerTube read: new comments only, no replies, replied false.
			threadsSince: async () => ({ comments: [
				{ id: GAME, videoId: VIDEO, author: "@구독자하나", authorChannelId: "UCg", text: "와 대박", publishedAt: at("2026-10-28T11:14:26Z"), replied: false },
				{ id: HWA, videoId: VIDEO, author: "@구독자둘", authorChannelId: "UCh", text: "진짜 직접 만드신 건가요?", publishedAt: at("2026-10-28T14:03:42Z"), replied: false },
				{ id: "Ugopen", videoId: VIDEO, author: "@fan", authorChannelId: "UCf", text: "자료 있나요?", publishedAt: at("2026-10-28T15:00:00Z"), replied: false },
			] satisfies YtComment[], newest: "n" }),
			uploads: async () => [],
			videos: async ids => Object.fromEntries(ids.map(i => [i, { title: "소개 영상" }])),
			reply: async () => "r",
			ownReplies: async () => [],
			threadsByIds: async (_c, ids) => (calls.push(ids), fail ? Promise.reject(new Error("quota")) : Object.fromEntries(ids.map(i => [i, { videoId: VIDEO, replies: replies[i] ?? [] }]))),
		};
		const reply = `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "q", to: "", body: "감사해요", questions: [] })}\n\`\`\``;
		const engine = createEngine({ dir, now: () => NOW, collector: "t", adapters: { youtube: youtubeAdapter(() => api) }, model: async () => ({ text: reply }) });
		return { engine, calls };
	}

	test("comments he answered on YouTube come with his replies (mine, under their comment), are not 미답장 and get no auto draft", async () => {
		const { engine, calls } = setup({
			[HWA]: [{ id: `${HWA}.r1`, parentId: HWA, author: "@채널주인", text: "네 직접 만들었어요", publishedAt: at("2026-10-29T01:00:00Z") }],
			[GAME]: [{ id: `${GAME}.r1`, parentId: GAME, author: "@채널주인", text: "감사합니다!", publishedAt: at("2026-10-28T12:00:00Z") }],
		});
		const out = await engine.collect({ force: true });
		expect(calls[0]).toEqual([GAME, HWA, "Ugopen"]);
		const mine = engine.store.comments().filter(c => c.mine).map(c => [c.parent, c.thread]);
		expect(mine).toEqual([[GAME, VIDEO], [HWA, VIDEO]]);
		for (const n of [HWA, GAME]) expect(engine.unreplied(engine.store.comments().find(c => c.native === n)!)).toBe(false);
		expect(out.drafted.map(d => d.commentId)).toEqual(["cm:youtube:Ugopen"]);
	});

	test("a failed reply lookup keeps the read (nothing lost; the re-check finds the replies later)", async () => {
		const { engine, calls } = setup({}, true);
		const out = await engine.collect({ force: true });
		expect(calls.length).toBeGreaterThan(0);
		expect(out.added.map(c => c.native)).toEqual([GAME, HWA, "Ugopen"]);
		// the read itself did not fail; only the later re-check reports the lookup error
		expect(out.errors.youtube).toBeUndefined();
	});
});

describe("needs() badge", () => {
	test("a pending draft on a comment already answered, deleted or dismissed is not counted, even before reconcile closes it", () => {
		config([source("youtube", "youtube")]);
		const store = createStore(dir);
		const row = (native: string, o: Partial<Comment> = {}): Comment => ({ id: `cm:youtube:${native}`, source: "youtube", native, thread: "v1", author: "@fan", text: "질문", postTitle: "post", at: NOW - DAY, mine: false, collector: "t", ...o });
		store.addComments([row("a"), row("a.r", { parent: "a", mine: true, author: "@me", at: NOW - DAY + 60_000 }), row("g", { gone: NOW }), row("o")]);
		for (const [code, n] of [["Da", "a"], ["Dg", "g"], ["Do", "o"]] as const) store.putDraft(draft({ code, commentId: `cm:youtube:${n}`, source: "youtube", thread: "v1" }));
		const { engine } = engineWith({});
		expect(engine.needs().youtube!.drafts).toBe(1);
	});
});
