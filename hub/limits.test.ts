import { expect, test } from "bun:test";
import { agentLimits, memoryPressureFreeFraction, readMachine, reserveGb, vmStatAvailableBytes, waitText } from "./limits.ts";

const mac = { totalGb: 48, availableGb: 24.8, cpus: 12 };
const none = { lanes: 0, workers: 0 };

test("the reserve is 25% of RAM or 8 GB, whichever is larger", () => {
	expect(reserveGb(48)).toBe(12);
	expect(reserveGb(16)).toBe(8);
	expect(reserveGb(128)).toBe(32);
});

test("48 GB / 12 cores with 24.8 GB reclaimable: 4 lanes, 2 workers each (the former fixed defaults)", () => {
	const l = agentLimits(mac, none);
	expect(l).toMatchObject({ lanes: 4, workers: 2, spare: 12, reserveGb: 12 });
	expect(l.reason).toBeUndefined();
});

test("less memory shrinks both numbers, more grows them", () => {
	expect(agentLimits({ ...mac, availableGb: 16 }, none)).toMatchObject({ lanes: 1, workers: 3, spare: 4 });
	expect(agentLimits({ totalGb: 48, availableGb: 30, cpus: 24 }, none)).toMatchObject({ lanes: 6, workers: 2, spare: 18 });
	expect(agentLimits({ totalGb: 128, availableGb: 100, cpus: 16 }, none)).toMatchObject({ lanes: 5, workers: 2, spare: 16 });
});

test("running agents are already out of the available memory: only the spare is added to the running lanes", () => {
	const l = agentLimits({ ...mac, availableGb: 18 }, { lanes: 3, workers: 3 });
	expect(l.spare).toBe(6);
	expect(l.lanes).toBe(5);
	expect(l.reason).toBeUndefined();
});

test("a launch waits, with its reason, when memory is short", () => {
	const l = agentLimits({ ...mac, availableGb: 12.5 }, { lanes: 2, workers: 0 });
	expect(l).toMatchObject({ lanes: 2, spare: 0, reason: "memory" });
	expect(waitText("memory")).toBe("메모리 여유가 없어 대기 중");
});

test("a short machine still runs one lane when nothing else runs, so work cannot starve", () => {
	const alone = agentLimits({ ...mac, availableGb: 3 }, none);
	expect(alone).toMatchObject({ lanes: 1, workers: 1 });
	expect(alone.reason).toBeUndefined();
	expect(agentLimits({ ...mac, availableGb: 3 }, { lanes: 1, workers: 0 })).toMatchObject({ lanes: 1, reason: "memory" });
});

test("cpu count bounds the agents when memory is plentiful", () => {
	const l = agentLimits({ totalGb: 64, availableGb: 60, cpus: 4 }, { lanes: 2, workers: 1 });
	expect(l).toMatchObject({ spare: 1, lanes: 3 });
	expect(agentLimits({ totalGb: 64, availableGb: 60, cpus: 4 }, { lanes: 2, workers: 2 })).toMatchObject({ lanes: 2, reason: "cpu" });
});

test("config values are hard caps, never raised and never the only number", () => {
	expect(agentLimits(mac, none, { lanes: 2, workers: 1 })).toMatchObject({ lanes: 2, workers: 1 });
	expect(agentLimits(mac, { lanes: 2, workers: 0 }, { lanes: 2 })).toMatchObject({ lanes: 2, reason: "cap" });
	expect(waitText("cap", { lanes: 2 })).toBe("동시 세션 한도(2개)에 도달해 대기 중");
	expect(agentLimits({ ...mac, availableGb: 16 }, none, { lanes: 10, workers: 10 })).toMatchObject({ lanes: 1, workers: 3 });
	expect(agentLimits(mac, none, { lanes: 0, workers: Number.NaN })).toMatchObject({ lanes: 4, workers: 2 });
});

test("macOS readings: vm_stat counts free + inactive + speculative pages, memory_pressure gives a fraction", () => {
	const vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      532227.\nPages active:     1083259.\nPages inactive:   1058652.\nPages speculative:  31260.\n";
	expect(vmStatAvailableBytes(vm)).toBe((532227 + 1058652 + 31260) * 16384);
	expect(vmStatAvailableBytes("nothing here")).toBeUndefined();
	expect(memoryPressureFreeFraction("System-wide memory free percentage: 87%")).toBe(0.87);
	expect(memoryPressureFreeFraction("")).toBeUndefined();
});

test("this machine's sample is sane", () => {
	const m = readMachine();
	expect(m.totalGb).toBeGreaterThan(0);
	expect(m.availableGb).toBeGreaterThan(0);
	expect(m.availableGb).toBeLessThanOrEqual(m.totalGb);
});
