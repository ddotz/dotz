import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app-off.ts";
import { fieldsOf } from "./app-settings.ts";
import type { CommentAdapter, RawComment } from "./comments/contract.ts";
import { appOf, createEngine } from "./comments/engine.ts";
import { createCommentsWeb } from "./comments/web.ts";
import { appEntries, commentOwner, integrationContext, integrationItems } from "./integrations.ts";

// Website comment sources as app instances (custom/apps.json {"site-mapia":{"app":"site","filter":{"source":"mapia"}}}): each instance has its own threads,
// source list, needs and reply model; an install with no instance keeps all sites under the one `site` app.
const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const raw = (native: string, thread: string, title: string): RawComment => ({ native, thread, author: "방문자", text: `질문 ${native}?`, postTitle: title, at: NOW - 1000 });
const SITES = ["mapia", "indi", "old"];

let data: string;
beforeEach(() => {
	data = mkdtempSync(join(tmpdir(), "site-inst-"));
});
afterEach(() => rmSync(data, { recursive: true, force: true }));

const apps = (doc: object) => {
	mkdirSync(join(data, "custom"), { recursive: true });
	writeFileSync(join(data, "custom/apps.json"), JSON.stringify(doc));
};
const INSTANCES = {
	"site-mapia": { app: "site", label: "마피아", filter: { source: "mapia" } },
	"site-indi": { app: "site", label: "인디스쿨", filter: { source: "indi" } },
};

async function engineWith(models: string[] = []) {
	const dir = join(data, "custom", "comments");
	mkdirSync(dir, { recursive: true });
	const sources = Object.fromEntries(SITES.map(s => [`site-${s}`, { key: `site-${s}`, kind: "website", label: `웹사이트 댓글 (${s})`, watch: ["*"], autoDraft: false }]));
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources }));
	const adapter: CommentAdapter = {
		kind: "website",
		list: async s => ({ comments: [raw(`${s.key}-1`, `p-${s.key}`, `${s.key} 글`)] }),
		reply: async () => ({ ok: true }),
		posts: async () => [{ id: "p", title: "글" }],
	};
	const engine = createEngine({
		dir, now: () => NOW, collector: "m", adapters: { website: adapter },
		model: async (_s, _u, app) => (models.push(String(app)), { text: "```json\n" + JSON.stringify({ action: "draft", reason: "r", to: "", body: "고마워요", questions: [] }) + "\n```" }),
		owner: src => commentOwner(appEntries(data), appOf(src), src.key),
	});
	await engine.collect({ force: true });
	return engine;
}

describe("site comment sources as app instances", () => {
	test("each instance opens its own filtered thread list; the default site app keeps the rest", async () => {
		apps(INSTANCES);
		const engine = await engineWith();
		const keys = (app: string) => engine.threads(app).map(t => t.source);
		expect(keys("site-mapia")).toEqual(["site-mapia"]);
		expect(keys("site-indi")).toEqual(["site-indi"]);
		expect(keys("site")).toEqual(["site-old"]);
	});

	test("an install with no instance keeps every site under the one site app", async () => {
		const engine = await engineWith();
		expect(engine.threads("site").map(t => t.source).sort()).toEqual(["site-indi", "site-mapia", "site-old"]);
		expect(engine.threads("site-mapia")).toEqual([]);
		expect(Object.keys(engine.needs())).toEqual(["site"]);
	});

	test("GET /api/comments/sources names the owning instance and threads?app= filters by it", async () => {
		apps(INSTANCES);
		const engine = await engineWith();
		const web = createCommentsWeb({ engine, broadcast: () => {} });
		const call = async (path: string) => {
			const url = new URL(`http://x${path}`);
			return (await web.route(new Request(url), url, url.pathname.split("/").filter(Boolean)))!.json() as Promise<any>;
		};
		const src = await call("/api/comments/sources");
		expect(Object.fromEntries(src.sources.map((s: any) => [s.key, s.app]))).toEqual({ "site-mapia": "site-mapia", "site-indi": "site-indi", "site-old": "site" });
		expect((await call("/api/comments/threads?app=site-indi")).threads.map((t: any) => t.source)).toEqual(["site-indi"]);
	});

	test("the app list shows one row per instance with its own needs", async () => {
		apps(INSTANCES);
		const engine = await engineWith();
		const ctx = integrationContext(data, ["comments-site"]);
		const rows = integrationItems(ctx, [], {}, 100, undefined, [], NOW, engine.needs());
		expect(rows.filter(r => r.app === "site").map(r => [r.key, r.label, r.unread])).toEqual([["site", "웹사이트 댓글", 1], ["site-mapia", "마피아", 1], ["site-indi", "인디스쿨", 1]]);
	});

	test("the draft model call and the reply-model setting are the instance's own", async () => {
		apps(INSTANCES);
		const models: string[] = [];
		const engine = await engineWith(models);
		const c = engine.store.comments().find(x => x.source === "site-mapia")!;
		await engine.makeDraft(c.id);
		expect(models).toEqual(["site-mapia"]);
		expect(fieldsOf("site-mapia").map(f => f.key)).toContain("reply_model");
	});

	test("POST /api/apps accepts a site filter and builds the same key the onboard gives the source", () => {
		const made = createApp(data, { app: "site", id: "site-mapia", label: "마피아", filter: { source: "mapia" } });
		expect(made).toEqual({ id: "site-mapia", label: "마피아" });
		expect(commentOwner(appEntries(data), "site", "site-mapia")).toBe("site-mapia");
		expect(commentOwner(appEntries(data), "site", "site-other")).toBe("site");
		expect(() => createApp(data, { app: "youtube", filter: { source: "x" } })).toThrow();
	});
});
