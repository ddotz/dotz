// One-shot localhost receiver (DESIGN R4): a secret read out of a web page by `aside repl` is POSTed here and written to a
// 0600 file, so it never passes through a model, argv or a log. 127.0.0.1 only, random port, random path token, accepts
// ONE valid POST, then closes. The body is never logged or echoed. `serveOnce` is the opposite direction (a value handed
// INTO `aside repl` as `const secret`, same pattern as hub/aside.ts; not imported because that module loads the gateway
// config at import time).
import { randomUUID } from "node:crypto";
import { writeJson } from "./config.ts";

export class ReceiverError extends Error {}

export type Receiver = {
	url: string;
	// Resolves once a valid body was written; rejects with ReceiverError after waitMs.
	done: Promise<void>;
	stop: () => void;
};
export type ReceiverOpts = {
	file: string;
	// Keys the body must carry as non-empty strings; only these are written.
	fields: string[];
	waitMs?: number;
	sleep?: (ms: number) => Promise<void>;
};

const MAX_BODY = 16 * 1024;
const DEFAULT_WAIT_MS = 5 * 60_000;
const CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "POST, OPTIONS",
	"access-control-allow-headers": "content-type",
	"access-control-allow-private-network": "true",
	"access-control-max-age": "600",
};

export function startReceiver(o: ReceiverOpts): Receiver {
	const token = randomUUID();
	let resolve!: () => void;
	let reject!: (e: Error) => void;
	const stored = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	let taken = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			if (new URL(req.url).pathname !== `/${token}`) return new Response("", { status: 404 });
			if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
			if (req.method !== "POST" || taken) return new Response("", { status: 405, headers: CORS });
			const text = await req.text();
			if (text.length > MAX_BODY) return new Response("", { status: 413, headers: CORS });
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(text);
			} catch {
				return new Response("", { status: 400, headers: CORS });
			}
			const picked: Record<string, string> = {};
			for (const k of o.fields) {
				const v = body?.[k];
				if (typeof v !== "string" || !v.trim()) return new Response("", { status: 400, headers: CORS });
				picked[k] = v.trim();
			}
			taken = true;
			writeJson(o.file, picked, true);
			resolve();
			return new Response("ok", { status: 200, headers: CORS });
		},
	});
	const stop = () => {
		if (timer) clearTimeout(timer);
		void server.stop();
	};
	const wait = o.waitMs ?? DEFAULT_WAIT_MS;
	const expiry = o.sleep ? o.sleep(wait) : new Promise<void>(r => (timer = setTimeout(r, wait)));
	const done = Promise.race([stored, expiry.then(() => Promise.reject(new ReceiverError("받는 쪽이 시간 안에 값을 받지 못했어요")))]);
	done.then(stop, stop);
	return { url: `http://127.0.0.1:${server.port}/${token}`, done, stop };
}

// Serves `value` once from a random-token localhost URL; the second request and any other path get 404.
export function serveOnce(value: string): { url: string; stop: () => void } {
	const token = randomUUID();
	let served = false;
	const srv = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: req => {
			if (served || new URL(req.url).pathname !== `/${token}`) return new Response("", { status: 404 });
			served = true;
			return new Response(value);
		},
	});
	return { url: `http://127.0.0.1:${srv.port}/${token}`, stop: () => void srv.stop(true) };
}
