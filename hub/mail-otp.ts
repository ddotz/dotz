import { createHash } from "node:crypto";
import { log } from "./config.ts";
import { SITE_RE, storeMailCode } from "./auth.ts";
import { type PeerCheck, peerHeaders, peerTokenFor } from "./peer-auth.ts";
import { knownComputers } from "./peers.ts";
import { json } from "./routes-util.ts";
import { peerFetch } from "./tailnet-fetch.ts";
import { newText, parseThread, watchFlags, zele, zeleRead, zeleState } from "./zele.ts";

export const PEER_MAIL_PATH = "/api/peer/mail-code";
export type MailReason = "no-mail" | "not-found" | "ambiguous" | "already-given" | "error";
export type MailAnswer = { ok: true; code: string } | { ok: false; reason: MailReason; detail?: string };
type Query = { from: string; account?: string; minutes: number };
type Candidate = { value: string; start: number; end: number; year: boolean };
type Flow = { over: boolean };

const DEFAULT_MINUTES = 10;
const MAX_MINUTES = 60;
const GIVEN_MEMORY_MS = 60 * 60_000;
const RETRY_MS = 15_000;
const ATTEMPTS = 3;
const TOTAL_MS = 45_000;
const PEER_MS = 60_000;
const THREADS_LOOKED_AT = "5";
const MORE_TELLING_FIRST: MailReason[] = ["not-found", "ambiguous", "already-given", "error", "no-mail"];

