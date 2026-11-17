import { afterAll, expect, spyOn, test } from "bun:test";
import * as discord from "./discord.ts";
import { onEmit } from "./events.ts";
import { sends } from "./outbound.ts";

process.env.DOTZ_NO_ORCHESTRATOR = "1";
afterAll(() => delete process.env.DOTZ_NO_ORCHESTRATOR);
const alerts: string[] = [];
onEmit(e => void (e.kind === "out" && e.target === "alert" && alerts.push(String(e.text))));

test("an answer the send ledger gives up on raises an alert that names its target", async () => {
	const send = spyOn(discord, "send").mockImplementation(async () => ({ delivered: false, reason: "403 Missing Access" }));
	const r = await sends.submit("ch:4242", "the answer the owner waits for", "m1");
	send.mockRestore();
	expect(r.delivered).toBe(false);
	expect(alerts.filter(a => a.includes("ch:4242") && a.includes("403 Missing Access") && a.includes("the answer the owner waits for"))).toHaveLength(1);
});

test("an alert that cannot be sent does not raise another alert", async () => {
	const before = alerts.length;
	const send = spyOn(discord, "send").mockImplementation(async () => ({ delivered: false, reason: "403 Missing Access" }));
	await sends.submit("alert", "[gateway] something", undefined);
	send.mockRestore();
	expect(alerts.length).toBe(before);
});
