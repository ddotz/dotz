import { expect, test } from "bun:test";
import { dedupeModels } from "./control.ts";

const m = (selector: string, name: string) => ({ provider: "anthropic", selector: `anthropic/${selector}`, name }) as never;

test("dated snapshots drop when their alias is listed; one entry per display name", () => {
	const out = dedupeModels([
		m("claude-3-5-sonnet-20240620", "Claude Sonnet 3.5"),
		m("claude-3-5-sonnet-20241022", "Claude Sonnet 3.5 v2"),
		m("claude-opus-4-0", "Claude Opus 4"),
		m("claude-opus-4-20250514", "Claude 4 Opus"),
		m("claude-opus-4-1", "Claude Opus 4.1"),
		m("claude-opus-4-1-20250805", "Claude 4.1 Opus"),
		m("claude-sonnet-4-5", "Claude Sonnet 4.5"),
		m("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"),
		m("claude-opus-5-5", "Claude Opus 5.5"),
	]).map((x: { selector: string }) => x.selector.split("/")[1]);
	expect(out).toEqual(["claude-3-5-sonnet-20240620", "claude-3-5-sonnet-20241022", "claude-opus-4-0", "claude-opus-4-1", "claude-sonnet-4-5", "claude-opus-5-5"]);
});
