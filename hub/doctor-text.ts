import { TZ, tzLabel } from "./config.ts";
import type { Grown } from "./failure-report.ts";
import type { TopSession, UsualDay } from "./token-audit.ts";

/** One day of counted gateway restarts: all of them, those an update install, the owner's own request or his restart of the orchestrator explains, and the rest. */
export type RestartCount = { all: number; update: number; owner: number; orchestrator: number; unexplained: number };
/** A failure class's growth as the failure report measured it. */
export type FailureGrowth = Pick<Grown, "byTokens" | "was" | "now">;
/** Yesterday's token use as the token audit measured it. */
export type TokenDay = { tokens: number; cost: number; usual?: UsualDay; top: TopSession[] };

const numbers = (under: (step: string) => string) => {
	const least = (n: number, text: string, step: string): string => (n > 0 && Number(text.replace(/[^\d.]/g, "")) === 0 ? under(step) : text);
	return {
		mega: (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : least(n, `${(n / 1e6).toFixed(1)}M`, "0.1M")),
		dollars: (n: number): string => least(n, `$${n.toFixed(2)}`, "$0.01"),
		share: (s: number): string => least(s, `${(s * 100).toFixed(2)}%`, "0.01%"),
		perThousand: (s: number): string => least(s, (s * 1e3).toFixed(2), "0.01"),
	};
};
const EN = numbers(step => `under ${step}`), KO = numbers(step => `${step} 미만`);
const dateOf = (date: string, locale: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, { timeZone: "UTC", month: "long", day: "numeric" });
const dayEn = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { timeZone: TZ, month: "long", day: "numeric" });
const dayKo = (ms: number): string => new Date(ms).toLocaleDateString("ko-KR", { timeZone: TZ, month: "long", day: "numeric" });
const range = (u: UsualDay, locale: string, to: string): string => (u.from === u.to ? dateOf(u.from, locale) : `${dateOf(u.from, locale)}${to}${dateOf(u.to, locale)}`);
const fullyChosen = (s: TopSession): boolean => s.chosen > 0 && Math.round(s.chosen * 100) >= Math.round(s.cost * 100);
const WARN_EN = " Warnings: ", WARN_KO = " 경고: ";
const joinTokens = (items: string[], warn: string, head: (kinds: string) => string): string => {
	const parts = items.map(s => (s.lastIndexOf(warn) < 0 ? { kinds: s.replace(/\.$/, "") } : { lead: s.slice(0, s.lastIndexOf(warn)), kinds: s.slice(s.lastIndexOf(warn) + warn.length).replace(/\.$/, "") }));
	const lead = parts.find(p => p.lead)?.lead, kinds = parts.map(p => p.kinds).join(", ");
	return lead ? `${lead}${warn}${kinds}.` : head(kinds);
};

export const DOCTOR_LEAD_EN = "Doctor check:";
export const DOCTOR_LEAD_KO = "닥터 점검:";
/** The mark a morning line ends with when its cause can be looked into; the web turns it into a button that replies with the line. */
export const DOCTOR_LOOK_EN = " · find the cause";
export const DOCTOR_LOOK_KO = " · 원인 찾기";

