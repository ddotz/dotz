import { expect, test } from "bun:test";
import { failedFiles } from "./update-gate-files.ts";

// The update gate runs only the files that failed a second time: a failed test and a file that errored while loading both count, a file that passed does not.
test("failed and errored files are found from bun's output; passing files are not", () => {
	const out = ["hub/a.test.ts:", "(pass) x [1ms]", "hub/b-web.test.ts:", "38 | const v = new Bun.WebView()", "error: Failed to spawn WebView host process", "hub/c.test.ts:", "(pass) y", "(fail) z [1ms]", "hub/d.test.ts:", "# Unhandled error between tests", "hub/e.test.ts:", "(pass) ok"].join("\n");
	expect(failedFiles(out)).toEqual(["hub/b-web.test.ts", "hub/c.test.ts", "hub/d.test.ts"]);
	expect(failedFiles("hub/a.test.ts:\n(pass) x\n")).toEqual([]);
});
