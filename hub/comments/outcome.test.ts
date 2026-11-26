// What a failed comment post means (reply design 2.3, comment table): `failed` only when nothing can have gone up, `unsure` otherwise.
// The real error classes of features/youtube-instagram/lib are thrown through each adapter; a throw the adapter does not catch is unsure too.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimSend } from "../draft-claim.ts";
import { InstagramError } from "../../features/youtube-instagram/lib/instagram.ts";
import { AuthError, QuotaError, TransientError } from "../../features/youtube-instagram/lib/watchkit.ts";
import { YoutubeError } from "../../features/youtube-instagram/lib/youtube.ts";
import { type InstagramApi, instagramAdapter, type YoutubeApi, youtubeAdapter } from "./adapters/google-meta.ts";
import { websiteAdapter } from "./adapters/website.ts";
import { type Comment, type CommentAdapter, dispatchReply, type GateResult, type SourceConfig } from "./contract.ts";
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

test("website script: ok: false with a known code keeps the code and the script's reason as detail; an unknown code or none is rejected", async () => {
	const site = src("website", { read: { kind: "script", command: ["read"] }, post: { kind: "script", command: ["post"] } });
	const cases: [string, string, string][] = [
		['{"ok":false,"code":"original_gone","reason":"x"}', "original_gone", "원래 글이 지워졌어요"],
		['{"ok":false,"code":"login_expired","reason":"x"}', "login_expired", "사이트 로그인이 풀렸어요"],
		['{"ok":false,"code":"no_such_code","reason":"x"}', "rejected", "사이트에서 이 글을 받지 않았어요"],
		['{"ok":false,"reason":"x"}', "rejected", "사이트에서 이 글을 받지 않았어요"],
	];
	for (const [stdout, code, reason] of cases) {
		const adapter = websiteAdapter({ exec: async () => ({ code: 0, stdout, stderr: "" }), fetch, secretsDir: dir, siteDir: dir });
		const out = await adapter.reply(site, comment("s"), "hi", "send:1");
		expect([stdout, out]).toEqual([stdout, { ok: false, code, sent: "no", reason, detail: code === "rejected" ? stdout : "x" }]);
	}
});

const claimFile = (code: string): string => join(dir, "sending", code);
function world(reply: CommentAdapter["reply"]) {
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { s: src("youtube") } }));
	const store = createStore(dir);
	store.addComments([comment("s")]);
	store.putDraft({ code: "D1", commentId: "cm:s:c1", source: "s", thread: "p1", text: "고마워요", status: "pending", created: NOW - 500, changes: [], clean: true, notes: [] });
	const logged: string[] = [];
	const adapter: CommentAdapter = { kind: "youtube", list: async () => ({ comments: [] }), reply };
	const send = (): GateResult => dispatchReply({ code: "D1", approval: { by: "owner" } }, { store, adapters: { youtube: adapter }, now: () => NOW, collector: "t", inflight: new Set(), claimFile, log: l => logged.push(l) });
	return { send, logged, store };
}

function gate(reply: CommentAdapter["reply"]) {
	const w = world(reply);
	const r = w.send();
	if (!r.ok) throw new Error(r.reason);
	return { done: r.done, logged: w.logged, store: w.store };
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

test("a site's refusal reaches the finished send masked and bounded, for the gateway's log and record, never the stored reply (Dggtza6)", async () => {
	const said = `spam filter matched; token=aB3dE9fGh1Jk2LmN ${"x".repeat(400)}`;
	const g = gate(async () => ({ ok: false, reason: "사이트에서 이 글을 받지 않았어요", code: "rejected", sent: "no", detail: said }));
	const done = await g.done;
	expect(done).toMatchObject({ state: "failed", code: "rejected" });
	expect(done.detail!.startsWith("spam filter matched; token=[가림:pair]")).toBe(true);
	expect(done.detail!.length).toBe(300);
	expect(JSON.stringify(g.store.replies())).not.toContain("spam filter");
	expect(g.logged.some(l => l.includes("spam filter matched; token=[가림:pair]") && !l.includes("aB3dE9fGh1Jk2LmN"))).toBe(true);
});

test("website script: the runtime warning a site script prints first on stderr is not taken for the site's answer", async () => {
	const site = src("website", { read: { kind: "script", command: ["read"] }, post: { kind: "script", command: ["post"] } });
	const stderr = "(node:8498) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\ncomment rejected: duplicate text\n";
	const adapter = websiteAdapter({ exec: async () => ({ code: 1, stdout: '{"ok":false,"sent":"no"}', stderr }), fetch, secretsDir: dir, siteDir: dir });
	const out = await adapter.reply(site, comment("s"), "hi", "send:1");
	expect(out).toMatchObject({ ok: false, code: "rejected", sent: "no", detail: "comment rejected: duplicate text" });
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

test("a claim another process holds refuses the send before any record is written or anything is posted; once it is released the send goes through and frees it again", async () => {
	const posted: string[] = [];
	const w = world(async (_s, _c, text) => (posted.push(text), { ok: true, ref: "r1" }));
	const other = claimSend(claimFile("D1"));
	expect(other).toBeDefined();
	expect(w.send()).toMatchObject({ ok: false, code: "already_sending" });
	expect(w.store.replies()).toEqual([]);
	expect(posted).toEqual([]);
	other!();
	const r = w.send();
	if (!r.ok) throw new Error(r.reason);
	expect(await r.done).toMatchObject({ state: "sent" });
	expect(posted).toEqual(["고마워요"]);
	expect(existsSync(claimFile("D1"))).toBe(false);
});

test("a claim left by a process that is gone, with no sending record behind it (it died before posting), does not block the next send, and a failed send frees the claim", async () => {
	const w = world(async () => ({ ok: false, reason: "이유", code: "rejected", sent: "no" }));
	mkdirSync(join(dir, "sending"), { recursive: true });
	writeFileSync(claimFile("D1"), `${process.pid} Mon Jan  1 00:00:00 2001`);
	const r = w.send();
	if (!r.ok) throw new Error(r.reason);
	expect(await r.done).toMatchObject({ state: "failed" });
	expect(existsSync(claimFile("D1"))).toBe(false);
});

test("a refused send leaves no claim behind: an unsure reply waits for the owner's resend and nothing is posted", () => {
	let posts = 0;
	const w = world(async () => (posts++, { ok: true }));
	w.store.putReply({ id: "send:cm:s:c1", commentId: "cm:s:c1", source: "s", thread: "p1", text: "고마워요", state: "unsure", at: NOW - 100, draft: "D1", via: "owner", collector: "t", reason: "?", code: "interrupted" });
	expect(w.send()).toMatchObject({ ok: false, code: "needs_resolve" });
	expect(existsSync(claimFile("D1"))).toBe(false);
	expect(posts).toBe(0);
});
