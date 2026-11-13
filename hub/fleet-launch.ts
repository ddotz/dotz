// Starting a session on another paired computer (docs/fleet.md "Starting work on another computer").
//   sender    placeLaunch: the checks, then POST /api/peer/act `launch` to the chosen computer; `fleet-sent.json` remembers what went where
//   receiver  receive: finds its own folder of the same repo, pulls (never copies), starts the session through its own POST /api/lanes
//   reports   report (that computer -> here) and receiveReport (here): a session's report lands in the asking conversation
// A project is the same on two computers when `normRepo` of their `origin` is the same; a folder without a git origin stays where it is.
// Everything outside (fleet rows, git, fetch, pair, token, clock, data dir, delivery) is injected, so tests run two gateways in one process.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, log as hubLog, writeAtomic } from "./config.ts";
import { FLEET_V, type Computer, type FleetRow } from "./fleet.ts";
import { msg } from "./i18n.ts";
import { peerHeaders, peerTokenFor } from "./peer-auth.ts";
import { createPairer, type PairResult } from "./peer-pair.ts";
import { knownComputers } from "./peers.ts";
import { json } from "./routes-util.ts";
import { peerFetch } from "./tailnet-fetch.ts";
import { parseTone } from "./tone.ts";

// `https://user:token@host/o/n.git`, `git@host:o/n.git`, `ssh://git@host:22/o/n` -> `host/o/n`: no scheme, user, password, port or `.git`.
// A local path or a file URL names no shared repository: undefined.
export function normRepo(url: string): string | undefined {
	const s = url.trim();
	let host: string;
	let path: string;
	const scp = s.includes("://") ? null : /^(?:[^@/\s]+@)?([A-Za-z0-9][A-Za-z0-9.-]*):([^\s]+)$/.exec(s);
	if (scp) {
		host = scp[1]!;
		path = scp[2]!;
	} else {
		try {
			const u = new URL(s);
			if (!/^(https?|ssh|git):$/.test(u.protocol)) return undefined;
			host = u.hostname;
			path = decodeURIComponent(u.pathname);
		} catch {
			return undefined;
		}
	}
	const parts = path.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
	if (!host || parts.length < 2 || parts.some(p => p === ".." || p === "." || /\s/.test(p))) return undefined;
	return `${host.toLowerCase()}/${parts.join("/")}`;
}

export type Git = (cwd: string, args: string[]) => Promise<{ code: number; out: string; err: string }>;
const GIT_MS = 60_000;
export const runGit: Git = async (cwd, args) => {
	try {
		const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
		const timer = setTimeout(() => p.kill(), GIT_MS);
		const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
		const code = await p.exited;
		clearTimeout(timer);
		return { code, out: out.trim(), err: err.trim() };
	} catch (e) {
		return { code: -1, out: "", err: e instanceof Error ? e.message : String(e) };
	}
};

// The normalized `origin` of a folder (the raw configured URL, so a local `insteadOf` rewrite never changes the identity); undefined = no git origin.
export async function repoOf(cwd: string, git: Git = runGit): Promise<string | undefined> {
	const r = await git(cwd, ["config", "--get", "remote.origin.url"]);
	return r.code === 0 ? normRepo(r.out) : undefined;
}
// A peer reads the list often (the sidebar); one folder's origin is read again after a minute.
const REPO_TTL_MS = 60_000;
const repoCache = new Map<string, { at: number; repo: string | undefined }>();
export async function repoOfCached(cwd: string, git: Git = runGit, now: () => number = Date.now): Promise<string | undefined> {
	const hit = repoCache.get(cwd);
	if (hit && now() - hit.at < REPO_TTL_MS) return hit.repo;
	const repo = await repoOf(cwd, git);
	repoCache.set(cwd, { at: now(), repo });
	return repo;
}

export type SentRow = { lane: string; computer: string; conv: string; title: string; at: number };
export type LaunchRequest = { cwd: string; title: string; brief: string; why: string; hours?: number; est?: number; owner_asked_for_lane?: boolean; conv: string };
export type Placed = { ok: true; computer: string; lane: string } | { ok: false; error: string };
export type Ask = (method: string, path: string, data?: unknown) => Promise<Response>;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type PeerLane = { name: string; title?: string; peer?: { name: string; conv: string } };

