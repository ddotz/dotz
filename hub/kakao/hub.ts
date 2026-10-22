// Default client of the dotz gateway's HTTP API for the kakao CLI: 127.0.0.1, header x-dotz-token. Tests inject a fake Hub instead.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HubFull } from "./types.ts";

const DEFAULT_PORT = 7420;

export function hubPort(dataDir: string, env: Record<string, string | undefined> = process.env): number {
	const fromEnv = Number(env.DOTZ_PORT);
	if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
	try {
		const port = Number(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"))?.web?.port);
		if (Number.isInteger(port) && port > 0) return port;
	} catch {}
	return DEFAULT_PORT;
}

export function createHub(dataDir: string, env: Record<string, string | undefined> = process.env): HubFull {
	const base = `http://127.0.0.1:${hubPort(dataDir, env)}`;
	const call = async (method: string, path: string, body?: unknown) => {
		const token = readFileSync(join(dataDir, "secrets", "hub-token"), "utf8").trim();
		// GET /api/auth/<id>?wait=55 holds the request for up to 55 s.
		const res = await fetch(base + path, {
			method,
			headers: { "x-dotz-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(path.includes("wait=") ? 70_000 : 15_000),
		});
		const json = await res.json().catch(() => undefined);
		return { status: res.status, json };
	};
	return {
		post: (path, body) => call("POST", path, body),
		get: path => call("GET", path),
		patch: (path, body) => call("PATCH", path, body),
		del: path => call("DELETE", path),
	};
}
