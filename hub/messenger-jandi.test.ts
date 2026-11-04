import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAsk } from "./ask-normalize.ts";
import { parseChoices } from "./choices.ts";
import { NAME } from "./config.ts";
import type { Incoming } from "./messenger.ts";
import { commandOf } from "./jandi-selfchat.ts";
import { desiredRooms } from "./messenger-rooms.ts";
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
	test("project goes to the room of that project; one with no room falls back to the main room", async () => {
		captured.length = 0;
		await send("project", "ch:123", "p");
		expect(await send("project", "ch:999", "q")).toEqual({ delivered: true });
		expect(captured.map(c => [c.path, c.body.body])).toEqual([["/in/p1", "p"], ["/in/m1", "q"]]);
	});
	test("alert goes to the alert room", async () => {
		captured.length = 0;
		await send("alert", "web:alert", "경고");
		expect(captured.map(c => c.path)).toEqual(["/in/a1"]);
		expect(roomStatus().a1?.last_out).toBeNumber();
	});
	test("options missing from the text are added to it, numbered, with a hint", async () => {
		captured.length = 0;
		await send("alert", "alert", "[ask] 어떻게 할까요?", { options: [{ n: 1, label: "고치기" }, { n: 2, label: "미루기" }] });
		expect(captured[0]!.body).toEqual({ body: "❓ 어떻게 할까요?\n\n1) 고치기\n2) 미루기\n\n번호로 답해 주세요", connectColor: "#FAC11B" });
	});
	test("a choice block shows its options once, in the text, and the reply is still a number", async () => {
		captured.length = 0;
		const text = normalizeAsk("영어 문장이 섞여 나갔어요.\n\n어떻게 할까요?\n1) 영어 문장 걸러 내기 - 컴퓨터에 적용하고 PR로 올려요\n2) 다른 수정 - 고칠 화면이나 증상을 알려 주시면 그것부터 할게요");
		const options = parseChoices(text).options.map(o => ({ n: o.n, label: o.label }));
		expect(options).toHaveLength(2);
		await send("main", "main", text, { options });
		expect(captured).toHaveLength(1);
		const b = captured[0]!.body;
		expect(b.connectInfo).toBeUndefined();
		expect(b.body.startsWith("❓ 영어 문장이 섞여 나갔어요.")).toBe(true);
		expect(b.body.match(/영어 문장 걸러 내기/g)).toHaveLength(1);
		expect(b.body).toContain("**2) 다른 수정 …**");
		expect(b.body.endsWith("번호로 답해 주세요")).toBe(true);
		const inbound = await hook("a1", { data: "1" });
		expect(inbound.status).toBe(200);
		expect(received.at(-1)).toMatchObject({ target: "alert", text: "1" });
	});
	test("a closing line that already asks for a number is not repeated", async () => {
		captured.length = 0;
		const text = "[ask] 어떻게 할까요?\n결정: 배포 시점\n**1) 지금**\n**2) 내일**\n번호로 답해 주세요";
		await send("main", "main", text, { options: parseChoices(text).options.map(o => ({ n: o.n, label: o.label })) });
		expect(captured[0]!.body.body.match(/번호로 답/g)).toHaveLength(1);
	});
	test("a status marker becomes its emoji, and a bracket that is content stays", async () => {
		captured.length = 0;
		await send("main", "main", "[done] 까르띠에 로그인을 해 뒰어요. [1]번 항목 참고");
		await send("main", "main", "[fail] 세션을 다시 띄우지 못했어요");
		expect(captured.map(c => c.body.body)).toEqual(["✅ 까르띠에 로그인을 해 뒰어요. [1]번 항목 참고", "❌ 세션을 다시 띄우지 못했어요"]);
	});
	test("what is not for the owner is never posted", async () => {
		captured.length = 0;
		for (const text of [
			"-",
			"ok",
			"[later]",
			"[run] Aside를 살려서 재고 감시를 1분 간격으로 걸어 뒴어요.",
			"[dotz gateway] 연결 확인입니다. 아무 작업도 하지 말고 '-' 한 글자로만 답하세요.",
			"[gateway check] [done] not accepted yet, sent back to the session:\n- NOT landed lane/mail-ui",
			`${NAME} 몫: 없음`,
		]) expect(await send("main", "main", text)).toEqual({ delivered: false, reason: "internal" });
		expect(await send("main", "web", "백그라운드 작업으로 맡겼어요: IFRS18 취합", { gatewayNote: true })).toEqual({ delivered: false, reason: "internal" });
		expect(captured).toHaveLength(0);
	});
	test("gateway, role and subtext lines leave the answer, which still goes out", async () => {
		captured.length = 0;
		await send("main", "main", `[done] 끝났어요.\n[dotz gateway] 작업 중에 새 메시지가 도착했어요\nFor ${NAME}: 없음\n-# ⚠️ 받는이 확인: boss@corp.test`);
		expect(captured[0]!.body.body).toBe("✅ 끝났어요.\n⚠️ 받는이 확인: boss@corp.test");
	});
	test("a code fence keeps its text as written", async () => {
		captured.length = 0;
		const text = "로그예요:\n```\n[dotz gateway] x\n-# y\n```";
		await send("main", "main", text);
		expect(captured[0]!.body.body).toBe(text);
	});
	test("a post that was only an attachment still says something", async () => {
		captured.length = 0;
		await send("main", "main", "[file] /Users/x/report.pdf", { files: ["/Users/x/report.pdf"] });
		expect(captured[0]!.body.body).toBe("첨부 파일은 웹에서 볼 수 있어요");
	});
	test("a web link becomes a connectInfo line", async () => {
		captured.length = 0;
		await send("main", "main", "끝났어요", { link: "https://dotz.example.com/#chat/main" });
		expect(captured[0]!.body.connectInfo).toEqual([{ title: "웹에서 보기", description: "https://dotz.example.com/#chat/main" }]);
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
	test("a self-chat reply prefix starts every posted part, still under 4000 chars", async () => {
		const cfg = loadJandiConfig(dir);
		saveJandiConfig({ ...cfg, self_chat: { enabled: true, team_id: 0, room_id: 0, member_id: 0, bot_id: 0, keyword: "work", reply_prefix: "[work]", session_secret: "jandi-session", interval_ms: 3000 } }, dir);
		try {
			captured.length = 0;
			await send("main", "main", "x".repeat(5000));
			expect(captured.map(c => c.body.body.startsWith("[work] "))).toEqual([true, true]);
			expect(captured.every(c => c.body.body.length <= 4000)).toBe(true);
		} finally {
			saveJandiConfig(cfg, dir);
		}
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

describe("rooms from the web structure", () => {
	const PROJECTS = [{ target: "ch:7", name: "결제" }, { target: "ch:8", name: "정산" }];
	const fresh = (cfg: object) => {
		const d = mkdtempSync(join(tmpdir(), "jandi-rooms-"));
		mkdirSync(join(d, "messengers"), { recursive: true });
		writeFileSync(jandiConfigPath(d), JSON.stringify(cfg));
		return { d, a: createJandiAdapter(d), cleanup: () => rmSync(d, { recursive: true, force: true }) };
	};
	const shape = (d: string) => loadJandiConfig(d).rooms.map(r => [r.kind, r.project ?? "", r.name]);

	test("switching it on maps main, alert, worklog and every project; nothing is sent and no webhook is invented", async () => {
		const t = fresh({ enabled: true, listen: { host: "127.0.0.1", port: 0 }, allow_emails: [], rooms: [] });
		try {
			await t.a.syncRooms!(desiredRooms(PROJECTS));
			expect(shape(t.d)).toEqual([["main", "", "메인 대화"], ["alert", "", "알림"], ["worklog", "", "작업내역"], ["project", "ch:7", "결제"], ["project", "ch:8", "정산"]]);
			const rooms = loadJandiConfig(t.d).rooms;
			expect(new Set(rooms.map(r => r.id)).size).toBe(5);
			expect(rooms.every(r => r.incoming_url === "" && r.outgoing_token.length >= 16)).toBe(true);
			expect(t.a.enabled()).toBe(true);
			const rs = t.a.settings!().rooms!;
			expect(rs.hint).toContain("남은 일");
			expect(rs.items.map(r => [r.kind, r.project?.target ?? ""])).toEqual([["main", ""], ["alert", ""], ["worklog", ""], ["project", "ch:7"], ["project", "ch:8"]]);
			const before = statSync(jandiConfigPath(t.d)).mtimeMs;
			await t.a.syncRooms!(desiredRooms(PROJECTS));
			expect(statSync(jandiConfigPath(t.d)).mtimeMs).toBe(before);
		} finally {
			t.cleanup();
		}
	});

	test("it does nothing while switched off", async () => {
		const t = fresh({ enabled: false, rooms: [] });
		try {
			await t.a.syncRooms!(desiredRooms(PROJECTS));
			expect(loadJandiConfig(t.d).rooms).toEqual([]);
		} finally {
			t.cleanup();
		}
	});

	test("adding a project adds its room; removing it drops the room unless the owner entered a webhook for it", async () => {
		const t = fresh({ enabled: true, rooms: [] });
		try {
			await t.a.syncRooms!(desiredRooms(PROJECTS.slice(0, 1)));
			expect(shape(t.d).map(r => r[1]).filter(Boolean)).toEqual(["ch:7"]);
			await t.a.syncRooms!(desiredRooms(PROJECTS));
			expect(shape(t.d).map(r => r[1]).filter(Boolean)).toEqual(["ch:7", "ch:8"]);
			const keep = loadJandiConfig(t.d);
			saveJandiConfig({ ...keep, rooms: keep.rooms.map(r => (r.project === "ch:8" ? { ...r, incoming_url: "http://in/8" } : r)) }, t.d);
			await t.a.syncRooms!(desiredRooms([]));
			expect(shape(t.d).map(r => r[1]).filter(Boolean)).toEqual(["ch:8"]);
			expect(loadJandiConfig(t.d).rooms.map(r => r.kind)).toEqual(["main", "alert", "worklog", "project"]);
		} finally {
			t.cleanup();
		}
	});

	test("an old config file loads with its keys and rooms, and sync keeps them", async () => {
		const old = {
			enabled: true,
			listen: { host: "127.0.0.1", port: 0 },
			allow_emails: ["boss@corp.test"],
			rooms: [
				{ id: "legacy", name: "예전 메인", kind: "main", outgoing_token: "tok-old", incoming_url: "http://in/legacy" },
				{ id: "pj", name: "예전 프로젝트", kind: "project", project: "ch:7", outgoing_token: "tok-pj", incoming_url: "" },
			],
		};
		const t = fresh(old);
		try {
			const cfg = loadJandiConfig(t.d);
			expect(cfg.rooms.map(r => [r.id, r.outgoing_token, r.incoming_url])).toEqual([["legacy", "tok-old", "http://in/legacy"], ["pj", "tok-pj", ""]]);
			expect(cfg.incoming_url).toBeUndefined();
			await t.a.syncRooms!(desiredRooms(PROJECTS));
			const after = loadJandiConfig(t.d).rooms;
			expect(after.slice(0, 2).map(r => [r.id, r.name, r.outgoing_token, r.incoming_url])).toEqual([["legacy", "예전 메인", "tok-old", "http://in/legacy"], ["pj", "예전 프로젝트", "tok-pj", ""]]);
			expect(after.map(r => r.kind)).toEqual(["main", "project", "alert", "worklog", "project"]);
		} finally {
			t.cleanup();
		}
	});

	test("one default webhook serves every room that has none, and a project without a room still reaches main; a lane's progress has no room but its result and question reach main", async () => {
		const seen: string[] = [];
		const hook = Bun.serve({ port: 0, async fetch(req) { seen.push(`${new URL(req.url).pathname} ${(await req.json()).body}`); return new Response("{}"); } });
		const t = fresh({ enabled: true, rooms: [], incoming_url: `http://127.0.0.1:${hook.port}/in/default` });
		try {
			await t.a.syncRooms!(desiredRooms(PROJECTS));
			expect(t.a.settings!().rooms!.hint).toBeUndefined();
			expect(await t.a.deliver({ kind: "alert", target: "web:alert", text: "a" })).toEqual({ delivered: true });
			expect(await t.a.deliver({ kind: "project", target: "ch:999", text: "p" })).toEqual({ delivered: true });
			expect(await t.a.deliver({ kind: "lane", target: "lane:x", text: "l" })).toEqual({ delivered: false, reason: "no room" });
			expect(await t.a.deliver({ kind: "lane", target: "lane:x", text: "[fail] 못 했어요" })).toEqual({ delivered: true });
			expect(await t.a.deliver({ kind: "lane", target: "lane:x", text: "[ask] 어느 쪽?" })).toEqual({ delivered: true });
			expect(seen).toEqual(["/in/default a", "/in/default p", "/in/default ❌ 못 했어요", "/in/default ❓ 어느 쪽?"]);
			expect(t.a.settings!().fields.find(f => f.key === "incoming_url")).toMatchObject({ type: "secret", set: true });
			expect(JSON.stringify(t.a.settings!())).not.toContain("/in/default");
			const cleared = t.a.saveSettings!({ values: { incoming_url: "" } });
			expect(cleared.fields.find(f => f.key === "incoming_url")?.set).toBe(false);
			expect(() => t.a.saveSettings!({ values: { incoming_url: "ftp://x" } })).toThrow();
		} finally {
			hook.stop(true);
			t.cleanup();
		}
	});

	test("with no webhook anywhere a message is reported undelivered, not lost silently", async () => {
		const t = fresh({ enabled: true, rooms: [] });
		try {
			await t.a.syncRooms!(desiredRooms(PROJECTS));
			expect(await t.a.deliver({ kind: "main", target: "main", text: "x" })).toEqual({ delivered: false, reason: "no room" });
		} finally {
			t.cleanup();
		}
	});
});

describe("self-chat keyword", () => {
	// The owner's real messages that never reached dotz: a Korean call ("곰돌아 ...") and a command glued to the keyword ("곰돌/login ...").
	test("a call form or a slash command right after the keyword is still a command", () => {
		expect(commandOf("곰돌아 근데 휴넷 체크해줘", "곰돌")).toBe("근데 휴넷 체크해줘");
		expect(commandOf("곰돌야, 휴넷 체크해줘", "곰돌")).toBe("휴넷 체크해줘");
		expect(commandOf("곰돌, 휴넷 체크해줘", "곰돌")).toBe("휴넷 체크해줘");
		expect(commandOf("곰돌/login anthropic", "곰돌")).toBe("/login anthropic");
		expect(commandOf("곰돌 휴넷 체크해줘", "곰돌")).toBe("휴넷 체크해줘");
	});
	test("a message without the keyword, or a longer word that starts with it, is not", () => {
		expect(commandOf("휴넷 수강 다 했는지 확인해줘", "곰돌")).toBeUndefined();
		expect(commandOf("곰돌들 다 어디 갔어", "곰돌")).toBeUndefined();
		expect(commandOf("곰돌아", "곰돌")).toBeUndefined();
		expect(commandOf("dotzz 안녕", "dotz")).toBeUndefined();
	});
});
