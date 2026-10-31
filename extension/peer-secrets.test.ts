import { expect, test } from "bun:test";
import { secretIn } from "./peer-secrets.ts";

const HUB = "h".repeat(32);
const PEER = "p".repeat(24);

test("a known token value in the text is refused, a short or missing one is ignored", () => {
	expect(secretIn(`token is ${HUB}`, [HUB, PEER])).toBeDefined();
	expect(secretIn(`x-dotz-peer: ${PEER}`, [HUB, PEER])).toBeDefined();
	expect(secretIn("password", ["password", undefined, ""])).toBeUndefined();
	expect(secretIn("nothing here", [HUB, undefined])).toBeUndefined();
});

test("well-known credential shapes are refused", () => {
	expect(secretIn("-----BEGIN RSA PRIVATE KEY-----\nabc", [])).toBeDefined();
	expect(secretIn(`key sk-${"a".repeat(24)}`, [])).toBeDefined();
	expect(secretIn(`ghp_${"A1".repeat(12)}`, [])).toBeDefined();
	expect(secretIn("xoxb-1234567890-abcdef", [])).toBeDefined();
	expect(secretIn("AKIAABCDEFGHIJKLMNOP", [])).toBeDefined();
});

test("ordinary handoff text passes", () => {
	expect(secretIn("맥미니에서 이어서 해. branch feat/peer-handoff, hub/peer-monitor.ts, next: bun test", [HUB, PEER])).toBeUndefined();
	expect(secretIn("task-list and sk-short are fine", [])).toBeUndefined();
});
