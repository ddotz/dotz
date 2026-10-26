// The update gate (hub/update-gate.json runs `bun test ./hub/update-gate-run.ts`): the whole suite, run the fastest way this bun can.
// bun 1.4.2+ runs test files in parallel workers. bun 1.4.0 cannot start WebView hosts from parallel workers ("Failed to spawn WebView host
// process", 25-31 web test files on a Mac mini, 2026-10-26), so an older bun runs the files one by one in a fresh global. Even then bun 1.4.0
// fails a WebView start now and then (ERR_DLOPEN_FAILED, 4 of 51 web files in one run, each passing alone), so the files that failed run once
// more on their own: a broken change fails again, a host that did not start does not stop the update.
// Not named *.test.ts, so a plain `bun test` never runs it (it would run the suite inside itself).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { failedFiles } from "./update-gate-files.ts";

const root = join(import.meta.dir, "..");
const [maj, min, patch] = Bun.version.split(".").map(n => Number.parseInt(n, 10) || 0);
export const parallelOk = (v: [number, number, number]) => v[0] > 1 || (v[0] === 1 && (v[1] > 4 || (v[1] === 4 && v[2] >= 2)));
// More failed files than this is a broken change, not a host that did not start: no second run.
const RERUN_MAX = 40;

async function run(args: string[]): Promise<{ code: number; out: string }> {
	// The suite's own preload makes its throwaway data dir; this file's one must not leak into it.
	const env = { ...process.env };
	delete env.DOTZ_TEST_DIR;
	const p = Bun.spawn([process.execPath, "test", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	let out = "";
	const pump = async (s: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
		const dec = new TextDecoder();
		for await (const chunk of s) {
			const t = dec.decode(chunk, { stream: true });
			out += t;
			to.write(t);
		}
	};
	await Promise.all([pump(p.stdout, process.stdout), pump(p.stderr, process.stderr)]);
	return { code: await p.exited, out };
}

test(`the whole suite passes (bun ${Bun.version})`, async () => {
	const mode = parallelOk([maj, min, patch]) ? ["--parallel=4"] : ["--isolate"];
	const first = await run([...mode, "--timeout=20000"]);
	if (first.code === 0) return;
	const files = failedFiles(first.out);
	expect(files.length).toBeGreaterThan(0);   // a failure the output does not tie to a file is not retried
	expect(files.length).toBeLessThanOrEqual(RERUN_MAX);
	console.log(`\nupdate gate: ${files.length} file(s) failed, running them once more on their own: ${files.join(" ")}`);
	const again = await run(["--isolate", "--timeout=20000", ...files.map(f => `./${f}`)]);
	expect(again.code).toBe(0);
}, 19 * 60_000);
