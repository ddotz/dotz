import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recentExchanges } from "./omp.ts";

const user = (text: string) => JSON.stringify({ message: { role: "user", content: text } });
const assistant = (text: string) => JSON.stringify({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });

test("recentExchanges skips assistant answers that are only [later] or -, keeping the rest", () => {
	const file = join(mkdtempSync(join(tmpdir(), "omp-exchanges-")), "session.jsonl");
	writeFileSync(file, [user("first question"), assistant("first answer"), user("queued one"), assistant("[later]"), user("queued two"), assistant("-"), user("[later] is what the owner typed"), assistant("real answer")].join("\n"));
	expect(recentExchanges(file)).toBe("IN: first question\n\nYOU: first answer\n\nIN: queued one\n\nIN: queued two\n\nIN: [later] is what the owner typed\n\nYOU: real answer");
});
