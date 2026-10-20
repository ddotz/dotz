// Kept finished turns lose their thinking after a compaction; text, tool calls, results and the running turn stay.
import { expect, test } from "bun:test";
import { dropKeptThinking, installCompactKept, SUMMARY_PREFIX } from "./compact-kept.ts";

const think = { type: "thinking", thinking: "long reasoning", thinkingSignature: "sig" };
const call = { type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } };
const assistant = (timestamp: number, content: unknown[]) => ({ role: "assistant", timestamp, content });
const user = (timestamp: number) => ({ role: "user", timestamp, content: [{ type: "text", text: "go" }] });
const result = (timestamp: number) => ({ role: "toolResult", toolCallId: "t1", toolName: "read", timestamp, content: [{ type: "text", text: "body" }] });
const summary = (timestamp: number) => ({ role: "compactionSummary", summary: "s", tokensBefore: 1, timestamp });

test("finished turns kept from before the compaction lose their thinking and keep everything else", () => {
	const messages = [summary(1000), user(800), assistant(810, [think, { type: "text", text: "plan" }, call]), result(820), assistant(830, [think, { type: "text", text: "done" }]), { role: "custom", customType: "dotz-mode", timestamp: 1100, content: "contract" }, user(1101)];
	const out = dropKeptThinking(messages)!;
	expect(out[2].content).toEqual([{ type: "text", text: "plan" }, call]);
	expect(out[4].content).toEqual([{ type: "text", text: "done" }]);
	for (const i of [0, 1, 3, 5, 6]) expect(out[i]).toBe(messages[i]);
	// The transcript objects themselves are never changed.
	expect(messages[2].content).toContain(think);
});

test("the running turn, turns after the compaction, thinking-only messages and sessions without a compaction stay", () => {
	// A mid-turn compaction: the kept assistant after the last user message is the turn still running.
	expect(dropKeptThinking([summary(1000), user(800), assistant(810, [think, call]), result(820)])).toBeUndefined();
	expect(dropKeptThinking([summary(1000), user(1100), assistant(1110, [think, { type: "text", text: "a" }]), user(1120)])).toBeUndefined();
	expect(dropKeptThinking([summary(1000), user(800), assistant(810, [think]), user(1100)])).toBeUndefined();
	expect(dropKeptThinking([user(800), assistant(810, [think, { type: "text", text: "a" }]), user(900)])).toBeUndefined();
});

test("the summary as senpi's context event carries it (a user message with the summary prefix) marks the compaction", () => {
	const asSent = { role: "user", timestamp: 1000, content: [{ type: "text", text: `${SUMMARY_PREFIX}\n\n<summary>\ns\n</summary>` }] };
	const out = dropKeptThinking([asSent, user(800), assistant(810, [think, { type: "text", text: "a" }]), user(1100)])!;
	expect(out[2].content).toEqual([{ type: "text", text: "a" }]);
	expect(dropKeptThinking([user(1000), user(800), assistant(810, [think, { type: "text", text: "a" }]), user(1100)])).toBeUndefined();
});

test("the result is the same on every call (prompt cache)", () => {
	const messages = [summary(1000), user(800), assistant(810, [{ type: "redacted_thinking", data: "x" }, { type: "text", text: "a" }]), user(1100)];
	const once = dropKeptThinking(messages)!;
	expect(once[2].content).toEqual([{ type: "text", text: "a" }]);
	expect(dropKeptThinking(messages)).toEqual(once);
});

test("the extension registers a context handler that declares it does not mutate messages", () => {
	const seen: Array<{ name: string; fn: (e: any) => any; options?: { mutatesMessages?: boolean } }> = [];
	installCompactKept({ on: (name, fn, options) => seen.push({ name, fn, options }) });
	expect(seen.map(s => [s.name, s.options?.mutatesMessages])).toEqual([["context", false]]);
	const r = seen[0].fn({ type: "context", messages: [summary(1000), user(800), assistant(810, [think, { type: "text", text: "a" }]), user(1100)] });
	expect(r.messages[2].content).toEqual([{ type: "text", text: "a" }]);
	expect(seen[0].fn({ type: "context", messages: [] })).toBeUndefined();
});
