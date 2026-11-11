// Spends one Claude 리셋권 (Anthropic's "limit reset", program cedar_ember) of an OmO subscription account, the call Claude Code's
// /limit-reset makes: POST /api/organizations/{org}/reset_rate_limits {program, grant_id, request_id}. Reached only from
// POST /api/quota/reset-credit with provider "anthropic" and confirm: true (the usage screen's confirm step), and only after a fresh
// read shows that grant still has one left and applies now. The token is never refreshed: an expired one is refused, not renewed.
import { randomUUID } from "node:crypto";
import { log } from "./config.ts";
import { claudeCliUa, claudeGrants, claudeOrg, claudeResets, claudeUsageGet, subscriptionAccounts } from "./usage-account.ts";

type Json = Record<string, any>;
const API = "https://api.anthropic.com/api/organizations";
// The results the usage screen knows how to word (web/js/21-providers.js resetRow). Any other answer is not told to the owner as a success.
const OUTCOMES = new Set(["reset", "nothing_to_reset", "not_limited", "no_credit", "already_redeemed", "already_used", "cooldown"]);

// What the server's ineligible_reason means for the owner. A reason not listed is shown as it came when it is a short plain word, else left out.
const REASONS: Record<string, string> = { surface: "이 접속 방식으로는 쓸 수 없다고 해요" };
const plainReason = (v: unknown): string => (typeof v === "string" && /^[\w .:-]{1,40}$/.test(v) ? v : "");

let using = false;
// `lift`: what to do once the server says the limit is reset (hub/limit-peer.ts liftAfterReset), as Claude Code treats the limit as gone at once;
// the fields it answers (what went on here, how many other gateways were told) join the response.
export async function useClaudeReset(b: Json, fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch, lift?: (account: string) => Promise<Json | void>): Promise<{ status: number; body: Json }> {
	if (b.confirm !== true) return { status: 400, body: { error: "리셋권은 확인을 거친 뒤에만 써요" } };
	if (typeof b.account !== "string" || typeof b.grant_id !== "string") return { status: 400, body: { error: "어느 리셋권인지 알 수 없어요" } };
	if (using) return { status: 409, body: { error: "리셋권을 쓰는 중이에요" } };
	using = true;
	try {
		const acct = subscriptionAccounts().find(a => a.name === b.account);
		if (!acct) return { status: 404, body: { error: "이 Claude 계정을 찾지 못했어요" } };
		if (acct.expiresAt !== null && acct.expiresAt <= Date.now()) return { status: 409, body: { error: "로그인이 풀려서 쓰지 않았어요" } };
		const org = claudeOrg(acct.name);
		if (!org) return { status: 409, body: { error: "이 계정은 여기서 리셋권을 쓸 수 없어요" } };
		const res = await claudeUsageGet(fetchFn, acct.token);
		if (res.status === 401 || res.status === 403) return { status: 409, body: { error: "로그인이 풀려서 쓰지 않았어요" } };
		if (!res.ok) return { status: 502, body: { error: `리셋권을 확인하지 못했어요 (${res.status})` } };
		const now = (await res.json()) as Json;
		const grant = claudeGrants(now).find(g => g.id === b.grant_id);
		if (!grant) return { status: 409, body: { error: "남은 리셋권이 없어요" } };
		if (!grant.now || now.cedar_ember?.eligible === false) return { status: 409, body: { error: "지금은 이 리셋권을 쓸 수 없어요" } };
		const held = claudeResets(now, () => true)?.held ?? grant.left;
		const out = await fetchFn(`${API}/${org}/reset_rate_limits`, {
			method: "POST",
			headers: { authorization: `Bearer ${acct.token}`, accept: "application/json", "content-type": "application/json", "anthropic-beta": "oauth-2025-04-20", "user-agent": claudeCliUa(), "x-app": "cli" },
			body: JSON.stringify({ program: "cedar_ember", grant_id: grant.id, request_id: randomUUID() }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!out.ok) return { status: 502, body: { error: `리셋권을 쓰지 못했어요 (${out.status})` } };
		const r = (await out.json()) as Json;
		const outcome = String(r.result ?? "");
		const reason = typeof r.ineligible_reason === "string" ? r.ineligible_reason.slice(0, 80) : "";
		log(`claude: limit reset ${grant.id} for ${acct.name}: ${outcome}${reason ? ` (${reason})` : ""}`);
		// An answer the screen cannot word fully: the names of its fields (never their values) tell the next real press what the server sent.
		if (outcome === "ineligible" || !OUTCOMES.has(outcome)) log(`claude: limit reset answer fields: ${Object.keys(r).filter(k => /^[\w.-]{1,40}$/.test(k)).sort().join(",")}`);
		if (outcome === "ineligible") {
			const why = REASONS[reason] ?? plainReason(reason);
			return { status: 409, body: { error: `리셋이 적용되지 않았고, 리셋권도 쓰지 않았어요${why ? ` (${why})` : ""}`, outcome, left: held } };
		}
		if (!OUTCOMES.has(outcome)) return { status: 502, body: { error: "리셋권이 쓰였는지 확인할 수 없어요. 사용량 화면의 리셋권 개수를 봐 주세요" } };
		// The reset is done: a failure to lift must not turn it into an error answer (the 리셋권 is spent either way).
		const lifted = outcome === "reset" ? await lift?.(acct.name).catch(e => log(`claude: lifting the limit after the reset failed: ${(e as Error).message}`)) : undefined;
		return { status: 200, body: { ok: true, outcome, left: outcome === "reset" ? held - 1 : held, ...(lifted ?? {}) } };
	} catch (e) {
		log(`claude: limit reset failed: ${(e as Error).message}`);
		return { status: 502, body: { error: "리셋권을 쓰지 못했어요" } };
	} finally {
		using = false;
	}
}
