// Small conveniences of the input round (ux3 T3), headless (Bun.WebView) against a fake hub:
// - the files waiting in the composer stay with their conversation, like the typed text;
// - a phone shows 미답장 and 답장 안 함 of an open KakaoTalk room (its room head is hidden below 1100px);
// - 지켜보기 / 자동 초안 of another computer's room go to that computer as a peer act instead of failing;
// - opening the mail app while reply drafts wait lands on 확인 대기, and a filter the owner picks then stays;
// - a reply draft answered in place says what happened, with the next step (메일 열기 / 되돌리기).
// COMPOSER_SHOTS=<dir> keeps screenshots (default: none).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.COMPOSER_SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown, status = 200) => Response.json(v, { status });
const iso = (h: number) => new Date(Date.UTC(2026, 9, 27, h, 0)).toISOString();

const OPTS = [{ n: 1, label: "보내기", desc: "", rec: true }, { n: 2, label: "고치기", desc: "", rec: false, detail: true }, { n: 3, label: "보내지 않기", desc: "", rec: false }];
type Dec = { id: string; to: string; at: string; state: string; answer?: string };
let decisions: Dec[] = [];
const notice = (d: Dec) => ({ id: d.id, ts: d.at, updated: d.at, kind: "decision", tone: "ask", title: "이 답장 보낼까요?", text: "이 답장 보낼까요?", open: d.to, src: d.to, at: d.at, read: d.state !== "open", decision: { options: OPTS, to: d.to, reply_to: d.at, group: 1, state: d.state, ...(d.answer ? { answer: d.answer, answered_at: d.at } : {}), draft: { toLabel: "받는이", to: "Kim <kim@example.com>", subject: "Re: 견적", body: "안녕하세요." } } });
const waiting = () => decisions.filter(d => d.state === "open").length;
const MAIL_APP = () => ({ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: decisions.map(d => d.id), unread: 0, unreplied: 0, needs: { drafts: waiting(), unread: 0, sentToday: 0, unreplied: 0 } });
const KAKAO_APP = { key: "kakao", label: "카카오톡", icon: "kakao", kind: "app", conv: [], notices: [], unread: 0, unreplied: 1, needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 1 } };
const ROWS = ["fx-a", "fx-b"].map((key, i) => ({ target: `mail:${key}`, unread: 0, read: iso(1), mail: { subject: ["견적 요청", "일정 조율"][i], from: "Kim <kim@example.com>", source: "mail", at: iso(9 - i), summary: "요약이에요.", reply: "draft" }, last: { ts: iso(9 - i), text: "메일", from: "bot" } }));
const ROOM = { chatId: "100", name: "가족", kind: "group", watched: true, autoDraft: false, unread: 0, unreplied: true, lastAt: Date.UTC(2026, 9, 27, 2, 0) };

