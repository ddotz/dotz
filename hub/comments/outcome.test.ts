// What a failed comment post means (reply design 2.3, comment table): `failed` only when nothing can have gone up, `unsure` otherwise.
// The real error classes of features/youtube-instagram/lib are thrown through each adapter; a throw the adapter does not catch is unsure too.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstagramError } from "../../features/youtube-instagram/lib/instagram.ts";
import { AuthError, QuotaError, TransientError } from "../../features/youtube-instagram/lib/watchkit.ts";
import { YoutubeError } from "../../features/youtube-instagram/lib/youtube.ts";
import { type InstagramApi, instagramAdapter, type YoutubeApi, youtubeAdapter } from "./adapters/google-meta.ts";
import { websiteAdapter } from "./adapters/website.ts";
import { type Comment, type CommentAdapter, dispatchReply, type SourceConfig } from "./contract.ts";
import { createStore } from "./store.ts";

const NOW = Date.parse("2026-11-13T00:00:00.000Z");
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comments-outcome-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const comment = (source: string): Comment => ({ id: `cm:${source}:c1`, source, native: "c1", thread: "p1", author: "A", text: "질문", postTitle: "글", at: NOW - 1000, mine: false, collector: "t" });
const src = (kind: SourceConfig["kind"], site?: SourceConfig["site"]): SourceConfig => ({ key: "s", kind, label: "출처", watch: ["*"], autoDraft: false, ...(site ? { site } : {}) });
const pick = (o: Awaited<ReturnType<CommentAdapter["reply"]>>) => (o.ok ? { ok: true } : { code: o.code, sent: o.sent });

test("youtube: each thrown error is classified by its class and stage", async () => {
	const cases: [Error, string, "no" | "maybe"][] = [
		[new AuthError("youtube"), "login_expired", "no"],
		[new QuotaError("quotaExceeded"), "quota", "no"],
		[new TransientError("youtube http 429"), "rate_limited", "no"],
		[new TransientError("youtube http 503"), "server_error", "maybe"],
		[new TransientError("youtube network error"), "net_cut", "maybe"],
		[new TransientError("youtube token network error"), "offline", "no"],
		[new TransientError("youtube token http 503"), "tool_before_send", "no"],
		[new TransientError("quota ledger is locked"), "tool_before_send", "no"],
		[new YoutubeError(404, "commentNotFound"), "original_gone", "no"],
		[new YoutubeError(403, "commentsDisabled"), "rejected", "no"],
		[new Error("boom"), "unknown", "maybe"],
	];
	for (const [err, code, sent] of cases) {
		const api = { reply: async () => Promise.reject(err) } as unknown as YoutubeApi;
		const out = await youtubeAdapter(() => api).reply(src("youtube"), comment("s"), "hi", "send:1");
		expect([err.message, pick(out)]).toEqual([err.message, { code, sent }]);
		if (!out.ok) expect(out.detail).toBe(err.message);
	}
});

test("instagram: auth, rate limit, 5xx and a 4xx refusal", async () => {
	const cases: [Error, string, "no" | "maybe"][] = [
		[new AuthError("instagram"), "login_expired", "no"],
		[new TransientError("instagram http 429"), "rate_limited", "no"],
		[new TransientError("instagram http 500"), "server_error", "maybe"],
		[new InstagramError(400, "OAuthException", 100), "rejected", "no"],
	];
	for (const [err, code, sent] of cases) {
		const api = { reply: async () => Promise.reject(err) } as unknown as InstagramApi;
		const out = await instagramAdapter(() => api).reply(src("instagram"), comment("s"), "hi", "send:1");
		expect([err.message, pick(out)]).toEqual([err.message, { code, sent }]);
	}
});

