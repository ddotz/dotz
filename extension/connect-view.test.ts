import { expect, test } from "bun:test";
import { connectText } from "./connect-view.ts";

test("a waiting view shows the step, what the owner does and numbered choices with ids", () => {
	const text = connectText({
		key: "jandi",
		state: "waiting",
		step: { id: "team", title: "Pick the team", detail: "Two teams found" },
		owner: { label: "Choose a team", hint: "Answer in this chat" },
		error: null,
		choices: [{ id: "t1", label: "Team A" }, { id: "t2", label: "Team B" }],
	});
	expect(text.split("\n")).toEqual([
		"jandi: waiting",
		"step: Pick the team - Two teams found",
		"owner does: Choose a team (Answer in this chat)",
		"choices (continue with choice=<id>):",
		"1. Team A [t1]",
		"2. Team B [t2]",
	]);
});

test("an idle or failed view stays short and carries the error", () => {
	expect(connectText({ key: "slack", state: "idle", step: null, owner: null })).toBe("slack: idle");
	expect(connectText({ key: "slack", state: "failed", step: null, owner: null, error: "login did not finish" })).toBe("slack: failed\nerror: login did not finish");
});
