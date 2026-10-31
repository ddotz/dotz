// A thank-you after the owner's reply is not a new mail (hub/zele.ts parseThread / isAck / tick): the `zele mail read` parser on a synthetic
// thread, the quote-stripping acknowledgement check, and the watch skipping an ack but not a question.
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { resetOwnAddresses, setOwnAddresses } from "./mail-state.ts";
import { isAck, newText, onlyAcksAfterOwner, parseThread, tick, type NewMail } from "./zele.ts";

const RULE = "─".repeat(60);
const threadText = (...msgs: { from: string; body: string; unread?: boolean }[]) =>
	[
		"Subject: Project schedule",
		"Messages: " + msgs.length,
		...msgs.flatMap((m, i) => [RULE, `From: ${m.from}${m.unread ? " [unread]" : ""}`, "  To: Someone <someone@example.com>", `Date: Oct ${20 + i}, 10:00 AM`, "Auth: pass", "", m.body]),
	].join("\n");

describe("parseThread", () => {
	test("one message per block after the header: sender, unread flag stripped, date and body", () => {
		const msgs = parseThread(threadText({ from: "Kim Partner <partner@example.com>", body: "Hello,\n\nCould we meet on Friday?" }, { from: "partner@example.com", body: "Thanks!", unread: true }));
		expect(msgs).toEqual([
			{ from: "Kim Partner <partner@example.com>", date: "Oct 20, 10:00 AM", body: "Hello,\n\nCould we meet on Friday?" },
			{ from: "partner@example.com", date: "Oct 21, 10:00 AM", body: "Thanks!" },
		]);
	});
	test("a block without a From: line is not a message; CRLF is fine", () => {
		expect(parseThread(`Subject: x\r\n${RULE}\r\nnothing here`)).toEqual([]);
		expect(parseThread(threadText({ from: "A <a@example.com>", body: "hi" }).replace(/\n/g, "\r\n"))[0].body).toBe("hi");
	});
});

describe("acknowledgement", () => {
	test("quoted text and signature are not new text", () => {
		expect(newText("Thanks, got it.\n\nOn Oct 20, 2026, Me <me@example.com> wrote:\n> Can you send the file?")).toBe("Thanks, got it.");
		expect(newText("잘 받았습니다.\n> 확인 부탁드립니다\n-- \nKim")).toBe("잘 받았습니다.");
	});
	test("a short thank-you is an ack even when the quote asks something", () => {
		expect(isAck("감사합니다!")).toBe(true);
		expect(isAck("Received, thanks.\n\nOn Oct 20, 2026, Me <me@example.com> wrote:\n> Could you confirm?")).toBe(true);
	});
	test("a question, a request word, no thanks word, a long note or an empty note is not an ack", () => {
		for (const body of ["Thanks. When is the next meeting?", "감사합니다. 자료 공유도 가능할까요", "확인 부탁드립니다", "Thanks, please also check the draft.", "Thanks.\nline\nline\nline\nline", `Thanks ${"a".repeat(400)}`, "", "See the attached file.", "내일 3시에 뵙겠습니다"]) {
			expect(isAck(body)).toBe(false);
		}
	});
	test("only after the owner's reply, and only when everything since is an ack", () => {
		const own = new Set(["me@example.com"]);
		const m = (from: string, body: string) => ({ from, date: "", body });
		const partner = "Kim <partner@example.com>";
		const me = "Me <Me+work@example.com>";
		expect(onlyAcksAfterOwner([m(partner, "Can you?"), m(me, "Yes."), m(partner, "감사합니다")], own)).toBe(true);
		expect(onlyAcksAfterOwner([m(partner, "Can you?"), m(me, "Yes."), m(partner, "Thanks"), m(partner, "Can I join?")], own)).toBe(false);
		expect(onlyAcksAfterOwner([m(partner, "Thanks"), m(partner, "Thanks again")], own)).toBe(false);
		expect(onlyAcksAfterOwner([m(partner, "Can you?"), m(me, "Yes.")], own)).toBe(false);
	});
});