type Req = { method: string; path: string; body?: unknown };
let reqs: Req[] = [];
beforeEach(() => { reqs = []; });
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: waiting() });
		if (p === "/api/notices") return json({ items: decisions.map(notice), unread: waiting() });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }]);
		if (p === "/api/monitoring/peers") return json([]);
		if (p === "/api/integrations") return json({ items: [MAIL_APP(), KAKAO_APP], available: [] });
		if (p === "/api/conversations") return json({ items: ROWS });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [] });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: [ROOM] });
		if (p === "/api/kakao/chat/100" && req.method === "GET") return json({ room: { chatId: "100", name: "가족", kind: "group", group: true, watched: true }, messages: [], read: null, drafts: [], sends: [] });
		if (p === "/api/upload" && req.method === "POST") {
			const f = (await req.formData()).get("file") as File;
			return json({ ok: true, files: [{ path: `/uploads/${f.name}`, name: f.name, type: f.type, size: f.size }] });
		}
		if (/^\/api\/notices\/[^/]+\/answer$/.test(p) && req.method === "POST") {
			const b = (await req.json()) as { n: number }, id = decodeURIComponent(p.split("/")[3]!);
			const d = decisions.find(x => x.id === id), o = d && OPTS.find(x => x.n === b.n);
			if (!d || !o) return json({ error: "unknown" }, 404);
			reqs.push({ method: "POST", path: p, body: b });
			d.state = "answered"; d.answer = `${o.n}) ${o.label}`;
			return json({ ok: true, item: notice(d), unread: waiting() });
		}
		if (p === "/api/notices/reopen" && req.method === "POST") {
			const b = (await req.json()) as { ids: string[] };
			reqs.push({ method: "POST", path: p, body: b });
			for (const d of decisions) if (b.ids.includes(d.id)) { d.state = "open"; delete d.answer; }
			return json({ reopened: b.ids, unread: waiting() });
		}
		if (req.method !== "GET") { reqs.push({ method: req.method, path: p, body: await req.json().catch(() => null) }); return json({ ok: true }); }
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
const open = (width: number, height: number): View => { const v = new Bun.WebView({ width, height }); views.push(v); return v; };
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 4000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };
const boot = async (v: View) => {
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && typeof INTG !== "undefined" && INTG.items.length === 2`);
};

describe("composer files per conversation", () => {
	const v = open(1280, 800);
	test("a file added in one conversation leaves the composer on switching away and comes back with its conversation", async () => {
		decisions = [];
		await boot(v);
		await run(v, `go("chat", MAIN)`);
		await waitFor(v, `current === "chat" && target === MAIN`);
		await run(v, `addFiles([new File(["hello"], "note.txt", { type: "text/plain" })])`);
		await waitFor(v, `ATT.length === 1 && ATT[0].file`);
		await run(v, `setTarget("mail:fx-a")`);
		expect(await q(v, `return { n: ATT.length, tray: $("#atray").hidden }`)).toEqual({ n: 0, tray: true });
		await run(v, `setTarget(MAIN)`);
		expect(await q(v, `return { names: ATT.map(a => a.name), tray: $("#atray").hidden, chip: $("#atray .fi-n").textContent }`)).toEqual({ names: ["note.txt"], tray: false, chip: "note.txt" });
	});
});

for (const [width, height, phone] of [[390, 844, true], [1280, 800, false]] as const) {
	describe(`open KakaoTalk room at ${width}px`, () => {
		const v = open(width, height);
		test(phone ? "the phone shows 미답장 and 답장 안 함 above the messages, and 답장 안 함 marks the room" : "the desktop keeps them in the room head only", async () => {
			decisions = [];
			ROOM.unreplied = true;
			await boot(v);
			await run(v, `go("monitoring", "i:kakao"); setTimeout(() => kkOpen("100"), 50)`);
			await waitFor(v, `KK.open === "100" && !KK.loading`);
			const shown = await q<{ owed: boolean; tags: string[]; head: boolean }>(v, `const o = $("#kk-owed"); return { owed: getComputedStyle(o).display !== "none" && o.offsetHeight > 0, tags: [...o.querySelectorAll(".tag.unreplied, .unrep-no")].map(n => n.textContent), head: getComputedStyle($("#kk-head")).display !== "none" }`);
			expect(shown).toEqual({ owed: phone, tags: ["미답장", "답장 안 함"], head: !phone });
			await shot(v, `kakao-owed-${width}.png`);
			if (!phone) return;
			await run(v, `$("#kk-owed .unrep-no").click()`);
			expect(await q<boolean>(v, `return $("#kk-owed").hidden`)).toBe(true);
			await waitFor(v, `[...document.querySelectorAll(".snack span")].some(s => s.textContent === "답장 안 함으로 표시했어요")`);
			expect(reqs.some(r => r.method === "POST" && r.path === "/api/kakao/chat/100/no-reply")).toBe(true);
		});
	});
}

describe("another computer's KakaoTalk room", () => {
	const v = open(1280, 800);
	test("지켜보기 and 자동 초안 of its room are sent to that computer as a peer act, not refused", async () => {
		decisions = [];
		await boot(v);
		const routed = await q(v, `const was = KK.pc; KK.pc = { name: "맥미니", url: "http://mini.test" }; try { return [pqRoute("/api/kakao/rooms/100", "PUT", { watched: false }), pqRoute("/api/kakao/rooms/100", "PUT", { autoDraft: true })]; } finally { KK.pc = was; }`);
		expect(routed).toEqual([
			[`/api/peer/proxy?pc=${encodeURIComponent("http://mini.test")}&p=${encodeURIComponent("/api/peer/act")}`, "POST", { action: "kakao", args: { op: "room", chatId: "100", watched: false } }],
			[`/api/peer/proxy?pc=${encodeURIComponent("http://mini.test")}&p=${encodeURIComponent("/api/peer/act")}`, "POST", { action: "kakao", args: { op: "room", chatId: "100", autoDraft: true } }],
		]);
		// this computer's own room keeps its plain PUT
		expect(await q(v, `return pqRoute("/api/kakao/rooms/100", "PUT", { watched: true })`)).toEqual(["/api/kakao/rooms/100", "PUT", { watched: true }]);
	});
});

describe("mail app landing", () => {
	const v = open(1280, 800);
	test("opening the mail app while a reply draft waits lands on 확인 대기; a filter picked there stays until the app is opened again", async () => {
		decisions = [{ id: "d1", to: "mail:fx-a", at: iso(8), state: "open" }];
		await boot(v);
		await run(v, `go("monitoring", "i:mail")`);
		await waitFor(v, `current === "monitoring" && document.querySelector('#mon-tl .mr-f.on')`);
		expect(await q<string>(v, `return document.querySelector("#mon-tl .mr-f.on").dataset.filter`)).toBe("pending");
		await run(v, `document.querySelector('#mon-tl .mr-f[data-filter="all"]').click()`);
		await waitFor(v, `document.querySelector('#mon-tl .mr-f.on').dataset.filter === "all"`);
		await run(v, `monSchedule()`);
		await waitFor(v, `!monRaf`);
		expect(await q<string>(v, `return document.querySelector("#mon-tl .mr-f.on").dataset.filter`)).toBe("all");
		await run(v, `go("monitoring", "i:kakao")`);
		await waitFor(v, `MON.sel === "i:kakao" && !monRaf`);
		await run(v, `go("monitoring", "i:mail")`);
		await waitFor(v, `MON.sel === "i:mail" && document.querySelector('#mon-tl .mr-f.on') && document.querySelector('#mon-tl .mr-f.on').dataset.filter === "pending"`);
	});
	test("with no draft waiting the mail app opens on 전체, not on an empty 확인 대기", async () => {
		decisions = [];
		await boot(v);
		await run(v, `MON.mailFilter = "pending"; go("monitoring", "i:mail")`);
		await waitFor(v, `current === "monitoring" && document.querySelector('#mon-tl .mr-f.on')`);
		expect(await q<string>(v, `return document.querySelector("#mon-tl .mr-f.on").dataset.filter`)).toBe("all");
	});
});

describe("inline draft answer toast", () => {
	const v = open(1280, 800);
	test("보내기 says 보냈어요 with 메일 열기, which opens the mail it answered", async () => {
		decisions = [{ id: "d1", to: "mail:fx-a", at: iso(8), state: "open" }];
		await boot(v);
		await run(v, `const n = NT.items.find(x => x.id === "d1"); answerInline(n, n.decision.options.find(o => o.label === "보내기"))`);
		await waitFor(v, `document.querySelector(".snack .sa")`);
		expect(await q(v, `const s = document.querySelector(".snack"); return { text: s.querySelector("span").textContent, act: s.querySelector(".sa").textContent, bad: s.classList.contains("bad") }`)).toEqual({ text: "보냈어요", act: "메일 열기", bad: false });
		await run(v, `document.querySelector(".snack .sa").click()`);
		await waitFor(v, `monCtx && target === "mail:fx-a"`);
	});
	test("보내지 않기 says 보내지 않았어요 with 되돌리기, which reopens the draft", async () => {
		decisions = [{ id: "d2", to: "mail:fx-b", at: iso(7), state: "open" }];
		await boot(v);
		await run(v, `const n = NT.items.find(x => x.id === "d2"); answerInline(n, n.decision.options.find(o => o.label === "보내지 않기"))`);
		await waitFor(v, `document.querySelector(".snack .sa")`);
		expect(await q(v, `const s = document.querySelector(".snack"); return { text: s.querySelector("span").textContent, act: s.querySelector(".sa").textContent }`)).toEqual({ text: "보내지 않았어요", act: "되돌리기" });
		await run(v, `document.querySelector(".snack .sa").click()`);
		await waitFor(v, `NT.items.some(x => x.id === "d2" && x.decision.state === "open")`);
		expect(reqs.filter(r => r.path === "/api/notices/reopen").map(r => r.body)).toEqual([{ ids: ["d2"] }]);
	});
});
