// The local dotz gateway's HTTP API, as setup scripts use it: register watches and edit one evolving progress message.
// Authenticated with the per-install hub token (read at call time, never printed). Injected as a function so onboarding
// tests record calls instead of reaching a gateway.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.ts";

export type Gateway = (method: string, path: string, body?: unknown) => Promise<any>;

const DEFAULT_PORT = 7420;

function base(): string {
	let port = Number(process.env.DOTZ_PORT);
	if (!port) {
		try {
			port = Number(JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8"))?.web?.port);
		} catch {
			port = 0;
		}
	}
	return `http://127.0.0.1:${port || DEFAULT_PORT}`;
}

export const liveGateway: Gateway = async (method, path, body) => {
	const tokenFile = join(dataDir(), "secrets", "hub-token");
	if (!existsSync(tokenFile)) throw new Error("게이트웨이 토큰이 없어요 (dotz 설치가 끝났는지 확인해 주세요)");
	const headers: Record<string, string> = { "x-dotz-token": readFileSync(tokenFile, "utf8").trim() };
	if (body !== undefined) headers["content-type"] = "application/json";
	let res: Response;
	try {
		res = await fetch(`${base()}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
	} catch {
		throw new Error("게이트웨이에 연결하지 못했어요 (게이트웨이가 켜져 있나요?)");
	}
	const text = await res.text();
	// `status` lets a caller tell "already there" (409) from a real failure.
	if (!res.ok) throw Object.assign(new Error(`게이트웨이 ${method} ${path} 실패: HTTP ${res.status} ${text.slice(0, 160)}`), { status: res.status });
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
};
