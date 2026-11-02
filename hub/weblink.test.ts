import { afterEach, describe, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { type Adapter, installFanout, type OutMsg, register } from "./messenger.ts";
import { flush } from "./runtime/test-clock.ts";
import { cfBase, convPath, setWebBase, webBase, webLink } from "./weblink.ts";

const got: OutMsg[] = [];
const fake: Adapter = { id: "weblink-fake", label: "fake", enabled: () => true, status: { state: "ok" }, start() {}, stop() {}, deliver: async m => (got.push(m), { delivered: true }), canEdit: false, canButtons: false };
register(fake);
installFanout();
const post = async (target: string, text = "hi") => {
	got.length = 0;
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target, text });
	await flush();
	return got[0];
};
afterEach(() => setWebBase(undefined));

describe("cloudflare web base", () => {
	test("the hostname becomes the base of file links and every other link", () => {
		setWebBase(cfBase("dotz.example.com"));
		expect(webBase()).toBe("https://dotz.example.com");
		expect(webLink(`/api/file?path=${encodeURIComponent("/a b.txt")}&dl=1`)).toBe("https://dotz.example.com/api/file?path=%2Fa%20b.txt&dl=1");
	});
	test("a scheme or slashes around the hostname are tolerated, anything that is not a host name is refused", () => {
		expect(cfBase("https://dotz.example.com/")).toBe("https://dotz.example.com");
		expect(cfBase("dotz.example.com/path")).toBeUndefined();
		expect(cfBase("a b")).toBeUndefined();
		expect(cfBase(undefined)).toBeUndefined();
	});
	test("without a base there is no link", () => {
		expect(webLink("/")).toBeUndefined();
	});
});

describe("messenger links", () => {
	test("main, project, alert and worklog messages carry their conversation's web address", async () => {
		setWebBase("https://dotz.example.com");
		expect((await post("web:alert"))?.link).toBe("https://dotz.example.com/#chat/alert");
		expect((await post("web:worklog"))?.link).toBe("https://dotz.example.com/#chat/worklog");
		expect((await post("ch:123"))?.link).toBe("https://dotz.example.com/#chat/ch:123");
		const main = await post("terminal");
		expect(main?.kind).toBe("main");
		expect(main?.link).toBe("https://dotz.example.com/#chat/main");
	});
	test("no base, no link, and the message still goes out", async () => {
		const m = await post("web:alert");
		expect(m).toBeDefined();
		expect(m?.link).toBeUndefined();
	});
	test("a conversation without a web chat route has no path", () => {
		expect(convPath("project", "th:9")).toBeUndefined();
		expect(convPath("lane", "lanes")).toBeUndefined();
	});
});
