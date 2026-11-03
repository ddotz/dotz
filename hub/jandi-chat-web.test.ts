import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A JANDI computer picked in the computer list stays in the chat view (web/js/42-jandi-chat.js, prPick in 33-peers.js): the real source text, run
// against fakes for the page (api, the timeline, the target state). No network.
const js = (f: string) => readFileSync(join(import.meta.dir, "..", "web", "js", f), "utf8");
const home = js("08-home.js"), peers = js("33-peers.js"), chat = js("42-jandi-chat.js");
const decl = home.slice(home.indexOf("const isJandiT"), home.indexOf("const mailSender"));
const pick = peers.slice(peers.indexOf("function prPick(p, o = {}) {"), peers.indexOf("function prSheet"));

type Line = { id: number; at: number; me: boolean; text: string };
type Row = { name: string; url: string; self: boolean; online: boolean; via?: "jandi" };
const SELF: Row = { name: "main-pc", url: "https://main:8443", self: true, online: true };
const WORK: Row = { name: "work", url: "/jandi-peer/work", self: false, online: true, via: "jandi" };
const T0 = Date.UTC(2026, 10, 3, 1, 0, 0);

function page(answers: Record<string, unknown>) {
	const calls: Array<{ path: string; method: string; body?: unknown }> = [];
	const TS: Record<string, any> = {};
	const tl = { kids: [] as any[], append(...n: any[]) { this.kids.push(...n); } };
	const el = (tag: string, props: Record<string, unknown>, ...kids: any[]) => ({ tag, ...props, kids });
	const classes = new Set<string>(), nodes: Record<string, any> = { "#jpnote": { hidden: true }, "#brand-name": { textContent: "bot" }, "#send-btn": { disabled: false } };
	const ticks: Array<() => void> = [];
	const ta: any = { value: "", placeholder: "메시지 또는 /명령", disabled: false };
	const log = { renders: 0, toasts: [] as string[], gone: [] as string[], location: "https://main:8443/" };
	const env: Record<string, unknown> = {
		api: async (path: string, method = "GET", body?: unknown) => {
			calls.push({ path, method, body });
			const a = answers[path];
			if (a instanceof Error) throw a;
			return a ?? { ok: true };
		},
		ts: (t: string) => (TS[t] ??= { msgs: [], mk: new Set(), draft: "", loading: null }),
		msgKey: (e: any) => `${e.ts}|${e.kind}|${String(e.text).slice(0, 60)}`,
		enc: encodeURIComponent, tl, el, ta,
		$: (s: string) => nodes[s], document: { body: { classList: { toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)) } }, hidden: false, addEventListener: () => {} },
		renderAll: () => { log.renders++; }, scrollChat: () => {}, autosize: () => {}, updateHints: () => {},
		DRAFT_KEY: (t: string) => `d:${t}`, localStorage: { removeItem: () => {} }, setInterval: (fn: () => void) => void ticks.push(fn),
		toast: (m: string) => log.toasts.push(m), prClose: () => {}, prEmbedded: false, selfDown: false, window: {}, prGo: () => {}, prUrl: () => "", DEVICE_ID: "d1",
		PR: { list: [SELF, WORK] }, location: { get href() { return log.location; }, set href(v: string) { log.location = v; } },
		botName: "bot", validTarget: (t: string) => t === "main" || t.startsWith("jandi:") || t.startsWith("lane:"),
	};
	const body = `let target = "main", current = "chat", chatList = false, chatStick = false; const MAIN = "main";
	${decl}
	const targetName = t => (isJandiT(t) ? JP.name[t] || t.slice(6) : "bot");
	const gone = [];
	const go = (name, tgt) => { gone.push([name, tgt]); if (tgt && validTarget(tgt)) target = tgt; current = name; jpPaint(); };
	${chat}
	${pick}
	return { jpLoad, jpSend, jpPaint, jpTail, prPick, JP, gone, set: (t, c) => { target = t; current = c; }, now: () => target };`;
	const api = new Function(...Object.keys(env), body)(...Object.values(env)) as {
		jpLoad(t: string, quiet?: boolean): Promise<void>; jpSend(text: string): Promise<void>; jpPaint(): void; jpTail(s: any): void; prPick(p: Row): void;
		JP: { name: Record<string, string>; back: string }; gone: Array<[string, string]>; now(): string; set(t: string, c: string): void;
	};
	return { ...api, ticks, calls, TS, tl, classes, ta, nodes, log };
}

const MSGS = "/api/jandi-peer/work/messages", SEND = "/api/jandi-peer/work/send";
const lines: Line[] = [{ id: 1, at: T0, me: true, text: "빌드 상태 알려줘" }, { id: 2, at: T0 + 5000, me: false, text: "**통과**했어요" }];

