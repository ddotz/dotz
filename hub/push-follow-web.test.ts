import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "web", "js", "33-peers.js"), "utf8");
const follow = src.slice(src.indexOf("function prTryFollow"), src.indexOf('if ("serviceWorker"'));

type Peer = { name: string; url: string; self: boolean; online: boolean };
const MINI: Peer = { name: "맥미니", url: "https://mini:8445", self: false, online: true };

function page(href: string, list: Peer[], fresh: boolean) {
	const nav: string[] = [], toasts: string[] = [];
	const env = {
		PR: { list, fresh },
		DEVICE_ID: "phone-device-0001",
		prOthers: () => list.filter(p => !p.self),
		toast: (m: string) => toasts.push(m),
		location: { replace: (u: string) => nav.push(u), href: "https://mac:8443/", pathname: "/", hash: "" },
		history: { state: null, replaceState: () => {} },
	};
	const run = new Function(...Object.keys(env), "href", `let prFollowHref = href;\n${follow}\nprTryFollow();\nreturn () => prFollowHref;`)(...Object.values(env), href) as () => string;
	return { nav, toasts, pending: run };
}

test("a relayed tap follows to that computer, at the item, and only to a computer in the list", () => {
	const ok = page("https://mac:8443/?pc=https%3A%2F%2Fmini%3A8445&n=n-7#chat/lane:x", [MINI], true);
	expect(ok.nav).toEqual(["https://mini:8445/?did=phone-device-0001&n=n-7#chat/lane:x"]);
	const msg = page("https://mac:8443/?pc=https%3A%2F%2Fmini%3A8445&m=2026-10-22T01%3A02%3A03.004Z#chat/main", [MINI], true);
	expect(msg.nav).toEqual(["https://mini:8445/?did=phone-device-0001&m=2026-10-22T01%3A02%3A03.004Z#chat/main"]);
	const evil = page("https://mac:8443/?pc=https%3A%2F%2Fevil.example&n=x", [MINI], true);
	expect(evil.nav).toEqual([]);
	expect(evil.toasts).toHaveLength(1);
});

test("an unknown computer waits for the fresh list; an offline one stays here", () => {
	const stale = page("https://mac:8443/?pc=https%3A%2F%2Fmini%3A8445", [], false);
	expect(stale.nav).toEqual([]);
	expect(stale.pending()).not.toBe("");
	const down = page("https://mac:8443/?pc=https%3A%2F%2Fmini%3A8445", [{ ...MINI, online: false }], true);
	expect(down.nav).toEqual([]);
	expect(down.toasts).toHaveLength(1);
});
