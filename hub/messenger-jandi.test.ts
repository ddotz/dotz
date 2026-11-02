import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Incoming } from "./messenger.ts";
import { createJandiAdapter, type JandiAdapter, jandiConfigPath, loadJandiConfig, roomStatus, saveJandiConfig, splitText } from "./messenger-jandi.ts";

type Captured = { path: string; headers: Headers; body: any };

let dir: string;
let adapter: JandiAdapter;
let incoming: ReturnType<typeof Bun.serve>;
let captured: Captured[];
let received: Incoming[];

const TOKENS = { m1: "tok-main", p1: "tok-proj", a1: "tok-alert", w1: "tok-work" } as const;
const url = (id: string) => `http://127.0.0.1:${adapter.port()}/jandi/${id}`;
const hook = (id: keyof typeof TOKENS, over: Record<string, unknown> = {}, token: string = TOKENS[id]) =>
	fetch(url(id), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token, teamName: "t", roomName: "r", writer: { id: "1", name: "홍길동", email: "Boss@Corp.test" }, text: "/땅콩 안녕", data: "안녕", keyword: "/땅콩", createdAt: "x", platform: "web", ...over }),
	});

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "jandi-test-"));
	captured = [];
	received = [];
	incoming = Bun.serve({
		port: 0,
		async fetch(req) {
			captured.push({ path: new URL(req.url).pathname, headers: req.headers, body: await req.json() });
			return new Response("{}");
		},
	});
	const hookUrl = (id: string) => `http://127.0.0.1:${incoming.port}/in/${id}`;
	saveJandiConfig(
		{
			enabled: true,
			listen: { host: "127.0.0.1", port: 0 },
			allow_emails: ["boss@corp.test"],
			allow_names: ["이름만"],
			rooms: [
				{ id: "m1", name: "메인", kind: "main", outgoing_token: TOKENS.m1, incoming_url: hookUrl("m1") },
				{ id: "p1", name: "프로젝트", kind: "project", project: "ch:123", outgoing_token: TOKENS.p1, incoming_url: hookUrl("p1") },
				{ id: "a1", name: "알림", kind: "alert", outgoing_token: TOKENS.a1, incoming_url: hookUrl("a1") },
				{ id: "w1", name: "기록", kind: "worklog", outgoing_token: TOKENS.w1, incoming_url: hookUrl("w1") },
			],
		},
		dir,
	);
	adapter = createJandiAdapter(dir);
	await adapter.start({ receive: m => void received.push(m), log: () => {} });
});

afterAll(async () => {
	await adapter.stop();
	incoming.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
	test("is written 0600 and read back", () => {
		expect(statSync(jandiConfigPath(dir)).mode & 0o777).toBe(0o600);
		const c = loadJandiConfig(dir);
		expect(c.rooms.map(r => r.id)).toEqual(["m1", "p1", "a1", "w1"]);
		expect(c.allow_emails).toEqual(["boss@corp.test"]);
	});
	test("listener is up", () => {
		expect(adapter.status).toEqual({ state: "ok" });
		expect(adapter.enabled()).toBe(true);
	});
});

