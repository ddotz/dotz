// The zele mail watch (hub/zele.ts tick) against a fake zele: follow-up keys per message count, the silent first tick after
// the key upgrade, and which thread messages become mail (needs action) or only a log line (own message, acknowledgement).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { setZeleRunner, tick, type NewMail } from "./zele.ts";

const STATE = join(DATA_DIR, "zele-state.json");
const RULE = "─".repeat(60);
const thread = (...msgs: [string, string][]) => ["Subject: Schedule", ...msgs.flatMap(([from, body], i) => [RULE, `From: ${from}`, "  To: x@example.com", `Date: Oct ${20 + i}, 10:00 AM`, "", body])].join("\n");
const ME = "Me <me@example.com>";
const PARTNER = "Partner <partner@example.com>";
type ListItem = { id: string; from?: string; subject?: string; snippet?: string; messages?: number };

function fake(items: ListItem[], reads: Record<string, string | Error>) {
	const calls: string[][] = [];
	setZeleRunner(async args => {
		calls.push(args);
		if (args[0] === "whoami") return { code: 0, out: "me@example.com (google)\n", err: "" };
		if (args[0] === "mail" && args[1] === "list") return { code: 0, out: JSON.stringify({ items: items.map(m => ({ account: "me@example.com", from: PARTNER, to: "me@example.com", subject: "Schedule", snippet: "list snippet", ...m })) }), err: "" };
		if (args[0] === "mail" && args[1] === "read") {
			const r = reads[args[2]];
			return r instanceof Error || r === undefined ? { code: 1, out: "", err: String(r ?? "no thread") } : { code: 0, out: r, err: "" };
		}
		return { code: 0, out: "items: []\n", err: "" };
	});
	return calls;
}
const state = (s: Record<string, unknown>) => writeFileSync(STATE, JSON.stringify({ events: {}, soon: [], briefDate: new Date().toLocaleDateString("sv-SE"), ...s }));
const saved = () => JSON.parse(readFileSync(STATE, "utf8"));
async function run() {
	const posted: NewMail[] = [];
	await tick({ alert: () => {}, brief: () => {}, mail: async m => void posted.push(m) });
	return posted;
}

afterEach(() => setZeleRunner());

describe("zele mail watch", () => {
	test("first tick after the key upgrade: a seen multi-message thread is recorded silently, new threads still post", async () => {
		state({ seeded: true, mail: ["t1"] });
		const calls = fake([{ id: "t1", messages: 3 }, { id: "t3", messages: 2 }, { id: "t4" }], { t3: thread([PARTNER, "Hello"], [PARTNER, "Any update on the date?"]) });
		const posted = await run();
		expect(posted.map(m => [m.id, m.seq, m.needsReply])).toEqual([
			["t3", 2, true],
			["t4", undefined, true],
		]);
		expect(posted[0].snippet).toBe("아직 답장하지 않은 스레드에 새 메시지 · Any update on the date?");
		expect(posted[1].snippet).toBe("list snippet");
		expect(calls.some(a => a[1] === "read" && a[2] === "t1")).toBe(false);
		expect(calls.find(a => a[1] === "read")).toEqual(["mail", "read", "t3", "--account", "me@example.com"]);
		expect(saved()).toMatchObject({ mailVersion: 2, mail: ["t1", "t1.3", "t3.2", "t4"] });
	});

	test("after the upgrade: a new message after the owner's reply posts as answered; own-latest, acknowledgements and own mail do not", async () => {
		state({ seeded: true, mailVersion: 2, mail: ["t1", "t1.3"] });
		fake([{ id: "t1", messages: 4 }, { id: "t5", messages: 2 }, { id: "t6", messages: 3 }, { id: "t7", from: ME }], {
			t1: thread([PARTNER, "Can we meet?"], [ME, "Friday works."], [PARTNER, "Thanks"], [PARTNER, "Could we move it to 3pm?"]),
			t5: thread([PARTNER, "Question?"], [ME, "Answer."]),
			t6: thread([PARTNER, "Can you send it?"], [ME, "Sent."], [PARTNER, "잘 받았습니다. 감사합니다!\n\nOn Oct 21, Me <me@example.com> wrote:\n> 확인 부탁드립니다"]),
		});
		const posted = await run();
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({ id: "t1", seq: 4, needsReply: true, from: PARTNER, snippet: "답장한 스레드에 새 메시지 · Could we move it to 3pm?" });
		expect(saved().mail).toEqual(["t1", "t1.3", "t1.4", "t5.2", "t6.3", "t7"]);
		expect(await run()).toEqual([]);
	});

	test("a thread that cannot be read is not recorded, so the next poll tries again", async () => {
		state({ seeded: true, mailVersion: 2, mail: [] });
		fake([{ id: "t8", messages: 2 }], { t8: new Error("network") });
		expect(await run()).toEqual([]);
		expect(saved().mail).toEqual([]);
		fake([{ id: "t8", messages: 2 }], { t8: thread([PARTNER, "Hi"], [PARTNER, "Hello again"]) });
		expect((await run()).map(m => m.seq)).toEqual([2]);
	});

	test("a fresh install records what exists and posts nothing", async () => {
		state({ seeded: false, mail: [] });
		const calls = fake([{ id: "t9", messages: 5 }, { id: "t10" }], {});
		expect(await run()).toEqual([]);
		expect(calls.some(a => a[1] === "read")).toBe(false);
		expect(saved()).toMatchObject({ seeded: true, mailVersion: 2, mail: ["t9.5", "t10"] });
	});
});
