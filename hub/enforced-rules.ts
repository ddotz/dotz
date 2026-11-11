// The one list of rules that code already enforces. A contract line that still spells one of them out costs every re-read
// for nothing: the guard refuses the case whether or not the line is there. hub/prompt-health.ts scans the contract lines
// against this list and proposes removing them. Each entry names the guard (repo path[:line]) that holds the rule.
//
// Add an entry only when a guard exists and a test covers it; drop it when the guard goes. hub/prompt-health.test.ts checks
// that every guard file still exists. `match` runs over one contract line, so keep it narrow: a line that also carries other
// rules must not match just because it mentions the topic.

export type EnforcedRule = { id: string; match: RegExp; guard: string };

export const ENFORCED_RULES: EnforcedRule[] = [
	// "Do not stop because a usage limit is low": a brief or follow-up with such a stop line is refused unless it quotes the owner.
	{ id: "limit-stop", match: /(한도|사용량|할당량|quota|usage|limit)[^\n]{0,60}(멈추|중단|그만|\bstop|\bpause|\bhalt)|(멈추|중단|\bstop|\bpause|\bhalt)[^\n]{0,60}(한도|사용량|할당량|quota|usage limit|rate limit)/i, guard: "extension/guard-limit.ts:6" },
	// Expensive models and max effort only when the owner asked.
	{ id: "expensive-model", match: /(fable|xhigh|\bmax\b[^\n]{0,15}effort)[^\n]{0,80}(only|ask|요청|때만|물어)/i, guard: "extension/guard.ts:16" },
	// Never restart the gateway from a shell.
	{ id: "gateway-restart", match: /launchctl\s+(kickstart|stop|kill|bootout|unload|remove)/i, guard: "hub/systemdeny.ts:12" },
	// A brief without a done-condition is refused.
	{ id: "brief-done-when", match: /(brief|브리프)[^\n]{0,80}(without|has no|missing|없|빠)[^\n]{0,40}(done when|done-condition|완료 조건)|(must|always|반드시|꼭)[^\n]{0,30}(done when|완료 조건)/i, guard: "extension/guard-brief.ts:10" },
	// A session needs a reason and an expected duration of at least LANE_MIN_HOURS.
	{ id: "session-min-hours", match: /(session|lane|세션|레인)[^\n]{0,60}(under|less than|shorter than|미만|안 되는)[^\n]{0,20}(1|one|한)[ -]?(hour|h\b|시간)/i, guard: "hub/lanegates.ts:15" },
	// The recommendation mark on an option line is stripped before anything shows or keys on it.
	{ id: "recommend-mark", match: /(추천|recommend\w*)[^\n]{0,30}(표시|mark|badge)[^\n]{0,30}(금지|never|don't|do not|말|않)|(never|don't|do not|금지|말)[^\n]{0,30}(추천|recommend\w*)[^\n]{0,20}(표시|mark|badge)/i, guard: "hub/choices.ts:67" },
	// Telemetry of the agent runtime is switched off at start.
	{ id: "telemetry-off", match: /(telemetry|텔레메트리)[^\n]{0,40}(off|disable|끄|꺼)|(turn off|disable|끄)[^\n]{0,20}(telemetry|텔레메트리)/i, guard: "hub/update.ts:180" },
];
