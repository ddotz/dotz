// Synthetic session lines only: every name, id and sentence below is made up.
import { describe, expect, test } from "bun:test";
import { capText, extractPairs, type Pair, type RawLine, type RecallCtx } from "./recall-extract.ts";

type Entry = Record<string, unknown>;
let seq = 0;
const stamp = () => `2026-10-0${1 + (seq % 8)}T0${seq % 10}:00:00.000Z`;
const msg = (role: string, content: unknown): Entry => ({ type: "message", id: `e${++seq}`, timestamp: stamp(), message: { role, content } });
const user = (text: string) => msg("user", [{ type: "text", text }]);
const said = (text: string) => msg("assistant", [{ type: "text", text }]);
const call = (name: string, args: Record<string, unknown>) => msg("assistant", [{ type: "toolCall", id: "c", name, arguments: args }]);
const monitor = (json: Record<string, unknown>): Entry => ({ type: "custom_message", id: `e${++seq}`, timestamp: stamp(), customType: "senpi-monitor:notification", content: `<system-reminder>Monitor event(discord inbox): ${JSON.stringify(json)}</system-reminder>` });

const lines = (entries: Entry[]): RawLine[] => {
	let offset = 0;
	return entries.map((e, i) => {
		const text = JSON.stringify(e);
		const raw = { text, line: i + 2, offset };
		offset += text.length + 1;
		return raw;
	});
};
const ctx = (cwd: string, file = "/data/s.jsonl"): RecallCtx => ({ file, cwd, session: "sess", title: "", convKey: "alert", afterBrief: false, ownerCap: 2000, answerCap: 3000 });
const pairs = (entries: Entry[], cwd: string, file?: string): Pair[] => [...extractPairs(lines(entries), ctx(cwd, file))];

const CONV = "/home/x/.dotz";
const inbox = (body: string, id = "ab12cd34", room = "web") => user(`[dotz inbox] ${room} msg=${id} from tester\n${body}`);

describe("gateway conversation era", () => {
	test("unwraps the inbox line, keeps file names, drops trailers and progress notes", () => {
		const out = pairs([
			inbox("pizza order for friday\n[attachment] menu.png (image/png) /tmp/menu.png\n(오너에게는 한국어로 답하세요.)\n(작업 채널 목록, secret)"),
			call("dotz_send", { target: "web", text: "progress note", update_key: "k" }),
			call("dotz_send", { target: "web", text: "ordered two pizzas" }),
			said("final words of the turn"),
		], CONV);
		expect(out).toHaveLength(1);
		expect(out[0]?.owner).toBe("pizza order for friday\n첨부: menu.png");
		expect(out[0]?.answer).toContain("ordered two pizzas");
		expect(out[0]?.answer).toContain("final words of the turn");
		expect(out[0]?.answer).not.toContain("progress note");
		expect(out[0]).toMatchObject({ kind: "owner", room: "web", msgIds: ["ab12cd34"], project: "alert", line: 2 });
	});

	test("channel messages carry the channel name as room", () => {
		const out = pairs([inbox("hello", "11223344", "ch:123456 #ops"), said("hi")], CONV);
		expect(out[0]?.room).toBe("#ops");
	});

	test("machine noise opens no pair", () => {
		const out = pairs([
			user("[keepalive] ping"),
			user("[handover] earlier\nIN: [dotz inbox] web msg=00000001 from tester\nold words"),
			user("[dotz inbox] 세션 보고 lane done"),
			user("[dotz inbox] watch tick"),
			user("[dotz gateway] you are the orchestrator, no owner text here"),
			user("[자동 재개] resume"),
			user("<environment_context>cwd</environment_context>"),
			said("reply to nothing"),
		], CONV);
		expect(out).toEqual([]);
	});

	test("an inbox block embedded after a gateway notice is kept", () => {
		const out = pairs([user("[dotz gateway] while you worked\n\n[dotz inbox] web msg=0a0b0c0d from tester\nthe real question"), said("the real answer")], CONV);
		expect(out.map(p => p.owner)).toEqual(["the real question"]);
	});

	test("owner messages with no answer between them merge into one doc at the first position", () => {
		const out = pairs([inbox("first part", "00000001"), inbox("second part", "00000002"), said("one answer for both")], CONV);
		expect(out).toHaveLength(1);
		expect(out[0]?.owner).toBe("first part\n\nsecond part");
		expect(out[0]?.msgIds).toEqual(["00000001", "00000002"]);
		expect(out[0]?.line).toBe(2);
	});

	test("a trivial reply does not close the pair", () => {
		const out = pairs([inbox("question one", "00000001"), said("ok"), inbox("question two", "00000002"), said("a real answer")], CONV);
		expect(out).toHaveLength(1);
		expect(out[0]?.owner).toContain("question two");
	});

	test("the last pair is reported open so ingest can re-read it", () => {
		const out = pairs([inbox("done one", "00000001"), said("answer one"), inbox("still running", "00000002")], CONV);
		expect(out.map(p => p.open)).toEqual([false, true]);
	});

	test("tool results are skipped without being parsed", () => {
		const bad: RawLine = { text: '{"type":"message","message":{"role":"toolResult","content":"[dotz inbox] web msg=ffffffff from x\nsecret"', line: 3, offset: 0 };
		const out = [...extractPairs([...lines([inbox("real")]), bad], ctx(CONV))];
		expect(out.map(p => p.owner)).toEqual(["real"]);
	});
});

