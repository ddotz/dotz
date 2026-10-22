import { expect, test } from "bun:test";
import { dropSection, renderState, STATE_CAP } from "./recall-parts.ts";

const PATH = "/data/state.json";

test("renderState: one line per open task with next and lane, other keys by name only", () => {
	const raw = JSON.stringify({
		open_tasks: [
			{ id: "t1", what: "ship the port", since: "2026-10-20", next: "run the tests" },
			{ id: "t2", what: "review PR", lane: "pr-review", next: "wait for CI" },
			{ id: "t3", what: "idea" },
		],
		notes: { long: "x".repeat(5000) },
		last_seen: "2026-10-21",
	});
	expect(renderState(raw, PATH)).toBe(
		["open_tasks:", "- t1: ship the port (next: run the tests)", "- t2: review PR (next: wait for CI) [lane: pr-review]", "- t3: idea", "other keys: notes, last_seen"].join("\n"),
	);
});

test("renderState: an oversized state is cut at a line boundary under the cap, with a marker naming the file", () => {
	const open_tasks = Array.from({ length: 200 }, (_, i) => ({ id: `task-${i}`, what: `work item number ${i}`, next: "keep going" }));
	const out = renderState(JSON.stringify({ open_tasks }), PATH);
	expect(out.length).toBeLessThanOrEqual(STATE_CAP);
	const lines = out.split("\n");
	expect(lines.at(-1)).toBe(`[... cut at ${STATE_CAP} characters; read ${PATH} for the rest]`);
	expect(lines.at(-2)).toMatch(/^- task-\d+: work item number \d+ \(next: keep going\)$/);
	expect(out).not.toContain("task-199");
});

test("renderState: invalid JSON (or a non-object) falls back to the raw 4000-character slice", () => {
	const broken = `{"open_tasks": [{"id": "t1", "what": "${"y".repeat(5000)}`;
	expect(renderState(broken, PATH)).toBe(broken.slice(0, 4000));
	expect(renderState("[1, 2]", PATH)).toBe("[1, 2]");
});

test("dropSection: removes from the heading to the next ## heading, keeps everything else", () => {
	const mode = ["## Intro", "hello", "", "## Mail and calendar (zele)", "mail rule", "more mail", "", "## Next", "keep"].join("\n");
	expect(dropSection(mode, "## Mail and calendar")).toBe(["## Intro", "hello", "", "## Next", "keep"].join("\n"));
	expect(dropSection("## Intro\n## Mail and calendar (zele)\nlast", "## Mail and calendar")).toBe("## Intro");
	expect(dropSection("## Intro\nno such section", "## Mail and calendar")).toBe("## Intro\nno such section");
});
