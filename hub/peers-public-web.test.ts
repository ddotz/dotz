import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { i18nPrelude } from "./web-i18n.ts";

const web = (name: string): string => readFileSync(join(import.meta.dir, "..", "web", "js", name), "utf8");
const peers = web("33-peers.js");
const between = (src: string, from: string, to: string): string => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const others = between(peers, "const prOthers", "\n\n");

const RELAY = { name: "릴레이", url: "/#chat/relay:jandi:work", self: false, online: true, via: "jandi" };
const PUBLIC = { name: "공개", url: "https://pub.example", self: false, online: true, public: true };
const DIRECT = { name: "맥미니", url: "https://mini:8445", self: false, online: true };
const SELF = { name: "맥북", url: "https://mac:8443", self: true, online: true };

describe("a public computer on the web side", () => {
	test("the remote desktop list draws no button for it, and still draws one for a direct computer", () => {
		const row = between(web("37-remote-desktop.js"), "function dskRowBtn", "/* ---------- state");
		const env: Record<string, unknown> = { selfDown: false, S: { desk: { on: true } }, el: (_tag: string, attrs: unknown) => attrs, prClose: () => {}, openScreen: () => {} };
		const draw = (p: unknown): unknown => new Function(...Object.keys(env), `${i18nPrelude()}${row}\nreturn dskRowBtn(${JSON.stringify(p)});`)(...Object.values(env));
		expect(draw(PUBLIC)).toBeNull();
		expect(draw(DIRECT)).not.toBeNull();
	});

	test("following a link never sends the device id to a public row, and still sends it to a direct one", () => {
		const follow = between(peers, "function prTryFollow", 'if ("serviceWorker"');
		const go = (p: unknown): string[] => {
			const calls: string[] = [];
			const env: Record<string, unknown> = { PR: { list: [SELF, p], fresh: true }, toast: () => {}, history: { state: null, replaceState: () => {} }, location: { href: "https://mac:8443/", pathname: "/" }, DEVICE_ID: "d1", prGo: (h: string) => calls.push(h) };
			const href = `/?pc=${encodeURIComponent((p as { url: string }).url)}&n=1#chat/main`;
			new Function(...Object.keys(env), `let prFollowHref = ${JSON.stringify(href)};\n${others}\n${follow}\nprTryFollow();`)(...Object.values(env));
			return calls;
		};
		expect(go(PUBLIC)).toEqual(["https://pub.example/?n=1#chat/main"]);
		expect(go(DIRECT)).toEqual(["https://mini:8445/?did=d1&n=1#chat/main"]);
	});

	test("switching away from a down gateway skips relay and public rows", () => {
		const refresh = between(web("17-state-refresh.js"), "function autoSwitch", "async function refreshState");
		const run = (list: unknown[]) => {
			const picked: string[] = [];
			const conn = { hidden: true, textContent: "", title: "", setAttribute: () => {}, disabled: false, onclick: null as (() => void) | null };
			const env: Record<string, unknown> = { PR: { list }, cameByAuto: false, everConnected: false, selfDown: true, prPick: (p: { name: string }) => picked.push(p.name), $: () => conn, matchMedia: () => ({ matches: false }) };
			new Function(...Object.keys(env), `${i18nPrelude()}let autoTried = false;\n${between(web("02-basic-markdown.js"), "const koPick", "function toast(")}\n${others}\n${refresh}\nautoSwitch();\npaintConn();`)(...Object.values(env));
			conn.onclick?.();
			return { picked, text: conn.textContent, disabled: conn.disabled };
		};
		expect(run([SELF, RELAY, PUBLIC, DIRECT])).toEqual({ picked: ["맥미니", "맥미니"], text: "연결 끊김 · 맥미니로 전환", disabled: false });
		expect(run([SELF, RELAY, PUBLIC])).toEqual({ picked: [], text: "연결 끊김 · 다시 연결 중", disabled: true });
	});
});

describe("a stale session on the cached app shell", () => {
	const guard = web("01-forbidden-pair.js");
	const lands = async (pathname: string, search: string, hash: string): Promise<string | undefined> => {
		let to: string | undefined;
		const win: { fetch: (...a: unknown[]) => Promise<Response> } = { fetch: async () => new Response("", { status: 403, headers: { "x-dotz-pair": "1" } }) };
		const env: Record<string, unknown> = { window: win, location: { pathname, search, hash, replace: (u: string) => { to = u; } }, snapForget: () => {} };
		new Function(...Object.keys(env), guard)(...Object.values(env));
		await win.fetch();
		return to;
	};
	test("goes to /pair with its address and fragment: bare / keeps only the fragment, another path goes as next", async () => {
		expect(await lands("/", "", "#chat/ch:1")).toBe("/pair#chat/ch:1");
		expect(await lands("/desk/", "?a=1&b=한", "#x")).toBe(`/pair?next=${encodeURIComponent("/desk/?a=1&b=한")}#x`);
	});
	test("stays on /pair", async () => {
		expect(await lands("/pair", "", "")).toBeUndefined();
	});
});
