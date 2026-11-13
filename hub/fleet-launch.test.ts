import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFleetLaunch, type FleetLaunch, normRepo, repoOf } from "./fleet-launch.ts";
import { type Computer, FLEET_V, type FleetRow, type Load } from "./fleet.ts";
import { msg } from "./i18n.ts";
import { checkPeer } from "./peer-auth.ts";
import { createPeerMonitor } from "./peer-monitor.ts";

// Two gateways (A asks, B receives) in one process, wired by an injected fetch; the repositories are real temp git repos with a bare origin.
const TOKEN = "t".repeat(24);
const LOGIN = "owner@example.test";
const SECRET = "fleet-fixture-value-7Qm42";
const URL_A = "https://a.example.test";
const URL_B = "https://b.example.test";
const URL_C = "https://c.example.test";
const URL_D = "https://d.example.test";
const REPO_URL = "https://git.example.test/o/proj.git";
const REPO = "git.example.test/o/proj";
let clock = 1_000_000;

const run = (args: string[]): string => {
	const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
};
const git = (cwd: string, ...args: string[]): string => run(["-C", cwd, ...args]);

type Gw = {
	name: string;
	folder: string;
	data: string;
	rows: FleetRow[];
	launch: FleetLaunch;
	handle: (req: Request) => Promise<Response>;
	lanesPosted: any[];
	lanesAnswer?: () => Response;
	messages: any[];
	delivered: Array<{ conv: string; text: string }>;
	acts: any[];
	logs: string[];
	down: boolean;
	auto: boolean;
};
const nodes = new Map<string, Gw>();
let fetched: string[] = [];
const netFetch = async (url: string, init?: RequestInit): Promise<Response> => {
	fetched.push(url);
	const g = nodes.get(new URL(url).origin);
	if (!g || g.down) throw new Error("connection refused");
	return g.handle(new Request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "tailscale-user-login": LOGIN } }));
};

const load = (over: Partial<Load["lanes"]> = {}): Load => ({ v: FLEET_V, name: "x", at: clock, working: false, paused: false, running: [], sessions: { live: 0, cap: 4, reason: "" }, lanes: { active: 0, cap: 3, waiting: 0, ...over }, waitlist: 0 }) as Load;
const row = (name: string, url: string, over: Partial<FleetRow> = {}): FleetRow => ({ name, url, self: false, online: true, state: "idle", load: load(), ...over });

let root = "";
let bare = "";
function wire(dir: string): void {
	git(dir, "config", "user.name", "tester");
	git(dir, "config", "user.email", "tester@example.test");
	git(dir, "config", "commit.gpgsign", "false");
	git(dir, "config", `url.${bare}.insteadOf`, REPO_URL);
}

function gateway(name: string, url: string, folder: string, computers: Computer[]): Gw {
	const data = join(root, `${name}-data`);
	mkdirSync(data, { recursive: true });
	const g: Gw = { name, folder, data, rows: [], launch: undefined as never, handle: undefined as never, lanesPosted: [], messages: [], delivered: [], acts: [], logs: [], down: false, auto: false };
	const local = async (req: Request): Promise<Response> => {
		const path = new URL(req.url).pathname;
		if (req.method === "POST" && path === "/api/lanes") {
			const b = (await req.json()) as { name: string };
			g.lanesPosted.push(b);
			return g.lanesAnswer ? g.lanesAnswer() : Response.json({ ok: true, lane: b.name });
		}
		if (req.method === "POST" && path === "/api/message") {
			g.messages.push(await req.json());
			return Response.json({ ok: true });
		}
		if (req.method === "GET" && path === "/api/peer/projects") return Response.json({ name, projects: [{ key: `dir:${folder}`, name: "proj", repo: await repoOf(folder) }] });
		return new Response("not found", { status: 404 });
	};
	g.launch = createFleetLaunch({
		name: () => name, fleet: async () => g.rows, computers: async () => computers, folders: () => [folder],
		deliver: (conv, text) => void g.delivered.push({ conv, text }), fetch: netFetch, token: () => TOKEN, pair: async () => ({ ok: true }) as never,
		secrets: () => [SECRET], dataDir: () => data, log: m => void g.logs.push(m), now: () => clock, newName: () => "fleet-b1", autoOn: () => g.auto,
	});
	const mon = createPeerMonitor({ name: () => name, local, computers: async () => computers, fetch: netFetch, now: () => clock, token: () => TOKEN, timeoutMs: 20, log: m => void g.logs.push(m), launch: g.launch });
	g.handle = async req => {
		if (checkPeer(req, TOKEN) === "denied") return new Response("forbidden", { status: 403 });
		const path = new URL(req.url).pathname;
		if (req.method === "POST" && path === "/api/peer/act") g.acts.push(await req.clone().json());
		return (await mon.route(req, new URL(req.url))) ?? local(req);
	};
	nodes.set(url, g);
	return g;
}

