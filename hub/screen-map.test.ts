// docs/ui-screens.md is what hub/screen-map.ts draws from the code today, and only what opens what changes it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAP_FILE, readInput, renderMap } from "./screen-map";

const input = readInput();
const map = renderMap(input);
const withFile = (path: string, text: string) => ({ ...input, files: { ...input.files, [path]: text } });

test("the committed map is what the code draws", () => {
	expect(readFileSync(join(import.meta.dir, "..", MAP_FILE), "utf8")).toBe(map);
});

test("a new go() call to an unknown screen adds an arrow", () => {
	const home = input.files["js/08-home.js"]!;
	const planted = renderMap(withFile("js/08-home.js", `${home}\nfunction zzzPlanted() { go("zzz"); }\n`));
	expect(map).not.toContain("s_zzz");
	expect(planted).toContain(`c_home -->|"go (1)"| s_zzz`);
	expect(planted).toContain(`s_zzz["zzz: (no view)"]`);
});

test("a blank line above a go() call leaves the map as it is", () => {
	const home = input.files["js/08-home.js"]!, at = home.lastIndexOf("\n", home.search(/(?<![\w.$])go\("/));
	expect(at).toBeGreaterThan(0);
	expect(renderMap(withFile("js/08-home.js", `${home.slice(0, at)}\n${home.slice(at)}`))).toBe(map);
});