export const doctorEn = {
	head: (day: string) => `${DOCTOR_LEAD_EN} ${day}`,
	told: (n: number) => `${n} to know`,
	decide: (n: number) => `${n} to decide`,
	toldPart: "To know",
	decidePart: "To decide",
	again: (n: number) => ` (${n})`,
	clear: "All good.",
	fixedLine: (items: string) => `Fixed by itself: ${items}.`,
	still: (n: number) => `${n} told before ${n === 1 ? "is" : "are"} still there.`,
	healthy: (names: string[]) => `${names.length} checks fine: ${names.join(", ")}.`,
	since: (day: string) => `Ongoing since ${day}.`,
	day: dayEn,
	when: (ms: number) => `${new Date(ms).toLocaleString("en-US", { timeZone: TZ, month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} ${tzLabel()}`,
	areas: { gateway: "gateway", sessions: "sessions", logins: "logins", watches: "monitors", disk: "disk", update: "updates", failures: "failed or repeated work", tokens: "token use", prompt: "re-read text", plugins: "plugins" },
	todo: { sessions: "Let it go on or close it.", login: "Log in to that site again.", disk: "Delete large files you no longer need." },
	look: DOCTOR_LOOK_EN,
	lookHint: `Reply with a line that ends in "${DOCTOR_LOOK_EN.slice(3)}" to have its cause looked into.`,
	more: (n: number) => `and ${n} more`,
	dryAt: (when: string) => `Check at ${when}. A dry run: nothing saved or sent.`,
	dryMorning: "The morning notice carries only the new ones:",
	drySame: "The morning notice says the same.",
	dryNone: (factor: number, days: number) => `Nothing new for the morning notice. Something told before is told again once it grows ${factor}x or ${days} days pass.`,
	restarts: (r: RestartCount) =>
		`The gateway restarted ${r.all} times in one day: ${[r.update ? `${r.update} to install an update` : "", r.owner ? `${r.owner} that you asked for` : "", r.orchestrator ? `${r.orchestrator} along with your restart of the orchestrator on the web` : "", `${r.unexplained} without a known cause`].filter(Boolean).join(", ")}.`,
	restartLine: (when: string, why: string) => `${when} · ${why}`,
	restartUnasked: "the log does not say who asked for it",
	crashes: (n: number, times: string[] = []) => `The gateway crashed ${n} time${n === 1 ? "" : "s"} since the last check${times.length ? `; it started again unplanned at ${times.join(", ")}` : ""}.`,
	crashAt: (when: string) => `Started again unplanned at ${when}`,
	sessionsStuck: (names: string, n: number, hours: number) => `${n} session${n === 1 ? " has" : "s have"} made no progress for over ${hours} hours: ${names}.`,
	sessionsError: (names: string, n: number, hours: number) => `${n} session${n === 1 ? "" : "s"} stopped on an error over ${hours} hours ago and still open: ${names}.`,
	loginLost: (name: string, hours: number) => `${name} has been logged out for ${hours} hours.`,
	watchFailing: (name: string, fails: number, since: string, last: string) => `The monitor '${name}' failed ${fails} times in a row${since ? ` since ${since}` : ""}.${last ? ` ${last}` : ""}`,
	firstFailed: (when: string) => `First failed: ${when}`,
	failedInRow: (n: number) => `Failed ${n} time${n === 1 ? "" : "s"} in a row`,
	lastReason: (reason: string) => `Last reason: ${reason}`,
	noOutput: (code: string) => `The last run ended with no output (exit code ${code}).`,
	exitCode: (code: string) => `The last run failed (exit code ${code}).`,
	watchFixed: (name: string) => `the monitor '${name}'`,
	disk: (freeGb: number, pct: number) => `${freeGb} GB (${pct}%) of disk left.`,
	diskLeft: (free: string, total: string) => `Free space ${free} / ${total} GB`,
	diskSubject: "Disk",
	diskQuestion: "Clean up old session records?",
	diskCleanName: "Clean up old session records",
	diskCleanResult: "Deletes session records past their keeping time (90 days by default) the same way the nightly cleanup does. Nothing is deleted before you pick this.",
	diskKeepName: "Leave it this time",
	diskKeepResult: "Looks again in a week.",
	updateFailed: (what: string, n: number, since: string, error: string) => `The ${what} update failed ${n} time${n === 1 ? "" : "s"} since ${since} and has not worked since.${error ? ` Last error: ${error}` : ""}`,
	failedTimes: (n: number) => `Failed ${n} time${n === 1 ? "" : "s"}`,
	lastError: (error: string) => `Last error: ${error}`,
	failuresGrew: (items: string[]) => `More failed or repeated work than at the last check: ${items.slice(0, 3).join("; ")}${items.length > 3 ? ` and ${items.length - 3} more` : ""}.`,
	failureShort: (label: string, grew: string) => `${label}: ${grew}`,
	failureGrowth: ({ byTokens, was, now }: FailureGrowth) =>
		!byTokens ? `${was.count} → ${now.count} cases (${EN.perThousand(was.share)} → ${EN.perThousand(now.share)} per 1,000 turns)`
		: now.count === 1 ? `one case of ${EN.mega(now.tokens)} tokens (${EN.share(now.share)} of all, was ${EN.share(was.share)})`
		: `${was.count} → ${now.count} cases${now.count - was.count === 1 && now.tokens > was.tokens ? ", the one added case is large" : ""}, ${EN.mega(was.tokens)} → ${EN.mega(now.tokens)} tokens (${EN.share(now.share)} of all, was ${EN.share(was.share)})`,
	failureBase: (days: number, total: number, byTokens: boolean) => `Out of ${byTokens ? `${EN.mega(total)} tokens` : `${total} turns`} in the last ${days} days`,
	failureTools: (top: string) => `Most often in: ${top}`,
	tokens: (items: string[]) => joinTokens(items, WARN_EN, kinds => `Sessions used many tokens yesterday: ${kinds}.`),
	tokenDay: (d: TokenDay, kinds: string[]) =>
		`Yesterday used ${EN.mega(d.tokens)} tokens, ${EN.dollars(d.cost)}${!d.usual ? "" : d.usual.days === 1 ? ` (the only day with use ${d.usual.from === d.usual.to ? "on" : "from"} ${range(d.usual, "en-US", " to ")}: ${EN.dollars(d.usual.cost)})` : ` (a usual day: ${EN.dollars(d.usual.cost)}, the median of the ${d.usual.days} days with use ${d.usual.from === d.usual.to ? "on" : "from"} ${range(d.usual, "en-US", " to ")})`}.${d.top.length ? ` Largest sessions: ${d.top.map(s => `${s.kind === "orchestrator" ? "main" : s.name} ${s.model} ${EN.dollars(s.cost)}${fullyChosen(s) ? " (a model you chose, not waste)" : s.chosen > 0 ? ` (${EN.dollars(s.chosen)} of it on a model you chose, not waste)` : ""}`.replace(/ +/g, " ")).join(", ")}.` : ""}${WARN_EN}${kinds.join(", ")}.`,
	tokenShort: (kind: string, n: number, cost = 0) => `${kind}: ${n} session${n === 1 ? "" : "s"}${cost ? ` ${EN.dollars(cost)}` : ""}`,
	dollars: EN.dollars,
	ownerExpensive: (n: number, cost: string) => `Expensive models you chose: ${n} session${n === 1 ? "" : "s"}, ${cost}. Not counted as waste.`,
	selfUpdate: "dotz",
	ruleKind: "Code already blocks it",
	ruleQuestion: "Delete it?",
	reviewKind: { conflict: "Conflicts with another line", outdated: "Outdated", "contradicts-code": "Unlike what the code does" } as Record<string, string>,
	reviewQuestion: "Change it?",
	texts: { mode: "Contract", rules: "Rules", lessons: "Lessons", feature: "Feature" },
	lineSubject: (name: string, quote: string) => `${name} '${quote}'`,
	pluginNotLoaded: (file: string) => `A plugin did not load and is off: ${file}.`,
};

