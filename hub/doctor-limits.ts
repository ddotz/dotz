// Every number the doctor (hub/doctor.ts, hub/doctor-checks.ts) decides by, in one place so the docs and the tests read the same values.
// Hours and days are kept in their own unit; the checks convert once.
export const THRESHOLDS = {
	/** gateway: `gateway restart (` lines in hub.log within the window, at least this many. */
	restarts: 3,
	restartWindowH: 24,
	/** gateway: uncaught stack traces added to gateway.err.log since the last run, at least this many. */
	crashes: 1,
	/** sessions: a running lane with no progress for longer than this; a lane in error and not closed for longer than this (and not older than the max). */
	laneIdleH: 6,
	laneErrorH: 24,
	laneErrorMaxDays: 30,
	/** logins: a login still lost this long after it was lost. */
	loginLostH: 12,
	/** watches: failing for longer than this, or this many runs in a row. */
	watchFailH: 24,
	watchFails: 3,
	/** disk: a finding below either free share or free space; a decision below the third. */
	diskFreePct: 10,
	diskFreeGb: 10,
	diskDecideGb: 3,
	/** failures: the failure report's own growth thresholds (hub/failure-report.ts check). */
	failures: { pct: 25, minTokens: 1_000_000, minCount: 10 },
	failureDays: 7,
	/** tokens: the window the token audit looks at. */
	tokensH: 24,
	/** delivery: told again when the level grew by this factor, or this many days after it was last told while still present. */
	repeatFactor: 1.5,
	repeatDays: 7,
	/** How much of the end of hub.log the checks read. */
	logTailBytes: 4_000_000,
} as const;
