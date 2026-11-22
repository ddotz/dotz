import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectKey } from "./answers.ts";

export type ConnectTarget = ConnectKey | "web-access";
export type OwnerStep = { label: string; hint: string };
type Choice = { id: string; label: string };
export type ConnectUI = {
	step(target: ConnectTarget, title: string, detail: string): void;
	waiting(target: ConnectTarget, owner: OwnerStep, choices?: Choice[]): Promise<{ action: "continue"; choice?: string } | { action: "later" }>;
	done(target: ConnectTarget, url?: string): void;
	failed(target: ConnectTarget, error: string, owner: OwnerStep | null): Promise<"retry" | "later">;
};
export type ConnectResult = "done" | "later" | "failed";

type Gateway = { dir: string; port: number; fetch?: typeof fetch };
type State = "idle" | "running" | "waiting" | "done" | "failed";
type View = { state: State; title: string; detail: string; owner: OwnerStep | null; error: string; url: string | undefined; choices: Choice[] | undefined };
type Reply = { ok: true; view: View } | { ok: false; error: string };

const REQUEST_MS = 15_000;
const RUNNING_LIMIT_MS = 35 * 60_000;
const STATES: readonly unknown[] = ["idle", "running", "waiting", "done", "failed"];
const NO_ANSWER = "게이트웨이가 알 수 없는 답을 보냈어요.";
const DEFAULT_OWNER: OwnerStep = { label: "확인", hint: "화면의 안내대로 한 뒤 계속을 선택해 주세요." };

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const base = (o: { port: number }): string => `http://127.0.0.1:${o.port}`;

function ownerOf(v: unknown): OwnerStep | null {
	return isRecord(v) && typeof v.label === "string" && typeof v.hint === "string" ? { label: v.label, hint: v.hint } : null;
}

function choicesOf(v: unknown): Choice[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const list = v.flatMap((c): Choice[] => (isRecord(c) && typeof c.id === "string" && typeof c.label === "string" ? [{ id: c.id, label: c.label }] : []));
	return list.length ? list : undefined;
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (e) {
		if (e instanceof SyntaxError) return undefined;
		throw e;
	}
}

const isState = (v: unknown): v is State => STATES.includes(v);

function viewOf(json: unknown): View | undefined {
	if (!isRecord(json) || !isState(json.state)) return undefined;
	const state = json.state;
	const step = isRecord(json.step) ? json.step : {};
	return { state, title: text(step.title), detail: text(step.detail), owner: ownerOf(json.owner), error: text(json.error), url: text(json.url) || undefined, choices: choicesOf(json.choices) };
}

function failureOf(status: number, json: unknown): string {
	if (status === 401 || status === 403) return "게이트웨이가 이 요청을 받아주지 않아요. 같은 컴퓨터의 ~/.dotz 로 설치했는지 확인해 주세요.";
	const reason = isRecord(json) ? text(json.error) : "";
	return reason ? `게이트웨이가 거절했어요: ${reason}` : `게이트웨이가 ${status} 로 답했어요.`;
}