export type FleetLaunchDeps = {
	name: () => string;
	fleet: () => Promise<FleetRow[]>;
	computers?: () => Promise<Computer[]>;
	/** The project entries (their `repo`) a peer lists at GET /api/peer/projects; undefined = could not read. */
	projects?: (url: string) => Promise<Array<{ repo?: string }> | undefined>;
	/** This computer's project folders (receiver): the folder of a repo is looked for among them. */
	folders?: () => string[];
	/** Puts a peer's report into the asking conversation like a local session's report (hub/lanewire.ts deliverToSession). */
	deliver?: (conv: string, text: string) => void;
	git?: Git;
	fetch?: Fetcher;
	token?: (peerUrl: string) => string | undefined;
	pair?: (peerUrl: string, force?: boolean) => Promise<PairResult>;
	/** The owner's switch (config fleet.auto_place); off by default. */
	autoOn?: () => boolean;
	secrets?: () => Array<string | undefined>;
	/** The secret check of dotz_peer (extension/peer-secrets.ts); loaded on first use. */
	secretIn?: (text: string, known: Array<string | undefined>) => string | undefined;
	dataDir?: () => string;
	log?: (message: string) => void;
	now?: () => number;
	newName?: () => string;
	timeoutMs?: number;
	launchTimeoutMs?: number;
};
export type FleetLaunch = {
	/** `computer` = a name chosen by the owner (manual), or "auto" for placement by this computer. */
	placeLaunch: (req: LaunchRequest, pick: { computer: string } | "auto") => Promise<Placed>;
	/** A launch that would wait here (`wait` = why): with the switch on, another computer with room may take it; undefined = it stays here. */
	placeAuto: (req: LaunchRequest, wait: string | undefined) => Promise<Placed | undefined>;
	isSelf: (computer: string) => boolean;
	/** The owner's pick from the web's computer chip: the listed computer's own name, or undefined for this computer, a name not in the list or a public-address row. */
	pickable: (computer: unknown) => Promise<string | undefined>;
	receive: (from: string, a: Record<string, any>, ask: Ask) => Promise<Response>;
	report: (lane: PeerLane, text: string) => void;
	receiveReport: (from: string, a: Record<string, any>) => Response | Promise<Response>;
	sent: () => SentRow[];
	idle: () => Promise<void>;   // resolves when no report is on its way (tests)
};

const GET_MS = 4000;
const LAUNCH_MS = 60_000;
const POST_MS = 15_000;
const SENT_MAX = 100;
const TEXT_MAX = 8000;
const TITLE_MAX = 80;
const CONV_MAX = 80;
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/;
const str = (x: unknown, max: number): string => (typeof x === "string" ? x.trim().slice(0, max) : "");
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

