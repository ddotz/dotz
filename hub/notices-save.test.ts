import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { paths } from "./config.ts";
import { emit } from "./events.ts";
import { resetNoticesForTest, type Notice } from "./notices.ts";
import { flushNotices } from "./notices-store.ts";
import { advance } from "./runtime/test-clock.ts";

const post = (n: number) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "worklog", text: `[done] 일 ${n} 끝났어요`, update_key: `lane:save${n}` });
const written = () => statSync(paths.notices).ino;
const onDisk = (): Notice[] => JSON.parse(readFileSync(paths.notices, "utf8"));

test("a burst of changes is one write of notices.json, 200 ms after the first change", async () => {
	resetNoticesForTest();
	const idle = written();
	for (let n = 0; n < 10; n++) post(n);
	expect(written()).toBe(idle);
	await advance(199);
	expect(written()).toBe(idle);
	await advance(1);
	const once = written();
	expect(once).not.toBe(idle);
	expect(onDisk().filter(i => i.text.includes("끝났어요"))).toHaveLength(10);
	await advance(1000);
	expect(written()).toBe(once);
});

test("a change after a write waits its own 200 ms, so two writes are never closer than that", async () => {
	resetNoticesForTest();
	post(20);
	await advance(200);
	const first = written();
	post(21);
	post(22);
	await advance(199);
	expect(written()).toBe(first);
	await advance(1);
	expect(written()).not.toBe(first);
	expect(onDisk().filter(i => i.text.includes("끝났어요"))).toHaveLength(3);
});

test("flushNotices writes a waiting change at once, and writes nothing when nothing waits", async () => {
	resetNoticesForTest();
	post(30);
	expect(onDisk().filter(i => i.text.includes("끝났어요"))).toHaveLength(0);
	flushNotices();
	expect(onDisk().filter(i => i.text.includes("끝났어요"))).toHaveLength(1);
	const flushed = written();
	flushNotices();
	await advance(1000);
	expect(written()).toBe(flushed);
});
