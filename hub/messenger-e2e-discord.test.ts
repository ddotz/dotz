// End to end through Discord: the real gateway (`bun hub/main.ts`, as hub/update-smoke.ts starts it) on a temp HOME and data dir, talking to a
// fake Discord (REST on DOTZ_DISCORD_API, the gateway websocket on DOTZ_DISCORD_GATEWAY) with a scripted omp (DOTZ_OMP) as the orchestrator.
// No tailscale is found (DOTZ_TAILSCALE_BIN is empty), so the web address stays unknown: file links and form links must cope with that.
// Time here is Bun.nanoseconds and Bun.sleep (the bun test preload fakes Date.now and setTimeout, hub/runtime/test-clock.ts); every wait is
// an event from the fake server or the gateway's output, bounded by a real deadline.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Server, ServerWebSocket, Subprocess } from "bun";

const root = join(import.meta.dir, "..");
const ms = () => Bun.nanoseconds() / 1e6;
const GUILD = "9000000000000000001";
const OWNER = "9000000000000000002";
const BOT = "9000000000000000003";

type Chan = { id: string; name: string; type: number; parent_id?: string; topic?: string };
type Post = { channel: string; content: string };

let tmp = "";
let fake: Server<unknown>;
let gateway: Subprocess<"ignore", "pipe", "pipe"> | undefined;
let exited = false;
let output = "";
let base = "";
let hubToken = "";
let ws: ServerWebSocket<unknown> | undefined;
const channels: Chan[] = [];
const posts: Post[] = [];
const unknown: string[] = [];
let nextId = 9100000000000000000n;
const newId = () => String(nextId++);

// Everything the tests wait on lands here; `waitFor` re-checks after each one.
const waiters = new Set<() => void>();
const changed = () => waiters.forEach(w => w());
async function waitFor<T>(what: string, find: () => T | undefined, limitMs = 8000): Promise<T> {
	const deadline = ms() + limitMs;
	for (;;) {
		const hit = find();
		if (hit !== undefined) return hit;
		if (exited) throw new Error(`the gateway exited while waiting for ${what}\n${tail()}`);
		const left = deadline - ms();
		if (left <= 0) throw new Error(`timed out waiting for ${what}\n${tail()}`);
		let wake!: () => void;
		const next = new Promise<void>(r => void (wake = r));
		waiters.add(wake);
		await Promise.race([next, Bun.sleep(left)]);
		waiters.delete(wake);
	}
}
const tail = () => {
	const hubLog = (() => {
		try {
			return readFileSync(join(tmp, "data", "hub.log"), "utf8");
		} catch {
			return "";
		}
	})();
	return `--- posts: ${posts.map(p => `${p.channel}: ${p.content.slice(0, 60)}`).join(" | ")}\n--- fake discord, unhandled calls: ${unknown.join(" | ") || "none"} ---\n--- gateway output ---\n${output.split("\n").slice(-30).join("\n")}\n--- hub.log ---\n${hubLog.split("\n").slice(-30).join("\n")}`;
};

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

// The REST calls the gateway makes in this run; anything else answers {} and is listed in the failure output.
async function rest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname.replace(/^\/api\/v10/, "");
	const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json().catch(() => ({}));
	let m: RegExpMatchArray | null;
	if (req.method === "GET" && path === "/users/@me") return json({ id: BOT, username: "fakebot" });
	if (req.method === "GET" && path === `/guilds/${GUILD}/channels`) return json(channels);
	if (req.method === "GET" && path === `/guilds/${GUILD}/roles`) return json([]);
	if (req.method === "POST" && path === `/guilds/${GUILD}/channels`) {
		const c: Chan = { id: newId(), name: body.name, type: body.type, ...(body.parent_id ? { parent_id: body.parent_id } : {}), ...(body.topic ? { topic: body.topic } : {}) };
		channels.push(c);
		changed();
		return json(c);
	}
	if ((m = path.match(/^\/channels\/(\d+)$/))) {
		const c = channels.find(x => x.id === m![1]);
		if (req.method === "GET") return c ? json(c) : json({ message: "Unknown Channel" }, 404);
		if (req.method === "PATCH" && c) return json(Object.assign(c, body));
		if (req.method === "DELETE") return json(c ?? {});
	}
	if ((m = path.match(/^\/channels\/(\d+)\/messages$/))) {
		if (req.method === "GET") return json([]);
		if (req.method === "POST") {
			posts.push({ channel: m[1]!, content: String(body?.content ?? "") });
			changed();
			return json({ id: newId(), channel_id: m[1], content: String(body?.content ?? ""), author: { id: BOT, bot: true } });
		}
	}
	if ((m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/)) && req.method === "PATCH") return json({ id: m[2], channel_id: m[1], content: String(body?.content ?? "") });
	if (req.method === "PATCH" && path === "/users/@me") {
		profileSynced = true;
		changed();
		return json({ id: BOT, username: "fakebot" });
	}
	if (req.method === "POST" && /\/typing$/.test(path)) return new Response(null, { status: 204 });
	if (req.method === "PUT" && /\/(reactions|permissions)\//.test(path)) return new Response(null, { status: 204 });
	unknown.push(`${req.method} ${path}`);
	return json({});
}