export const doctorKo: typeof doctorEn = {
	head: (day: string) => `${DOCTOR_LEAD_KO} ${day}`,
	told: (n: number) => `알릴 것 ${n}`,
	decide: (n: number) => `정할 것 ${n}`,
	toldPart: "알릴 것",
	decidePart: "정할 것",
	again: (n: number) => ` (${n})`,
	clear: "모두 괜찮아요.",
	fixedLine: (items: string) => `스스로 고친 것: ${items}.`,
	still: (n: number) => `전에 알린 ${n}가지는 아직 그대로예요.`,
	healthy: (names: string[]) => `괜찮은 점검 ${names.length}가지: ${names.join(", ")}.`,
	since: (day: string) => `${day}부터 계속돼요.`,
	day: dayKo,
	when: (ms: number) => `${new Date(ms).toLocaleString("ko-KR", { timeZone: TZ, month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} ${tzLabel()}`,
	areas: { gateway: "게이트웨이", sessions: "세션", logins: "로그인", watches: "모니터링", disk: "디스크", update: "업데이트", failures: "실패·반복 작업", tokens: "토큰 사용", prompt: "다시 읽는 글", plugins: "플러그인" },
	todo: { sessions: "이어서 하게 하거나 닫아 주세요.", login: "그 사이트에 다시 로그인해 주세요.", disk: "안 쓰는 큰 파일을 지워 주세요." },
	look: DOCTOR_LOOK_KO,
	lookHint: `'${DOCTOR_LOOK_KO.slice(3)}'가 붙은 줄을 그대로 답장하면 그 원인을 찾아봐요.`,
	more: (n: number) => `외 ${n}번`,
	dryAt: (when: string) => `${when} 점검이에요. 시험 실행이라 아무것도 저장하거나 보내지 않았어요.`,
	dryMorning: "아침 알림에는 이 중 새로 알릴 것만 이렇게 올라가요.",
	drySame: "아침 알림에도 이대로 올라가요.",
	dryNone: (factor: number, days: number) => `아침에 새로 알릴 것은 없어요. 전에 알린 것은 ${factor}배로 커지거나 ${days}일이 지나야 다시 알려요.`,
	restarts: (r: RestartCount) =>
		`하루 사이에 게이트웨이가 ${r.all}번 다시 시작했어요: ${[r.update ? `업데이트 설치 ${r.update}번` : "", r.owner ? `직접 하신 재시작 ${r.owner}번` : "", r.orchestrator ? `웹에서 오케스트레이터를 다시 시작하실 때 함께 ${r.orchestrator}번` : "", `이유를 모르는 것 ${r.unexplained}번`].filter(Boolean).join(", ")}.`,
	restartLine: (when: string, why: string) => `${when} · ${why}`,
	restartUnasked: "누가 요청했는지 로그에 나와 있지 않아요",
	crashes: (n: number, times: string[] = []) => `지난 점검 뒤로 게이트웨이가 ${n}번 갑자기 꺼졌어요${times.length ? `. 예고 없이 다시 켜진 때: ${times.join(", ")}` : ""}.`,
	crashAt: (when: string) => `${when}에 예고 없이 다시 켜졌어요`,
	sessionsStuck: (names: string, n: number, hours: number) => `세션 ${n}개가 ${hours}시간 넘게 진전이 없어요: ${names}.`,
	sessionsError: (names: string, n: number, hours: number) => `오류로 멈춘 세션 ${n}개가 ${hours}시간 넘게 그대로예요: ${names}.`,
	loginLost: (name: string, hours: number) => `${name} 로그인이 ${hours}시간째 풀려 있어요.`,
	watchFailing: (name: string, fails: number, since: string, last: string) => `'${name}' 모니터링이 ${since ? `${since}부터 ` : ""}${fails}번 연속 실패했어요.${last ? ` ${last}` : ""}`,
	firstFailed: (when: string) => `처음 실패: ${when}`,
	failedInRow: (n: number) => `연속 실패 ${n}번`,
	lastReason: (reason: string) => `마지막 이유: ${reason}`,
	noOutput: (code: string) => `마지막 실행은 아무 출력 없이 끝났어요(종료 코드 ${code}).`,
	exitCode: (code: string) => `마지막 실행은 실패로 끝났어요(종료 코드 ${code}).`,
	watchFixed: (name: string) => `'${name}' 모니터링`,
	disk: (freeGb: number, pct: number) => `디스크 남은 공간이 ${freeGb}GB(${pct}%)예요.`,
	diskLeft: (free: string, total: string) => `남은 공간 ${free} / ${total} GB`,
	diskSubject: "디스크",
	diskQuestion: "오래된 세션 기록을 정리할까요?",
	diskCleanName: "오래된 세션 기록 정리",
	diskCleanResult: "보관 기간(기본 90일)이 지난 세션 기록을 야간 정리와 같은 방식으로 지워요. 고르기 전에는 아무것도 지우지 않아요.",
	diskKeepName: "이번엔 둬요",
	diskKeepResult: "일주일 뒤에 다시 볼게요.",
	updateFailed: (what: string, n: number, since: string, error: string) => `${what} 업데이트가 ${since}부터 ${n}번 실패했고 그 뒤로 성공하지 못했어요.${error ? ` 마지막 오류: ${error}` : ""}`,
	failedTimes: (n: number) => `실패 ${n}번`,
	lastError: (error: string) => `마지막 오류: ${error}`,
	failuresGrew: (items: string[]) => `실패하거나 되풀이한 작업이 어제 점검 때보다 늘었어요: ${items.slice(0, 3).join("; ")}${items.length > 3 ? ` 외 ${items.length - 3}가지` : ""}.`,
	failureShort: (label: string, grew: string) => `${label}: ${grew}`,
	failureGrowth: ({ byTokens, was, now }: FailureGrowth) =>
		!byTokens ? `${was.count}건 → ${now.count}건 (1천 턴당 ${KO.perThousand(was.share)} → ${KO.perThousand(now.share)})`
		: now.count === 1 ? `1건이 ${KO.mega(now.tokens)} 토큰 (전체의 ${KO.share(now.share)}, 전에는 ${KO.share(was.share)})`
		: `${was.count}건 → ${now.count}건${now.count - was.count === 1 && now.tokens > was.tokens ? ", 늘어난 1건이 큰 것" : ""}, ${KO.mega(was.tokens)} → ${KO.mega(now.tokens)} 토큰 (전체의 ${KO.share(now.share)}, 전에는 ${KO.share(was.share)})`,
	failureBase: (days: number, total: number, byTokens: boolean) => `기준: 최근 ${days}일 ${byTokens ? `전체 ${KO.mega(total)} 토큰` : `${total}턴`}`,
	failureTools: (top: string) => `자주 나온 도구: ${top}`,
	tokens: (items: string[]) => joinTokens(items, WARN_KO, kinds => `어제 토큰을 많이 쓴 세션이 있어요: ${kinds}.`),
	tokenDay: (d: TokenDay, kinds: string[]) =>
		`어제 ${KO.mega(d.tokens)} 토큰, ${KO.dollars(d.cost)}를 썼어요${!d.usual ? "" : d.usual.days === 1 ? ` (${range(d.usual, "ko-KR", "~")} 중 쓴 날은 하루뿐, 그날 ${KO.dollars(d.usual.cost)})` : ` (평소 하루 ${KO.dollars(d.usual.cost)}: ${range(d.usual, "ko-KR", "~")} 중 쓴 날 ${d.usual.days}일의 중앙값)`}.${d.top.length ? ` 큰 세션: ${d.top.map(s => `${s.kind === "orchestrator" ? "메인" : s.name} ${s.model} ${KO.dollars(s.cost)}${fullyChosen(s) ? "(직접 고른 모델이라 낭비 아님)" : s.chosen > 0 ? `(이 중 직접 고른 모델 ${KO.dollars(s.chosen)}, 낭비 아님)` : ""}`.replace(/ +/g, " ")).join(", ")}.` : ""}${WARN_KO}${kinds.join(", ")}.`,
	tokenShort: (kind: string, n: number, cost = 0) => `${kind} 세션 ${n}개${cost ? ` ${KO.dollars(cost)}` : ""}`,
	dollars: KO.dollars,
	ownerExpensive: (n: number, cost: string) => `직접 고른 비싼 모델: 세션 ${n}개, ${cost}. 요청하신 것이라 경고에서 뺐어요.`,
	selfUpdate: "dotz",
	ruleKind: "코드가 이미 막음",
	ruleQuestion: "지울까요?",
	reviewKind: { conflict: "서로 맞지 않음", outdated: "낡음", "contradicts-code": "코드와 어긋남" },
	reviewQuestion: "고칠까요?",
	texts: { mode: "계약", rules: "규칙", lessons: "교훈", feature: "기능" },
	lineSubject: (name: string, quote: string) => `${name} '${quote}' 줄`,
	pluginNotLoaded: (file: string) => `불러오지 못해서 꺼진 플러그인이 있어요: ${file}.`,
};
