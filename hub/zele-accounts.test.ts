// `zele.accounts` (hub/zele.ts): which of the logged-in zele accounts dotz watches. No list = every account, a list = only those, for every call the watch makes.
// The CLI is replaced two ways: the injected `list` of tick() records the argv of the watch's own calls, and a spy on Bun.spawn records the calls
// that go straight to the binary (the event check, a thread read, a mail search). No zele process starts, no network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zeleMailSearch } from "./comments/mail-match.ts";
import { cfg, DATA_DIR } from "./config.ts";
import { ownAddresses, resetOwnAddresses, setOwnAddresses } from "./mail-state.ts";
import * as zele from "./zele.ts";
import type { NewMail } from "./zele.ts";

const { tick, zeleRead } = zele;

const A = "a@example.com";
const B = "b@example.com";
const STATE = join(DATA_DIR, "zele-state.json");
const NOON = new Date(2026, 0, 15, 12, 0, 0);
const hooks = (over: Record<string, unknown> = {}) => ({ alert: () => {}, brief: () => {}, mail: async () => {}, ...over });
const setWanted = (accounts?: unknown) => void (cfg.zele = accounts === undefined ? {} : ({ accounts } as never));

beforeEach(() => {
	rmSync(STATE, { force: true });
	setOwnAddresses("zele", [A, B]);
});
afterEach(() => {
	setWanted();
	resetOwnAddresses();
});

describe("which accounts are watched", () => {
	test("no list watches everything: nothing is passed, nothing is missing", () => {
		expect(zele.resolveWatch([A, B], [])).toEqual({ watch: [], missing: [], none: false });
	});
	test("a listed address matches the whole address, whatever its case, and keeps the CLI's own spelling", () => {
		expect(zele.resolveWatch(["A@Example.com", B], ["a@EXAMPLE.com"])).toEqual({ watch: ["A@Example.com"], missing: [], none: false });
		expect(zele.resolveWatch([A, B], ["a@example.co"])).toEqual({ watch: [], missing: ["a@example.co"], none: true });
	});
	test("a listed address the CLI is not logged into is reported and otherwise ignored", () => {
		expect(zele.resolveWatch([A, B], [A, "gone@example.com"])).toEqual({ watch: [A], missing: ["gone@example.com"], none: false });
	});
	test("no listed address logged in is 'none', never all accounts", () => {
		expect(zele.resolveWatch([A, B], ["gone@example.com"])).toEqual({ watch: [], missing: ["gone@example.com"], none: true });
	});
});

describe("the argv of the watch's calls", () => {
	const calls = async (only?: string[], setup?: () => void) => {
		setup?.();
		const argv: string[][] = [];
		const list = async (args: string[]) => (argv.push(args), [] as Record<string, string>[]);
		await tick(hooks(), NOON, list, async () => "", ...(only ? [only] : []));
		return argv;
	};
	const BASE = [
		["mail", "list", "--filter", "newer_than:2d", "--limit", "60"],
		["mail", "list", "--folder", "sent", "--filter", "newer_than:2d", "--limit", "40"],
		["cal", "events", "--days", "14", "--all", "--limit", "100"],
		["cal", "events", "--from", NOON.toISOString(), "--to", "+45m", "--all"],
	];
	test("without a list the calls are exactly as before", async () => {
		expect(await calls([])).toEqual(BASE);
		expect(await calls()).toEqual(BASE);
	});
	test("with a list every list call (inbox, sent folder, events, soon) carries --account for it", async () => {
		expect(await calls([A])).toEqual(BASE.map(a => [...a, "--account", A]));
	});
	test("several listed accounts repeat the flag", async () => {
		expect(await calls([A, B])).toEqual(BASE.map(a => [...a, "--account", A, "--account", B]));
	});
	test("a tick that is not told uses the configured list", async () => {
		expect(await calls(undefined, () => setWanted([A]))).toEqual(BASE.map(a => [...a, "--account", A]));
	});
});