const dispatch = (t: string, d: unknown) => ws!.send(JSON.stringify({ op: 0, t, s: 1, d }));
let ready = false;
let profileSynced = false;
const ownerSays = (channel: string, content: string, guild = true) =>
	dispatch("MESSAGE_CREATE", { id: newId(), channel_id: channel, ...(guild ? { guild_id: GUILD } : {}), author: { id: OWNER, username: "owner", bot: false }, content, attachments: [], mentions: [] });

// The scripted omp: `omp --mode rpc` answers every prompt with "answer <the first MARK-word in it>"; any other omp call prints nothing and exits.
const STUB = `#!${process.execPath}
if (!process.argv.includes("rpc")) process.exit(0);
const out = f => process.stdout.write(JSON.stringify(f) + "\\n");
let buf = "";
process.stdin.on("data", chunk => {
	buf += chunk;
	let nl;
	while ((nl = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		let f;
		try { f = JSON.parse(line); } catch { continue; }
		if (f.type !== "prompt") continue;
		const mark = /MARK-[A-Za-z0-9]+/.exec(String(f.message))?.[0];
		out({ type: "agent_start" });
		out({ type: "message_end", message: { role: "user", content: String(f.message) } });
		if (mark) out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer " + mark }], stopReason: "stop" } });
		out({ type: "agent_end" });
	}
});
`;

const freePort = (): number => {
	const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const port = s.port as number;
	s.stop(true);
	return port;
};

async function pump(stream: ReadableStream<Uint8Array>): Promise<void> {
	const decoder = new TextDecoder();
	for await (const chunk of stream) {
		output += decoder.decode(chunk);
		changed();
	}
}

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), "dotz-e2e-discord-"));
	const home = join(tmp, "home"), data = join(tmp, "data"), bin = join(tmp, "bin");
	for (const d of [home, join(data, "secrets"), bin]) mkdirSync(d, { recursive: true });

	fake = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, server) {
			if (new URL(req.url).pathname === "/gateway") return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
			return rest(req);
		},
		websocket: {
			open(s) {
				ws = s;
				s.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));
			},
			message(s, raw) {
				const f = JSON.parse(String(raw));
				if (f.op === 1) s.send(JSON.stringify({ op: 11 }));
				if (f.op === 2) {
					s.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "fake-session", resume_gateway_url: `ws://127.0.0.1:${fake.port}/gateway`, user: { id: BOT, username: "fakebot" } } }));
					ready = true;
					changed();
				}
			},
		},
	});

	const omp = join(bin, "omp");
	writeFileSync(omp, STUB);
	chmodSync(omp, 0o755);
	writeFileSync(join(data, "secrets", "discord-token"), "fake-token\n");
	const port = freePort();
	writeFileSync(
		join(data, "config.json"),
		JSON.stringify({
			identity: { name: "e2e", language: "ko", timezone: "Asia/Seoul" },
			runtime: "omp",
			discord: { token_file: join(data, "secrets", "discord-token"), guild: GUILD, owner_id: OWNER },
			// a tailscale port without a tailscale binary: the web address (webBase) stays undefined
			web: { port, tailscale_https_port: 8443, peer_discovery: false },
			zele: { enabled: false },
			omp_update: { mode: "off" },
			self_update: { auto_check: false },
		}),
	);

	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("DOTZ_") && !k.startsWith("OMO_") && !k.startsWith("PI_")) env[k] = v;
	Object.assign(env, {
		HOME: home,
		// directories without a tailscale binary: bun's own, the system's
		PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
		DOTZ_DIR: data,
		DOTZ_PORT: String(port),
		DOTZ_HARNESS: "none",
		DOTZ_TAILSCALE_BIN: "",
		DOTZ_ALLOW_LIVE: "1",
		DOTZ_DISCORD_API: `http://127.0.0.1:${fake.port}`,
		DOTZ_DISCORD_GATEWAY: `ws://127.0.0.1:${fake.port}/gateway`,
		DOTZ_OMP: omp,
		DOTZ_OMO: join(tmp, "no-omo"),
		OMO_CODING_AGENT_DIR: join(tmp, "omo-agent"),
		OMO_USER_CONFIG: join(tmp, "omo-home", "omo.json"),
	});
	base = `http://127.0.0.1:${port}`;
	gateway = Bun.spawn([process.execPath, "hub/main.ts"], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	void gateway.exited.then(() => {
		exited = true;
		changed();
	});
	void pump(gateway.stdout);
	void pump(gateway.stderr);

	// The profile sync is the last step of the Discord boot (hub/main.ts), after the web server listens and the channels exist.
	await waitFor("the gateway to finish its Discord boot", () => (profileSynced && ready && channels.filter(c => c.type === 0).length >= 3 ? true : undefined), 15_000);
	hubToken = readFileSync(join(data, "secrets", "hub-token"), "utf8").trim();
}, 20_000);

