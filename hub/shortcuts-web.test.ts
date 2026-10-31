import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The keyboard shortcuts, run on the real source text: Cmd/Ctrl+1..5 open the tabs (web/js/04-state.js) and Cmd/Ctrl+` goes to the
// next computer without the sheet (web/js/33-peers.js prNext). Only the page around the handlers is faked.
const web = (f: string) => readFileSync(join(import.meta.dir, "..", "web", "js", f), "utf8");
const state = web("04-state.js"), peers = web("33-peers.js");
const tabSrc = state.slice(state.indexOf("const isMac ="), state.indexOf("for (const [id, label] of navTabs())"));
const gwSrc = peers.slice(peers.indexOf("const prKeyHint"), peers.indexOf("// Tapping 홈 again"));
const navStart = state.indexOf("const NAV =");
const NAV = new Function(`${state.slice(navStart, state.indexOf(";\n", navStart) + 1)} return NAV;`)() as [string, string][];

type Handler = (ev: unknown) => void;
type Key = Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }>;
type Peer = { name: string; self?: boolean; online: boolean };

function fire(handlers: Handler[], k: Key) {
	let prevented = false;
	const ev = { key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...k, preventDefault: () => { prevented = true; } };
	for (const h of handlers) h(ev);
	return prevented;
}

function tabs(platform: string, o: { current?: string; dialog?: boolean; sheet?: boolean } = {}) {
	const handlers: Handler[] = [], log: string[] = [];
	const env: Record<string, unknown> = {
		navigator: { platform }, NAV, navOff: (id: string) => id === "apps", monCtx: "", current: o.current ?? "home", PR: { node: o.sheet ? {} : null },
		document: { addEventListener: (_: string, h: Handler) => handlers.push(h), querySelector: () => (o.dialog ? {} : null) },
		go: (v: string) => log.push(`go:${v}`), prClose: () => log.push("prClose"), lastChatView: () => "chat", chatTabEnter: () => log.push("chatEnter"),
	};
	const api = new Function(...Object.keys(env), `${tabSrc}\nreturn { navKeyHint };`)(...Object.values(env)) as { navKeyHint: (id: string) => string };
	return { ...api, handlers, log };
}

function gateways(platform: string, list: Peer[], o: { dialog?: boolean } = {}) {
	const handlers: Handler[] = [], log: string[] = [];
	const env: Record<string, unknown> = {
		isMac: /Mac/.test(platform), PR: { list }, selfDown: false,
		document: { addEventListener: (_: string, h: Handler) => handlers.push(h), querySelector: () => (o.dialog ? {} : null) },
		prPick: (p: Peer) => log.push(`pick:${p.name}`), toast: (m: string, bad?: boolean) => log.push(`toast:${bad ? "bad:" : ""}${m}`),
	};
	new Function(...Object.keys(env), gwSrc)(...Object.values(env));
	return { handlers, log };
}

describe("Cmd/Ctrl+1..6 tab shortcuts", () => {
	test("on a Mac Cmd+1..5 open 홈, 채팅, 프로젝트, 모니터링, 설정 in tab order; the hidden 앱 has no number, so Cmd+6 is left alone", () => {
		const t = tabs("MacIntel", { current: "settings" });
		for (const n of [1, 2, 3, 4, 5]) expect(fire(t.handlers, { key: String(n), code: `Digit${n}`, metaKey: true })).toBe(true);
		expect(fire(t.handlers, { key: "6", code: "Digit6", metaKey: true })).toBe(false);
		expect(t.log).toEqual(["go:home", "chatEnter", "go:projects", "go:monitoring", "go:settings"]);
	});

	test("Ctrl+1 does nothing on a Mac and Cmd+1 does nothing elsewhere; Ctrl+3 works elsewhere", () => {
		expect(fire(tabs("MacIntel").handlers, { key: "1", code: "Digit1", ctrlKey: true })).toBe(false);
		const win = tabs("Win32");
		expect(fire(win.handlers, { key: "1", code: "Digit1", metaKey: true })).toBe(false);
		expect(fire(win.handlers, { key: "3", code: "Digit3", ctrlKey: true })).toBe(true);
		expect(win.log).toEqual(["go:projects"]);
	});

	test("the key alone, 7, shift/alt, IME composition and an open dialog are left alone", () => {
		const t = tabs("MacIntel");
		for (const k of [{ key: "2", code: "Digit2" }, { key: "7", code: "Digit7", metaKey: true }, { key: "2", code: "Digit2", metaKey: true, shiftKey: true }, { key: "2", code: "Digit2", metaKey: true, altKey: true }, { key: "2", code: "Digit2", metaKey: true, isComposing: true }])
			expect(fire(t.handlers, k)).toBe(false);
		const d = tabs("MacIntel", { dialog: true });
		expect(fire(d.handlers, { key: "2", code: "Digit2", metaKey: true })).toBe(false);
		expect([t.log, d.log]).toEqual([[], []]);
	});

	test("on 채팅 the shortcut reopens the conversation; an open computer sheet closes for other tabs only", () => {
		const t = tabs("MacIntel", { current: "chat", sheet: true });
		fire(t.handlers, { key: "2", code: "Digit2", metaKey: true });
		fire(t.handlers, { key: "1", code: "Digit1", metaKey: true });
		expect(t.log).toEqual(["prClose", "go:chat", "go:home"]);
	});

	test("tooltips name the shortcut", () => {
		expect(tabs("MacIntel").navKeyHint("monitoring")).toBe("⌘4");
		expect(tabs("Win32").navKeyHint("settings")).toBe("Ctrl+5");
		expect(tabs("MacIntel").navKeyHint("apps")).toBe("");
		expect(tabs("Win32").navKeyHint("models")).toBe("");
	});
});

describe("Cmd/Ctrl+` next computer", () => {
	const three: Peer[] = [{ name: "맥북", self: true, online: true }, { name: "맥미니", online: true }, { name: "서버", online: true }];

	test("goes to the next computer in list order and wraps round", () => {
		const a = gateways("MacIntel", three);
		expect(fire(a.handlers, { key: "`", code: "Backquote", metaKey: true })).toBe(true);
		const last = gateways("Win32", [three[1]!, three[2]!, three[0]!]);
		fire(last.handlers, { key: "`", code: "Backquote", ctrlKey: true });
		expect(a.log).toEqual(["pick:맥미니"]);
		expect(last.log).toEqual(["pick:맥미니"]);
	});

	test("skips an offline computer; none online says so", () => {
		const a = gateways("MacIntel", [three[0]!, { ...three[1]!, online: false }, three[2]!]);
		fire(a.handlers, { key: "`", code: "Backquote", metaKey: true });
		expect(a.log).toEqual(["pick:서버"]);
		const b = gateways("MacIntel", [three[0]!, { ...three[1]!, online: false }]);
		expect(fire(b.handlers, { key: "`", code: "Backquote", metaKey: true })).toBe(true);
		expect(b.log).toEqual(["toast:bad:다른 컴퓨터에 연결할 수 없어요"]);
	});

	test("Ctrl+` also works on a Mac (Cmd+` may stay with macOS); Cmd+` does nothing elsewhere", () => {
		expect(fire(gateways("MacIntel", three).handlers, { key: "`", code: "Backquote", ctrlKey: true })).toBe(true);
		const win = gateways("Win32", three);
		expect(fire(win.handlers, { key: "`", code: "Backquote", metaKey: true })).toBe(false);
		expect(win.log).toEqual([]);
	});

	test("with one computer, a plain backtick, shift or an open dialog the key is not taken", () => {
		const one = gateways("MacIntel", [three[0]!]);
		expect(fire(one.handlers, { key: "`", code: "Backquote", metaKey: true })).toBe(false);
		const g = gateways("MacIntel", three);
		expect(fire(g.handlers, { key: "`", code: "Backquote" })).toBe(false);
		expect(fire(g.handlers, { key: "~", code: "Backquote", metaKey: true, shiftKey: true })).toBe(false);
		const d = gateways("MacIntel", three, { dialog: true });
		expect(fire(d.handlers, { key: "`", code: "Backquote", metaKey: true })).toBe(false);
		expect([one.log, g.log, d.log]).toEqual([[], [], []]);
	});
});
