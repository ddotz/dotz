// inbox watch: local folder scan with a fake ffprobe. First run is a baseline, later runs report each new video once with the
// ok flag, files still being copied wait, a missing ffprobe is a setup failure, and nothing touches the network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { run } from "../bin/inbox.ts";
import { paths } from "../lib/config.ts";
import { dropVideo, fakeCtx, NOW, readState, setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

type P = { w: number; h: number; d: number; rot?: number };
const probes: Record<string, P> = {
	"a.mp4": { w: 1080, h: 1920, d: 20 },
	"b.mp4": { w: 1080, h: 1920, d: 59.6 },
	"c.mov": { w: 1920, h: 1080, d: 30 },
	"d.m4v": { w: 1080, h: 1920, d: 200 },
	"f.mp4": { w: 1920, h: 1080, d: 10, rot: -90 },
};
const exec = async (argv: string[]) => {
	const p = probes[basename(argv.at(-1) ?? "")];
	if (!p) return { code: 1, stdout: "", stderr: "invalid data" };
	const stream = { width: p.w, height: p.h, ...(p.rot ? { side_data_list: [{ rotation: p.rot }] } : {}) };
	return { code: 0, stdout: JSON.stringify({ streams: [stream], format: { duration: String(p.d) } }), stderr: "" };
};

test("first run is a baseline, later runs print each new video once with its flag", async () => {
	dropVideo(env, "a.mp4");
	const ctx = fakeCtx(env, { exec });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.execs).toHaveLength(0);
	for (const n of ["b.mp4", "c.mov", "d.m4v", "f.mp4", "g.mp4"]) dropVideo(env, n);
	writeFileSync(join(paths.inbox(), "notes.txt"), "not a video");
	const dir = paths.inbox();
	expect(await run(ctx, [])).toEqual({
		lines: [
			`new-video ${dir}/b.mp4 60s 1080x1920 vertical ok`,
			`new-video ${dir}/c.mov 30s 1920x1080 landscape not-vertical`,
			`new-video ${dir}/d.m4v 200s 1080x1920 vertical too-long`,
			`new-video ${dir}/f.mp4 10s 1080x1920 vertical ok`,
		],
		code: 0,
	});
	const probed = ctx.execs.length;
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.execs.length).toBe(probed);
	expect(ctx.calls).toHaveLength(0);
	expect(readState(env).data.seen).toContain(`${dir}/g.mp4`);
});

test("a file touched in the last 30 seconds waits until it settles", async () => {
	const ctx = fakeCtx(env, { exec });
	await run(ctx, []);
	const file = dropVideo(env, "b.mp4");
	const fresh = new Date(Date.parse(NOW) - 5_000);
	utimesSync(file, fresh, fresh);
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	const later = fakeCtx(env, { exec, now: new Date(Date.parse(NOW) + 60_000).toISOString() });
	expect((await run(later, [])).lines).toEqual([`new-video ${file} 60s 1080x1920 vertical ok`]);
});

test("a missing ffprobe is DOTZ_FAIL setup", async () => {
	const ctx = fakeCtx(env, { exec: async () => ({ code: 127, stdout: "", stderr: "not found" }) });
	await run(ctx, []);
	dropVideo(env, "b.mp4");
	const res = await run(ctx, []);
	expect(res.code).toBe(1);
	expect(res.lines[0]).toBe("DOTZ_FAIL setup");
});

test("missing config prints DOTZ_FAIL setup", async () => {
	rmSync(paths.config());
	expect((await run(fakeCtx(env), [])).lines[0]).toBe("DOTZ_FAIL setup");
});
