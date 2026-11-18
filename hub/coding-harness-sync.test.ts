import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCodingHarness } from "../scripts/sync-coding-harness.ts";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(ship: string): { checkout: string; dest: string } {
	const root = mkdtempSync(join(tmpdir(), "coding-sync-"));
	roots.push(root);
	const checkout = join(root, "harness-foundation");
	mkdirSync(join(checkout, "agent", "harness"), { recursive: true });
	writeFileSync(join(checkout, "agent", "harness", "ship.ts"), ship);
	const dest = join(root, "coding-harness");
	mkdirSync(dest);
	writeFileSync(join(dest, "SHIPPED_FROM"), "old\n");
	return { checkout, dest };
}

const WRITES = `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [out, , rev] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "SHIPPED_FROM"), (rev ?? "HEAD") + "\\n");
console.log("shipped 1 files");
`;

test("a successful ship replaces the vendored folder with the checkout's payload at the asked revision", () => {
	const { checkout, dest } = fixture(WRITES);
	expect(syncCodingHarness({ checkout, rev: "abc123", dest })).toBe("shipped 1 files");
	expect(readFileSync(join(dest, "SHIPPED_FROM"), "utf8")).toBe("abc123\n");
	expect(readdirSync(join(dest, "..")).sort()).toEqual(["coding-harness", "harness-foundation"]);
});

test("a failed ship leaves the old copy and no leftover folder", () => {
	const { checkout, dest } = fixture(`console.error("personal value found"); process.exit(1);`);
	expect(() => syncCodingHarness({ checkout, dest })).toThrow("personal value found");
	expect(readFileSync(join(dest, "SHIPPED_FROM"), "utf8")).toBe("old\n");
	expect(readdirSync(join(dest, "..")).sort()).toEqual(["coding-harness", "harness-foundation"]);
});

test("a checkout without ship.ts is refused before anything is touched", () => {
	const { dest } = fixture(WRITES);
	expect(() => syncCodingHarness({ checkout: join(dest, ".."), dest })).toThrow("no agent/harness/ship.ts");
	expect(readFileSync(join(dest, "SHIPPED_FROM"), "utf8")).toBe("old\n");
});
