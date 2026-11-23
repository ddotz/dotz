import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { i18nPrelude } from "./web-i18n.ts";

const web = (f: string) => readFileSync(join(import.meta.dir, "..", "web", "js", f), "utf8");
const palette = web("05-command-palette.js"), history = web("32-history-nav.js"), monitoring = web("30-monitoring.js"), monRoute = web("30-monitoring-route.js");
const between = (src: string, from: string, to: string) => {
	const a = src.indexOf(from), b = src.indexOf(to, a);
	if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
	return src.slice(a, b);
};

const { NAV, views } = new Function(`${i18nPrelude()}${web("03-screens.js")} return { NAV, views };`)() as { NAV: [string, string][]; views: string[] };
const routeAlias = new Function(`const NSC = { pass: 0 };\n${between(palette, "const alertAddr =", ";\n")};\n${between(palette, "const routeAlias =", ";\n")}; return routeAlias;`)() as (name: string, tgt?: string) => [string, string | undefined];

type Mon = { sel: string; list: boolean };
function monitoringRoute(narrow: boolean) {
	// The address is read and written in 30-monitoring-route.js (monParse, monApply, monHashOf); no mail account is open here.
	const env = { narrowChat: () => narrow, enc: encodeURIComponent, current: "monitoring", pqOpen: () => {}, mxKeyOf: (k: string) => `i:${k}`, mxDec: (s: string) => s, mxRouteSet: () => {}, MX: { key: "" } };
	const src = `${between(monitoring, "const MON =", "async function loadMonitors")}\n${between(monRoute, "const MON_MAIL", "/* ---------- monitoring: what other files")}\nreturn { MON, monConv, monHash, monRoute };`;
	return new Function(...Object.keys(env), src)(...Object.values(env)) as { MON: Mon; monConv: () => boolean; monHash: () => string; monRoute: (t?: string) => void };
}

function chain(name: string, hash: string, narrow: boolean, mon: Mon) {
	const env = { narrowChat: () => narrow, chatList: false, target: "main", SUB: new Set(), NSC: { ret: false }, backTarget: () => null, MON: mon, monCtx: "", enc: encodeURIComponent, mxChain: (h: string) => [h] };
	// 모니터링 builds its own chain in its chain hook (30-monitoring-route.js monChain), which routeChain asks first.
	const hook = `${between(monRoute, "function monChain", "screenHooks(")}\nconst SCREEN_HOOKS = { monitoring: { chain: monChain } };\n`;
	const src = `${hook}${between(history, "function routeChain", "function navSync")}\nreturn routeChain;`;
	return (new Function(...Object.keys(env), src)(...Object.values(env)) as (n: string, h: string) => string[])(name, hash);
}

describe("top-level tabs", () => {
	test("the tabs are 홈, 채팅, 앱, 설정 in that order: 프로젝트 has no tab, there is no separate apps screen, and the 세션 tab is gone", () => {
		expect(NAV.map(n => n[0])).toEqual(["home", "chat", "monitoring", "settings"]);
		expect(NAV.map(n => n[1])).toEqual(["홈", "채팅", "앱", "설정"]);
		for (const [id] of NAV) expect(views).toContain(id);
		for (const id of ["projects", "project"]) expect(views).toContain(id);
		expect(views).not.toContain("apps");
	});

	test("an old #lanes address opens the chat list; every other route is untouched", () => {
		expect(routeAlias("lanes", undefined)).toEqual(["chat", "list"]);
		expect(routeAlias("lanes", "x")).toEqual(["chat", "list"]);
		expect(routeAlias("monitoring", "i:mail")).toEqual(["monitoring", "i:mail"]);
		expect(routeAlias("chat", "lane:a")).toEqual(["chat", "lane:a"]);
		expect(routeAlias("chat", "alert")).toEqual(["notices", undefined]);
	});
});

describe("모니터링 routing", () => {
	test("every width opens the list first and an item as its own screen", () => {
		const phone = monitoringRoute(true);
		phone.monRoute();
		expect(phone.MON.list).toBe(true);
		expect(phone.monHash()).toBe("monitoring");
		expect(phone.monConv()).toBe(false);
		phone.monRoute("m:서버 디스크");
		expect(phone.MON).toMatchObject({ sel: "m:서버 디스크", list: false });
		expect(phone.monHash()).toBe(`monitoring/${encodeURIComponent("m:서버 디스크")}`);
		expect(phone.monConv()).toBe(true);
		phone.monRoute("list");
		expect(phone.monConv()).toBe(false);

		const wide = monitoringRoute(false);
		wide.monRoute("i:mail");
		expect(wide.monConv()).toBe(true);
		wide.monRoute();
		expect(wide.MON).toMatchObject({ sel: "i:mail", list: true });
		expect(wide.monConv()).toBe(false);
	});

	test("back from an item lands on the 모니터링 list on every width, not on the chat list", () => {
		const open = { sel: "i:mail", list: false }, list = { sel: "i:mail", list: true };
		expect(chain("monitoring", "monitoring/i%3Amail", true, open)).toEqual(["home", "monitoring", "monitoring/i%3Amail"]);
		expect(chain("monitoring", "monitoring", true, list)).toEqual(["home", "monitoring"]);
		expect(chain("monitoring", "monitoring/i%3Amail", false, open)).toEqual(["home", "monitoring", "monitoring/i%3Amail"]);
	});
});