let A: Gw;
let B: Gw;
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "fleet-launch-"));
	bare = join(root, "origin.git");
	run(["init", "--bare", "-b", "main", bare]);
	const a = join(root, "a", "proj");
	mkdirSync(a, { recursive: true });
	run(["init", "-b", "main", a]);
	git(a, "remote", "add", "origin", REPO_URL);
	wire(a);
	writeFileSync(join(a, "readme.txt"), "one\n");
	git(a, "add", ".");
	git(a, "commit", "-m", "first");
	git(a, "push", "-u", "origin", "main");
	const b = join(root, "b", "proj");
	mkdirSync(join(root, "b"), { recursive: true });
	run(["clone", bare, b]);
	git(b, "remote", "set-url", "origin", REPO_URL);
	wire(b);
	const all: Computer[] = [{ name: "맥미니", url: URL_A, self: true }, { name: "맥북", url: URL_B, self: false }];
	A = gateway("맥미니", URL_A, a, all);
	B = gateway("맥북", URL_B, b, all.map(c => ({ ...c, self: !c.self })));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
	clock += 1000;
	fetched = [];
	for (const g of [A, B]) {
		g.lanesPosted = [];
		g.lanesAnswer = undefined;
		g.messages = [];
		g.delivered = [];
		g.acts = [];
		g.logs = [];
		g.down = false;
		g.auto = false;
	}
	A.rows = [row("맥미니", URL_A, { self: true, state: "busy" }), row("맥북", URL_B)];
});

const req = (over: Partial<Parameters<FleetLaunch["placeLaunch"]>[0]> = {}) => ({ cwd: A.folder, title: "정리 작업", brief: "목표: 정리\n완료: bun test 통과", why: "오래 걸리는 정리예요", conv: "main", ...over });
const actOn = (g: Gw, from: string, action: string, args: object, url = g === B ? URL_B : URL_A) => g.handle(new Request(`${url}/api/peer/act`, { method: "POST", headers: { "x-dotz-peer": TOKEN, "tailscale-user-login": LOGIN }, body: JSON.stringify({ action, args, from }) }));
const sentRows = () => A.launch.sent();

test("normRepo drops scheme, credentials, port and .git, and names no repository for a local path", () => {
	for (const url of [REPO_URL, "git@git.example.test:o/proj.git", "https://user:tok-123@git.example.test/o/proj", "ssh://git@git.example.test:22/o/proj.git/", "https://Git.Example.test/o/proj"]) expect(normRepo(url)).toBe(REPO);
	expect(normRepo("https://user:tok-123@git.example.test/o/proj")).not.toContain("tok");
	expect(normRepo("/some/local/path")).toBeUndefined();
	expect(normRepo("file:///some/local/path")).toBeUndefined();
	expect(normRepo("")).toBeUndefined();
});

test("a pick is refused while the computer is unknown, offline or on an older dotz, with nothing sent", async () => {
	const err = async (pick: string) => {
		const r = await A.launch.placeLaunch(req(), { computer: pick });
		expect(r.ok).toBe(false);
		return r.ok ? "" : r.error;
	};
	expect(await err("없는컴퓨터")).toBe(msg().fleetUnknown("없는컴퓨터"));
	A.rows = [row("맥미니", URL_A, { self: true }), row("맥북", URL_B, { online: false, state: "offline", load: null })];
	expect(await err("맥북")).toBe(msg().fleetOffline("맥북"));
	A.rows = [row("맥미니", URL_A, { self: true }), row("맥북", URL_B, { load: null, legacy: true })];
	expect(await err("맥북")).toBe(msg().fleetLegacy("맥북"));
	A.rows = [row("맥미니", URL_A, { self: true }), row("맥북", URL_B, { load: { ...load(), v: FLEET_V + 1 } })];
	expect(await err("맥북")).toBe(msg().fleetLegacy("맥북"));
	expect(B.acts).toEqual([]);
});