test("website webhook: 4xx failed, 401 login, 5xx / timeout / cut unsure, refused connection failed", async () => {
	const hook = src("website", { read: { kind: "script", command: ["read"] }, post: { kind: "webhook", url: "https://example.test/hook" } });
	const answer = (status: number) => async () => new Response("{}", { status });
	const thrown = (e: unknown) => async () => Promise.reject(e);
	const refused = Object.assign(new Error("Unable to connect"), { code: "ECONNREFUSED" });
	const cases: [string, () => Promise<Response>, string, "no" | "maybe"][] = [
		["404", answer(404), "rejected", "no"],
		["401", answer(401), "login_expired", "no"],
		["503", answer(503), "server_error", "maybe"],
		["timeout", thrown(new DOMException("timed out", "TimeoutError")), "timeout", "maybe"],
		["cut", thrown(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), "net_cut", "maybe"],
		["refused", thrown(refused), "offline", "no"],
	];
	for (const [name, fetch, code, sent] of cases) {
		const adapter = websiteAdapter({ exec: async () => ({ code: 0, stdout: "", stderr: "" }), fetch: fetch as unknown as typeof globalThis.fetch, secretsDir: dir, siteDir: dir });
		expect([name, pick(await adapter.reply(hook, comment("s"), "hi", "send:1"))]).toEqual([name, { code, sent }]);
	}
});

test("website script: exit non-zero saying sent: no is failed; without it unsure; ok: false failed", async () => {
	const site = src("website", { read: { kind: "script", command: ["read"] }, post: { kind: "script", command: ["post"] } });
	const cases: [{ code: number; stdout: string }, string, "no" | "maybe"][] = [
		[{ code: 1, stdout: '{"ok":false,"sent":"no"}' }, "rejected", "no"],
		[{ code: 1, stdout: "" }, "unknown", "maybe"],
		[{ code: 0, stdout: '{"ok":false,"reason":"spam"}' }, "rejected", "no"],
	];
	for (const [r, code, sent] of cases) {
		const adapter = websiteAdapter({ exec: async () => ({ ...r, stderr: "" }), fetch, secretsDir: dir, siteDir: dir });
		expect([r, pick(await adapter.reply(site, comment("s"), "hi", "send:1"))]).toEqual([r, { code, sent }]);
	}
});

function gate(reply: CommentAdapter["reply"]) {
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { s: src("youtube") } }));
	const store = createStore(dir);
	store.addComments([comment("s")]);
	store.putDraft({ code: "D1", commentId: "cm:s:c1", source: "s", thread: "p1", text: "고마워요", status: "pending", created: NOW - 500, changes: [], clean: true, notes: [] });
	const logged: string[] = [];
	const adapter: CommentAdapter = { kind: "youtube", list: async () => ({ comments: [] }), reply };
	const r = dispatchReply({ code: "D1", approval: { by: "owner" } }, { store, adapters: { youtube: adapter }, now: () => NOW, collector: "t", inflight: new Set(), log: l => logged.push(l) });
	if (!r.ok) throw new Error(r.reason);
	return { done: r.done, logged, store };
}

test("the gate stores a sent: no outcome as failed and a maybe as unsure, with the code; the draft stays pending", async () => {
	for (const [sent, state] of [["no", "failed"], ["maybe", "unsure"]] as const) {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "comments-outcome-"));
		const g = gate(async () => ({ ok: false, reason: "이유", code: "rejected", sent }));
		expect(await g.done).toMatchObject({ state, code: "rejected", reason: "이유" });
		expect(g.store.drafts()[0]!.status).toBe("pending");
	}
});

test("an adapter that throws ends unsure with code unknown: the raw message goes to the log, never into the record", async () => {
	const g = gate(async () => {
		throw new Error("secret stack text");
	});
	const done = await g.done;
	expect(done).toMatchObject({ state: "unsure", code: "unknown" });
	expect(JSON.stringify(done)).not.toContain("secret stack text");
	expect(g.logged.some(l => l.includes("secret stack text") && l.includes("unknown"))).toBe(true);
});
