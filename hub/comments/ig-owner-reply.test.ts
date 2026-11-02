import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IgComment, IgMedia } from "../../features/youtube-instagram/lib/instagram.ts";
import { type InstagramApi, instagramAdapter } from "./adapters/google-meta.ts";
import type { Comment, SourceConfig } from "./contract.ts";
import { createEngine } from "./engine.ts";

const NOW = Date.parse("2030-06-16T00:00:00.000Z");
const SRC: SourceConfig = { key: "instagram", kind: "instagram", label: "인스타 댓글", watch: ["*"], autoDraft: false };
const top = (id: string, username: string, timestamp: string, text: string, o: Partial<IgComment> = {}): IgComment => ({ id, text, username, timestamp, replies: [], ...o });

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ig-owner-"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { instagram: SRC } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
	const state = { list: [] as IgComment[], replied: [] as string[] };
	const api: InstagramApi = {
		username: () => "owner_ig",
		userId: () => "17841",
		media: async (): Promise<IgMedia[]> => [{ id: "m1", caption: "post", comments_count: state.list.length, timestamp: "2030-06-01T00:00:00Z" }],
		comments: async () => state.list,
		reply: async id => (state.replied.push(id), "ref"),
	};
	const engine = createEngine({ dir, now: () => NOW, collector: "t", adapters: { instagram: instagramAdapter(() => api) } });
	return { engine, state };
}
const open = (e: ReturnType<typeof setup>["engine"]) => e.needs().instagram?.unreplied;

test("a reply id that is the owner's own comment clears the unreplied badge of that comment only", async () => {
	const t = setup();
	t.state.list = [top("k1", "fan1", "2030-06-15T12:10:00Z", "q1"), top("k2", "fan2", "2030-06-15T12:20:00Z", "q2")];
	await t.engine.collect({ force: true });
	expect(open(t.engine)).toBe(2);

	t.state.list = [top("k1", "fan1", "2030-06-15T12:10:00Z", "q1", { replies: [{ id: "r1", username: "알 수 없는 사용자", text: "thanks" }] }), t.state.list[1]!, top("r1", "17841", "2030-06-15T12:15:00Z", "thanks", { fromId: "17841" })];
	await t.engine.collect({ force: true });
	const view = t.engine.threadView("instagram", "m1")!;
	expect(view.comments.filter(c => c.unreplied).map(c => c.id)).toEqual(["cm:instagram:k2"]);
	expect(view.comments.find(c => c.id === "cm:instagram:r1")!.mine).toBe(true);
	expect(open(t.engine)).toBe(1);
});

test("a reply seen nested and at top level is stored once under its real id, with the owner as author, its parent and its API time", async () => {
	const t = setup();
	t.state.list = [
		top("k1", "fan1", "2026-10-12T03:00:00+0000", "q1", { replies: [{ id: "r1", username: "알 수 없는 사용자", text: "thanks", timestamp: "2026-10-12T03:04:05+0000" }] }),
		top("r1", "owner_ig", "2026-10-12T03:04:05+0000", "thanks", { fromId: "17841" }),
	];
	await t.engine.collect({ force: true });
	const stored = t.engine.store.comments();
	expect(stored.map(c => c.id)).toEqual(["cm:instagram:k1", "cm:instagram:r1"]);
	const reply = stored.find(c => c.native === "r1")!;
	expect({ author: reply.author, mine: reply.mine, parent: reply.parent, at: reply.at }).toEqual({ author: "owner_ig", mine: true, parent: "k1", at: Date.parse("2026-10-12T03:04:05Z") });
	expect(t.engine.needsReply(stored.find(c => c.native === "k1")!)).toBe(false);
	expect(open(t.engine)).toBe(0);
});

test("someone else's reply is stored once, with its real username, instead of as a second top-level comment", async () => {
	const t = setup();
	t.state.list = [top("k1", "fan1", "2026-10-12T03:00:00+0000", "q1", { replies: [{ id: "r2", username: "알 수 없는 사용자", text: "me too", timestamp: "2026-10-12T03:10:00+0000" }] }), top("r2", "fan2", "2026-10-12T03:10:00+0000", "me too")];
	await t.engine.collect({ force: true });
	expect(t.engine.store.comments().map(c => ({ id: c.id, author: c.author, parent: c.parent }))).toEqual([{ id: "cm:instagram:k1", author: "fan1", parent: undefined }, { id: "cm:instagram:r2", author: "fan2", parent: "k1" }]);
});

test("a reply stored earlier as a top-level comment learns its parent when it is read again nested", async () => {
	const t = setup();
	t.state.list = [top("k1", "fan1", "2026-10-12T03:00:00+0000", "q1"), top("r1", "owner_ig", "2026-10-12T03:04:05+0000", "thanks", { fromId: "17841" })];
	await t.engine.collect({ force: true });
	expect(t.engine.store.comments().find(c => c.native === "r1")!.parent).toBeUndefined();
	t.state.list = [top("k1", "fan1", "2026-10-12T03:00:00+0000", "q1", { replies: [{ id: "r1", username: "알 수 없는 사용자", text: "thanks", timestamp: "2026-10-12T03:04:05+0000" }] }), t.state.list[1]!, top("k3", "fan3", "2026-10-12T04:00:00+0000", "q3")];
	await t.engine.collect({ force: true });
	expect(t.engine.store.comments().filter(c => c.native === "r1").map(c => c.parent)).toEqual(["k1"]);
	expect(open(t.engine)).toBe(0);
});

test("a comment stamped after the read is stored at the read time", async () => {
	const t = setup();
	t.state.list = [top("k1", "fan1", "2030-07-07T00:00:00+0000", "from the future")];
	await t.engine.collect({ force: true });
	expect(t.engine.store.comments().map(c => c.at)).toEqual([NOW]);
});

test("the owner @mentioning the commenter under the same media clears the badge, also when the mention comes in a later read", async () => {
	const t = setup();
	t.state.list = [top("k1", "bob", "2030-06-15T12:10:00Z", "love it"), top("k2", "amy", "2030-06-15T12:11:00Z", "nice")];
	await t.engine.collect({ force: true });
	expect(open(t.engine)).toBe(2);

	t.state.list = [...t.state.list, top("k3", "owner_ig", "2030-06-15T12:30:00Z", "@bob 고마워요!")];
	await t.engine.collect({ force: true });
	const view = t.engine.threadView("instagram", "m1")!;
	expect(view.comments.filter(c => c.unreplied).map(c => c.id)).toEqual(["cm:instagram:k2"]);
	expect(view.comments.find(c => c.id === "cm:instagram:k1")!.needsReply).toBe(false);
	expect(open(t.engine)).toBe(1);
});

test("a reply goes to the comment id, even for a comment without a username", async () => {
	const t = setup();
	t.state.list = [top("k9", "알 수 없는 사용자", "2030-06-15T12:10:00Z", "who am i?", { replies: [{ id: "r5", username: "알 수 없는 사용자", text: "me too" }] })];
	await t.engine.collect({ force: true });
	const ids = t.engine.store.comments().map(c => c.id);
	expect(ids).toEqual(["cm:instagram:k9", "cm:instagram:r5"]);
	for (const id of ids) {
		const c = t.engine.store.comments().find(x => x.id === id)!;
		const out = await instagramAdapter(() => ({ username: () => "owner_ig", media: async () => [], comments: async () => [], reply: async target => (t.state.replied.push(target), "ref") })).reply(SRC, c, "hello", "s1");
		expect(out.ok).toBe(true);
	}
	expect(t.state.replied).toEqual(["k9", "k9"]);
});