export const mailEnv = {
	on: (): boolean => zeleState() === "on",
	list: (args: string[]): Promise<Array<Record<string, unknown>>> => zele(args),
	read: (id: string, account: string): Promise<string> => zeleRead(id, account),
	flags: (): string[] => watchFlags(),
	now: (): number => Date.now(),
	sleep: (ms: number): Promise<void> => Bun.sleep(ms),
	peers: async (): Promise<Array<{ url: string }>> => (await knownComputers()).filter(f => !f.self),
	headers: (url: string): Record<string, string> | undefined => peerHeaders(peerTokenFor(url)),
	post: (url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<Response> =>
		peerFetch(`${url}${PEER_MAIL_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal, redirect: "manual" }),
};
export type MailEnv = typeof mailEnv;

const DETAIL: Record<MailReason, string> = {
	"no-mail": "메일이 연결된 기기를 찾지 못했어요",
	"not-found": "최근 메일에서 인증 코드를 찾지 못했어요",
	ambiguous: "인증 코드로 보이는 숫자가 여럿이라 고를 수 없어요",
	"already-given": "그 메일의 코드는 이미 한 번 건넸어요",
	error: "메일을 읽지 못했어요",
};
const fail = (reason: MailReason, detail: string = DETAIL[reason]): MailAnswer => ({ ok: false, reason, detail });

const KEYWORD = /(?:인증|확인|보안)\s*(?:코드|번호)|코드|verification|security\s+code|one[-\s]?time|pass\s?code|\botp\b|\bcode\b/gi;
const ABOUT_OTHER_NUMBERS = /전화번호|연락처|고객센터|문의|\btel\b|phone\s+number|\bfax\b|팩스|주문|\border\b|invoice|사업자|등록번호|계좌|금액|결제|\bprice\b|\bamount\b|\btotal\b|승인|거래/i;
const LINK_ADDRESS_OR_PHONE = new RegExp(
	[/https?:\/\/\S+/, /www\.\S+/, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, /(?:\+\d{1,3}[ -]?)?\(?\d{2,4}\)?[ -]\d{3,4}[ -]\d{4}/].map(r => r.source).join("|"),
	"g",
);
const QUANTITY_UNIT = /^(?:[원년월일시분초개건명회%]|\s*(?:원|%|won\b|krw\b|usd\b|달러|dollars?\b|minutes?\b|mins?\b|hours?\b|seconds?\b|days?\b))/i;
const BETWEEN_KEYWORD_AND_CODE = /^(?:[\s:：=*"'“”‘’()[\]<>\-–—.,]|은|는|이|가|입니다|is|are)*$/i;
const ONLY_MARKS = /^[\s*"'“”‘’()[\]<>`:：\-–—_]*$/;
const RANK = { none: 0, alone: 1, nearKeyword: 2, afterKeyword: 3 } as const;
const isOneOf = (char: string, set: string): boolean => char !== "" && set.includes(char);

function candidatesOf(line: string): Candidate[] {
	const found: Candidate[] = [];
	for (const m of line.matchAll(/[A-Za-z0-9]+/g)) {
		const value = m[0], start = m.index!, end = start + value.length;
		if (value.length < 4 || value.length > 8) continue;
		const digits = /^\d+$/.test(value);
		if (!digits && !(/^[A-Z0-9]+$/.test(value) && /\d/.test(value))) continue;
		const prev = line[start - 1] ?? "", prev2 = line[start - 2] ?? "", next = line[end] ?? "", next2 = line[end + 1] ?? "";
		if (isOneOf(prev, "_@/#")) continue;
		if (isOneOf(prev, ".,:-–") && /\d/.test(prev2)) continue;
		if (isOneOf(next, ".,:-–/") && /\d/.test(next2)) continue;
		if (next === "_" || /[$₩￦€¥£]\s*$/.test(line.slice(0, start)) || QUANTITY_UNIT.test(line.slice(end))) continue;
		found.push({ value, start, end, year: digits && /^(?:19|20)\d\d$/.test(value) });
	}
	return found;
}

export function codeIn(text: string): { code: string } | { reason: "not-found" | "ambiguous" } {
	const lines = newText(text).split("\n").map(l => l.replace(LINK_ADDRESS_OR_PHONE, m => " ".repeat(m.length))).filter(l => l.trim());
	const keywords = lines.map(l => [...l.matchAll(KEYWORD)].map(k => ({ start: k.index!, end: k.index! + k[0].length })));
	const best = { rank: 0 as number, values: new Set<string>() };
	lines.forEach((line, i) => {
		const nearKeyword = [0, 1, 2].some(back => keywords[i - back]?.length);
		for (const c of candidatesOf(line)) {
			const keyword = keywords[i].filter(k => k.end <= c.start).at(-1);
			const afterKeyword = !!keyword && c.start - keyword.end <= 24 && BETWEEN_KEYWORD_AND_CODE.test(line.slice(keyword.end, c.start));
			let rank: number = RANK.none;
			if (afterKeyword) rank = RANK.afterKeyword;
			else if (c.year || ABOUT_OTHER_NUMBERS.test(line)) rank = RANK.none;
			else if (nearKeyword) rank = RANK.nearKeyword;
			else if (ONLY_MARKS.test(line.slice(0, c.start) + line.slice(c.end))) rank = RANK.alone;
			if (rank === RANK.none || rank < best.rank) continue;
			if (rank > best.rank) {
				best.rank = rank;
				best.values.clear();
			}
			best.values.add(c.value);
		}
	});
	if (!best.values.size) return { reason: "not-found" };
	return best.values.size === 1 ? { code: [...best.values][0] } : { reason: "ambiguous" };
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const ADDRESS = new RegExp(`^[a-z0-9][a-z0-9._%+-]{0,63}@${LABEL}(?:\\.${LABEL})+$`, "i");

export function cleanQuery(b: unknown): { ok: true; q: Query } | { ok: false; detail: string } {
	const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
	const from = typeof o.from === "string" ? o.from.trim().toLowerCase().replace(/^@/, "") : "";
	if (from.length > 254 || !(DOMAIN.test(from) || ADDRESS.test(from))) return { ok: false, detail: "보낸이는 도메인이나 메일 주소여야 해요" };
	const account = o.account === undefined || o.account === "" ? undefined : o.account;
	if (account !== undefined && (typeof account !== "string" || account.length > 254 || !ADDRESS.test(account.trim()))) return { ok: false, detail: "메일 계정은 주소여야 해요" };
	if (o.minutes !== undefined && (typeof o.minutes !== "number" || !Number.isFinite(o.minutes))) return { ok: false, detail: "minutes는 숫자여야 해요" };
	const minutes = Math.min(Math.max(Math.round((o.minutes as number | undefined) ?? DEFAULT_MINUTES), 1), MAX_MINUTES);
	return { ok: true, q: { from, ...(account === undefined ? {} : { account: (account as string).trim() }), minutes } };
}

const domainOf = (from: string): string => from.slice(from.indexOf("@") + 1);

function sender(header: string, from: string): boolean {
	const address = (/<([^<>]+)>/.exec(header)?.[1] ?? header).trim().toLowerCase();
	if (from.includes("@")) return address === from;
	const host = domainOf(address);
	return address.includes("@") && (host === from || host.endsWith(`.${from}`));
}

const given = new Map<string, number>();
export const resetMailCodes = (): void => given.clear();

function giveOnce(from: string, code: string, now: number): boolean {
	for (const [key, until] of given) if (until <= now) given.delete(key);
	const key = createHash("sha256").update(`${from}|${code}`).digest("hex");
	if (given.has(key)) return false;
	given.set(key, now + GIVEN_MEMORY_MS);
	return true;
}

const AGO_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const AGO = /^(?:(just now)|(\d{1,3})([mhd]) ago)$/i;

function sentAt(date: string, now: number): number {
	const t = date.trim();
	const ago = AGO.exec(t);
	if (ago) return ago[1] ? now - 60_000 : now - (Number(ago[2]) + 1) * AGO_MS[ago[3].toLowerCase() as keyof typeof AGO_MS];
	return /(?<!\d)(?:19|20)\d\d(?!\d)/.test(t) ? Date.parse(t) : Number.NaN;
}

async function scan(q: Query, env: MailEnv, flow: Flow): Promise<MailAnswer> {
	try {
		const rows = await env.list(["mail", "list", "--filter", `from:${q.from} newer_than:1d`, "--limit", THREADS_LOOKED_AT, ...(q.account ? ["--account", q.account] : env.flags())]);
		const threads = rows.filter(r => r.id !== undefined && sender(String(r.from ?? ""), q.from));
		if (!threads.length) return fail("not-found");
		const now = env.now(), since = now - q.minutes * 60_000;
		let ambiguous = false, repeated = false;
		for (const row of threads) {
			const thread = parseThread(await env.read(String(row.id), q.account ?? String(row.account ?? "")));
			for (const message of thread.filter(m => sender(m.from, q.from) && sentAt(m.date, now) >= since).reverse()) {
				const found = codeIn(message.body);
				if ("reason" in found) {
					ambiguous ||= found.reason === "ambiguous";
				} else if (flow.over) {
					return fail("error");
				} else if (giveOnce(q.from, found.code, now)) {
					return { ok: true, code: found.code };
				} else {
					repeated = true;
				}
			}
		}
		return fail(ambiguous ? "ambiguous" : repeated ? "already-given" : "not-found");
	} catch {
		return fail("error");
	}
}

async function poll(q: Query, env: MailEnv, flow: Flow): Promise<MailAnswer> {
	let best = fail("not-found");
	for (let attempt = 0; attempt < ATTEMPTS && !flow.over; attempt++) {
		if (attempt) await env.sleep(RETRY_MS);
		const got = await scan(q, env, flow);
		if (got.ok || (got.reason !== "not-found" && got.reason !== "already-given")) return got;
		if (got.reason === "already-given") best = got;
	}
	return best;
}

const inflight = new Map<string, Promise<MailAnswer>>();

export function findMailCode(raw: unknown, env: MailEnv = mailEnv): Promise<MailAnswer> {
	const cleaned = cleanQuery(raw);
	if (!cleaned.ok) return Promise.resolve(fail("error", cleaned.detail));
	const q = cleaned.q;
	if (!env.on()) {
		log(`mail code: ${domainOf(q.from)} no-mail`);
		return Promise.resolve(fail("no-mail"));
	}
	const key = `${q.from}|${q.account ?? ""}|${q.minutes}`;
	const running = inflight.get(key);
	if (running) return running;
	const flow: Flow = { over: false };
	const { promise: tooLong, resolve } = Promise.withResolvers<MailAnswer>();
	const timer = setTimeout(() => {
		flow.over = true;
		resolve(fail("error", "메일을 찾는 데 너무 오래 걸렸어요"));
	}, TOTAL_MS);
	const run = Promise.race([poll(q, env, flow), tooLong]).finally(() => {
		flow.over = true;
		clearTimeout(timer);
		inflight.delete(key);
	});
	inflight.set(key, run);
	void run.then(a => log(`mail code: ${domainOf(q.from)} ${a.ok ? "found" : a.reason}`));
	return run;
}

function answerOf(v: unknown): MailAnswer | undefined {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	if (o.ok === true) return typeof o.code === "string" && /^[A-Za-z0-9]{4,8}$/.test(o.code) ? { ok: true, code: o.code } : undefined;
	if (o.ok === false && typeof o.reason === "string" && (MORE_TELLING_FIRST as string[]).includes(o.reason)) return fail(o.reason as MailReason, typeof o.detail === "string" ? o.detail.slice(0, 200) : undefined);
	return undefined;
}

async function askPeer(url: string, headers: Record<string, string>, body: string, env: MailEnv): Promise<MailAnswer> {
	try {
		const r = await env.post(url, headers, body, AbortSignal.timeout(PEER_MS));
		if (r.status === 404 || r.status === 403) return fail("no-mail");
		return (r.ok ? answerOf(await r.json()) : undefined) ?? fail("error", "다른 기기에서 답을 받지 못했어요");
	} catch {
		return fail("error", "다른 기기에서 답을 받지 못했어요");
	}
}

export async function askMailCode(raw: unknown, env: MailEnv = mailEnv): Promise<MailAnswer> {
	const cleaned = cleanQuery(raw);
	if (!cleaned.ok) return fail("error", cleaned.detail);
	const q = cleaned.q;
	if (env.on()) return findMailCode(q, env);
	const body = JSON.stringify({ from: q.from, ...(q.account ? { account: q.account } : {}), minutes: q.minutes });
	const failures: MailAnswer[] = [];
	let urls: string[] = [];
	try {
		urls = [...new Set((await env.peers()).map(p => p.url))];
	} catch {
		failures.push(fail("error"));
	}
	for (const url of urls) {
		const headers = env.headers(url);
		if (!headers) continue;
		const got = await askPeer(url, headers, body, env);
		log(`mail code: ${domainOf(q.from)} via ${new URL(url).host} ${got.ok ? "found" : got.reason}`);
		if (got.ok) return got;
		failures.push(got);
	}
	const tellingness = (a: MailAnswer) => MORE_TELLING_FIRST.indexOf(a.ok ? "no-mail" : a.reason);
	return failures.sort((a, b) => tellingness(a) - tellingness(b))[0] ?? fail("no-mail");
}

async function readBody(req: Request): Promise<Record<string, unknown> | undefined> {
	let parsed: unknown;
	try {
		parsed = await req.json();
	} catch (e) {
		if (e instanceof SyntaxError) return undefined;
		throw e;
	}
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

export async function peerMailCode(req: Request, peer: boolean, env: MailEnv = mailEnv): Promise<Response> {
	if (!peer) return new Response("forbidden", { status: 403 });
	return json(await findMailCode(await readBody(req), env));
}

export async function authMailCode(req: Request, allowed: boolean, env: MailEnv = mailEnv): Promise<Response> {
	if (!allowed) return new Response("forbidden", { status: 403 });
	const b = await readBody(req);
	if (!b) return json({ error: "body must be a JSON object" }, 400);
	if (typeof b.site !== "string" || !SITE_RE.test(b.site)) return json({ error: "site must match /^[a-z0-9][a-z0-9._-]{0,63}$/" }, 400);
	const a = await askMailCode(b, env);
	if (!a.ok) return json(a);
	try {
		return json({ ok: true, ...storeMailCode(b.site, a.code) });
	} catch {
		log(`mail code: ${b.site} not stored`);
		return json(fail("error", "받은 코드를 안전하게 두지 못했어요"));
	}
}

export function mailCodeRoute(req: Request, path: string, caller: { peer: PeerCheck; hubToken: boolean }, env: MailEnv = mailEnv): Promise<Response> | undefined {
	if (req.method !== "POST") return undefined;
	if (path === "/api/auth/mail-code") return authMailCode(req, caller.peer === "none" && caller.hubToken, env);
	if (path === PEER_MAIL_PATH) return peerMailCode(req, caller.peer === "ok", env);
	return undefined;
}
