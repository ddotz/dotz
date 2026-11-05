// Preload of the sandboxed load-qa gateway (`bun --preload`): replaces globalThis.fetch for the YouTube / Instagram API hosts only.
// Every call is recorded in $LOAD_QA_RUN/net-calls.jsonl {ts, method, url, body}; secrets (tokens, Authorization) are never written.
// Posting a reply (YouTube comments.insert, Instagram /<id>/replies) and the token grant answer success, or a definite failure while
// the file $LOAD_QA_RUN/fail-comment exists; while $LOAD_QA_RUN/hang-comment exists the answer waits (bounded) for the file to go.
// Reads (comment lists, media, channel) fail like the blocked sandbox network did, so seeded comments are not touched by an empty list.
// Every other host keeps the real fetch.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const RUN = process.env.LOAD_QA_RUN;
const HOSTS = new Set(["www.googleapis.com", "oauth2.googleapis.com", "graph.instagram.com"]);
const HANG_MAX_MS = 120_000;
const real = globalThis.fetch.bind(globalThis);
let seq = 0;

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const flag = (name: string): boolean => Boolean(RUN) && existsSync(join(RUN!, name));

function bodyText(init?: RequestInit): string {
	const b = init?.body;
	if (b === undefined || b === null) return "";
	return typeof b === "string" ? b : b instanceof URLSearchParams ? b.toString() : "[binary]";
}

// The body of a call without the credentials of the token grant.
function safeBody(host: string, body: string): string {
	if (host === "oauth2.googleapis.com") return "[token grant]";
	return body;
}

async function fake(host: string, url: URL, init?: RequestInit): Promise<Response> {
	const method = (init?.method ?? "GET").toUpperCase();
	const clean = `${url.origin}${url.pathname}${[...url.searchParams.keys()].filter(k => k !== "access_token").map((k, i) => `${i ? "&" : "?"}${k}=${url.searchParams.get(k)}`).join("")}`;
	if (RUN) appendFileSync(join(RUN, "net-calls.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), method, url: clean, body: safeBody(host, bodyText(init)) })}\n`);
	const id = ++seq;
	if (host === "oauth2.googleapis.com") return json(200, { access_token: `fake-access-${id}`, expires_in: 3600 });
	const youtubeReply = host === "www.googleapis.com" && method === "POST" && url.pathname === "/youtube/v3/comments";
	const instagramReply = host === "graph.instagram.com" && method === "POST" && /\/replies$/.test(url.pathname);
	if (!youtubeReply && !instagramReply) throw new TypeError("fetch failed (load-qa: no network)");
	for (let waited = 0; flag("hang-comment") && waited < HANG_MAX_MS; waited += 100) await new Promise(r => setTimeout(r, 100));
	if (flag("fail-comment")) return youtubeReply ? json(403, { error: { errors: [{ reason: "forbidden" }], status: "PERMISSION_DENIED" } }) : json(400, { error: { type: "OAuthException", code: 100, message: "fake failure" } });
	return json(200, { id: `${youtubeReply ? "fakeytc" : "fakeigc"}${id}` });
}

globalThis.fetch = Object.assign(
	(input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const host = url.hostname;
		return HOSTS.has(host) ? fake(host, url, init) : real(input as string, init);
	},
	{ preconnect: real.preconnect },
) as typeof fetch;
