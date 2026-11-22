import { beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { resetOwnAddresses, setOwnAddresses } from "./mail-state.ts";
import { flush } from "./runtime/test-clock.ts";
import { tick, type NewMail } from "./zele.ts";

const ME = "Me <me@example.com>";
const KIM = "Kim <kim@example.com>";
const THREE_MESSAGES = ["Subject: s", "Messages: 3", `${"─".repeat(60)}`, `From: ${KIM}`, "Date: Oct 20, 10:00 AM", "", "Can you?", "─".repeat(60), `From: ${ME}`, "Date: Oct 21, 10:00 AM", "", "Yes.", "─".repeat(60), `From: ${KIM}`, "Date: Oct 22, 10:00 AM", "", "내일 몇 시에 볼까요?"].join("\n");

beforeEach(() => {
	rmSync(join(DATA_DIR, "zele-state.json"), { force: true });
	resetOwnAddresses();
	setOwnAddresses("zele", ["me@example.com"]);
});

const overlap = () => {
	const flying = new Map<string, number>(), most = new Map<string, number>();
	return {
		most,
		async run<T>(kind: string, done: () => T): Promise<T> {
			const n = (flying.get(kind) ?? 0) + 1;
			flying.set(kind, n);
			most.set(kind, Math.max(most.get(kind) ?? 0, n));
			await flush(1);
			flying.set(kind, flying.get(kind)! - 1);
			return done();
		},
	};
};

test("the inbox and sent lists, the two calendar lists and the thread reads each overlap, and the mail is posted in the listed order", async () => {
	const ids = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
	const rows = (from: string, messages: number) => ids.map(id => ({ id, from, subject: `제목 ${id}`, messages, date: `10월 ${20 + messages}일, 오전 10:00`, flags: "unread", snippet: "x" }));
	const posted: string[] = [];
	const hooks = { alert: () => {}, brief: () => {}, mail: async (m: NewMail) => void posted.push(m.id) };
	const seed = async (args: string[]) => (args[0] === "cal" || args.includes("sent") ? [] : rows(ME, 1));
	await tick(hooks, new Date(), seed, async () => "");

	const t = overlap();
	const list = (args: string[]) => t.run(args[0] === "cal" ? "calendar" : "mail", () => (args[0] === "cal" || args.includes("sent") ? [] : rows(KIM, 2)));
	const reading: string[] = [];
	const read = (id: string) => t.run("read", () => (reading.push(id), THREE_MESSAGES));
	await tick(hooks, new Date(), list, read);

	expect(t.most.get("mail")).toBe(2);
	expect(t.most.get("calendar")).toBe(2);
	expect(t.most.get("read")).toBeGreaterThan(1);
	expect(t.most.get("read")).toBeLessThanOrEqual(3);
	expect(reading.toSorted()).toEqual(ids);
	expect(posted).toEqual(ids);
});