describe("inbound", () => {
	test("main room message from an allowlisted email", async () => {
		const res = await hook("m1");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ body: "받았어요", connectColor: "#FAC11B" });
		expect(received.at(-1)).toEqual({ adapter: "jandi", target: "main", text: "안녕", author: "boss@corp.test" });
	});
	test("project room targets its channel", async () => {
		await hook("p1");
		expect(received.at(-1)?.target).toBe("ch:123");
	});
	test("alert room reply is received as the plain number", async () => {
		await hook("a1", { data: "1", text: "/땅콩 1" });
		expect(received.at(-1)).toMatchObject({ target: "alert", text: "1" });
	});
	test("worklog room targets worklog", async () => {
		await hook("w1");
		expect(received.at(-1)?.target).toBe("worklog");
	});
	test("writerEmail wins over writer.email", async () => {
		const res = await hook("m1", { writerEmail: "other@corp.test" });
		expect(res.status).toBe(403);
	});
	test("bad token is 401 and nothing is received", async () => {
		const before = received.length;
		const res = await hook("m1", {}, "wrong");
		expect(res.status).toBe(401);
		expect(await res.text()).toBe("");
		expect(received.length).toBe(before);
	});
	test("non-allowlisted email is 403", async () => {
		const before = received.length;
		const res = await hook("m1", { writer: { id: "2", name: "x", email: "stranger@corp.test" } });
		expect(res.status).toBe(403);
		expect(received.length).toBe(before);
	});
	test("allow_names admits a sender without email", async () => {
		const res = await hook("m1", { writer: { id: "3", name: "이름만" } });
		expect(res.status).toBe(200);
		expect(received.at(-1)).toMatchObject({ target: "main", author: "이름만" });
		const denied = await hook("m1", { writer: { id: "4", name: "모르는사람" } });
		expect(denied.status).toBe(403);
	});
	test("bad JSON is 400, unknown room 404", async () => {
		expect((await fetch(url("m1"), { method: "POST", body: "{nope" })).status).toBe(400);
		expect((await fetch(url("zz"), { method: "POST", body: "{}" })).status).toBe(404);
	});
	test("room status records last_in and the auth error", () => {
		const s = roomStatus();
		expect(typeof s.m1?.last_in).toBe("number");
		expect(s.m1?.last_error).toBe("403 sender");
	});
});

describe("deliver", () => {
	const send = (kind: "main" | "project" | "alert" | "worklog", target: string, text: string, extra: Record<string, unknown> = {}) => adapter.deliver({ kind, target, text, ...extra });

	test("main goes to the main incoming URL with JANDI headers", async () => {
		captured.length = 0;
		expect(await send("main", "main", "안녕하세요")).toEqual({ delivered: true });
		expect(captured).toHaveLength(1);
		expect(captured[0]!.path).toBe("/in/m1");
		expect(captured[0]!.headers.get("accept")).toBe("application/vnd.tosslab.jandi-v2+json");
		expect(captured[0]!.headers.get("content-type")).toContain("application/json");
		expect(captured[0]!.body).toEqual({ body: "안녕하세요" });
	});
	test("project goes only to the room of that project", async () => {
		captured.length = 0;
		await send("project", "ch:123", "p");
		expect((await send("project", "ch:999", "q")).delivered).toBe(false);
		expect(captured.map(c => c.path)).toEqual(["/in/p1"]);
	});
	test("alert goes to the alert room", async () => {
		captured.length = 0;
		await send("alert", "web:alert", "경고");
		expect(captured.map(c => c.path)).toEqual(["/in/a1"]);
		expect(roomStatus().a1?.last_out).toBeNumber();
	});
	test("options become connectInfo lines and a hint", async () => {
		captured.length = 0;
		await send("alert", "alert", "[ask] 어떻게 할까요?", { options: [{ n: 1, label: "고치기" }, { n: 2, label: "미루기" }] });
		const b = captured[0]!.body;
		expect(b.body.endsWith("번호로 답해 주세요")).toBe(true);
		expect(b.connectInfo).toEqual([{ title: "선택지", description: "1) 고치기\n2) 미루기" }]);
	});
	test("progress edits are skipped", async () => {
		captured.length = 0;
		expect(await send("main", "main", "작업 중…", { updateKey: "progress" })).toEqual({ delivered: false, reason: "edit" });
		expect(captured).toHaveLength(0);
	});
	test("long text is split under 4000 chars", async () => {
		captured.length = 0;
		await send("worklog", "worklog", `${"가".repeat(3000)}\n${"나".repeat(3000)}`);
		expect(captured).toHaveLength(2);
		expect(captured.every(c => c.body.body.length <= 4000)).toBe(true);
		expect(splitText("x".repeat(9000)).map(p => p.length)).toEqual([4000, 4000, 1000]);
	});
	test("a failing incoming URL rejects without leaking the URL", async () => {
		const cfg = loadJandiConfig(dir);
		saveJandiConfig({ ...cfg, rooms: cfg.rooms.map(r => (r.id === "m1" ? { ...r, incoming_url: "http://127.0.0.1:1/secret-path" } : r)) }, dir);
		const err = await send("main", "main", "x").then(() => "", e => String(e));
		expect(err).not.toBe("");
		expect(err).not.toContain("secret-path");
		expect(roomStatus().m1?.last_error).not.toContain("secret-path");
	});
});
