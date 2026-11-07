import { afterAll, describe, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { type Adapter, installFanout, kindOf, type OutMsg, parseAskNumber, register, unregister } from "./messenger.ts";
import { flush } from "./runtime/test-clock.ts";
import { setWebBase } from "./weblink.ts";

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
afterAll(() => ["notes", "plain", "native", "off", "bad", "sync", "good", "flaky", "line", "own"].forEach(unregister));

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

	test("gateway records are marked as notes; asks, alerts, failures and answers are not", async () => {
		const plain = fake("notes");
		register(plain);
		installFanout();
		const gateway = (target: string, text: string, extra: Record<string, unknown> = {}) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "gateway", target, text, ...extra });
		gateway("main", "백그라운드 작업으로 맡겼어요: 월간 보고서 정리", { system: "deferred" });
		gateway("web", "게이트웨이를 다시 시작했어요 (오후 11:34 KST).");
		gateway("worklog", "게이트웨이를 다시 시작했어요 (오후 11:34 KST).");
		gateway("web", "[ask] 가져올까요?");
		gateway("worklog", "[fail] 세션을 다시 띄우지 못했어요");
		gateway("alert", "땅콩: 사용량 한도에 걸려서 멈췄어요.");
		gateway("main", "지금 사용량 한도로 멈춰 있어요.");
		post("web", "답이에요");
		await flush();
		expect(plain.got.map(m => !!m.gatewayNote)).toEqual([true, true, true, false, false, false, false, false]);
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
		["1.\n[attachment] a.png (image/png) https://files.jandi.com/a", undefined],
	])("%j", (text, want) => expect(parseAskNumber(text)).toEqual(want));
});

describe("web link", () => {
	test("an adapter that does not place the link itself gets it as the last line; one that does gets msg.link; no address, no link", async () => {
		const line = fake("line");
		const own = fake("own", { ownsLink: true });
		register(line);
		register(own);
		installFanout();
		setWebBase("https://dotz.example.com");
		try {
			post("main", "끝났어요");
			await flush();
		} finally {
			setWebBase(undefined);
		}
		post("main", "주소 없음");
		await flush();
		expect(line.got.map(m => [m.text, m.link])).toEqual([["끝났어요\n\n웹에서 보기: https://dotz.example.com/#chat/main", undefined], ["주소 없음", undefined]]);
		expect(own.got.map(m => [m.text, m.link])).toEqual([["끝났어요", "https://dotz.example.com/#chat/main"], ["주소 없음", undefined]]);
	});
});
