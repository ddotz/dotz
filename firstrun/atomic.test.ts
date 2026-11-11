import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "./atomic.ts";

const dir = mkdtempSync(join(tmpdir(), "atomic-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a mode given is the file's mode, and no temp file stays behind", () => {
	const file = join(dir, "secret.json");
	writeAtomic(file, "{}\n", 0o600);
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(readFileSync(file, "utf8")).toBe("{}\n");
	expect(readdirSync(dir)).toEqual(["secret.json"]);
});

test("writing again replaces the text whole", () => {
	const file = join(dir, "plain.txt");
	writeAtomic(file, "a long first text");
	writeAtomic(file, "b");
	expect(readFileSync(file, "utf8")).toBe("b");
});
