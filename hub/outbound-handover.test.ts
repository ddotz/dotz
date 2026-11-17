import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOVER_AFTER_MS } from "./bgwork.ts";
import { convs } from "./convsessions.ts";
import "./outbound.ts";
import { clock } from "./runtime/test-clock.ts";

process.env.DOTZ_NO_ORCHESTRATOR = "1";
afterAll(() => delete process.env.DOTZ_NO_ORCHESTRATOR);

const ROOT = "01a159d6-b330-71dd-b28a-301dd01d6031";
let dir: string;
let session: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dz-handover-"));
	mkdirSync(join(dir, "projects", "p1", "senpi-task", "tasks"), { recursive: true });
	mkdirSync(join(dir, "sessions", "p1"), { recursive: true });
	session = join(dir, "sessions", "p1", `2026-10-21T05-00-00-000Z_${ROOT}.jsonl`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const failedWorker = (id: string, endedAt: number) =>
	writeFileSync(join(dir, "projects", "p1", "senpi-task", "tasks", `${id}.json`), JSON.stringify({ task_id: id, status: "failed", root_session_id: ROOT, created_at: new Date(endedAt - 60_000).toISOString(), started_at: new Date(endedAt - 59_000).toISOString(), updated_at: new Date(endedAt).toISOString(), terminal_at: new Date(endedAt).toISOString(), description: "사진첩 업로드 고치기", error_message: "Concurrent turn admission" }));

test("a failed worker of a parked conversation handed back to its session starts that session as a message to it does: parked is cleared", () => {
	const c = convs.ensure("ch:parked-handover");
	c.meta.parked = true;
	c.o.orch.sessionFile = session;
	const endedAt = c.o.lastTurnEndAt() + 1000;
	failedWorker("st_parked", endedAt);
	clock.now = endedAt + HANDOVER_AFTER_MS + 1000;
	expect(c.bg.list()[0]).toMatchObject({ id: "st_parked", status: "failed" });
	expect(c.queue.queued().at(-1)!.text).toContain("st_parked");
	expect(c.meta.parked).toBeUndefined();
});