describe("a JANDI computer in the chat view", () => {
	test("picking its row enters the chat view of that computer and does not navigate", () => {
		const p = page({});
		p.prPick(WORK);
		expect(p.gone).toEqual([["chat", "jandi:work"]]);
		expect(p.now()).toBe("jandi:work");
		expect(p.log.location).toBe("https://main:8443/");
		expect(p.JP.name["jandi:work"]).toBe("work");
		expect(p.classes.has("jp")).toBe(true);
		expect(p.nodes["#brand-name"].textContent).toBe("work");
		expect(p.nodes["#jpnote"].hidden).toBe(false);
		expect(p.ta.placeholder).toContain("work");
	});

	test("its lines become the owner's messages and the computer's replies of the ordinary conversation", async () => {
		const p = page({ [MSGS]: lines });
		p.prPick(WORK);
		await p.jpLoad("jandi:work");
		const s = p.TS["jandi:work"];
		expect(s.msgs.map((e: any) => [e.kind, e.text])).toEqual([["message", "빌드 상태 알려줘"], ["out", "**통과**했어요"]]);
		expect(s.msgs[0].ts).toBe(new Date(T0).toISOString());
		expect(s.msgs[1].peer).toBe("work");
		expect(s.hLoaded && s.aLoaded).toBe(true);
		expect(p.log.renders).toBe(1);
		expect(p.calls.map(c => c.path)).toEqual([MSGS]);
	});

	test("a quiet poll redraws only when something changed", async () => {
		const p = page({ [MSGS]: lines });
		p.prPick(WORK);
		await p.jpLoad("jandi:work");
		await p.jpLoad("jandi:work", true);
		expect(p.log.renders).toBe(1);
	});

	test("it polls its lines only while it is the open chat", async () => {
		const p = page({ [MSGS]: lines });
		p.ticks[0]!();
		expect(p.calls).toEqual([]);
		p.prPick(WORK);
		p.ticks[0]!();
		await p.jpLoad("jandi:work", true);
		expect(p.calls.map(c => c.path)).toEqual([MSGS]);
	});

	test("sending posts to the peer's send endpoint, never to the local chat API, and shows a pending line until the owner line appears", async () => {
		const answers: Record<string, unknown> = { [MSGS]: lines };
		const p = page(answers);
		p.prPick(WORK);
		await p.jpLoad("jandi:work");
		p.ta.value = "다음 작업";
		await p.jpSend("다음 작업");
		expect(p.calls.filter(c => c.method === "POST")).toEqual([{ path: SEND, method: "POST", body: { text: "다음 작업" } }]);
		expect(p.calls.some(c => c.path.startsWith("/api/message"))).toBe(false);
		expect(p.ta.value).toBe("");
		const s = p.TS["jandi:work"];
		expect(s.jpend.map((x: any) => x.text)).toEqual(["다음 작업"]);
		p.tl.kids.length = 0;
		p.jpTail(s);
		expect(p.tl.kids.map((n: any) => n.class)).toEqual(["um jp-pend"]);
		expect(JSON.stringify(p.tl.kids)).toContain("보내는 중");
		answers[MSGS] = [...lines, { id: 3, at: T0 + 9000, me: true, text: "다음 작업" }];
		await p.jpLoad("jandi:work", true);
		expect(s.jpend).toEqual([]);
		expect(s.msgs.map((e: any) => e.text)).toContain("다음 작업");
	});

	test("an endpoint error is an error line in the chat, not an empty conversation; a failed send gives the text back", async () => {
		const p = page({ [MSGS]: Object.assign(new Error("잔디에 연결하지 못했어요"), {}), [SEND]: new Error("너무 길어요") });
		p.prPick(WORK);
		await p.jpLoad("jandi:work");
		const s = p.TS["jandi:work"];
		expect(s.hLoaded).toBe(true);
		p.tl.kids.length = 0;
		p.jpTail(s);
		expect(p.tl.kids.map((n: any) => [n.class, n.text])).toEqual([["a-error", "잔디: 잔디에 연결하지 못했어요"]]);
		await p.jpSend("보낼 글");
		expect(s.jpend).toEqual([]);
		expect(s.jserr).toBe("보내지 못했어요: 너무 길어요");
		expect(p.ta.value).toBe("보낼 글");
		p.tl.kids.length = 0;
		p.jpTail(s);
		expect(p.tl.kids.map((n: any) => n.text)).toEqual(["잔디: 잔디에 연결하지 못했어요", "보내지 못했어요: 너무 길어요"]);
	});

	test("picking this computer again returns to the conversation the owner came from", () => {
		const p = page({});
		p.set("lane:dev", "chat");
		p.prPick(WORK);
		expect(p.JP.back).toBe("lane:dev");
		p.prPick(SELF);
		expect(p.gone).toEqual([["chat", "jandi:work"], ["chat", "lane:dev"]]);
		expect(p.now()).toBe("lane:dev");
		expect(p.classes.has("jp")).toBe(false);
		expect(p.nodes["#brand-name"].textContent).toBe("bot");
		expect(p.nodes["#jpnote"].hidden).toBe(true);
	});

	test("the local chat is untouched while no JANDI computer is picked", () => {
		const p = page({});
		p.prPick(SELF);
		p.jpPaint();
		expect(p.gone).toEqual([]);
		expect(p.calls).toEqual([]);
		expect(p.classes.has("jp")).toBe(false);
		expect(p.ta.placeholder).toBe("메시지 또는 /명령");
		expect(p.nodes["#brand-name"].textContent).toBe("bot");
	});
});
