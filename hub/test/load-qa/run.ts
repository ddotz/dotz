// One command for the load install: seed, boot the gateway under the sandbox, measure, write results, stop.
//   bun run load-qa            (= bun hub/test/load-qa/run.ts --scale large --out /tmp/load-qa/run)
//   bun hub/test/load-qa/run.ts --scale small|large [--out DIR] [--serve] [--port N] [--latency MS]
//   bun hub/test/load-qa/run.ts --stop --out DIR
// The gateway runs from a copy of this working tree under <out>/repo (the sandbox cannot read ~/.dotz, where the real checkout of an
// install lives, and the copy keeps the run away from the real checkout), on a temp data dir, a fake HOME and the fake CLIs.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bench, type Ctx } from "./bench.ts";
import { alive, freePort, prepare, probe, start, stop } from "./harness.ts";
import { loginLink } from "./install.ts";

const flag = (name: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`);
	return i < 0 ? undefined : process.argv[i + 1];
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const fail = (msg: string): never => {
	console.error(`load-qa run: ${msg}`);
	process.exit(1);
};

const scale = flag("scale") ?? "small";
const out = resolve(flag("out") ?? `/tmp/load-qa/run-${scale}`);
if (!/^\/(private\/)?tmp\/load-qa\/[^/]+/.test(out)) fail(`--out must be a directory under /tmp/load-qa/, got ${out}`);

if (has("stop")) {
	console.log(await stop(out));
	process.exit(0);
}
if (scale !== "small" && scale !== "large") fail("--scale must be small or large");
const pidFile = join(out, "gateway.pid");
if (existsSync(pidFile) && alive(Number(readFileSync(pidFile, "utf8").trim()))) fail(`a gateway of ${out} still runs; stop it with: bun hub/test/load-qa/run.ts --stop --out ${out}`);

const latency = Number(flag("latency") ?? 0);
const g = await prepare({ out, scale, port: Number(flag("port") ?? freePort()), latency }).catch(e => fail(String(e.message ?? e)));
await start(g).catch(async e => (await stop(out), fail(String(e.message ?? e))));

if (has("serve")) {
	console.log(`serving ${g.l.url}\nlogin link (one use, open it in the browser): ${await loginLink(g.l.dataDir, g.port)}\npid ${g.pid}\nstop: bun hub/test/load-qa/run.ts --stop --out ${out}`);
	process.exit(0);
}

let code = 0;
try {
	const ctx: Ctx = { base: g.base, token: g.token, pid: g.pid, out, dataDir: g.l.dataDir, scale, latency, bootMs: g.bootMs, seedMs: g.seedMs, seed: g.seed, repoFiles: g.files.length, probe: await probe(g) };
	code = await bench(ctx);
} catch (e) {
	console.error(e);
	code = 1;
} finally {
	console.log(await stop(out));
}
process.exit(code);