describe("the watch", () => {
	beforeEach(() => {
		rmSync(join(DATA_DIR, "zele-state.json"), { force: true });
		setOwnAddresses("zele", ["me@example.com"]);
	});
	const row = (from: string, n: number) => ({ id: "thr-ack-1", from, subject: "일정", messages: n, date: `10월 ${20 + n}일, 오전 10:00`, flags: "unread", snippet: "x" });
	async function run(reads: Record<number, string>, states: [string, number][]) {
		const posted: string[] = [];
		const reading: string[] = [];
		for (const [from, n] of states) {
			const list = async (args: string[]) => (args[0] === "cal" ? [] : args.includes("sent") ? [] : [row(from, n)]);
			const read = async (id: string) => (reading.push(id), reads[n] ?? Promise.reject(new Error("no such thread")));
			await tick({ alert: () => {}, brief: () => {}, mail: async m => void posted.push(`${m.id}#${n}` as NewMail["id"]) }, new Date(), list, read);
		}
		return { posted, reading };
	}
	const ME = "Me <me@example.com>";
	const KIM = "Kim <kim@example.com>";
	const convo = (...last: string[]) => threadText({ from: KIM, body: "Can you?" }, { from: ME, body: "Yes." }, ...last.map(body => ({ from: KIM, body })));

	test("a new mail carries its 참조 (cc) list from the watch's list output", async () => {
		const got: NewMail[] = [];
		const list = (n: number) => async (args: string[]) => (args[0] === "cal" ? [] : args.includes("sent") ? [] : [{ id: "thr-cc-1", from: KIM, subject: "일정", messages: n, date: "10월 21일, 오전 10:00", flags: "unread", snippet: "x", to: ME, cc: "Lee <lee@example.com>" }]);
		// first run only records what exists; the second one sees a newer message and posts it
		await tick({ alert: () => {}, brief: () => {}, mail: async m => void got.push(m) }, new Date(), list(1), async () => "");
		await tick({ alert: () => {}, brief: () => {}, mail: async m => void got.push(m) }, new Date(), list(2), async () => "");
		expect(got.map(m => [m.id, m.to, m.cc])).toEqual([["thr-cc-1", ME, "Lee <lee@example.com>"]]);
	});

	test("a thread whose age moves on (5h ago -> 6h ago) is no new mail, a newer message still is", async () => {
		const posted: string[] = [];
		const list = (n: number, date: string) => async (args: string[]) => (args[0] === "cal" ? [] : args.includes("sent") ? [] : [{ ...row(KIM, n), date }]);
		const hooks = { alert: () => {}, brief: () => {}, mail: async (m: NewMail) => void posted.push(m.message) };
		await tick(hooks, new Date(), list(1, "4h ago"), async () => "");
		await tick(hooks, new Date(), list(2, "just now"), async () => "");
		await tick(hooks, new Date(), list(2, "5m ago"), async () => "");
		await tick(hooks, new Date(), list(2, "1h ago"), async () => "");
		await tick(hooks, new Date(), list(2, "2시간 전"), async () => "");
		await tick(hooks, new Date(), list(3, "just now"), async () => "");
		expect(posted).toEqual(["2|", "3|"]);
	});

	test("a stamp noted with an age before this fix matches the same thread without one", async () => {
		const posted: string[] = [];
		const list = (n: number, date: string) => async (args: string[]) => (args[0] === "cal" ? [] : args.includes("sent") ? [] : [{ ...row(KIM, n), date }]);
		const hooks = { alert: () => {}, brief: () => {}, mail: async (m: NewMail) => void posted.push(m.message) };
		await tick(hooks, new Date(), list(1, "10월 21일, 오전 10:00"), async () => "");
		const file = join(DATA_DIR, "zele-state.json");
		const s = JSON.parse(readFileSync(file, "utf8"));
		s.threads["thr-ack-1"].n = "1|6h ago";
		writeFileSync(file, JSON.stringify(s));
		await tick(hooks, new Date(), list(1, "7h ago"), async () => "");
		expect(posted).toEqual([]);
	});

	test("a thank-you after the owner's reply is not posted, a later question is", async () => {
		const { posted } = await run({ 3: convo("감사합니다"), 4: convo("감사합니다", "내일 몇 시에 볼까요?") }, [[KIM, 0], [KIM, 1], [ME, 2], [KIM, 3], [KIM, 4]]);
		expect(posted).toEqual(["thr-ack-1#1", "thr-ack-1#4"]);
	});

	test("an IMAP/SMTP account's calendar refusal is an empty calendar: mail is still seeded and posted", async () => {
		const posted: string[] = [];
		const list = (n: number) => async (args: string[]) => {
			if (args[0] === "cal") throw new Error(`zele ${args.join(" ")}: error: Calendar is not available for IMAP/SMTP accounts. Calendar requires a Google account.`);
			return args.includes("sent") ? [] : [row(KIM, n)];
		};
		const hooks = { alert: () => {}, brief: () => {}, mail: async (m: NewMail) => void posted.push(m.message) };
		await tick(hooks, new Date(), list(1), async () => "");
		await tick(hooks, new Date(), list(2), async () => "");
		expect(posted).toEqual([`2|${row(KIM, 2).date}`]);
	});

	test("another calendar error still fails the tick", async () => {
		const list = async (args: string[]) => {
			if (args[0] === "cal") throw new Error("zele cal events: network down");
			return [];
		};
		await expect(tick({ alert: () => {}, brief: () => {}, mail: async () => {} }, new Date(), list, async () => "")).rejects.toThrow("network down");
	});

	test("a thread that cannot be read is posted: a failure only makes the watch louder", async () => {
		const { posted, reading } = await run({}, [[KIM, 0], [KIM, 1], [ME, 2], [KIM, 3]]);
		expect(reading).toEqual(["thr-ack-1"]);
		expect(posted).toEqual(["thr-ack-1#1", "thr-ack-1#3"]);
	});
});
