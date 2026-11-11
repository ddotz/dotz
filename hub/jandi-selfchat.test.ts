import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandOf, createSelfChat, normalizeSelfChat, type SelfChatConfig, type SelfChatDeps, type SelfChatPeer } from "./jandi-selfchat.ts";
import type { Upload } from "./files.ts";
import { readSecretFile, setSecretKey } from "./secretbox.ts";
import fileRecord from "./fixtures/jandi-file-message.json";

const TEAM = 7;
const ROOM = 100;
const ME = 11;
const BOT = 22;
const WEBHOOK_BOT = 33;

type Msg = { id: number; fromEntity: number; body?: string; message?: unknown };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let room: { type: string; companionId: number; members: number[] };
let messages: Msg[];
let calls: string[];
let expireOnce: boolean;
let rotate: string | undefined;
let tokenStatus: number | undefined;

const jandi = Bun.serve({
	port: 0,
	async fetch(req) {
		const u = new URL(req.url);
		calls.push(u.pathname + u.search);
		if (u.pathname === "/inner-api/token") {
			if (tokenStatus) return new Response(null, { status: tokenStatus });
			const b = (await req.json()) as { refresh_token?: string };
			if (b.refresh_token !== "rt-1" && b.refresh_token !== "rt-2") return Response.json({ code: 40000 }, { status: 400 });
			return Response.json({ access_token: "at", refresh_token: rotate ?? b.refresh_token, expires_in: 43200 });
		}
		if (req.headers.get("authorization") !== "bearer at") return new Response(null, { status: 401 });
		if (expireOnce) {
			expireOnce = false;
			return new Response(null, { status: 401 });
		}
		if (u.pathname === "/files/screenshot.png") return new Response(PNG, { headers: { "Content-Type": "image/png" } });
		if (u.pathname === "/files/unsized.png") return new Response(new ReadableStream({ pull: c => c.enqueue(PNG) })); // never ends, no Content-Length
		if (u.pathname === "/files/stalled.png") return new Response(new ReadableStream({ start: c => c.enqueue(PNG) }));
		if (u.pathname === `/room-api/v2/teams/${TEAM}/rooms/${ROOM}`) return Response.json({ id: ROOM, ...room });
		if (u.pathname === `/message-api/v2/teams/${TEAM}/rooms/${ROOM}/messages`) {
			const after = Number(u.searchParams.get("linkId") ?? 0);
			const list = u.searchParams.get("type") === "new" ? messages.filter(m => m.id > after) : messages.slice(-1);
			const records = list.map(m => ({ id: m.id, fromEntity: m.fromEntity, message: m.message ?? { content: { body: m.body } } }));
			return Response.json({ lastLinkId: messages.at(-1)?.id ?? 0, records: records.reverse() });
		}
		return new Response(null, { status: 404 });
	},
});
afterAll(() => jandi.stop(true));

