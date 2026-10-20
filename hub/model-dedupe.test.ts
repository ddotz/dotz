import { expect, test } from "bun:test";
import { modelChoices } from "./control.ts";

const m = (selector: string, name: string) => ({ provider: "anthropic", selector: `anthropic/${selector}`, name, reasoning: true });
const list = [
	m("claude-3-5-sonnet-20240620", "Claude Sonnet 3.5"),
	m("claude-3-5-sonnet-20241022", "Claude Sonnet 3.5 v2"),
	m("claude-opus-4-0", "Claude Opus 4"),
	m("claude-opus-4-20250514", "Claude 4 Opus"),
	m("claude-sonnet-4-0", "Claude Sonnet 4"),
	m("claude-sonnet-4-20250514", "Claude 4 Sonnet"),
	m("claude-sonnet-4-5", "Claude Sonnet 4.5"),
	m("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"),
	m("claude-opus-4-5", "Claude Opus 4.5"),
	m("claude-opus-5-5", "Claude Opus 5.5"),
	m("claude-haiku-4-5", "Claude Haiku 4.5"),
	m("claude-mythos-5", "Claude Mythos 5"),
];
const view = (out: ReturnType<typeof modelChoices>) => out.map(c => `${c.name}=${c.selector.split("/")[1]}${c.older ? " (older)" : ""}`);

test("one '<Family> <version>' per model from the id: alias over snapshot, Opus/Sonnet first, newest first, latest two per family", () => {
	expect(view(modelChoices(list))).toEqual([
		"Opus 5.5=claude-opus-5-5",
		"Opus 4.5=claude-opus-4-5",
		"Opus 4=claude-opus-4-0 (older)",
		"Sonnet 4.5=claude-sonnet-4-5",
		"Sonnet 4=claude-sonnet-4-0",
		"Sonnet 3.5=claude-3-5-sonnet-20241022 (older)",
		"Mythos 5=claude-mythos-5",
	]);
});

test("the kept selection wins over its alias", () => {
	expect(view(modelChoices(list, "anthropic/claude-sonnet-4-5-20250929"))).toContain("Sonnet 4.5=claude-sonnet-4-5-20250929");
});
