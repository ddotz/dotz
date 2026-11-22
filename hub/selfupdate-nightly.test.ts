// Self-update installs once a night: the 10-minute check still finds a release at once, but the automatic install (and its restart)
// waits for the nightly slot (omp_update.at, default DEFAULTS.update_at). The owner's own update installs at once.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cfg } from "./config.ts";
import { advance, clock, flush } from "./runtime/test-clock.ts";
import { autoHooks, failFileTestCmd as testCmd, head, makeRepos, type Repos, setSelfUpdateCfg } from "./selfupdate-fixture.ts";
import * as parse from "./selfupdate-parse.ts";
import { apply, CHECK_EVERY_MS, startSelfUpdate } from "./selfupdate.ts";
import { clearTrackedTimers } from "./shutdown.ts";

const local = (day: number, h: number, m: number) => new Date(2027, 0, day, h, m, 0, 0);

test("nightSlot: inside [at, at + window) names the night the slot opened on; outside, off or unreadable, none", () => {
	expect(parse.nightSlot("04:20", local(10, 4, 20))).toBe("2027-01-10");
	expect(parse.nightSlot("04:20", local(10, 4, 20 + parse.NIGHT_WINDOW_MIN - 1))).toBe("2027-01-10");
	expect(parse.nightSlot("04:20", local(10, 4, 19))).toBeUndefined();
	expect(parse.nightSlot("04:20", local(10, 4, 20 + parse.NIGHT_WINDOW_MIN))).toBeUndefined();
	expect(parse.nightSlot("04:20", local(10, 13, 0))).toBeUndefined();
	// a slot just before midnight is one night across the date change
	expect(parse.nightSlot("23:50", local(11, 0, 10))).toBe("2027-01-10");
	expect(parse.nightSlot("off", local(10, 4, 20))).toBeUndefined();
	expect(parse.nightSlot("25:00", local(10, 1, 0))).toBeUndefined();
});

let r: Repos;
const saved = (cfg as Record<string, unknown>).omp_update;
beforeEach(() => {
	r = makeRepos();
	setSelfUpdateCfg(undefined);
	(cfg as Record<string, unknown>).omp_update = { at: "04:20" };
});
afterEach(() => {
	clearTrackedTimers();
	setSelfUpdateCfg(undefined);
	(cfg as Record<string, unknown>).omp_update = saved;
	r.remove();
});

test("a release found by day only announces; the check in the nightly slot installs and restarts once; the owner's update installs at once", async () => {
	const opts = { dir: r.work, remote: "origin", branch: "main", testCmd, logDir: r.logDir, alert: () => {} };
	const { h, api } = autoHooks();
	let signal = () => {};
	const next = () => new Promise<void>(res => void (signal = res));
	const notes: string[] = [];
	const hooks = { ...api, restartIdle: () => (api.restartIdle(), signal(), "queued") };
	// Arms the check timer so the next check runs at `when`, runs it, and waits for its notice or restart.
	const checkAt = async (when: Date) => {
		clock.now = when.getTime() - CHECK_EVERY_MS;
		await startSelfUpdate(t => (notes.push(t), signal()), opts, hooks);
		const done = next();
		await advance(CHECK_EVERY_MS);
		await done;
		await flush();
	};
	const start = head(r.work);

	r.release("a.txt", "2\n", "second");
	await checkAt(local(10, 13, 0));
	expect(head(r.work)).toBe(start);
	expect(h.restarts).toBe(0);
	expect(notes).toHaveLength(1);

	await checkAt(local(11, 4, 25));
	expect(head(r.work)).toBe(head(r.pusher));
	expect(h.restarts).toBe(1);
	expect(h.worklog).toHaveLength(1);

	// A second release later in the same slot waits for the next night.
	const installed = head(r.work);
	r.release("a.txt", "3\n", "third");
	await checkAt(local(11, 4, 45));
	expect(head(r.work)).toBe(installed);
	expect(h.restarts).toBe(1);
	expect(notes).toHaveLength(2);

	// The owner's explicit update does not wait for the slot.
	clock.now = local(11, 14, 0).getTime();
	expect((await apply(opts)).status).toBe("updated");
	expect(head(r.work)).toBe(head(r.pusher));
});