export function createFleetLaunch(deps: FleetLaunchDeps): FleetLaunch {
	const f: Fetcher = deps.fetch ?? ((u, init) => peerFetch(u, init));
	const now = deps.now ?? Date.now;
	const log = deps.log ?? hubLog;
	const git = deps.git ?? runGit;
	const token = deps.token ?? peerTokenFor;
	const computers = deps.computers ?? knownComputers;
	const pair = deps.pair ?? createPairer({ fetch: f, selfUrl: async () => (await computers()).find(c => c.self)?.url });
	const dataDir = deps.dataDir ?? (() => DATA_DIR);
	const secrets = deps.secrets ?? (() => ["hub-token", "peer-token"].map(n => { try { return readFileSync(join(dataDir(), "secrets", n), "utf8").trim(); } catch { return undefined; } }));
	const newName = deps.newName ?? (() => `fleet-${randomBytes(3).toString("hex")}`);
	const reports = new Set<Promise<void>>();
	const secretIn = deps.secretIn ?? (async (text: string, known: Array<string | undefined>) => (await import("../extension/peer-secrets.ts")).secretIn(text, known));

	// --- what this computer sent where (the sheet shows it; dropped when the session's final report arrives) ---
	const sentFile = () => join(dataDir(), "fleet-sent.json");
	function sent(): SentRow[] {
		try {
			const rows = JSON.parse(readFileSync(sentFile(), "utf8")) as unknown;
			return (Array.isArray(rows) ? rows : []).filter((r): r is SentRow => !!r && typeof r.lane === "string" && typeof r.computer === "string" && typeof r.conv === "string" && typeof r.title === "string" && typeof r.at === "number");
		} catch {
			return [];
		}
	}
	const saveSent = (rows: SentRow[]): void => writeAtomic(sentFile(), `${JSON.stringify(rows.slice(-SENT_MAX), null, 2)}\n`);

	// A request to a peer with its pair token; a 403 asks for a fresh token once. undefined = no token (not paired).
	async function post(url: string, path: string, body: string, ms: number): Promise<Response | undefined> {
		let h = peerHeaders(token(url));
		if (!h && (await pair(url)).ok) h = peerHeaders(token(url));
		if (!h) return undefined;
		const send = (hh: Record<string, string>) => f(`${url}${path}`, { method: "POST", headers: { ...hh, "content-type": "application/json" }, body, signal: AbortSignal.timeout(ms), redirect: "manual" });
		let r = await send(h);
		if (r.status === 403 && (await pair(url, true)).ok) r = await send(peerHeaders(token(url)) ?? h);
		return r;
	}
	async function readProjects(url: string): Promise<Array<{ repo?: string }> | undefined> {
		if (deps.projects) return deps.projects(url);
		try {
			let h = peerHeaders(token(url));
			if (!h && (await pair(url)).ok) h = peerHeaders(token(url));
			if (!h) return undefined;
			const get = (hh: Record<string, string>) => f(`${url}/api/peer/projects`, { headers: hh, signal: AbortSignal.timeout(GET_MS), redirect: "manual" });
			let r = await get(h);
			if (r.status === 403 && (await pair(url, true)).ok) r = await get(peerHeaders(token(url)) ?? h);
			const list = r.ok ? ((await r.json()) as { projects?: unknown }).projects : undefined;
			return Array.isArray(list) ? list.map(p => ({ ...(typeof p?.repo === "string" ? { repo: p.repo } : {}) })) : undefined;
		} catch {
			return undefined;
		}
	}

	// ---------------------------------------------------------------- sender
	type Candidate = { row: FleetRow };
	// Why a computer cannot take a launch at all (undefined = it can), in the owner's words.
	function refusal(row: FleetRow, manual: boolean): string | undefined {
		if (!row.online || row.state === "offline") return msg().fleetOffline(row.name);
		if (!row.load || row.load.v !== FLEET_V) return msg().fleetLegacy(row.name);
		if (!manual && !(row.load.lanes.active < row.load.lanes.cap && (row.state === "idle" || row.state === "busy"))) return msg().fleetNoRoom;
		return undefined;
	}

	async function forward(row: FleetRow, req: LaunchRequest, repo: string, branch: string | undefined): Promise<Placed> {
		const args = { v: FLEET_V, repo, ...(branch ? { branch } : {}), title: req.title, brief: req.brief, why: req.why, ...(req.hours !== undefined ? { hours: req.hours } : {}), ...(req.est !== undefined ? { est: req.est } : {}), ...(req.owner_asked_for_lane ? { owner_asked_for_lane: true } : {}), conv: req.conv };
		let r: Response | undefined;
		try {
			r = await post(row.url, "/api/peer/act", JSON.stringify({ action: "launch", args, from: deps.name() }), deps.launchTimeoutMs ?? LAUNCH_MS);
		} catch (e) {
			return { ok: false, error: msg().fleetUnreachable(row.name, e instanceof Error ? e.message : String(e)) };
		}
		if (!r) return { ok: false, error: msg().fleetNotPaired(row.name) };
		const body = (await r.json().catch(() => ({}))) as { lane?: unknown; error?: unknown };
		if (!r.ok || typeof body.lane !== "string") return { ok: false, error: msg().fleetUnreachable(row.name, typeof body.error === "string" ? body.error : `HTTP ${r.status}`) };
		saveSent([...sent().filter(x => !(x.lane === body.lane && x.computer === row.name)), { lane: body.lane, computer: row.name, conv: req.conv, title: req.title, at: now() }]);
		return { ok: true, computer: row.name, lane: body.lane };
	}

	async function decide(req: LaunchRequest, pick: { computer: string } | "auto"): Promise<Placed> {
		const fail = (error: string): Placed => ({ ok: false, error });
		const manual = pick !== "auto";
		const secret = await secretIn([req.title, req.brief, req.why].join("\n"), secrets());
		if (secret) return fail(msg().fleetSecret(secret));
		const others = (await deps.fleet()).filter(r => !r.self);
		let candidates: Candidate[];
		if (manual) {
			const want = pick.computer.trim().toLowerCase();
			const row = others.find(r => r.name === pick.computer.trim()) ?? others.find(r => r.name.toLowerCase() === want);
			if (!row) return fail(msg().fleetUnknown(pick.computer));
			const why = refusal(row, true);
			if (why) return fail(why);
			candidates = [{ row }];
		} else {
			// idle before busy, then the most free session slots
			const free = (r: FleetRow) => (r.load ? r.load.lanes.cap - r.load.lanes.active : 0);
			candidates = others.filter(r => !refusal(r, false)).sort((a, b) => (a.state === b.state ? 0 : a.state === "idle" ? -1 : 1) || free(b) - free(a)).map(row => ({ row }));
			if (!candidates.length) return fail(msg().fleetNoRoom);
		}
		const repo = await repoOf(req.cwd, git);
		if (!repo) return fail(msg().fleetNotGit);
		const remote = await git(req.cwd, ["branch", "-r", "--contains", "HEAD"]);
		if (remote.code !== 0 || !remote.out) return fail(msg().fleetPush);
		const head = (await git(req.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).out;
		const branch = BRANCH.test(head) && head !== "HEAD" ? head : undefined;
		let last: Placed = fail(msg().fleetNoRoom);
		for (const { row } of candidates) {
			const list = await readProjects(row.url);
			if (!list?.some(p => p.repo === repo)) {
				last = fail(list === undefined && !peerHeaders(token(row.url)) ? msg().fleetNotPaired(row.name) : msg().fleetNoProject(row.name));
				continue;
			}
			last = await forward(row, req, repo, branch);
			if (last.ok) return last;
		}
		return last;
	}

	// One hub.log line per decision, whichever way it went.
	async function placeLaunch(req: LaunchRequest, pick: { computer: string } | "auto"): Promise<Placed> {
		const r = await decide(req, pick);
		log(r.ok ? `fleet launch (${pick === "auto" ? "auto" : "picked"}): "${req.title}" placed on ${r.computer} as ${r.lane}` : `fleet launch (${pick === "auto" ? "auto" : `picked ${pick.computer}`}): "${req.title}" not placed: ${r.error}`);
		return r;
	}

	async function placeAuto(req: LaunchRequest, wait: string | undefined): Promise<Placed | undefined> {
		if (!wait || deps.autoOn?.() !== true) return undefined;
		const r = await placeLaunch(req, "auto");
		return r.ok ? r : undefined;
	}

	// ---------------------------------------------------------------- receiver
	async function receive(from: string, a: Record<string, any>, ask: Ask): Promise<Response> {
		const refuse = (error: string, status = 409) => json({ error }, status);
		if (a.v !== FLEET_V) return refuse(msg().fleetVersion);
		const repo = typeof a.repo === "string" && /^[a-z0-9][a-z0-9.-]*(\/[^\s/]+){2,}$/.test(a.repo) && !a.repo.split("/").some((x: string) => x === ".." || x === ".") ? a.repo : undefined;
		const title = str(a.title, 200), brief = str(a.brief, 12_000), why = str(a.why, 2000), conv = str(a.conv, CONV_MAX);
		if (!repo || !title || !brief || !why || !conv) return refuse(msg().fleetBadRequest, 400);
		let folder: string | undefined;
		for (const dir of deps.folders?.() ?? []) {
			if ((await repoOf(dir, git)) === repo) {
				folder = dir;
				break;
			}
		}
		if (!folder) return refuse(msg().fleetNoProject(deps.name()));
		const dirty = await git(folder, ["status", "--porcelain"]);
		if (dirty.code !== 0) return refuse(msg().fleetPull(dirty.err));
		if (dirty.out) return refuse(msg().fleetDirty);
		const branch = typeof a.branch === "string" && BRANCH.test(a.branch) ? a.branch : undefined;
		if (branch && (await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"])).out !== branch) return refuse(msg().fleetBranch(branch));
		for (const step of [["fetch"], ["pull", "--ff-only"]]) {
			const r = await git(folder, step);
			if (r.code !== 0) return refuse(msg().fleetPull(r.err || r.out));
		}
		// Only these fields reach this computer's own launch route: never a model, worker model, force or path of the sender.
		const hours = num(a.hours), est = num(a.est);
		return ask("POST", "/api/lanes", { name: newName(), cwd: folder, title, brief, why, ...(hours !== undefined ? { hours } : {}), ...(est !== undefined ? { est } : {}), ...(a.owner_asked_for_lane === true ? { owner_asked_for_lane: true } : {}), peer: { name: from, conv } });
	}

	// ---------------------------------------------------------------- reports
	// A session started for another computer reports: the report also goes to that computer. Never throws; a failure is noted in the log.
	function report(lane: PeerLane, text: string): void {
		const peer = lane.peer;
		if (!peer) return;
		const p: Promise<void> = (async () => {
			try {
				const target = (await computers()).find(c => !c.self && c.name === peer.name);
				if (!target) return log(`lane ${lane.name} report: ${peer.name} is not a known computer`);
				const withheld = await secretIn(text, secrets());
				const body = JSON.stringify({ action: "lane-report", args: { lane: lane.name, title: lane.title ?? lane.name, text: withheld ? msg().fleetReportWithheld : text.slice(0, TEXT_MAX) }, from: deps.name() });
				const r = await post(target.url, "/api/peer/act", body, POST_MS);
				if (!r) return log(`lane ${lane.name} report: no peer token for ${peer.name}`);
				if (!r.ok) log(`lane ${lane.name} report: ${peer.name} answered ${r.status}`);
			} catch (e) {
				log(`lane ${lane.name} report: ${e instanceof Error ? e.message : String(e)}`);
			}
		})().finally(() => reports.delete(p));
		reports.add(p);
	}

	// The asking gateway: a report of a session it started on `from` goes into the conversation that asked (found by its own record, never by what the peer says).
	function receiveReport(from: string, a: Record<string, any>): Response {
		const lane = str(a.lane, 60), text = str(a.text, TEXT_MAX);
		const rows = sent();
		const row = rows.find(r => r.lane === lane && r.computer === from);
		if (!row) return json({ error: "unknown session" }, 404);
		if (!text) return json({ error: "text required" }, 400);
		const title = str(a.title, TITLE_MAX) || row.title;
		const tone = parseTone(text).tone;
		const final = tone === "done" || tone === "fail";
		saveSent(final ? rows.filter(r => r !== row) : rows.map(r => (r === row ? { ...r, title, at: now() } : r)));
		// Routine progress ([run], [wait], no marker) only refreshes the row: waking the asking session for it costs a model turn and tells it nothing.
		if (!final && tone !== "ask") return json({ ok: true, delivered: false });
		deps.deliver?.(row.conv, `${msg().inboxLaneReport(`${from} · ${title}`)}\n${text}${final ? "" : `\n\n${msg().fleetReportReply(from, lane)}`}`);
		return json({ ok: true });
	}

	const isSelf = (computer: string): boolean => computer.trim().toLowerCase() === deps.name().toLowerCase();
	const idle = async (): Promise<void> => { while (reports.size) await Promise.all([...reports]); };
	const pickable = async (computer: unknown): Promise<string | undefined> => {
		const want = typeof computer === "string" ? computer.trim().toLowerCase() : "";
		if (!want || isSelf(want)) return undefined;
		return (await computers()).find(c => !c.self && !c.via && !c.public && c.name.toLowerCase() === want)?.name;
	};
	return { placeLaunch, placeAuto, isSelf, pickable, receive, report, receiveReport, sent, idle };
}

// The running gateway's launcher (set by routes.ts); the launch route and the lane report handler reach it here.
let active: FleetLaunch | undefined;
export const activateFleetLaunch = (m: FleetLaunch): void => { active = m; };
export const activeFleetLaunch = (): FleetLaunch | undefined => active;
