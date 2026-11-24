import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { setOwnAddresses } from "./mail-state.ts";
import { tick } from "./zele.ts";

const A = "a@example.com";
const B = "b@example.com";
const STATE = join(DATA_DIR, "zele-state.json");
const NOON = new Date(2026, 0, 15, 12, 0, 0);
const NEXT_DAY = new Date(2026, 0, 16, 0, 5, 0);
type Row = Record<string, string>;
const lunch: Row = { id: "ev1", summary: "점심", start: "1월 20일, 오전 11:00", end: "오후 12:00", calendar: "team@group.calendar.google.com", account: B };

let getResult: (argv: string[]) => { code: number; stdout?: string; stderr?: string } = () => ({ code: 0, stdout: "id: ev1\n" });
const gets: string[] = [];
let restoreSpawn = () => {};
beforeAll(() => {
	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		const argv = cmd.slice(1);
		if (argv[0] === "cal" && argv[1] === "get") gets.push(argv.join(" "));
		const r = argv[1] === "get" ? getResult(argv) : { code: 0, stdout: "items: []" };
		return { pid: 0, stdout: new Response(r.stdout ?? "").body, stderr: new Response(r.stderr ?? "").body, exited: Promise.resolve(r.code), kill() {} };
	}) as unknown as typeof Bun.spawn);
	restoreSpawn = () => spawn.mockRestore();
});
afterAll(() => restoreSpawn());
beforeEach(() => {
	rmSync(STATE, { force: true });
	setOwnAddresses("zele", [A, B]);
	gets.length = 0;
	getResult = () => ({ code: 0, stdout: "id: ev1\n" });
});

const calendarOf = (main: Row[], edge: Row[] = []) => async (args: string[]) => {
	if (args[0] !== "cal") return [];
	if (args.includes("--days")) return main;
	if (args.includes("+45m")) return [];
	return edge;
};
const run = async (alerts: string[], rows: Row[], now = NOON, edge: Row[] = []) =>
	tick({ alert: t => void alerts.push(t), brief: () => {}, mail: async () => {} }, now, calendarOf(rows, edge), async () => "", [A, B], [A, B]);
const zeleLookup = (argv: string[]) => {
	const accounts = argv.filter((_, i) => argv[i - 1] === "--account");
	if (accounts.length > 1) return { code: 1, stderr: `Error: Multiple accounts matched. Specify --account:\n  ${accounts.join("\n  ")}` };
	const calendar = argv[argv.indexOf("--calendar") + 1];
	if (accounts[0] !== B || !argv.includes("--calendar") || calendar !== lunch.calendar) return { code: 1, stderr: `Error: event "${argv[2]}" not found` };
	return { code: 0, stdout: "id: ev1\nsummary: 점심\n" };
};

test("an unchanged event that one poll's list missed is neither cancelled nor announced as new when it comes back", async () => {
	getResult = zeleLookup;
	const alerts: string[] = [];
	await run(alerts, [lunch]);
	await run(alerts, []);
	await run(alerts, [lunch]);
	await run(alerts, [lunch]);
	expect(alerts).toEqual([]);
});

test("a vanished event is looked up in its own calendar and account", async () => {
	getResult = zeleLookup;
	const alerts: string[] = [];
	await run(alerts, [lunch]);
	await run(alerts, []);
	expect(gets).toEqual([`cal get ev1 --account ${B} --calendar ${lunch.calendar}`]);
	expect(alerts).toEqual([]);
});

test("a lookup that fails for another reason than a missing event is not a cancellation", async () => {
	getResult = () => ({ code: 124, stderr: "" });
	const alerts: string[] = [];
	await run(alerts, [lunch]);
	await run(alerts, []);
	await run(alerts, [lunch]);
	expect(alerts).toEqual([]);
});

test("an event zele no longer finds is announced as cancelled once", async () => {
	getResult = argv => ({ code: 1, stderr: `Error: event "${argv[2]}" not found` });
	const alerts: string[] = [];
	await run(alerts, [lunch]);
	await run(alerts, []);
	await run(alerts, []);
	expect(alerts).toEqual(["일정 취소: 1/20 11:00 ~ 12:00 · 점심"]);
});

test("a cancelled event is announced even when it shows as cancelled in zele", async () => {
	getResult = () => ({ code: 0, stdout: "id: ev1\nstatus: cancelled\n" });
	const alerts: string[] = [];
	await run(alerts, [lunch]);
	await run(alerts, []);
	expect(alerts).toEqual(["일정 취소: 1/20 11:00 ~ 12:00 · 점심"]);
});

test("when the day turns, events that only entered the 14-day window are not new, an event added that day is", async () => {
	const alerts: string[] = [];
	const entered: Row = { id: "ev2", summary: "치과", start: "1월 29일, 오후 3:00", end: "오후 4:00", calendar: A, account: A };
	const added: Row = { id: "ev3", summary: "저녁", start: "1월 22일, 오후 7:00", end: "오후 9:00", calendar: A, account: A };
	await run(alerts, [lunch]);
	await run(alerts, [lunch, added, entered], NEXT_DAY, [entered]);
	expect(alerts).toEqual(["새 일정: 1/22 19:00 ~ 21:00 · 저녁"]);
});

test("a repeating event listed once per occurrence under one id is not reported as changed while the occurrences shift", async () => {
	const alerts: string[] = [];
	const occurrence = (start: string): Row => ({ id: "weekly", summary: "주간 회의", start, end: "오전 11:00", calendar: A, account: A });
	await run(alerts, [occurrence("2025년 3월 3일, 오전 10:00"), occurrence("1월 19일, 오전 10:00")]);
	await run(alerts, [occurrence("2025년 3월 3일, 오전 10:00"), occurrence("1월 26일, 오전 10:00")]);
	expect(alerts).toEqual([]);
});