describe("lane era", () => {
	const LANE = "/home/x/.dotz/lanes/alpha/worktree";
	test("the brief loses the gateway footer, owner-via messages lose the trailer", () => {
		const out = pairs([
			user("Build the widget.\nUse the shared helper.\n\n---\n[dotz lane alpha] footer rules\nsecret footer"),
			said("widget built"),
			user("[owner via web] please also add tests\n(오너 메시지예요: reply in korean)\n(오너에게는 한국어로 답하세요.)"),
			said("tests added"),
		], LANE);
		expect(out.map(p => [p.kind, p.owner, p.room])).toEqual([["brief", "Build the widget.\nUse the shared helper.", ""], ["owner", "please also add tests", "web"]]);
		expect(out[0]?.project).toBe("alpha");
		expect(out[1]?.answer).toBe("tests added");
	});

	test("a footer-only message is not indexed", () => {
		expect(pairs([user("[dotz lane alpha] only the footer"), said("x")], LANE)).toEqual([]);
	});
});

describe("legacy monitor era", () => {
	const LEGACY = "/home/x/Code/widgets";
	test("discord events pair with replies sent from code, other monitors are ignored", () => {
		const out = pairs([
			monitor({ kind: "mail", id: "m1", content: "newsletter text" }),
			monitor({ kind: "message", id: "d1", channel_id: "555", author: { name: "tester" }, content: "legacy question here" }),
			call("eval", { code: "await sh(`discordbot message send 555 \"이것은 열 글자가 넘는 한국어 답변입니다\" --flag`)" }),
			call("eval", { code: "console.log('not a send, 이것은 열 글자가 넘는 한국어 로그입니다')" }),
			said("plain closing text"),
		], LEGACY);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ owner: "legacy question here", room: "ch:555", msgIds: ["d1"], project: "widgets" });
		expect(out[0]?.answer).toContain("이것은 열 글자가 넘는 한국어 답변입니다");
		expect(out[0]?.answer).not.toContain("로그");
	});

	test("relayed instructions keep their kind and lose the tag", () => {
		const out = pairs([user("[사용자 지시 · 이전 비서] do the thing"), said("done")], LEGACY);
		expect(out[0]).toMatchObject({ kind: "relay", owner: "do the thing" });
	});

	test("question-tool answers and peer handoffs are unwrapped", () => {
		const out = pairs([user("[Answer to question call_1]\nThe user responded: yes go ahead"), said("going"), user("hello plain"), said("hi")], LEGACY);
		expect(out.map(p => p.owner)).toEqual(["yes go ahead", "hello plain"]);
	});
});

describe("limits", () => {
	test("capText keeps head and tail", () => {
		const capped = capText(`${"a".repeat(50)}MID${"z".repeat(50)}`, 40);
		expect(capped.length).toBeLessThan(60);
		expect(capped.startsWith("aaaa")).toBe(true);
		expect(capped.endsWith("zzzz")).toBe(true);
		expect(capped).not.toContain("MID");
	});

	test("pairs are capped at the context limits", () => {
		const out = [...extractPairs(lines([inbox("q".repeat(5000)), said("w".repeat(9000))]), { ...ctx(CONV), ownerCap: 100, answerCap: 200 })];
		expect(out[0]?.owner.length).toBeLessThan(120);
		expect(out[0]?.answer.length).toBeLessThan(220);
	});

	test("the pair id is stable per file and first entry", () => {
		const e = [inbox("same words"), said("same answer")];
		expect(pairs(e, CONV)[0]?.id).toBe(pairs(e, CONV)[0]?.id);
		expect(pairs(e, CONV)[0]?.id).not.toBe(pairs(e, CONV, "/data/other.jsonl")[0]?.id);
	});
});
