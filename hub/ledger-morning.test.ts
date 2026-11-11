import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Deps, runMorning, runNight } from "./doctor.ts";
import type { Finding } from "./doctor-types.ts";
import { createLedger, type Ledger } from "./ledger.ts";
import { morningExtra } from "./ledger-tick.ts";

const NOW = new Date(2026, 10, 10, 8, 0).getTime();
const source = { kind: "conversation" as const, ref: "main" };
let dir: string, store: Ledger, clock: number;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-ledger-morning-"));
	store = createLedger({ file: join(dir, "ledger.json"), now: () => clock });
	clock = NOW;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const finding: Finding = { key: "gateway:restarts", area: "gateway", what: "WHAT-DOCTOR", evidence: "hub.log", since: NOW, level: 4 };
function rig(found: Finding[], waiting = 0, at = "auto", delivered = true) {
	const state = { doctor: [] as string[], news: [] as string[] };
	const deps: Deps = {
		now: () => clock,
		dataDir: dir,
		home: dir,
		at: () => at,
		checks: [() => found],
		refresh: async () => undefined,
		send: text => (state.doctor.push(text), { delivered }),
		log: () => undefined,
		ledgerPart: { morning: now => morningExtra(store, () => waiting, now), news: text => (state.news.push(text), { delivered }) },
	};
	return { state, deps };
}

describe("the ledger in the doctor's morning", () => {
	test("a doctor item and a due item go in ONE send, the text holds both", async () => {
		store.add({ what: "WHAT-LEDGER", source, due: "2026-11-10" });
		const r = rig([finding]);
		await runNight(r.deps);
		await runMorning(r.deps);
		expect(r.state.doctor).toHaveLength(1);
		expect(r.state.news).toHaveLength(0);
		expect(r.state.doctor[0]).toContain("WHAT-DOCTOR");
		expect(r.state.doctor[0]).toContain("WHAT-LEDGER");
	});

	test("a morning with only the ledger is one news send, told once", async () => {
		store.add({ what: "WHAT-TODAY", source, due: "2026-11-10" });
		store.add({ what: "WHAT-OVERDUE", source, due: "2026-11-08" });
		store.add({ what: "WHAT-LATER", source, due: "2026-11-20" });
		const r = rig([]);
		await runNight(r.deps);
		await runMorning(r.deps);
		expect(r.state.doctor).toHaveLength(0);
		expect(r.state.news).toHaveLength(1);
		expect(r.state.news[0]).toContain("WHAT-TODAY");
		expect(r.state.news[0]).toContain("WHAT-OVERDUE");
		expect(r.state.news[0]).not.toContain("WHAT-LATER");
		await runMorning(r.deps);
		expect(r.state.news).toHaveLength(1);
	});

	test("approvals still waiting alone are a morning message; nothing due and none waiting is silence", async () => {
		const quiet = rig([]);
		await runNight(quiet.deps);
		await runMorning(quiet.deps);
		expect(quiet.state.news.concat(quiet.state.doctor)).toHaveLength(0);
		const waiting = rig([], 3);
		await runMorning(waiting.deps);
		expect(waiting.state.news).toHaveLength(1);
		expect(waiting.state.news[0]).toContain("3");
	});

	test("done and cancelled items are not in the morning", async () => {
		const a = store.add({ what: "WHAT-A", source, due: "2026-11-10" }), b = store.add({ what: "WHAT-B", source, due: "2026-11-09" });
		store.done(a.id);
		store.cancel(b.id);
		const r = rig([]);
		await runMorning(r.deps);
		expect(r.state.news).toHaveLength(0);
	});

	test("the mark is saved only after delivery: a failed send leaves the item for the next try", async () => {
		store.add({ what: "WHAT-A", source, due: "2026-11-10" });
		const failing = rig([], 0, "auto", false);
		await expect(runMorning(failing.deps)).rejects.toThrow();
		expect(store.list()[0]!.told).toBeUndefined();
		const ok = rig([]);
		await runMorning(ok.deps);
		expect(ok.state.news).toHaveLength(1);
		expect(store.list()[0]!.told?.morning).toBeDefined();
		expect(store.list()[0]!.told?.before).toBeDefined();
	});

	test("with the doctor off the doctor part is skipped and the ledger is still told", async () => {
		store.add({ what: "WHAT-A", source, due: "2026-11-10" });
		const r = rig([finding], 0, "off");
		await runMorning(r.deps);
		expect(r.state.doctor).toHaveLength(0);
		expect(r.state.news).toHaveLength(1);
		expect(r.state.news[0]).toContain("WHAT-A");
	});
});