describe("what the watch does with a filtered list", () => {
	const row = (from: string, n: number, over: Record<string, unknown> = {}) => ({ id: "thr-1", from, subject: "일정", messages: n, date: `10월 ${20 + n}일, 오전 10:00`, flags: "unread", snippet: "x", ...over });
	const feed = (n: number, over: Record<string, unknown> = {}, from = "Kim <kim@example.com>") => async (args: string[]) => (args[0] === "cal" || args.includes("sent") ? [] : [row(from, n, over)]);

	test("with one listed account a mail the CLI lists without its account is posted with it", async () => {
		const got: NewMail[] = [];
		const h = hooks({ mail: async (m: NewMail) => void got.push(m) });
		await tick(h, NOON, feed(1), async () => "", [A]);
		await tick(h, NOON, feed(2), async () => "", [A]);
		expect(got.map(m => m.account)).toEqual([A]);
	});
	test("a mail that names its own account keeps it", async () => {
		const got: NewMail[] = [];
		const h = hooks({ mail: async (m: NewMail) => void got.push(m) });
		await tick(h, NOON, feed(1, { account: B }), async () => "", [A, B]);
		await tick(h, NOON, feed(2, { account: B }), async () => "", [A, B]);
		expect(got.map(m => m.account)).toEqual([B]);
	});
	test("an unwatched account stays the owner's own address: its message is his own, not a new mail", async () => {
		const mails: string[] = [];
		const sent: string[] = [];
		const h = hooks({ mail: async (m: NewMail) => void mails.push(m.id), sent: async (m: NewMail) => void sent.push(m.id) });
		await tick(h, NOON, feed(1, {}, `Me <${B}>`), async () => "", [A]);
		expect([mails, sent]).toEqual([[], ["thr-1"]]);
		expect(ownAddresses().has(B)).toBe(true);
	});
	test("the morning brief names the watched accounts in the commands it hands over", async () => {
		const briefs: string[] = [];
		const h = hooks({ brief: (t: string) => void briefs.push(t) });
		const none = async () => [] as Record<string, string>[];
		await tick(h, NOON, none, async () => "", [A, B]); // first run only seeds
		await tick(h, NOON, none, async () => "", [A, B]);
		expect(briefs).toHaveLength(1);
		expect(briefs[0]).toContain(`zele cal events --today --all --account ${A} --account ${B}`);
		expect(briefs[0]).toContain(`--filter "is:unread newer_than:1d" --account ${A} --account ${B}`);
		rmSync(STATE, { force: true });
		briefs.length = 0;
		await tick(h, NOON, none, async () => "", []);
		await tick(h, NOON, none, async () => "", []);
		expect(briefs[0]).not.toContain("--account");
	});
});

describe("calls that go straight to the binary", () => {
	const argv: string[] = [];
	let spawn: ReturnType<typeof spyOn>;
	beforeAll(() => {
		spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			argv.push(cmd.slice(1).join(" "));
			const gone = cmd[1] === "cal" && cmd[2] === "get";
			return { pid: 0, stdout: new Response(gone ? "" : "items: []").body, stderr: new Response("").body, exited: Promise.resolve(gone ? 1 : 0), kill() {} };
		}) as unknown as typeof Bun.spawn);
	});
	afterAll(() => spawn.mockRestore());
	beforeEach(() => void (argv.length = 0));
	const logged = () => [...argv];

	const event = { summary: "Lunch", start: "10월 21일, 오전 11:00", end: "" };
	const stored = (watch?: string) => writeFileSync(STATE, JSON.stringify({ seeded: true, mail: [], threads: {}, events: { ev1: event }, soon: [], briefDate: "", ...(watch === undefined ? {} : { watch }) }));
	const vanish = async (only: string[]) => {
		stored(only.length ? only.join(",") : undefined);
		await tick(hooks(), NOON, undefined, undefined, only);
		return logged().filter(l => l.startsWith("cal get"));
	};
	test("a state recorded for other accounts starts over: its events are not checked or reported as cancelled, and the listed mail is not posted", async () => {
		const alerts: string[] = [];
		const mails: string[] = [];
		const h = hooks({ alert: (t: string) => void alerts.push(t), mail: async (m: NewMail) => void mails.push(m.id) });
		const inbox = (id: string) => async (args: string[]) => (args[0] === "cal" || args.includes("sent") ? [] : [{ id, from: "Kim <kim@example.com>", subject: "s", messages: 1, date: "10월 21일, 오전 10:00", flags: "unread", snippet: "x" }]);
		stored(); // recorded while every account was watched
		await tick(h, NOON, inbox("old"), async () => "", [A]);
		expect([alerts, mails, logged().filter(l => l.startsWith("cal get"))]).toEqual([[], [], []]);
		await tick(h, NOON, inbox("new"), async () => "", [A]);
		expect(mails).toEqual(["new"]);
		stored(A); // the same list, another case and order of spelling: not a change
		await tick(h, NOON, async () => [], async () => "", ["A@Example.com"]);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatch(/^일정 취소: .*Lunch$/);
	});
	test("the check whether a vanished event is cancelled stays inside the watched accounts", async () => {
		expect(await vanish([A])).toEqual([`cal get ev1 --account ${A}`]);
	});
	test("without a list the event check is as before", async () => {
		expect(await vanish([])).toEqual(["cal get ev1"]);
	});

	test("a thread read names its record's account, else the watched ones, else nothing", async () => {
		await zeleRead("t1", B);
		setWanted([A]);
		await zeleRead("t2", "");
		setWanted();
		await zeleRead("t3", "");
		expect(logged()).toEqual([`mail read t1 --account ${B}`, `mail read t2 --account ${A}`, "mail read t3"]);
	});
	test("a mail search with no account of its own stays inside the watched accounts (reply history, comment match)", async () => {
		const search = zeleMailSearch(async () => []);
		await search.search("from:kim@example.com");
		await search.search("from:kim@example.com", B);
		setWanted([A]);
		await search.search("from:kim@example.com");
		await search.read("t1");
		expect(logged()).toEqual([
			"mail search from:kim@example.com --limit 50",
			`mail search from:kim@example.com --limit 50 --account ${B}`,
			`mail search from:kim@example.com --limit 50 --account ${A}`,
			`mail read t1 --account ${A}`,
		]);
	});
});