afterAll(async () => {
	if (gateway && !exited) {
		gateway.kill("SIGTERM");
		const stopped = await Promise.race([gateway.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
		if (!stopped) {
			gateway.kill("SIGKILL");
			await gateway.exited;
		}
	}
	fake?.stop(true);
	rmSync(tmp, { recursive: true, force: true });
});

// ensureChannels creates the category, the work category, then chat, alert and worklog (in that order) under the first category.
const named = () => {
	const [category, workCategory] = channels.filter(c => c.type === 4);
	const [chat, alert, worklog] = channels.filter(c => c.type === 0 && c.parent_id === category!.id);
	return { category: category!, workCategory: workCategory!, chat: chat!, alert: alert!, worklog: worklog! };
};
const postTo = (channel: string, mark: string) => posts.find(p => p.channel === channel && p.content.includes(mark));

test("the gateway is up with no tailscale, and /api/health answers a token", async () => {
	const ok = await fetch(`${base}/api/health`, { headers: { "x-dotz-token": hubToken }, signal: AbortSignal.timeout(5000) });
	expect(ok.status).toBe(200);
	const denied = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
	expect(denied.status).not.toBe(200);
	expect(exited).toBe(false);
	expect(unknown).toEqual([]);
});

test("an owner message in chat is answered in chat", async () => {
	const { chat } = named();
	ownerSays(chat.id, "MARK-chat1 hello there");
	const post = await waitFor("the answer in chat", () => postTo(chat.id, "answer MARK-chat1"));
	expect(post.channel).toBe(chat.id);
}, 12_000);

test("an owner message in a work channel is answered in that channel", async () => {
	const { workCategory } = named();
	const project: Chan = { id: newId(), name: "project-x", type: 0, parent_id: workCategory.id };
	channels.push(project);
	ownerSays(project.id, "MARK-work1 status of project x?");
	const post = await waitFor("the answer in the work channel", () => postTo(project.id, "answer MARK-work1"));
	expect(post.channel).toBe(project.id);
	expect(posts.some(p => p.content.includes("answer MARK-work1") && p.channel !== project.id)).toBe(false);
}, 12_000);

test("an alert reaches the alert channel", async () => {
	const { alert } = named();
	const r = await fetch(`${base}/api/send`, {
		method: "POST",
		headers: { "x-dotz-token": hubToken, "content-type": "application/json" },
		body: JSON.stringify({ target: "alert", text: "MARK-alert1 disk is almost full" }),
		signal: AbortSignal.timeout(5000),
	});
	expect(r.status).toBe(200);
	const post = await waitFor("the alert in the alert channel", () => postTo(alert.id, "MARK-alert1"));
	expect(post.channel).toBe(alert.id);
}, 12_000);

test("the gateway survived every path without a web address", async () => {
	const r = await fetch(`${base}/api/health`, { headers: { "x-dotz-token": hubToken }, signal: AbortSignal.timeout(5000) });
	expect(r.status).toBe(200);
	expect(exited).toBe(false);
});
