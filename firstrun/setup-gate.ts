import { homedir } from "node:os";
import { join } from "node:path";
import { cookieValid, markDone, readFirstRun, redeemToken, saveDraft, SETUP_COOKIE } from "./first-run.ts";
import { runApply } from "./setup-apply.ts";
import { type JobFn, type JobId, createJobs, fill, isJobId } from "./setup-jobs.ts";
import { draftLang, parseDraft, saveSecret, savedSecrets, setupText } from "./setup-state.ts";
import { createTerms, type TermId } from "./setup-term.ts";
import { scanMachine } from "./scan.ts";
import { tokenFile, peerTokenFile } from "./apply.ts";
import { readFileSync } from "node:fs";
import { bundle } from "../hub/webapp.ts";
import { localBrowser } from "../hub/web-access.ts";

// The first-run gate (docs/web-onboarding.md, "보안" and "API 계약"): /setup, /setup.js, /setup.css and /api/setup/* answer only while first-run.json is
// pending, the request is a browser on this computer (localBrowser) and it holds the dotz_setup cookie. Anything else is a plain 404, so a request
// through tailscale serve or cloudflared, or after the onboarding, learns nothing. routes.ts asks this gate before the owner check; it changes no
// other gate, cookie or header.

export type SetupDeps = {
	dir: string;
	home?: string;
	pkg?: string;
	localHeaders: () => Record<string, string>;
	restart: () => void;
	providers: (req: Request, url: URL, parts: string[]) => Promise<Response | undefined>;
	log: (line: string) => void;
	scan?: () => Promise<unknown>;
	jobs?: Partial<Record<JobId, JobFn>>;
	terms?: (id: TermId) => string[] | undefined;
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const SECURE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const SSE = { ...SECURE, "Content-Type": "text/event-stream", Connection: "keep-alive" };
const PKG = join(import.meta.dir, "..");
const WEB_SETUP = join(PKG, "web", "setup");
const PING_MS = 15_000;

const reply = (body: unknown, status = 200): Response => Response.json(body, { status, headers: SECURE });
const notFound = (): Response => new Response("not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURE } });
const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const cookieOf = (req: Request): string | undefined => (req.headers.get("cookie") ?? "").split(";").map(c => c.trim()).find(c => c.startsWith(`${SETUP_COOKIE}=`))?.slice(SETUP_COOKIE.length + 1);
const shell = (lang: string, wait: string): string => `<!doctype html>\n<html lang="${lang.replace(/[^A-Za-z-]/g, "")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dotz</title><link rel="stylesheet" href="/setup.css"></head><body><div id="setup"><p class="ob-wait">${wait}</p></div><script src="/setup.js"></script></body></html>\n`;
const read = (path: string): string => {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return "";
	}
};
const file = (name: string): string => read(join(WEB_SETUP, name));

export function createSetupGate(deps: SetupDeps) {
	const { dir } = deps;
	const draft = (): Record<string, unknown> => readFirstRun(dir)?.draft ?? {};
	const text = () => setupText(draftLang(draft()));
	// A scan takes seconds (it asks every CLI), so the state answers from the last one; ?fresh=1 looks again and joins a scan already running.
	let scanned: Promise<unknown> | undefined;
	let scanning = false;
	const scanNow = (): Promise<unknown> => {
		if (scanning) return scanned!;
		scanning = true;
		const run = (deps.scan ?? scanMachine)().finally(() => { scanning = false; });
		scanned = run;
		run.catch(() => { if (scanned === run) scanned = undefined; });
		return run;
	};
	if (readFirstRun(dir)?.status === "pending") void scanNow();
	const secretValues = (): string[] => [tokenFile(dir), peerTokenFile(dir)].map(read);
	const jobs = createJobs({ text, secrets: secretValues, log: deps.log, ...(deps.jobs ? { jobs: deps.jobs } : {}) });
	const terms = createTerms(deps.terms);
	let applying: ReturnType<typeof runApply> | undefined;
	let finished = false;

	async function apply(): Promise<Response> {
		if (!applying) {
			saveDraft(dir, "apply", {});
			let outcome: Awaited<ReturnType<typeof runApply>> | undefined;
			const row = jobs.start("apply", async io => {
				outcome = await runApply({ dir, home: deps.home ?? homedir(), pkg: deps.pkg ?? PKG, permissionsDone: () => jobs.snapshot().find(r => r.id === "permissions")?.state === "done" }, io);
				return outcome.ok ? { ok: true, owner: outcome.owner, detail: outcome.why } : { ok: false, detail: outcome.error };
			});
			applying = row.then(() => outcome!);
		}
		const o = await applying;
		if (!o.ok) {
			applying = undefined;
			return reply({ ok: false, error: fill(text().errors.applyFailed, o.error) }, 400);
		}
		const headers = new Headers(SECURE);
		headers.set("Content-Type", "application/json; charset=utf-8");
		headers.append("Set-Cookie", `${SETUP_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`);
		// A browser that stays on this computer gets its dotz_local session from the same code the one-time login link uses, so it lands in the app with no confirmation.
		if (o.access === "local") for (const [k, v] of Object.entries(deps.localHeaders())) k.toLowerCase() === "set-cookie" ? headers.append(k, v) : headers.set(k, v);
		if (!finished) {
			finished = true;
			markDone(dir);
			deps.log("setup: onboarding done, restarting once");
			setTimeout(deps.restart, 500);
		}
		return new Response(JSON.stringify({ ok: true, access: o.access, url: o.url, why: o.why, owner: o.owner }), { headers });
	}

	function stream(): Response {
		let off = () => {};
		let ping: ReturnType<typeof setInterval> | undefined;
		const body = new ReadableStream<string>({
			start(c) {
				const send = (event: string, data: unknown): void => {
					try {
						c.enqueue(frame(event, data));
					} catch {
						// The browser closed the stream; there is nobody left to tell.
					}
				};
				send("snapshot", { jobs: jobs.snapshot() });
				off = jobs.subscribe(e => (e.type === "line" ? send("line", { job: e.job, text: e.text }) : send("state", e.row)));
				ping = setInterval(() => { try { c.enqueue(": ping\n\n"); } catch { /* the stream is closed; cancel() stops this timer */ } }, PING_MS);
			},
			cancel() {
				off();
				clearInterval(ping);
			},
		});
		return new Response(body, { headers: SSE });
	}

	async function api(req: Request, url: URL): Promise<Response> {
		const parts = url.pathname.split("/").filter(Boolean);
		const [, , name = "", ...rest] = parts;
		const get = req.method === "GET";
		const post = req.method === "POST";
		const body = async (): Promise<Record<string, unknown>> => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
		if (name === "state" && get) {
			const f = readFirstRun(dir)!;
			return reply({ step: f.step, draft: f.draft, saved: savedSecrets(dir), scan: await (url.searchParams.has("fresh") ? scanNow() : (scanned ?? scanNow())), lang: draftLang(f.draft), text: text(), jobs: jobs.snapshot() });
		}
		if (name === "draft" && req.method === "PUT") {
			const b = await body();
			const values = parseDraft(b.values);
			if (!values || typeof b.step !== "string" || !/^[a-z0-9-]{1,40}$/.test(b.step) || jobs.busy()) return reply({ error: text().errors.badDraft }, 400);
			saveDraft(dir, b.step, values);
			return reply({ ok: true });
		}
		if (name === "secret" && post) {
			const b = await body();
			const saved = saveSecret(dir, b.name, b.value);
			return saved ? reply({ ok: true, name: saved }) : reply({ error: text().errors.badSecret }, 400);
		}
		if (name === "run" && post && rest.length === 1) {
			const id = rest[0]!;
			if (!isJobId(id)) return reply({ error: text().errors.unknownJob }, 404);
			if (id === "apply") return apply();
			void jobs.start(id);
			return reply({ ok: true, jobs: jobs.snapshot() }, 202);
		}
		if (name === "stream" && get) return stream();
		if (name === "apply" && post) return apply();
		if (name === "term") return terms(req, url, rest, text());
		if (name === "providers") {
			const [id, login, step] = rest;
			const shape = rest.length === 0 ? get : login === "login" && rest.length === 2 ? get || post || req.method === "DELETE" : login === "login" && step === "complete" && rest.length === 3 && post;
			if (!shape || id === "") return notFound();
			const target = new URL(`/api/providers${rest.length ? `/${rest.join("/")}` : ""}${url.search}`, url);
			const r = await deps.providers(new Request(target, req), target, ["api", "providers", ...rest]);
			if (!r) return notFound();
			const headers = new Headers(r.headers);
			for (const [k, v] of Object.entries(SECURE)) headers.set(k, v);
			return new Response(r.body, { status: r.status, headers });
		}
		return notFound();
	}

	return {
		/** undefined = not a first-run request (the normal routes go on); otherwise the answer. */
		async route(req: Request, url: URL, peerIp: string | undefined): Promise<Response | undefined> {
			const p = url.pathname;
			const mine = p === "/setup" || p === "/setup.js" || p === "/setup.css" || p.startsWith("/api/setup/");
			const root = p === "/" && req.method === "GET";
			if (!mine && !root) return undefined;
			const open = readFirstRun(dir)?.status === "pending" && localBrowser(req, peerIp);
			if (root) return open && cookieValid(dir, cookieOf(req)) ? new Response(null, { status: 303, headers: { Location: "/setup", ...SECURE } }) : undefined;
			if (!open) return notFound();
			if (p === "/setup" && req.method === "GET" && url.searchParams.has("token")) {
				const prefetch = (req.headers.get("sec-purpose") ?? "").toLowerCase().includes("prefetch");
				const cookie = prefetch ? undefined : redeemToken(dir, url.searchParams.get("token") ?? "");
				if (!cookie) return notFound();
				return new Response(null, { status: 303, headers: { Location: "/setup", "Set-Cookie": `${SETUP_COOKIE}=${cookie}; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict`, ...SECURE } });
			}
			if (!cookieValid(dir, cookieOf(req))) return notFound();
			if (req.method === "GET" && p === "/setup") return new Response(shell(draftLang(draft()), text().ui.wait), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP, ...SECURE } });
			if (req.method === "GET" && p === "/setup.js") return new Response(file("setup.js"), { headers: { "Content-Type": "text/javascript; charset=utf-8", ...SECURE } });
			if (req.method === "GET" && p === "/setup.css") return new Response(`${bundle("css").text}\n${file("setup.css")}`, { headers: { "Content-Type": "text/css; charset=utf-8", ...SECURE } });
			return p.startsWith("/api/setup/") ? api(req, url) : notFound();
		},
	};
}
