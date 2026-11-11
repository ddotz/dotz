import { publicPostDeny as scrubPostDeny } from "./public-scrub.ts";
export { prepareCommitIdentity } from "./clone-identity.ts";
import { upstreamCommitsDeny } from "./upstream-commits.ts";

// Always refused, whatever RULES.md says: pattern kills reach the live gateway (a test hub shares its command line),
// and kickstarting it cuts the orchestrator and every lane mid-turn. Test hubs are stopped by their own PID;
// gateway restarts go through /api/gateway/restart, which waits for idle (plain `dotz restart` does exactly that and stays allowed; `dotz restart --force` kills a
// process that does not answer, an owner-at-a-terminal act that onboard/dotz-ctl.ts also refuses without a TTY). Shared by every runtime's guard (the omp
// extension, the Claude Code deny hook); hub/features.ts lists these lines on the 구성 tab.
export const SYSTEM_DENY: [RegExp, string][] = [
	[/\b(pkill|killall)\b[^;&|\n]*(hub\/main|dotz)/i, "a pattern kill also hits the live dotz gateway; stop a test hub by the PID you started"],
	[/\blaunchctl\s+(kickstart|stop|kill|bootout|unload|remove)\b[^;&|\n]*dev\.dotz\.gateway/i, "restarting the gateway cuts every session short; use /restart gateway (POST /api/gateway/restart)"],
	[/(?:\bdotz|dotz-ctl-cli\.ts)\s+restart\b[^;&|\n]*--force\b/i, "dotz restart --force kills the gateway process and the work it runs; only the owner types it at a terminal. Plain `dotz restart` waits for running work and is allowed"],
];

// A turn an outside mail woke (hub/intake.ts puts this token on its first line): the text came from a stranger, so the shell
// of that turn must not read stored secrets or send anything out (extension/mail-turn.ts applies it until the turn ends).
export const MAIL_TURN_MARK = "[dotz:mail-turn]";
const MAIL_TURN_DENY: [RegExp, string][] = [
	[/secrets-cli|\bsecrets[\/\\]|[\/\\]secrets\b|hub-token|peer-token/i, "it reads stored secrets or the owner token"],
	[/\b(?:curl|wget)\b[^|;&\n]*(?:\s-[A-Za-z]*[dFTX]|--(?:data[\w-]*|form[\w-]*|json|upload-file|post-data|post-file|body-data|body-file|request|method)\b)/, "it sends data out"],
	[/\b(?:curl|wget)\b[^|;&\n]*\?[^\s|;&]*=/, "it puts values in a URL"],
	[/\bzele\b[^|;&\n]*\b(?:send|reply|forward|compose)\b/i, "it sends mail"],
	[/(?:^|[\s;&|(])gh\s+\S/, "it runs gh"],
	[/\b(?:draft|comments|mail-cli|mail|sns|voice|cli)\.ts\s+(?:send|send-file|compose|approve|publish)\b/, "it sends through a dotz send command"],
];
export const mailTurnDeny = (command: string): string | undefined => MAIL_TURN_DENY.find(([re]) => re.test(command))?.[1];

// The text of a post to a public repo first, then the commits a PR or a push would publish (hub/upstream-commits.ts).
export const publicPostDeny = (command: string, dataDir: string, cwd: string): string | undefined => scrubPostDeny(command, dataDir, cwd) ?? upstreamCommitsDeny(command, dataDir, cwd);

export const systemDeny = (command: string): string | undefined => SYSTEM_DENY.find(([re]) => re.test(command))?.[1];
