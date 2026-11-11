import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { inboxText } from "./intake.ts";
import { allWatches, removeWatch } from "./watch.ts";
import { channelContext, clearChannel, endStanding, getSetup, lapseStandings, listSetups, setupChannel, setupsSummary, standingLive, standingTerm, STANDING_HOURS_MAX, watchWakeEvent, type Setup } from "./workchannels.ts";

const CH = "1500000000007000001";
const WORDS = "새 글에 라벨 달기";
const BASIS = "두 시간만 해 줘";
const T0 = new Date("2026-03-01T00:00:00.000Z");
const setSystemTime = (t: Date) => spyOn(Date, "now").mockReturnValue(t.getTime());
const hoursAfter = (h: number) => new Date(T0.getTime() + h * 3_600_000);
const grant = (extra: Record<string, unknown>) => setupChannel({ channel: `ch:${CH}`, purpose: "글 관리", standing: WORDS, basis: BASIS, ...extra }, "글-관리", "");
const setupOf = () => listSetups().find(s => s.channel === CH) as Setup;
const lapsedNow = () => {
	const told: string[] = [];
	lapseStandings(s => told.push(s.channel));
	return told;
};
const wakeFor = (name: string) => inboxText(watchWakeEvent(allWatches().find(w => w.name === name)!, "output changed", "new post"));

afterEach(() => {
	mock.restore();
	clearChannel(CH);
	for (const w of allWatches().filter(x => x.project === `ch:${CH}`)) removeWatch(w.id);
});

test("an hours standing stops applying after expiry while its monitor keeps running, and the owner is told once", () => {
	setSystemTime(T0);
	const s = grant({ scope: "hours", hours: 2, monitors: [{ command: "echo 1" }] });
	const monitor = s.monitors[0]!;
	expect(standingLive(setupOf())).toBe(true);
	expect(wakeFor(monitor)).toContain(WORDS);
	expect(lapsedNow()).toEqual([]);

	setSystemTime(hoursAfter(1.99));
	expect(wakeFor(monitor)).toContain(WORDS);

	setSystemTime(hoursAfter(2));
	expect(standingLive(setupOf())).toBe(false);
	expect(standingTerm(setupOf())).toBe("lapsed");
	expect(wakeFor(monitor)).not.toContain(WORDS);
	expect(setupsSummary()).not.toContain(WORDS);
	expect(lapsedNow()).toEqual([CH]);
	expect(lapsedNow()).toEqual([]);
	expect((JSON.parse(readFileSync(paths.setups, "utf8")) as Setup[]).find(x => x.channel === CH)?.lapsed).toBeString();

	const w = allWatches().find(x => x.name === monitor)!;
	expect(w.paused ?? false).toBe(false);
	expect(setupOf().monitors).toEqual([monitor]);
});

test.each([
	["no scope", {}],
	["an unknown scope", { scope: "forever" }],
	["hours without a number", { scope: "hours" }],
	["zero hours", { scope: "hours", hours: 0 }],
	["a limit past the longest grant", { scope: "hours", hours: STANDING_HOURS_MAX + 1 }],
])("setup refuses a new standing with %s and sets nothing up", (_what, extra) => {
	expect(() => grant({ ...extra, monitors: [{ command: "echo 1" }] })).toThrow(/scope|hours/);
	expect(setupOf()).toBeUndefined();
	expect(allWatches().some(w => w.project === `ch:${CH}`)).toBe(false);
});

test("a standing stored before scopes existed keeps working, survives a repeated setup, reads as no limit and never lapses", () => {
	setSystemTime(T0);
	grant({ scope: "task" });
	const stored = getSetup(CH)!;
	delete stored.scope;
	delete stored.expires;

	setSystemTime(hoursAfter(24 * 400));
	expect(standingLive(setupOf())).toBe(true);
	expect(standingTerm(setupOf())).toBe("none");
	expect(listSetups().find(s => s.channel === CH)?.standing_term).toBe("기한 없음");
	expect(channelContext(CH)).toContain(WORDS);
	expect(lapsedNow()).toEqual([]);

	const again = grant({ monitors: [{ command: "echo 2" }] });
	expect(again.monitors).toHaveLength(1);
	expect(standingTerm(setupOf())).toBe("none");
});

test("repeating setup with the same words keeps the grant: it neither renews a running limit nor revives a lapsed one", () => {
	setSystemTime(T0);
	const first = grant({ scope: "hours", hours: 2 });
	setSystemTime(hoursAfter(1));
	expect(grant({ scope: "hours", hours: 2 }).expires).toBe(first.expires);

	setSystemTime(hoursAfter(3));
	expect(lapsedNow()).toEqual([CH]);
	grant({ scope: "hours", hours: 2 });
	expect(standingLive(setupOf())).toBe(false);
	expect(lapsedNow()).toEqual([]);

	const renewed = grant({ scope: "hours", hours: 2, basis: "두 시간 더 해 줘" });
	expect(standingLive(setupOf())).toBe(true);
	expect(renewed.lapsed).toBeUndefined();
});

test("once ends with the wake that used it, task ends with the task, and neither outlives a day without either", () => {
	setSystemTime(T0);
	grant({ scope: "once" });
	endStanding(CH, "task");
	expect(standingLive(setupOf())).toBe(true);
	endStanding(CH, "once");
	expect(standingLive(setupOf())).toBe(false);
	expect(lapsedNow()).toEqual([CH]);

	grant({ scope: "task", standing: "다른 일", basis: "이번 일만 해 줘" });
	endStanding(CH, "once");
	expect(standingLive(setupOf())).toBe(true);
	endStanding(CH, "task");
	expect(standingLive(setupOf())).toBe(false);

	grant({ scope: "task", standing: "또 다른 일", basis: "이것도 해 줘" });
	setSystemTime(hoursAfter(24));
	expect(standingLive(setupOf())).toBe(false);
});

test("old words give no new grant: not under another standing, and not after the standing was dropped", () => {
	setSystemTime(T0);
	grant({ scope: "hours", hours: 2 });
	setSystemTime(hoursAfter(3));
	expect(() => grant({ scope: "hours", hours: 2, standing: "조금 다른 일" })).toThrow(/basis/);
	setupChannel({ channel: CH, purpose: "글 관리" }, "글-관리", "");
	expect(() => grant({ scope: "hours", hours: 2 })).toThrow(/basis/);
	expect(standingTerm(setupOf())).toBeUndefined();
	grant({ scope: "hours", hours: 2, basis: "다시 두 시간 해 줘" });
	expect(standingLive(setupOf())).toBe(true);
});

test("a setup that drops the standing ends it quietly: the owner already read the setup note", () => {
	setSystemTime(T0);
	grant({ scope: "hours", hours: 2 });
	setupChannel({ channel: CH, purpose: "글 관리" }, "글-관리", "");
	setSystemTime(hoursAfter(3));
	expect(standingTerm(setupOf())).toBeUndefined();
	expect(lapsedNow()).toEqual([]);
});
