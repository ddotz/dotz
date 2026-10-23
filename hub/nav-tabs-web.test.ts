import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const web = (f: string) => readFileSync(join(import.meta.dir, "..", "web", "js", f), "utf8");
const state = web("04-state.js"), palette = web("05-command-palette.js"), history = web("32-history-nav.js"), monitoring = web("30-monitoring.js");
const between = (src: string, from: string, to: string) => {
	const a = src.indexOf(from), b = src.indexOf(to, a);
	if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
	return src.slice(a, b);
};
const array = (src: string, name: string) => new Function(`${between(src, `const ${name} =`, ";\n")}; return ${name};`)() as unknown[];

const NAV = array(state, "NAV") as [string, string][], views = array(state, "views") as string[];
const routeAlias = new Function(`${between(palette, "const routeAlias =", ";\n")}; return routeAlias;`)() as (name: string, tgt?: string) => [string, string | undefined];

type Mon = { sel: string; list: boolean };
function monitoringRoute(narrow: boolean) {
	const env = { narrowChat: () => narrow, enc: encodeURIComponent, current: "monitoring" };
	const src = `${between(monitoring, "const MON =", "async function loadMonitors")}\nreturn { MON, monConv, monHash, monRoute };`;
	return new Function(...Object.keys(env), src)(...Object.values(env)) as { MON: Mon; monConv: () => boolean; monHash: () => string; monRoute: (t?: string) => void };
}

function chain(name: string, hash: string, narrow: boolean, mon: Mon) {
	const env = { narrowChat: () => narrow, chatList: false, target: "main", SUB: new Set(), backTarget: () => null, MON: mon, monCtx: "", enc: encodeURIComponent };
	const src = `${between(history, "function routeChain", "function navSync")}\nreturn routeChain;`;
	return (new Function(...Object.keys(env), src)(...Object.values(env)) as (n: string, h: string) => string[])(name, hash);
}

describe("top-level tabs", () => {
	test("the tabs are 홈, 채팅, 프로젝트, 모니터링, 설정 in that order, and the 세션 tab is gone", () => {
		expect(NAV.map(n => n[0])).toEqual(["home", "chat", "projects", "monitoring", "settings"]);
		expect(NAV.map(n => n[0])).not.toContain("lanes");
		expect(views).not.toContain("lanes");
		for (const [id] of NAV) expect(views).toContain(id);
	});

	test("an old #lanes address opens the chat list; every other route is untouched", () => {
		expect(routeAlias("lanes", undefined)).toEqual(["chat", "list"]);
		expect(routeAlias("lanes", "x")).toEqual(["chat", "list"]);
		expect(routeAlias("monitoring", "i:mail")).toEqual(["monitoring", "i:mail"]);
		expect(routeAlias("chat", "lane:a")).toEqual(["chat", "lane:a"]);
	});
});

describe("모니터링 routing", () => {
	test("a phone opens the list first and an item as its own screen; a wide screen keeps the item beside the list", () => {
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
		wide.monRoute();
		expect(wide.MON).toMatchObject({ sel: "i:mail", list: false });
		expect(wide.monConv()).toBe(false);
	});

	test("back from an item on a phone lands on the 모니터링 list, not on the chat list", () => {
		const open = { sel: "i:mail", list: false }, list = { sel: "i:mail", list: true };
		expect(chain("monitoring", "monitoring/i%3Amail", true, open)).toEqual(["home", "monitoring", "monitoring/i%3Amail"]);
		expect(chain("monitoring", "monitoring", true, list)).toEqual(["home", "monitoring"]);
		expect(chain("monitoring", "monitoring/i%3Amail", false, open)).toEqual(["home", "monitoring/i%3Amail"]);
	});
});
