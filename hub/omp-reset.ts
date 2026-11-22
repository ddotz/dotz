import { log, OMP } from "./config.ts";
import { type Ran, runLimited } from "./run-limited.ts";

type Credit = { id?: string; remainingCount?: number; status?: string; usable?: boolean };
type OmpAccount = { provider?: string; email?: string; credentialId?: number; nextCreditId?: string; availableCount?: number; redeemableCount?: number; credits?: Credit[] };
type Answer = { status: number; body: Record<string, unknown> };
type Request = { confirm?: unknown; account?: unknown; grant_id?: unknown };

const LIST_MS = 45_000;
const SPEND_MS = 45_000;

/** How the spend reaches omp; a test swaps `run` for a stub, so no test starts the real binary. */
export const ompResetEnv: { run: (argv: readonly string[], limitMs: number) => Promise<Ran> } = { run: runLimited };

const REFUSALS: [RegExp, string, string][] = [
	[/already redeemed/i, "already_redeemed", "이미 쓴 리셋권이에요"],
	[/nothing to reset/i, "nothing_to_reset", "지금은 리셋할 한도가 없어서 리셋권을 쓰지 않았어요"],
	[/no saved resets/i, "no_credit", "남은 리셋권이 없어요"],
	[/offer changed|already in progress|another omp process/i, "cooldown", "다른 곳에서 쓰는 중이라 리셋권을 쓰지 않았어요"],
];

const refuse = (status: number, error: string): Answer => ({ status, body: { error } });

async function listAccounts(env: typeof ompResetEnv): Promise<OmpAccount[] | undefined> {
	const listed = await env.run([OMP, "usage", "reset", "--json"], LIST_MS);
	try {
		const accounts: unknown = listed.code === 0 ? JSON.parse(listed.stdout)?.accounts : undefined;
		if (Array.isArray(accounts)) return accounts as OmpAccount[];
		log(`omp: limit reset list has no accounts (exit ${listed.code}${listed.timedOut ? ", timed out" : ""})`);
	} catch (e) {
		log(`omp: limit reset list is not JSON: ${(e as Error).message}`);
	}
	return undefined;
}

let using = false;

/**
 * Spends one Claude 리셋권 of omp's Anthropic login with `omp usage reset anthropic/<credential id>` (omp@18.22.0). omp spends only its own
 * next credit and only when that credit is usable, so a fresh `omp usage reset --json` decides first: the grant must still be the next one,
 * with one left, usable now. Reached only from POST /api/quota/reset-credit with provider "anthropic" and confirm: true.
 */
export async function useOmpReset(b: Request, lift?: (account: string) => Promise<Record<string, unknown> | void>, env = ompResetEnv): Promise<Answer> {
	if (b.confirm !== true) return refuse(400, "리셋권은 확인을 거친 뒤에만 써요");
	if (typeof b.account !== "string" || typeof b.grant_id !== "string") return refuse(400, "어느 리셋권인지 알 수 없어요");
	if (using) return refuse(409, "리셋권을 쓰는 중이에요");
	using = true;
	try {
		const accounts = await listAccounts(env);
		if (!accounts) return refuse(502, "리셋권을 확인하지 못했어요");
		const mine = accounts.filter(a => a?.provider === "anthropic" && a.email === b.account);
		if (!mine.length) return refuse(404, "이 Claude 계정을 찾지 못했어요");
		const acct = mine.find(a => a.nextCreditId === b.grant_id) ?? mine[0]!;
		const credit = (acct.credits ?? []).find(c => c?.id === b.grant_id);
		if (!credit || !(Number(credit.remainingCount ?? 1) > 0) || credit.status === "redeemed" || credit.status === "expired") return refuse(409, "남은 리셋권이 없어요");
		if (credit.usable !== true || acct.nextCreditId !== credit.id || Number(acct.redeemableCount ?? 1) < 1) return refuse(409, "지금은 이 리셋권을 쓸 수 없어요");
		if (!Number.isInteger(acct.credentialId)) return refuse(409, "이 계정은 여기서 리셋권을 쓸 수 없어요");
		const held = Math.max(0, Math.floor(Number(acct.availableCount ?? 1)));
		const out = await env.run([OMP, "usage", "reset", `anthropic/${acct.credentialId}`], SPEND_MS);
		log(`omp: limit reset ${credit.id} for ${b.account}: exit ${out.code}${out.timedOut ? " (timed out)" : ""}`);
		if (out.code === 0 && /^Reset applied/m.test(out.stdout)) {
			const cleared = await env.run([OMP, "usage", "invalidate", "--provider", "anthropic"], LIST_MS);
			if (cleared.code !== 0) log(`omp: usage cache not cleared after the reset (exit ${cleared.code})`);
			const lifted = await lift?.(b.account).catch(e => log(`omp: lifting the limit after the reset failed: ${(e as Error).message}`));
			return { status: 200, body: { ok: true, outcome: "reset", left: held - 1, ...(lifted ?? {}) } };
		}
		const refused = out.timedOut ? undefined : REFUSALS.find(([re]) => re.test(`${out.stdout}\n${out.stderr}`));
		if (refused) return { status: 409, body: { error: refused[2], outcome: refused[1], left: held } };
		return refuse(502, "리셋권이 쓰였는지 확인할 수 없어요. 사용량 화면의 리셋권 개수를 봐 주세요");
	} finally {
		using = false;
	}
}