test("a folder that is not a git repository with an origin stays here; so does a title or brief that carries a secret", async () => {
	const plain = join(root, "plain");
	mkdirSync(plain, { recursive: true });
	expect(await A.launch.placeLaunch(req({ cwd: plain }), { computer: "맥북" })).toEqual({ ok: false, error: msg().fleetNotGit });
	const r = await A.launch.placeLaunch(req({ brief: `목표: x\n완료: y\nkey ${SECRET}` }), { computer: "맥북" });
	expect(r.ok).toBe(false);
	expect(r.ok ? "" : r.error).not.toContain(SECRET);
	expect(B.acts).toEqual([]);
});

test("a HEAD that is not on a remote branch asks for a push first, and sends nothing", async () => {
	writeFileSync(join(A.folder, "pulled.txt"), "x\n");
	git(A.folder, "add", ".");
	git(A.folder, "commit", "-m", "second");
	expect(await A.launch.placeLaunch(req(), { computer: "맥북" })).toEqual({ ok: false, error: msg().fleetPush });
	expect(B.acts).toEqual([]);
});

test("manual placement: B pulls, starts the session in its own project folder through its own route, and A records it", async () => {
	git(A.folder, "push", "origin", "main");
	const r = await A.launch.placeLaunch(req({ hours: 2, est: 5 }), { computer: "맥북" });
	expect(r).toEqual({ ok: true, computer: "맥북", lane: "fleet-b1" });
	const launchAct = B.acts.find(a => a.action === "launch");
	expect(launchAct.from).toBe("맥미니");
	expect(Object.keys(launchAct.args).sort()).toEqual(["branch", "brief", "conv", "est", "hours", "repo", "title", "v", "why"]);
	expect(launchAct.args).toMatchObject({ v: FLEET_V, repo: REPO, branch: "main", conv: "main" });
	expect(B.lanesPosted).toHaveLength(1);
	const posted = B.lanesPosted[0];
	expect(posted.cwd).toBe(B.folder);
	expect(Object.keys(posted).sort()).toEqual(["brief", "cwd", "est", "hours", "name", "peer", "title", "why"]);
	expect(posted.peer).toEqual({ name: "맥미니", conv: "main" });
	expect(readFileSync(join(B.folder, "pulled.txt"), "utf8")).toBe("x\n");
	expect(JSON.parse(readFileSync(join(A.data, "fleet-sent.json"), "utf8"))).toEqual([{ lane: "fleet-b1", computer: "맥북", conv: "main", title: "정리 작업", at: clock }]);
	expect(A.logs.some(l => l.includes("placed on 맥북"))).toBe(true);
});

test("B refuses a dirty working tree, a repo it has no project for, a wrong version and an incomplete request", async () => {
	writeFileSync(join(B.folder, "dirty.txt"), "wip\n");
	const dirty = await A.launch.placeLaunch(req(), { computer: "맥북" });
	expect(dirty).toEqual({ ok: false, error: msg().fleetUnreachable("맥북", msg().fleetDirty) });
	rmSync(join(B.folder, "dirty.txt"));
	expect(B.lanesPosted).toEqual([]);

	git(B.folder, "remote", "set-url", "origin", "https://git.example.test/o/other.git");
	expect(await A.launch.placeLaunch(req(), { computer: "맥북" })).toEqual({ ok: false, error: msg().fleetNoProject("맥북") });
	git(B.folder, "remote", "set-url", "origin", REPO_URL);

	const good = { v: FLEET_V, repo: REPO, title: "t", brief: "b", why: "w", conv: "main" };
	expect((await actOn(B, "맥미니", "launch", { ...good, v: 0 })).status).toBe(409);
	expect((await actOn(B, "맥미니", "launch", { ...good, repo: "git.example.test/o/unknown" })).status).toBe(409);
	expect((await actOn(B, "맥미니", "launch", { ...good, brief: "" })).status).toBe(400);
	expect(B.lanesPosted).toEqual([]);
});

