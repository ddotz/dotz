import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The gateway serves web/js as one classic script (hub/webapp.ts), so one broken file takes the whole screen down while the hub
// itself still answers. A settings edit shipped with an unclosed object literal once (2026-11-03); this parses what is served.
const WEB = join(import.meta.dir, "..", "web", "js");
const files = readdirSync(WEB).filter(f => f.endsWith(".js")).sort();
const source = (f: string) => readFileSync(join(WEB, f), "utf8");
const parse = (text: string) => new Function(text);

test("every web/js file parses on its own", () => {
	const broken: string[] = [];
	for (const f of files) {
		try {
			parse(source(f));
		} catch (e) {
			broken.push(`${f}: ${(e as Error).message}`);
		}
	}
	expect(broken).toEqual([]);
});

test("the joined bundle the gateway serves parses as one script", () => {
	expect(() => parse(files.map(source).join("\n"))).not.toThrow();
});
