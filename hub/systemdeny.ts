// Always refused, whatever RULES.md says: pattern kills reach the live gateway (a test hub shares its command line),
// and kickstarting it cuts the orchestrator and every lane mid-turn. Test hubs are stopped by their own PID;
// gateway restarts go through /api/gateway/restart, which waits for idle. Shared by every runtime's guard (the omp
// extension, the Claude Code deny hook); hub/features.ts lists these lines on the 구성 tab.
export const SYSTEM_DENY: [RegExp, string][] = [
	[/\b(pkill|killall)\b[^;&|\n]*(hub\/main|dotz)/i, "a pattern kill also hits the live dotz gateway; stop a test hub by the PID you started"],
	[/\blaunchctl\s+(kickstart|stop|kill|bootout|unload|remove)\b[^;&|\n]*dev\.dotz\.gateway/i, "restarting the gateway cuts every session short; use /restart gateway (POST /api/gateway/restart)"],
];

export const systemDeny = (command: string): string | undefined => SYSTEM_DENY.find(([re]) => re.test(command))?.[1];