let dir: string;
const cfg: SelfChatConfig = { enabled: true, team_id: TEAM, room_id: ROOM, member_id: ME, bot_id: BOT, keyword: "dotz", reply_prefix: "", session_secret: "jandi-session", interval_ms: 1000 };
function make(received: string[], errors: (string | undefined)[] = []) {
	return createSelfChat(cfg, { dataDir: dir, api: `http://127.0.0.1:${jandi.port}/`, receive: t => received.push(t), log: () => {}, onError: e => errors.push(e) });
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jandi-selfchat-"));
	mkdirSync(join(dir, "secrets"));
	mkdirSync(join(dir, "messengers"));
	writeFileSync(join(dir, "secrets", "jandi-session"), JSON.stringify({ refresh_token: "rt-1" }), { mode: 0o600 });
	setSecretKey(Buffer.alloc(32, 7));
	room = { type: "chat", companionId: BOT, members: [WEBHOOK_BOT, ME] };
	messages = [{ id: 1, fromEntity: ME, body: "dotz 예전 명령" }];
	calls = [];
	expireOnce = false;
	rotate = undefined;
	tokenStatus = undefined;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("commandOf takes `dotz <text>` and `/dotz <text>` only, case-insensitively", () => {
	expect(commandOf("dotz 오늘 일정", "dotz")).toBe("오늘 일정");
	expect(commandOf("  /DOTZ  win Get-Date ", "dotz")).toBe("win Get-Date");
	expect(commandOf("dotz", "dotz")).toBeUndefined();
	expect(commandOf("dotzz 안녕", "dotz")).toBeUndefined();
	expect(commandOf("메모: dotz 안녕", "dotz")).toBeUndefined();
	expect(normalizeSelfChat({ keyword: "/땅콩", enabled: true })?.keyword).toBe("땅콩");
});

test("a room that is not the member's chat with the JANDI bot is refused before any message is read", async () => {
	room = { type: "topic", companionId: 0, members: [ME] };
	const got: string[] = [];
	await expect(make(got).tick()).rejects.toThrow("not this member's chat with the JANDI bot");
	expect(calls.some(c => c.includes("/messages"))).toBe(false);
	expect(got).toEqual([]);
});

test("starts after the newest message, hands on only the owner's keyword messages in order, and never twice across a restart", async () => {
	const got: string[] = [];
	const sc = make(got);
	await sc.tick();
	expect(got).toEqual([]); // history before the start is not replayed
	messages.push(
		{ id: 2, fromEntity: ME, body: "dotz 안녕" },
		{ id: 3, fromEntity: WEBHOOK_BOT, body: "dotz 웹훅이 올린 글" },
		{ id: 4, fromEntity: ME, body: "그냥 메모" },
		{ id: 5, fromEntity: ME, body: "/dotz win Get-Date" },
	);
	await sc.tick();
	expect(got).toEqual(["안녕", "win Get-Date"]);
	await sc.tick();
	expect(got).toEqual(["안녕", "win Get-Date"]);

	messages.push({ id: 6, fromEntity: ME, body: "dotz 재시작 뒤" });
	const again: string[] = [];
	await make(again).tick();
	expect(again).toEqual(["재시작 뒤"]);
});

test("an expired access token is refreshed once, and a rotated refresh token is stored sealed", async () => {
	rotate = "rt-2";
	const got: string[] = [];
	const sc = make(got);
	await sc.tick();
	expect(JSON.parse(readSecretFile(join(dir, "secrets", "jandi-session"))).refresh_token).toBe("rt-2");
	expireOnce = true;
	messages.push({ id: 2, fromEntity: ME, body: "dotz 다시" });
	await sc.tick();
	expect(got).toEqual(["다시"]);
	expect(calls.filter(c => c === "/inner-api/token").length).toBe(2);
});

test("a missing session secret is reported, not guessed around", async () => {
	rmSync(join(dir, "secrets", "jandi-session"));
	await expect(make([]).tick()).rejects.toThrow("no JANDI session");
	expect(calls).toEqual([]);
});

test("a peer's reply fires peerReply once, from another member or from the owner's own session, with the prefix taken off and the position already saved; never for notify: false or for a word that only starts with the prefix", async () => {
	const peers: SelfChatPeer[] = [
		{ name: "work", keyword: "work", reply_prefix: "[work]" },
		{ name: "quiet", keyword: "quiet", reply_prefix: "[quiet]", notify: false },
	];
	const state = join(dir, "messengers", "jandi-selfchat.json");
	const saved: number[] = [];
	const replies: Array<[string, string, number]> = [];
	const again = () => createSelfChat(cfg, {
		peers: () => peers,
		dataDir: dir, api: `http://127.0.0.1:${jandi.port}/`, receive: () => {}, log: () => {}, onError: () => {},
		peerReply: (peer, text, id) => {
			saved.push(JSON.parse(readFileSync(state, "utf8")).last_link_id);
			replies.push([peer.name, text, id]);
		},
	});
	const sc = again();
	await sc.tick();   // starts after the history
	messages.push(
		{ id: 2, fromEntity: WEBHOOK_BOT, body: "[work] 빌드 끝났어요" },
		{ id: 3, fromEntity: WEBHOOK_BOT, body: "[quiet] 조용히 해요" },
		{ id: 4, fromEntity: ME, body: "[work] 내가 쓴 글" },
		{ id: 5, fromEntity: WEBHOOK_BOT, body: "[work]네" },
		{ id: 6, fromEntity: WEBHOOK_BOT, body: "그냥 글" },
	);
	await sc.tick();
	await sc.tick();
	expect(replies).toEqual([["work", "빌드 끝났어요", 2], ["work", "내가 쓴 글", 4]]);
	expect(saved).toEqual([2, 4]);
	await again().tick();   // a restart does not notify the same reply again
	expect(replies).toHaveLength(2);
	peers.splice(0, 1);   // the web settings removed it while this polls
	messages.push({ id: 7, fromEntity: WEBHOOK_BOT, body: "[work] 또 끝났어요" });
	await sc.tick();
	expect(replies).toHaveLength(2);
});

test("a peer's status snapshot line raises no peerReply, while a plain reply right after it does", async () => {
	const peers: SelfChatPeer[] = [{ name: "work", keyword: "work", reply_prefix: "[work]" }];
	const replies: string[] = [];
	const sc = createSelfChat(cfg, { peers: () => peers, dataDir: dir, api: `http://127.0.0.1:${jandi.port}/`, receive: () => {}, log: () => {}, onError: () => {}, peerReply: (_p, text) => replies.push(text) });
	await sc.tick();   // starts after the history
	messages.push(
		{ id: 2, fromEntity: WEBHOOK_BOT, body: `[work] #dotz-status.v1 ${JSON.stringify({ v: 1, at: 1, projects: [] })}` },
		{ id: 3, fromEntity: WEBHOOK_BOT, body: "[work] #dotz-status.v1 {broken" },
		{ id: 4, fromEntity: WEBHOOK_BOT, body: "[work] 빌드 끝났어요" },
	);
	await sc.tick();
	expect(replies).toEqual(["빌드 끝났어요"]);
});

// A real-shaped JANDI file message (hub/fixtures/jandi-file-message.json): `attachments[]` on a text record, with or without a caption.
function fileMsg(id: number, from: number, caption?: string, file: Record<string, unknown> = {}): Msg {
	const m = structuredClone(fileRecord.message) as any;
	Object.assign(m.attachments[0].content, { fileUrl: `http://127.0.0.1:${jandi.port}/files/screenshot.png` }, file);
	if (caption !== undefined) m.content.body = caption;
	return { id, fromEntity: from, message: m };
}
type Got = { text: string; files: Upload[] };
function makeFiles(got: Got[], over: Partial<SelfChatDeps> = {}) {
	return createSelfChat(cfg, { dataDir: dir, api: `http://127.0.0.1:${jandi.port}/`, receive: (text, files) => got.push({ text, files }), log: () => {}, onError: () => {}, ...over });
}

test("an owner image with the keyword as caption, and an image alone, each reach dotz with the file saved in the message's own folder", async () => {
	const got: Got[] = [];
	const sc = makeFiles(got);
	await sc.tick();
	messages.push(fileMsg(2, ME, "dotz 이거 봐줘"), fileMsg(3, ME), fileMsg(4, ME, "dotz"));
	await sc.tick();
	expect(got.map(g => g.text)).toEqual(["이거 봐줘", "", ""]);
	for (const [i, g] of got.entries()) {
		expect(g.files).toHaveLength(1);
		const f = g.files[0]!;
		expect(f.path).toMatch(new RegExp(`/uploads/\\d{4}-\\d{2}-\\d{2}/jandi-${i + 2}/screenshot\\.png$`));
		expect(f.path.startsWith(dir)).toBe(true);
		expect({ name: f.name, type: f.type, size: f.size }).toEqual({ name: "screenshot.png", type: "image/png", size: PNG.length });
		expect(new Uint8Array(readFileSync(f.path))).toEqual(PNG);
	}
	expect(calls.filter(c => c === "/files/screenshot.png")).toHaveLength(3); // fetched with the owner's session (the route refuses any other)
});

test("text then an image right after are two messages in order, so the gateway's burst joins them into one turn", async () => {
	const got: Got[] = [];
	const sc = makeFiles(got);
	await sc.tick();
	messages.push({ id: 2, fromEntity: ME, body: "dotz 이 화면 뭐가 문제야" }, fileMsg(3, ME));
	await sc.tick();
	expect(got.map(g => [g.text, g.files.length])).toEqual([["이 화면 뭐가 문제야", 0], ["", 1]]);
});

test("another member's image and the owner's image with a caption for someone else are ignored, and nothing is downloaded", async () => {
	const got: Got[] = [];
	const sc = makeFiles(got);
	await sc.tick();
	messages.push(fileMsg(2, WEBHOOK_BOT), fileMsg(3, WEBHOOK_BOT, "dotz 봐"), fileMsg(4, ME, "메모로 둔 사진"));
	await sc.tick();
	expect(got).toEqual([]);
	expect(calls.some(c => c.startsWith("/files/"))).toBe(false);
	expect(existsSync(join(dir, "uploads"))).toBe(false);
});

test("a file over the size cap or one that cannot be fetched still makes a turn, as an [attachment] line with its JANDI URL", async () => {
	const got: Got[] = [];
	const sc = makeFiles(got, { maxFileBytes: 4 });
	await sc.tick();
	messages.push(fileMsg(2, ME, "dotz 큰 파일"), fileMsg(3, ME, undefined, { size: 1, fileUrl: `http://127.0.0.1:${jandi.port}/files/gone.png`, name: "gone.png" }));
	await sc.tick();
	expect(got).toEqual([
		{ text: `큰 파일\n[attachment] screenshot.png (image/png) http://127.0.0.1:${jandi.port}/files/screenshot.png`, files: [] },
		{ text: `[attachment] gone.png (image/png) http://127.0.0.1:${jandi.port}/files/gone.png`, files: [] },
	]);
	expect(existsSync(join(dir, "uploads"))).toBe(false);
});

test("a record of contentType file (the older shape) is read the same way", async () => {
	const got: Got[] = [];
	const sc = makeFiles(got);
	await sc.tick();
	const content = { ...fileRecord.message.attachments[0]!.content, fileUrl: `http://127.0.0.1:${jandi.port}/files/screenshot.png` };
	messages.push({ id: 2, fromEntity: ME, message: { contentType: "file", content } });
	await sc.tick();
	expect(got.map(g => [g.text, g.files.map(f => f.name)])).toEqual([["", ["screenshot.png"]]]);
});

// Hosts a test cannot serve: everything but the local API goes through `routes`, and `seen` is what each host was sent.
function outside(routes: Record<string, () => Response>) {
	const seen: [string, string | null][] = [];
	const fetcher = ((url: string | URL, init?: RequestInit) => {
		if (String(url).startsWith(`http://127.0.0.1:${jandi.port}/`)) return fetch(url, init);
		seen.push([String(url), new Headers(init?.headers).get("authorization")]);
		return Promise.resolve(routes[String(url)]?.() ?? new Response(null, { status: 404 }));
	}) as typeof fetch;
	return { seen, fetcher };
}
const moved = (to: string) => () => new Response(null, { status: 302, headers: { Location: to } });

test("the session goes to https jandi.com hosts only, never to a lookalike a redirect names", async () => {
	const got: Got[] = [];
	const hop = outside({
		"https://files.jandi.com/a": moved("https://evil-jandi.com/a"),
		"https://evil-jandi.com/a": moved("https://files.jandi.com.evil.test/a"),
		"https://files.jandi.com.evil.test/a": () => new Response(PNG),
	});
	const sc = makeFiles(got, { fetch: hop.fetcher });
	await sc.tick();
	messages.push(fileMsg(2, ME, undefined, { fileUrl: "https://files.jandi.com/a" }));
	await sc.tick();
	expect(hop.seen).toEqual([["https://files.jandi.com/a", "bearer at"], ["https://evil-jandi.com/a", null], ["https://files.jandi.com.evil.test/a", null]]);
	expect(got[0]!.files).toHaveLength(1);
});

test("a downgrade to http, another scheme and an endless redirect are refused; the line and the log keep no query", async () => {
	const got: Got[] = [];
	const logs: string[] = [];
	const hop = outside({
		"https://files.jandi.com/plain?sig=s3cret": moved("http://files.jandi.com/plain?sig=s3cret"),
		"https://files.jandi.com/local": moved("file:///etc/hosts"),
		"https://files.jandi.com/loop": moved("https://files.jandi.com/loop"),
	});
	const sc = makeFiles(got, { fetch: hop.fetcher, log: m => logs.push(m) });
	await sc.tick();
	messages.push(fileMsg(2, ME, undefined, { fileUrl: "https://files.jandi.com/plain?sig=s3cret" }), fileMsg(3, ME, undefined, { fileUrl: "https://files.jandi.com/local" }), fileMsg(4, ME, undefined, { fileUrl: "https://files.jandi.com/loop" }), fileMsg(5, ME, undefined, { fileUrl: "file:///etc/hosts" }));
	await sc.tick();
	expect(got.map(g => [g.text, g.files.length])).toEqual([
		["[attachment] screenshot.png (image/png) https://files.jandi.com/plain", 0],
		["[attachment] screenshot.png (image/png) https://files.jandi.com/local", 0],
		["[attachment] screenshot.png (image/png) https://files.jandi.com/loop", 0],
		["[attachment] screenshot.png (image/png) (not saved)", 0],
	]);
	expect(hop.seen.filter(([u]) => !u.startsWith("https:"))).toEqual([]);
	expect(hop.seen.filter(([u]) => u.endsWith("/loop"))).toHaveLength(4);
	expect(logs.filter(l => l.includes("not saved")).map(l => /\((.+)\)$/.exec(l)?.[1])).toEqual(["not https", "not https", "too many redirects", "not https"]);
	expect(logs.join("\n")).not.toContain("s3cret");
});

test("a body with no Content-Length stops at the cap and leaves no partial file", async () => {
	const got: Got[] = [];
	const sc = makeFiles(got, { maxFileBytes: 20 });
	await sc.tick();
	messages.push(fileMsg(2, ME, "dotz 봐", { fileUrl: `http://127.0.0.1:${jandi.port}/files/unsized.png` }));
	await sc.tick();
	expect(got).toEqual([{ text: `봐\n[attachment] screenshot.png (image/png) http://127.0.0.1:${jandi.port}/files/unsized.png`, files: [] }]);
	const day = readdirSync(join(dir, "uploads"))[0]!;
	expect(readdirSync(join(dir, "uploads", day, "jandi-2"))).toEqual([]);
});

test("a file name cannot leave the message's folder and a saved file is not executable", async () => {
	const got: Got[] = [];
	const sc = makeFiles(got);
	await sc.tick();
	messages.push(fileMsg(2, ME, undefined, { name: "../../../../.ssh/run.sh" }));
	await sc.tick();
	const f = got[0]!.files[0]!;
	expect(f.path).toMatch(/\/uploads\/[^/]+\/jandi-2\/run\.sh$/);
	expect(statSync(f.path).mode & 0o111).toBe(0);
});

test("a stalled file does not hold the turn or the poll: the message's deadline covers all its files", async () => {
	const got: Got[] = [];
	const sc = makeFiles(got, { filesTimeoutMs: 50 });
	await sc.tick();
	const stalled = fileMsg(2, ME, "dotz 봐", { fileUrl: `http://127.0.0.1:${jandi.port}/files/stalled.png` }) as { message: { attachments: unknown[] } };
	stalled.message.attachments.push(stalled.message.attachments[0]);
	messages.push(stalled as unknown as Msg, { id: 3, fromEntity: ME, body: "dotz 다음" });
	await sc.tick();
	expect(got.map(g => g.text.split("\n").length)).toEqual([3, 1]);
	expect(got.map(g => g.files)).toEqual([[], []]);
	expect(got[1]!.text).toBe("다음");
});

test("a text before a file waits for the download, so both land in one burst; stop() during a download leaves the rest to the next reader", async () => {
	const got: Got[] = [];
	const at: number[] = [];
	let sc: ReturnType<typeof makeFiles>;
	const hop = outside({
		"https://files.jandi.com/a": () => {
			at.push(got.length);
			sc.stop();
			return new Response(PNG);
		},
	});
	sc = makeFiles(got, { fetch: hop.fetcher });
	await sc.tick();
	messages.push({ id: 2, fromEntity: ME, body: "dotz 이거" }, fileMsg(3, ME, undefined, { fileUrl: "https://files.jandi.com/a" }), { id: 4, fromEntity: ME, body: "dotz 다음" });
	await sc.tick();
	expect(at).toEqual([0]);
	expect(got.map(g => [g.text, g.files.length])).toEqual([["이거", 0], ["", 1]]);
	const next: Got[] = [];
	const again = makeFiles(next);
	await again.tick();
	expect(next.map(g => g.text)).toEqual(["다음"]);
});

function runOnce(lost: string[], extra: Partial<SelfChatDeps> = {}) {
	const errors: (string | undefined)[] = [];
	const sc: ReturnType<typeof createSelfChat> = createSelfChat(cfg, {
		dataDir: dir,
		api: `http://127.0.0.1:${jandi.port}/`,
		receive: () => {},
		log: () => {},
		onError: e => errors.push(e),
		onSessionLost: () => lost.push("lost"),
		sleep: async () => sc.stop(),
		...extra,
	});
	return { sc, errors };
}

test("a token exchange answered 400, 401 or 403 is a lost session; a 5xx is not", async () => {
	for (const status of [400, 401, 403]) {
		tokenStatus = status;
		const lost: string[] = [];
		const { sc } = runOnce(lost);
		await sc.run();
		expect(lost).toEqual(["lost"]);
	}
	tokenStatus = 503;
	const lost: string[] = [];
	const { sc, errors } = runOnce(lost);
	await sc.run();
	expect(lost).toEqual([]);
	expect(errors.at(-1)).toContain("503");
});

test("a missing or empty session secret is a lost session", async () => {
	rmSync(join(dir, "secrets", "jandi-session"));
	const lost: string[] = [];
	await runOnce(lost).sc.run();
	expect(lost).toEqual(["lost"]);
	writeFileSync(join(dir, "secrets", "jandi-session"), JSON.stringify({ refresh_token: "" }), { mode: 0o600 });
	await runOnce(lost).sc.run();
	expect(lost).toEqual(["lost", "lost"]);
});

test("a network failure is not a lost session", async () => {
	const lost: string[] = [];
	const { sc, errors } = runOnce(lost, { api: "http://127.0.0.1:1/" });
	await sc.run();
	expect(lost).toEqual([]);
	expect(errors.at(-1)).toBeTruthy();
});

test("a reply the owner's own session posted reaches the peer's notice, not the commands, and a prefixed post is never read as a command", async () => {
	const peers: SelfChatPeer[] = [{ name: "집", keyword: "home", reply_prefix: "[home]" }];
	const got: string[] = [];
	const replies: string[] = [];
	const own = { ...cfg, keyword: "dotz", reply_prefix: "[dotz]" };
	const sc = createSelfChat(own, {
		dataDir: dir,
		api: `http://127.0.0.1:${jandi.port}/`,
		receive: t => got.push(t),
		peers: () => peers,
		peerReply: (_p, text) => replies.push(text),
		log: () => {},
		onError: () => {},
	});
	await sc.tick();
	messages.push(
		{ id: 2, fromEntity: ME, body: "[home] 끝났어요" },
		{ id: 3, fromEntity: ME, body: "[dotz] dotz 안녕" },
		{ id: 4, fromEntity: ME, body: "[dotz] 안녕하세요" },
		{ id: 5, fromEntity: ME, body: "dotz 진짜 명령" },
	);
	await sc.tick();
	expect(replies).toEqual(["끝났어요"]);
	expect(got).toEqual(["진짜 명령"]);
});
