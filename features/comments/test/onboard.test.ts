import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../../../hub/comments/engine.ts";
import type { CommentAdapter } from "../../../hub/comments/contract.ts";
import { type Gateway, runOnboard } from "../bin/onboard.ts";

let dir: string;
let before: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comments-onboard-"));
	before = process.env.DOTZ_DIR;
	process.env.DOTZ_DIR = dir;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (before === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = before;
});

const adapter = (own: string[] = ["네, 감사합니다!", "곧 알려 드릴게요."]): CommentAdapter => ({ kind: "youtube", list: async () => ({ comments: [{ native: "c1", thread: "v1", author: "A", text: "?", postTitle: "T", at: 1 }] }), reply: async () => ({ ok: true }), ownReplies: async () => own });
const engineOf = (a: CommentAdapter) => createEngine({ dir: join(dir, "custom", "comments"), now: () => 1000, collector: "m", adapters: { youtube: a, website: a } });
const gateway = (names: string[] = []) => {
	const added: Record<string, unknown>[] = [];
	const paused: string[] = [];
	const g: Gateway = { watches: async () => [...names, ...added.map(a => String(a.name))], add: async b => void added.push(b), pause: async n => void paused.push(n) };
	return { g, added, paused };
};

describe("onboard", () => {
	test("an unconnected platform stops with the owner-only step and turns nothing on", async () => {
		const gw = gateway();
		const r = await runOnboard(["on", "--app", "youtube"], { engine: engineOf(adapter()), gateway: gw.g, connected: () => false });
		expect(r.code).toBe(3);
		expect(r.lines.join("\n")).toContain("연결");
		expect(existsSync(join(dir, "custom", "comments", "config.json"))).toBe(false);
		expect(gw.added).toHaveLength(0);
	});

	test("one request sets everything up, and a second run changes nothing", async () => {
		const gw = gateway(["sns-yt-comments"]);
		const engine = engineOf(adapter());
		const first = await runOnboard(["on", "--app", "youtube"], { engine, gateway: gw.g, connected: () => true });
		expect(first.code).toBe(0);
		const cfg = engine.store.config();
		expect(cfg.enabled).toBe(true);
		expect(cfg.sources.youtube).toMatchObject({ kind: "youtube", watch: ["*"], autoDraft: false });
		expect(gw.added).toHaveLength(1);
		expect(gw.added[0]).toMatchObject({ name: "comments", every_minutes: 5, on: "match", to: "orchestrator" });
		expect(gw.paused).toEqual(["sns-yt-comments"]);
		expect(engine.store.comments()).toHaveLength(1);
		expect(readFileSync(join(dir, "features", "comments", "feature.md"), "utf8")).toMatch(/^enabled: true$/m);
		expect(readFileSync(join(dir, "custom", "reply-drafts", "tone", "youtube.md"), "utf8")).toContain("네, 감사합니다!");
		await runOnboard(["on", "--app", "youtube"], { engine, gateway: gw.g, connected: () => true });
		expect(gw.added).toHaveLength(1);
		expect(engine.store.comments()).toHaveLength(1);
	});

	test("a website needs its read and post method in one batch, then turns on with them", async () => {
		const gw = gateway();
		const engine = engineOf(adapter());
		const ask = await runOnboard(["on", "--app", "site", "--name", "blog"], { engine, gateway: gw.g });
		expect(ask.code).toBe(3);
		expect(ask.lines.filter(l => l.startsWith("- "))).toHaveLength(2);
		const ok = await runOnboard(["on", "--app", "site", "--name", "blog", "--read-kind", "rss", "--read", "https://site.example/comments/feed", "--post-kind", "webhook", "--post", "https://site.example/hook", "--secret", "blog-token", "--owner", "Owner"], { engine, gateway: gw.g });
		expect(ok.code).toBe(0);
		expect(engine.store.config().sources["site-blog"]).toMatchObject({ kind: "website", watch: ["*"], site: { read: { kind: "rss", url: "https://site.example/comments/feed" }, post: { kind: "webhook", url: "https://site.example/hook", secret: "blog-token" }, owner: "Owner" } });
	});

	test("off stops reading that source", async () => {
		const gw = gateway();
		const engine = engineOf(adapter());
		await runOnboard(["on", "--app", "youtube"], { engine, gateway: gw.g, connected: () => true });
		const r = await runOnboard(["off", "--app", "youtube"], { engine, gateway: gw.g });
		expect(r.code).toBe(0);
		expect(engine.store.config().sources.youtube!.watch).toEqual([]);
	});
});