async function send(o: Gateway, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
	const tokenFile = join(o.dir, "secrets", "hub-token");
	if (!existsSync(tokenFile)) return { ok: false, error: "게이트웨이 열쇠(secrets/hub-token)가 없어요. 게이트웨이가 한 번 시작된 뒤에 다시 해 주세요." };
	const headers: Record<string, string> = { "x-dotz-token": readFileSync(tokenFile, "utf8").trim() };
	if (body !== undefined) headers["content-type"] = "application/json";
	try {
		const res = await (o.fetch ?? fetch)(`${base(o)}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_MS) });
		const json = parseJson(await res.text());
		return res.ok ? { ok: true, json } : { ok: false, error: failureOf(res.status, json) };
	} catch (e) {
		return { ok: false, error: e instanceof Error && e.name === "TimeoutError" ? "게이트웨이가 시간 안에 답하지 않았어요." : "게이트웨이에 연결하지 못했어요. 켜져 있는지 확인해 주세요." };
	}
}

async function viewReply(o: Gateway, method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
	const r = await send(o, method, path, body);
	if (!r.ok) return r;
	const view = viewOf(r.json);
	return view ? { ok: true, view } : { ok: false, error: NO_ANSWER };
}

const startReply = (o: Gateway, target: ConnectTarget, hostname: string | undefined): Promise<Reply> =>
	target === "web-access" ? viewReply(o, "POST", "/api/web-access/onboard", { mode: "cloudflare", ...(hostname ? { hostname } : {}) }) : viewReply(o, "POST", `/api/onboarding/${target}/start`, {});

/** Connects the chosen messengers and the web access one after another through the gateway's own connection engine. A target the caller did not ask for stays "later". */
export async function connectAll(o: { dir: string; port: number; targets: ConnectTarget[]; hostname?: string; ui: ConnectUI; fetch?: typeof fetch; pollMs?: number }): Promise<Record<ConnectTarget, ConnectResult>> {
	const result: Record<ConnectTarget, ConnectResult> = { discord: "later", slack: "later", telegram: "later", jandi: "later", "web-access": "later" };
	const gateway: Gateway = { dir: o.dir, port: o.port, fetch: o.fetch };
	const pollMs = o.pollMs ?? 1500;

	async function drive(target: ConnectTarget): Promise<ConnectResult> {
		const path = `/api/onboarding/${target}`;
		let reply = await startReply(gateway, target, o.hostname);
		let shown = "";
		let runningSince = Date.now();
		for (;;) {
			if (!reply.ok) {
				if ((await o.ui.failed(target, reply.error, null)) === "later") return "failed";
				const now = await viewReply(gateway, "GET", path);
				reply = now.ok && now.view.state !== "idle" && now.view.state !== "failed" ? now : await startReply(gateway, target, o.hostname);
				runningSince = Date.now();
				continue;
			}
			const view = reply.view;
			if (view.state === "done") {
				o.ui.done(target, view.url);
				return "done";
			}
			if (view.state === "failed" || view.state === "idle") {
				const error = view.error || "연결이 끝까지 가지 못했어요.";
				if ((await o.ui.failed(target, error, view.owner)) === "later") return "later";
				reply = await startReply(gateway, target, o.hostname);
				runningSince = Date.now();
				continue;
			}
			if (view.state === "waiting") {
				const answer = await o.ui.waiting(target, view.owner ?? DEFAULT_OWNER, view.choices);
				if (answer.action === "later") return "later";
				reply = await viewReply(gateway, "POST", `${path}/continue`, answer.choice ? { choice: answer.choice } : {});
				runningSince = Date.now();
				continue;
			}
			const line = `${view.title}\n${view.detail}`;
			if (line !== shown && view.title) {
				shown = line;
				o.ui.step(target, view.title, view.detail);
			}
			if (Date.now() - runningSince > RUNNING_LIMIT_MS) {
				if ((await o.ui.failed(target, "연결이 너무 오래 걸려요.", null)) === "later") return "later";
				reply = await startReply(gateway, target, o.hostname);
				runningSince = Date.now();
				continue;
			}
			await wait(pollMs);
			reply = await viewReply(gateway, "GET", path);
		}
	}

	for (const target of o.targets) result[target] = await drive(target);
	return result;
}

/** Moves the live web access to the tailnet or to this computer only; the Cloudflare mode goes through connectAll. */
export async function switchAccess(o: { dir: string; port: number; mode: "tailscale" | "local"; fetch?: typeof fetch }): Promise<{ ok: boolean; error?: string }> {
	const r = o.mode === "tailscale" ? await send(o, "PUT", "/api/web-access", { mode: "tailscale" }) : await send(o, "POST", "/api/web-access/onboard", { mode: "local" });
	return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** True once the gateway on this port answers GET /api/peer-info, polled for up to `seconds`. */
export async function gatewayUp(o: { port: number; seconds: number; fetch?: typeof fetch }): Promise<boolean> {
	const deadline = Date.now() + o.seconds * 1000;
	do {
		try {
			const res = await (o.fetch ?? fetch)(`${base(o)}/api/peer-info`, { signal: AbortSignal.timeout(2000) });
			if (res.ok) return true;
		} catch (e) {
			if (!(e instanceof Error)) throw e;
		}
		await wait(500);
	} while (Date.now() < deadline);
	return false;
}
