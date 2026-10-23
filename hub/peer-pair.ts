// Zero-config pairing of two gateways on one tailnet (docs/peer-monitoring.md). The trust rule: a gateway pairs with a request only when
// it came through `tailscale serve` (so it carries Tailscale-User-Login, which tailscaled sets from its own whois of the source node and
// which a tagged node never has) AND that login is the login this node runs as. Then it issues a token for that one peer; the peer keeps
// it and sends it as `x-dotz-peer`, exactly like the hand-copied shared token (hub/peer-auth.ts), which keeps working.
//   issued here  : <data dir>/secrets/peer-pairs/in/<hash of the asker's origin>   (tokens this gateway accepts)
//   received     : <data dir>/secrets/peer-pairs/out/<hash of the peer's origin>   (the token this gateway sends to that peer)
// Both files are 0600. A new pairing request from the same origin replaces its token, so a lost or stale token heals itself.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export const pairDir = (dataDir: string = DATA_DIR) => join(dataDir, "secrets", "peer-pairs");
export const PAIR_PATH = "/api/peer/pair";
const MAX_ISSUED = 32;
const MIN_TOKEN = 16;
const FAIL_COOLDOWN_MS = 60_000;
const FORCE_COOLDOWN_MS = 10_000;

export const REASON = {
	otherUser: "다른 사용자의 컴퓨터라 읽기만 돼요",
	notTailnet: "같은 Tailscale 계정의 컴퓨터가 아니라서 읽기만 돼요",
	unknownSelf: "상대 컴퓨터가 계정을 확인하지 못해서 읽기만 돼요",
	unsupported: "상대 컴퓨터가 자동 연결을 지원하지 않아서 읽기만 돼요",
};

const keyOf = (origin: string) => createHash("sha1").update(origin).digest("hex").slice(0, 20);
export const originOf = (u: string): string | undefined => {
	try {
		const p = new URL(u);
		return p.protocol === "https:" || p.protocol === "http:" ? p.origin : undefined;
	} catch {
		return undefined;
	}
};

function readToken(path: string): string | undefined {
	try {
		const t = readFileSync(path, "utf8").trim();
		return t.length >= MIN_TOKEN ? t : undefined;
	} catch {
		return undefined;
	}
}

function save(path: string, token: string): void {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, token, { mode: 0o600 });
	renameSync(tmp, path);
}

// Tokens this gateway issued to its paired peers.
export function acceptedTokens(dir: string = pairDir()): string[] {
	const d = join(dir, "in");
	try {
		return readdirSync(d).filter(n => !n.endsWith(".tmp")).map(n => readToken(join(d, n))).filter((t): t is string => !!t);
	} catch {
		return [];
	}
}

// The token this gateway received from the peer at `url`, if it is paired with it.
export function outToken(url: string, dir: string = pairDir()): string | undefined {
	const o = originOf(url);
	return o ? readToken(join(dir, "out", keyOf(o))) : undefined;
}

function issueToken(origin: string, dir: string): string {
	const d = join(dir, "in");
	const token = randomBytes(32).toString("hex");
	save(join(d, keyOf(origin)), token);
	const files = readdirSync(d).filter(n => !n.endsWith(".tmp")).map(n => ({ n, at: statSync(join(d, n)).mtimeMs })).sort((a, b) => b.at - a.at);
	for (const f of files.slice(MAX_ISSUED)) unlinkSync(join(d, f.n));
	return token;
}

const refuse = (reason: string, status = 403) => Response.json({ error: "pairing refused", reason }, { status });

// POST /api/peer/pair on the gateway that is asked. `ownLogin` is the tailscale login this node runs as (undefined for a tagged node).
export async function handlePair(req: Request, o: { ownLogin: () => Promise<string | undefined>; dir?: string }): Promise<Response> {
	const theirs = (req.headers.get("tailscale-user-login") ?? "").trim().toLowerCase();
	if (!theirs) return refuse(REASON.notTailnet);
	const mine = await o.ownLogin();
	if (!mine) return refuse(REASON.unknownSelf);
	if (theirs !== mine) return refuse(REASON.otherUser);
	const b = (await req.json().catch(() => ({}))) as { origin?: unknown };
	const origin = typeof b.origin === "string" ? originOf(b.origin) : undefined;
	if (!origin) return Response.json({ error: "origin required" }, { status: 400 });
	return Response.json({ token: issueToken(origin, o.dir ?? pairDir()) });
}

export type PairResult = { ok: true } | { ok: false; reason?: string };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

// The asking half: one pairing attempt per peer at a time, failures remembered for a minute (a forced retry, after a 403, waits only 10 s).
export function createPairer(o: { fetch: Fetcher; selfUrl: () => Promise<string | undefined>; dir?: string; now?: () => number; timeoutMs?: number }): (url: string, force?: boolean) => Promise<PairResult> {
	const now = o.now ?? Date.now;
	const last = new Map<string, { at: number; r: PairResult }>();
	const inflight = new Map<string, Promise<PairResult>>();
	async function attempt(origin: string): Promise<PairResult> {
		try {
			const self = await o.selfUrl();
			if (!self) return { ok: false };
			const res = await o.fetch(`${origin}${PAIR_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: self }), signal: AbortSignal.timeout(o.timeoutMs ?? 5000), redirect: "manual" });
			const body = (await res.json().catch(() => null)) as { token?: unknown; reason?: unknown } | null;
			if (res.ok && typeof body?.token === "string" && body.token.length >= MIN_TOKEN) {
				save(join(o.dir ?? pairDir(), "out", keyOf(origin)), body.token);
				return { ok: true };
			}
			return { ok: false, reason: typeof body?.reason === "string" ? body.reason : REASON.unsupported };
		} catch {
			return { ok: false }; // unreachable: no reason line, the peer simply shows as offline
		}
	}
	return (url, force = false) => {
		const origin = originOf(url);
		if (!origin) return Promise.resolve({ ok: false });
		const run = inflight.get(origin);
		if (run) return run;
		const prev = last.get(origin);
		if (prev && now() - prev.at < (force ? FORCE_COOLDOWN_MS : prev.r.ok ? FORCE_COOLDOWN_MS : FAIL_COOLDOWN_MS)) return Promise.resolve(prev.r);
		const p = attempt(origin).then(r => {
			last.set(origin, { at: now(), r });
			return r;
		}).finally(() => inflight.delete(origin));
		inflight.set(origin, p);
		return p;
	};
}
