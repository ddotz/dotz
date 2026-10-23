import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IgComment, IgMedia } from "../../features/youtube-instagram/lib/instagram.ts";
import { type InstagramApi, instagramAdapter } from "./adapters/google-meta.ts";
import type { SourceConfig } from "./contract.ts";
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
	expect(view.comments.find(c => c.id === "cm:instagram:k1.0")!.mine).toBe(true);
	expect(open(t.engine)).toBe(1);
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
	expect(ids).toEqual(["cm:instagram:k9", "cm:instagram:k9.0"]);
	for (const id of ids) {
		const c = t.engine.store.comments().find(x => x.id === id)!;
		const out = await instagramAdapter(() => ({ username: () => "owner_ig", media: async () => [], comments: async () => [], reply: async target => (t.state.replied.push(target), "ref") })).reply(SRC, c, "hello", "s1");
		expect(out.ok).toBe(true);
	}
	expect(t.state.replied).toEqual(["k9", "k9"]);
});