test("B's own launch refusal comes back as the answer and leaves no row behind", async () => {
	const before = sentRows().length;
	B.lanesAnswer = () => Response.json({ error: "Done-when missing" }, { status: 409 });
	expect(await A.launch.placeLaunch(req(), { computer: "맥북" })).toEqual({ ok: false, error: msg().fleetUnreachable("맥북", "Done-when missing") });
	expect(sentRows()).toHaveLength(before);
});

test("auto placement does nothing with the switch off, or when the launch would not wait", async () => {
	expect(await A.launch.placeAuto(req(), "lanes full")).toBeUndefined();
	A.auto = true;
	expect(await A.launch.placeAuto(req(), undefined)).toBeUndefined();
	expect(B.acts).toEqual([]);
});

test("auto placement (switch on, full here) takes the idle computer with room, never a full or busier one, and nothing fitting keeps it here", async () => {
	A.auto = true;
	A.rows = [
		row("맥미니", URL_A, { self: true, state: "busy" }),
		row("서버", URL_C, { state: "busy", load: load({ active: 2 }) }),
		row("노트", URL_D, { state: "busy", load: load({ active: 3 }) }),
		row("맥북", URL_B),
	];
	const r = await A.launch.placeAuto(req(), "lanes full");
	expect(r).toMatchObject({ ok: true, computer: "맥북" });
	expect(fetched.some(u => u.startsWith(URL_C) || u.startsWith(URL_D))).toBe(false);
	expect(B.lanesPosted).toHaveLength(1);
	A.rows = [row("맥미니", URL_A, { self: true }), row("맥북", URL_B, { online: false, state: "offline", load: null }), row("노트", URL_D, { state: "busy", load: load({ active: 3 }) })];
	expect(await A.launch.placeAuto(req(), "lanes full")).toBeUndefined();
});

test("B's questions and final reports reach the asking conversation prefixed with the computer and title; progress wakes nothing; a final one clears the sent row", async () => {
	sentRows();
	await A.launch.placeLaunch(req(), { computer: "맥북" });
	const lane = { name: "fleet-b1", title: "정리 작업", peer: { name: "맥미니", conv: "main" } };
	B.launch.report(lane, "[run] 절반 했어요");
	await B.launch.idle();
	expect(A.delivered).toEqual([]);
	B.launch.report(lane, "[ask] 어느 쪽으로 할까요?");
	await B.launch.idle();
	expect(A.delivered).toHaveLength(1);
	expect(A.delivered[0]!.conv).toBe("main");
	expect(A.delivered[0]!.text).toContain("맥북 · 정리 작업");
	expect(A.delivered[0]!.text).toContain("어느 쪽으로");
	expect(sentRows().some(r => r.lane === "fleet-b1")).toBe(true);
	B.launch.report(lane, "[done] 끝났어요");
	await B.launch.idle();
	expect(A.delivered).toHaveLength(2);
	expect(sentRows().some(r => r.lane === "fleet-b1")).toBe(false);
});

test("a report of a session A never started is refused, a lane without a peer sends nothing, and an unreachable A is only logged", async () => {
	expect((await actOn(A, "맥북", "lane-report", { lane: "other", text: "[done] x" })).status).toBe(404);
	B.launch.report({ name: "plain", title: "t" }, "[done] x");
	await B.launch.idle();
	expect(A.delivered).toEqual([]);
	A.down = true;
	B.launch.report({ name: "fleet-b1", title: "t", peer: { name: "맥미니", conv: "main" } }, "[run] x");
	await B.launch.idle();
	expect(B.logs.some(l => l.includes("fleet-b1 report"))).toBe(true);
});

test("the owner's answer reaches B's session through the message action with target lane:<name>", async () => {
	const r = await actOn(B, "맥미니", "message", { target: "lane:fleet-b1", text: "그대로 진행해" });
	expect(r.status).toBe(200);
	expect(B.messages).toEqual([{ lane: "fleet-b1", text: "그대로 진행해", via: "맥미니" }]);
});
