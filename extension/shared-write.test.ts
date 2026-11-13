import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedWriteBlock } from "./guard.ts";

// A lane and a conversation's session may read the shared files (state.json, RULES.md, LESSONS.md, memory/); only a write
// whose target is one of them is refused.
const data = mkdtempSync(join(tmpdir(), "dotz-shared-write-"));
afterAll(() => rmSync(data, { recursive: true, force: true }));
const sessions: [conv: string, lane: string][] = [["mail:acme-1", ""], ["", "fleet"]];
const refused = (tool: string, input: any) => sessions.map(([conv, lane]) => sharedWriteBlock(tool, input, data, conv, lane) !== undefined);

test("reads that name a shared file next to >, =>, >= or 2>&1 are not refused", () => {
	const reads: [string, any][] = [
		["eval", { language: "js", code: `const r = read(HOME+"/.dotz/RULES.md"); [1].map(x => x)` }],
		["bash", { command: "cat ~/.dotz/LESSONS.md 2>&1 | head" }],
		["bash", { command: `python3 -c "print(open('~/.dotz/state.json').read())" > /tmp/state-copy.json` }],
		["eval", { language: "py", code: `rules = open("${join(data, "RULES.md")}").read()\nif len(rules) >= 1: print(rules)` }],
		["eval", { language: "js", code: `const d = JSON.parse(read("${join(data, "state.json")}")); await Bun.write("/tmp/out.json", JSON.stringify(d))` }],
	];
	for (const [tool, input] of reads) expect([tool, input, refused(tool, input)]).toEqual([tool, input, [false, false]]);
});

test("a write whose target is a shared file is refused", () => {
	const writes: [string, any][] = [
		["bash", { command: "echo x >> ~/.dotz/LESSONS.md" }],
		["eval", { language: "js", code: `fs.appendFileSync("${join(data, "LESSONS.md")}", s)` }],
		["eval", { language: "py", code: `S = "~/.dotz/LESSONS.md"\nopen(S,"a").write("- lesson")` }],
		// S was set in an earlier cell: a write-mode open of a name this cell never set, in a cell naming a shared file.
		["eval", { language: "py", code: `open(S,"a").write("- lesson")\nprint(open("${join(data, "LESSONS.md")}").read()[-200:])` }],
		["bash", { command: "sed -i '' 's/a/b/' ~/.dotz/RULES.md" }],
		["edit", { path: join(data, "memory", "owner.md"), edits: [] }],
	];
	for (const [tool, input] of writes) expect([tool, input, refused(tool, input)]).toEqual([tool, input, [true, true]]);
});
