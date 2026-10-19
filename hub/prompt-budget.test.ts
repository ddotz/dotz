import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths, TEMPLATES } from "./config.ts";
import { BOUNDARIES_TEMPLATE_MAX_BYTES, LESSONS_TEMPLATE_MAX_BYTES, MODE_KO_MD_MAX_BYTES, MODE_MD_MAX_BYTES, OWNER_TEMPLATE_MAX_BYTES, RULES_TEMPLATE_MAX_BYTES } from "./prompt-budget.ts";

const repo = join(import.meta.dir, "..");
const bytes = (text: string | Buffer) => Buffer.byteLength(text);

const budgets: [name: string, size: number, cap: number][] = [
	["MODE.md", bytes(readFileSync(join(repo, "MODE.md"))), MODE_MD_MAX_BYTES],
	["MODE.ko.md", bytes(readFileSync(join(repo, "MODE.ko.md"))), MODE_KO_MD_MAX_BYTES],
	["RULES template (hub/config.ts)", bytes(TEMPLATES[paths.rules]), RULES_TEMPLATE_MAX_BYTES],
	["LESSONS template (hub/config.ts)", bytes(TEMPLATES[paths.lessons]), LESSONS_TEMPLATE_MAX_BYTES],
	["owner card template (hub/config.ts)", bytes(TEMPLATES[paths.owner]), OWNER_TEMPLATE_MAX_BYTES],
	["boundaries template (hub/config.ts)", bytes(TEMPLATES[paths.boundaries]), BOUNDARIES_TEMPLATE_MAX_BYTES],
];

test("prompt files stay within their byte caps", () => {
	const over = budgets
		.filter(([, size, cap]) => size > cap)
		.map(([name, size, cap]) => `${name} is ${size - cap} bytes over its cap (${size} > ${cap}); bump the cap in hub/prompt-budget.ts only if the growth is deliberate`);
	expect(over).toEqual([]);
});
