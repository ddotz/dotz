// Test doubles shared by setup.test.ts and card.test.ts: a Ctx whose fetch answers the gateway, Google and Instagram at
// the URL level (the real libs run against it), records every call, and never touches the network or the clock.
import type { Ctx } from "../lib/config.ts";

export const YT_ID = "UCabcdefghij1234";
export const SECRETS = { refresh: "RT-secret", access: "AT-secret", clientSecret: "CS-secret", instagram: "IG-secret", hub: "hub-secret" };
export const GATEWAY = "http://127.0.0.1:47999";

export type Call = { method: string; url: string; body?: any; form?: Record<string, string>; hubToken?: string };

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export function fakeCtx(o: { now?: string; env?: Record<string, string | undefined> } = {}) {
	const calls: Call[] = [];
	const watches: any[] = [];
	const state = { offline: false, gatewayStatus: 200, gatewayDown: false, subscribers: "1234", followers: 56 };
	let nowMs = Date.parse(o.now ?? "2026-10-22T03:00:00Z");
	const isGateway = (url: string) => url.startsWith("http://127.0.0.1:") && !url.includes("oauth");

	const ctx: Ctx = {
		fetch: async (url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			const raw = init?.body === undefined ? undefined : String(init.body);
			const call: Call = { method: init?.method ?? "GET", url, hubToken: headers["x-dotz-token"] };
			if (raw !== undefined) {
				if (headers["content-type"] === "application/json") call.body = JSON.parse(raw);
				else call.form = Object.fromEntries(new URLSearchParams(raw));
			}
			calls.push(call);

			if (isGateway(url)) {
				if (state.gatewayDown) throw new TypeError("connect ECONNREFUSED");
				if (call.method === "GET") return json(watches);
				if (state.gatewayStatus !== 200) return json({ error: "boom" }, state.gatewayStatus);
				if (call.method === "POST") watches.push(call.body);
				if (call.method === "POST" && url.endsWith("/api/watches")) watches.splice(0, watches.length, ...watches.filter((w, i) => w.name !== call.body.name || i === watches.length - 1));
				if (call.method === "PATCH") for (const w of watches) if (w.name === decodeURIComponent(url.split("/").pop()!)) Object.assign(w, call.body);
				return json({ ok: true });
			}
			if (state.offline) throw new TypeError("network down");
			if (url.startsWith("https://oauth2.googleapis.com/token")) {
				return call.form?.grant_type === "authorization_code" ? json({ refresh_token: SECRETS.refresh, access_token: SECRETS.access, expires_in: 3600 }) : json({ access_token: SECRETS.access, expires_in: 3600 });
			}
			if (url.includes("googleapis.com/youtube/v3/channels")) {
				if (url.includes("mine=true")) return json({ items: [{ id: YT_ID, snippet: { title: "My Channel" } }] });
				return json({ items: [{ id: YT_ID, snippet: { title: "My Channel" }, statistics: { subscriberCount: state.subscribers, viewCount: "99000", videoCount: "42" } }] });
			}
			if (url.startsWith("https://graph.instagram.com/")) return json({ id: "1784", user_id: "1784", username: "owner", followers_count: state.followers, media_count: 7 });
			return json({ error: `unexpected ${url}` }, 404);
		},
		now: () => new Date(nowMs),
		sleep: () => new Promise<void>(() => {}),
		exec: async () => ({ code: 1, stdout: "", stderr: "no exec in tests" }),
		env: o.env ?? {},
	};
	return {
		ctx,
		calls,
		watches,
		state,
		advance: (ms: number) => void (nowMs += ms),
		gateway: () => calls.filter(c => isGateway(c.url)),
		api: () => calls.filter(c => !isGateway(c.url)),
	};
}
