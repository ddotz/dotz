import { afterAll, describe, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { type Adapter, installFanout, kindOf, type OutMsg, parseAskNumber, register, unregister } from "./messenger.ts";
import { flush } from "./runtime/test-clock.ts";

const fake = (id: string, over: Partial<Adapter> = {}): Adapter & { got: OutMsg[] } => {
	const got: OutMsg[] = [];
	return {
		id,
		label: id,
		enabled: () => true,
		status: { state: "ok" },
		start() {},
		stop() {},
		deliver: async m => {
			got.push(m);
			return { delivered: true };
		},
		canEdit: false,
		canButtons: false,
		got,
		...over,
	};
};
const post = (target: string, text: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target, text });

// All test files share one process: the fakes must not stay listed for the next file.
afterAll(() => ["plain", "native", "off", "bad", "sync", "good", "flaky"].forEach(unregister));

describe("kindOf", () => {
	test.each([
		["main", "main"],
		["web", "main"],
		["alert", "alert"],
		["worklog", "worklog"],
		["web:alert", "alert"],
		["web:worklog", "worklog"],
		["lane:build", "lane"],
		["ch:123", "project"],
		["th:456", "project"],
		["mail:abc", undefined],
		["settings:app", undefined],
	])("%s -> %s", (target, kind) => expect(kindOf(target)).toBe(kind as ReturnType<typeof kindOf>));
});

describe("fan-out", () => {
	test("reaches non-native adapters for chat targets only", async () => {
		const plain = fake("plain");
		const native = fake("native", { native: true });
		const off = fake("off", { status: { state: "off" } });
		register(plain);
		register(native);
		register(off);
		installFanout();
		for (const t of ["main", "ch:1", "alert", "web:alert", "mail:x"]) post(t, `hi ${t}`);
		post("main", "고르세요\n결정: 무엇?\n1) 가\n2) 나\n[file] /tmp/a.png");
		await flush();
		expect(plain.got.map(m => [m.target, m.kind])).toEqual([["main", "main"], ["ch:1", "project"], ["alert", "alert"], ["web:alert", "alert"], ["main", "main"]]);
		expect(plain.got[4]).toMatchObject({ files: ["/tmp/a.png"], options: [{ n: 1, label: "가" }, { n: 2, label: "나" }] });
		expect(native.got).toEqual([]);
		expect(off.got).toEqual([]);
	});

	test("a throwing adapter turns error and emit still works", async () => {
		const bad = fake("bad", { deliver: () => Promise.reject(new Error("down")) });
		const sync = fake("sync", {
			deliver: () => {
				throw new Error("boom");
			},
		});
		const good = fake("good");
		register(bad);
		register(sync);
		register(good);
		installFanout();
		expect(() => post("main", "after failure")).not.toThrow();
		await flush();
		expect(bad.status).toEqual({ state: "error", error: "Error: down" });
		expect(sync.status).toEqual({ state: "error", error: "Error: boom" });
		expect(good.got.map(m => m.text)).toEqual(["after failure"]);
	});

	test("a failed delivery does not mute the adapter; the next one that works sets it back to ok", async () => {
		let down = true;
		const flaky = fake("flaky", { deliver: async () => (down ? Promise.reject(new Error("lan")) : { delivered: true }) });
		register(flaky);
		installFanout();
		post("main", "first");
		await flush();
		expect(flaky.status.state).toBe("error");
		down = false;
		post("main", "second");
		await flush();
		expect(flaky.status).toEqual({ state: "ok" });
	});
});

describe("parseAskNumber", () => {
	test.each([
		["1", { n: 1 }],
		["1)", { n: 1 }],
		["1.", { n: 1 }],
		["2) 고치기", { n: 2 }],
		["2) 고치기 - 이유", { n: 2, note: "이유" }],
		["10개 주세요", undefined],
		["1등이야", undefined],
		["1.5배", undefined],
		["0", undefined],
		["", undefined],
	])("%j", (text, want) => expect(parseAskNumber(text)).toEqual(want));
});
