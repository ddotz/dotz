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

const call = (name: string, args: Record<string, unknown>) => JSON.stringify({ message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c", name, arguments: args }] } });
const session = (lines: string[]) => {
	const file = join(mkdtempSync(join(tmpdir(), "omp-exchanges-")), "session.jsonl");
	writeFileSync(file, lines.join("\n"));
	return file;
};

test("recentExchanges lists the edited and written paths after the tail, most recent first, each once", () => {
	const file = session([user("fix it"), call("edit", { path: "/work/a.ts", edits: [{ oldText: "x", newText: "y" }] }), call("write", { path: "/work/b.ts", content: "body" }), call("edit", { path: "/work/a.ts", edits: [] }), assistant("done")]);
	expect(recentExchanges(file)).toBe("IN: fix it\n\nYOU: done\n\nFiles touched:\n- /work/a.ts\n- /work/b.ts");
});

test("recentExchanges caps the touched paths at 20 and the block at about 1500 characters", () => {
	const many = Array.from({ length: 30 }, (_, i) => call("write", { path: `/work/f${i}.ts`, content: "" }));
	const block = recentExchanges(session([user("go"), ...many, assistant("done")]))!.split("Files touched:\n")[1].split("\n");
	expect(block).toHaveLength(20);
	expect(block[0]).toBe("- /work/f29.ts");
	const long = Array.from({ length: 20 }, (_, i) => call("write", { path: `/${"d".repeat(190)}${i}`, content: "" }));
	const text = recentExchanges(session([user("go"), ...long, assistant("done")]))!;
	expect(text.slice(text.indexOf("Files touched:")).length).toBeLessThanOrEqual(1500);
});

test("recentExchanges adds no block for shell-only sessions and never reads commands or code", () => {
	const secret = "ghp_SECRETTOKEN";
	const file = session([user("deploy"), call("bash", { command: `curl -H 'Authorization: ${secret}' https://x.test`, path: "/not/a/file" }), call("eval", { language: "js", code: `await fetch("https://x.test", { headers: { a: "${secret}" } })` }), assistant("done")]);
	expect(recentExchanges(file)).toBe("IN: deploy\n\nYOU: done");
});
