// `dotz status`: is this an SSH shell that cannot read the Claude login kept in the macOS login keychain? An SSH session can see the keychain items
// but not open them (security exits 36, "User interaction is not allowed"), so an agent started from it answers "Not logged in" although the login is fine.
// A /login done in that shell is kept in the account dir's .credentials.json instead, which the agent reads. Observed: that exit code and text from a launchd
// Background session (the kind an SSH login runs in); the SSH shell itself is assumed to behave the same. Only node builtins: like dotz-ctl.ts this must not
// pull hub/config.ts. The account dir is found the way hub/usage-account.ts cliCredential does (<agent dir>/anthropic-subscription-claude/<dirId>); the agent dir
// the way hub/apikey-policy.ts authFile does. One `security show-keychain-info` call (it prints no secret, and no -w is ever passed) with a hard timeout.

export const SSH_KEYCHAIN_LINE = "이 SSH 셸에서 띄운 에이전트는 키체인에 저장된 Claude 로그인을 읽지 못해 \"Not logged in\"이라고 답해요. 그 에이전트 안에서 /login을 한 번 하면 로그인이 파일에 저장돼서 해결돼요";

const SECURITY_TIMEOUT_MS = 1_500;
const BLOCKED_EXIT = 36;
const BLOCKED_TEXT = /User interaction is not allowed/i;

export type KeychainProbe = {
	platform: string;
	env: Record<string, string | undefined>;
	home: string;
	read: (file: string) => string | undefined;
	exists: (file: string) => boolean;
	/** Runs one command with a hard timeout; undefined when it timed out or could not start. */
	security: (argv: string[], timeoutMs: number) => Promise<{ code: number; out: string } | undefined>;
};

/** The agent's Claude CLI accounts whose login would be in the keychain unless a .credentials.json sits in their dir. */
function accountFiles(p: KeychainProbe): string[] {
	const agentDir = p.env.OMO_CODING_AGENT_DIR ?? p.env.PI_AGENT_DIR ?? `${p.home}/.omo/agent`;
	let accounts: unknown;
	try {
		accounts = (JSON.parse(p.read(`${agentDir}/auth.json`) ?? "null") as { "anthropic-subscription"?: { accounts?: unknown } } | null)?.["anthropic-subscription"]?.accounts;
	} catch {
		return []; // an auth.json that does not parse says nothing about a keychain login
	}
	if (!Array.isArray(accounts)) return [];
	return accounts.flatMap((a: { store?: unknown; dirId?: unknown; signInRequired?: unknown }) =>
		a?.store === "claude-cli" && !a.signInRequired && typeof a.dirId === "string" && /^[0-9a-f]{32}$/.test(a.dirId) ? [`${agentDir}/anthropic-subscription-claude/${a.dirId}/.credentials.json`] : [],
	);
}

export async function sshKeychainFinding(p: KeychainProbe): Promise<"ssh-keychain-unreadable" | undefined> {
	if (p.platform !== "darwin" || !(p.env.SSH_CONNECTION || p.env.SSH_TTY)) return undefined;
	const files = accountFiles(p);
	if (!files.length || files.some(f => p.exists(f))) return undefined;
	const r = await p.security(["security", "show-keychain-info", `${p.home}/Library/Keychains/login.keychain-db`], SECURITY_TIMEOUT_MS);
	return r && r.code !== 0 && (r.code === BLOCKED_EXIT || BLOCKED_TEXT.test(r.out)) ? "ssh-keychain-unreadable" : undefined;
}
