import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LOAD_ROOT } from "./seed.ts";

// The seed's notices come through the real feed, which drops 감시 소식 older than WATCH_DAYS by its own clock: the seed must therefore be
// relative to the clock it runs on. Each instant below runs the seed in its own process (it seeds one dir per process) with that clock.
setDefaultTimeout(120_000);
const SEED = join(import.meta.dir, "seed.ts");
const INSTANTS = ["2026-11-11T03:00:00.000Z", "2026-11-12T00:30:00.000Z", "2026-11-19T03:00:00.000Z", "2027-03-01T12:00:00.000Z"];

async function seedAt(scale: "small" | "large", now?: string) {
	mkdirSync(LOAD_ROOT, { recursive: true });
	const tmp = mkdtempSync(join(LOAD_ROOT, "seed-test-"));
	try {
		const p = Bun.spawn([process.execPath, SEED, "--dir", join(tmp, "data"), "--scale", scale, ...(now ? ["--now", now] : [])], { stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		const manifest = JSON.parse(readFileSync(join(tmp, "data", "seed-manifest.json"), "utf8")) as { base: string; counts: { notices: number } };
		return { code, err, manifest, out };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

test("the small seed makes its 50 notices at any clock, including across a day and a week later", async () => {
	const runs = await Promise.all(INSTANTS.map(async at => ({ at, ...(await seedAt("small", at)) })));
	for (const r of runs) {
		expect({ at: r.at, code: r.code, err: r.code ? r.err : "" }).toEqual({ at: r.at, code: 0, err: "" });
		expect(r.manifest.counts.notices).toBe(50);
		const moved = Date.parse(r.manifest.base) - Date.parse(r.at);
		expect(moved).toBeGreaterThanOrEqual(0);
		expect(moved).toBeLessThan(10 * 60_000);
	}
});

test("the large seed makes its 1000 notices on a moved clock", async () => {
	const r = await seedAt("large", "2026-11-19T03:00:00.000Z");
	expect({ code: r.code, err: r.code ? r.err : "" }).toEqual({ code: 0, err: "" });
	expect(r.manifest.counts.notices).toBe(1000);
});
