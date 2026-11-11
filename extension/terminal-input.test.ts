import { expect, test } from "bun:test";
import { staysInTerminal } from "./terminal-input.ts";

test("a shell line and a command-shaped word stay with the harness", () => {
	for (const text of ["!ls", "/quit", "/model opus", "/skill:review 봐줘", "/foo bar"]) expect(staysInTerminal(text)).toBe(true);
});

test("a path and ordinary text go to the gateway", () => {
	for (const text of ["/Users/me/Downloads/a 이거 봐줘", "/tmp/a.txt", "/ 이거", "안녕"]) expect(staysInTerminal(text)).toBe(false);
});
