// Example account script for ~/.dotz/accounts/rules.json "script" (docs/accounts.md): the work account on weekdays
// 09:00-18:00 KST, the personal one otherwise, and off any account with less than MIN_5H_LEFT % of its 5-hour window.
// Copy it to ~/.dotz/accounts/, set the names below to your aliases (or slot ids) and point rules.json at it.
// Dry run: echo '<input json>' | bun docs/account-examples/work-hours.ts
const WORK = "회사 계정";
const PERSONAL = "개인 계정";
const MIN_5H_LEFT = 10;
const WORK_DAYS = [1, 2, 3, 4, 5];
const WORK_FROM = 9 * 60;
const WORK_TO = 18 * 60;

export type Account = { name: string; alias: string | null; blocked: string | null; five_hour_left: number | null };
export type Input = { now: string; current: string | null; accounts: Account[] };

const KST_OFFSET_MS = 9 * 3600_000;
const matches = (a: Account, wanted: string) => a.name === wanted || a.alias === wanted;
const usable = (a: Account) => !a.blocked && (a.five_hour_left === null || a.five_hour_left >= MIN_5H_LEFT);
const shown = (a: Account) => a.alias ?? a.name;

// The account to use (its name) and a short reason, or undefined for no opinion.
export function choose(input: Input): { account: string; reason: string } | undefined {
	const kst = new Date(Date.parse(input.now) + KST_OFFSET_MS);
	const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
	const workTime = WORK_DAYS.includes(kst.getUTCDay()) && minutes >= WORK_FROM && minutes < WORK_TO;
	const wanted = input.accounts.find(a => matches(a, workTime ? WORK : PERSONAL));
	if (wanted && usable(wanted)) return { account: wanted.name, reason: workTime ? "근무 시간이라 회사 계정을 써요" : "근무 시간이 아니라 개인 계정을 써요" };
	const other = input.accounts.find(a => a !== wanted && usable(a));
	if (!other) return undefined;
	return { account: other.name, reason: `${wanted ? shown(wanted) : workTime ? WORK : PERSONAL}을 쓸 수 없어서 ${shown(other)}으로 옮겨요` };
}

if (import.meta.main) {
	const pick = choose(JSON.parse(await Bun.stdin.text()) as Input);
	if (pick) console.log(`${pick.account}\n${pick.reason}`);
}
