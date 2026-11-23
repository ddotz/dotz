import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// The 모니터링 address grammar (web/js/30-monitoring-route.js) as a table: every route string the tests and the hub use (go("monitoring", ...)
// and #monitoring/... literals), run through the real page with two mail accounts and their boxes loaded (an item key and a box are read from
// that data), and what it leaves: the address, the history chain, MON's open item and MX's account, box and screen. hub/monitoring-route.json is
// the behaviour recorded before the grammar moved into one file; a change to it is a change of what an address means.
// Regenerate (only when the meaning is meant to change): MONITORING_ROUTE_WRITE=1 bun test hub/monitoring-route-web.test.ts
const TABLE = join(import.meta.dir, "monitoring-route.json");
const box = (id: string, name: string, base = false) => ({ id, name, icon: "mail", notify: true, conds: { from: [], subj: [], body: [], src: [] }, not: { from: [] }, judge: { on: false, text: "" }, how: "",
	greets: [], folders: [], bans: [], rules: [], ...(base ? { base: true } : { mode: "ask" }) });
const BOXES: Record<string, ReturnType<typeof box>[]> = {
	mail: [box("base", "일반", true), box("b-score", "문서 요청"), box("b-pay", "결제"), box("b-slash", "결제/영수")],
	"mail-2": [box("base", "일반", true), box("b-work", "업무"), box("b-slash2", "결제/영수")],
};
const at = "2026-11-16T09:00:00.000Z";
const mail = (inst: string) => ({ key: inst, app: "mail", label: inst === "mail" ? "개인 메일" : "회사 메일", icon: "mail", kind: "app", conv: inst === "mail" ? ["mail:"] : ["mail:w-"],
	...(inst === "mail" ? { convNot: ["mail:w-"] } : {}), state: "connected", notices: [], unread: 1, needs: { drafts: 0, unread: 1, sentToday: 0, unreplied: 0 },
	boxes: BOXES[inst], account: inst === "mail" ? "me@example.com" : "me@work.example.com" });
const card = (subject: string, b: string) => ({ subject, from: "Kim <kim@example.com>", source: "acme", at, summary: "요약", read: false, archived: false, starred: false, can: ["read"], box: b });

const hub = fakeHub({
	slowTimers: true,
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/monitors") return json({ items: [{ name: "서버 디스크", watch: "disk", kind: "watch", every: "1h" }] });
		if (p === "/api/integrations") return json({ items: [mail("mail"), mail("mail-2"), { key: "kakao", app: "kakao", label: "카카오톡", icon: "chat", kind: "app", conv: [], state: "connected", notices: [] }], available: [] });
		if (p === "/api/conversations") return json({ items: [["p-1", "문서 부탁", "b-score"], ["w-1", "업무 보고", "b-work"]].map(([k, s, b]) => ({ target: `mail:${k}`, unread: 1, read: null, mail: card(s!, b!), last: { ts: at, text: s, from: "bot" } })) });
		if (p === "/api/apps") return json({ items: [{ id: "docs", label: "문서", icon: "file", kind: "tool", source: "manifest", status: "running", web: { href: "/apps/docs/", url: "http://127.0.0.1:4500", path: "/", mode: "rewrite" } }], errors: [] });
		if (p.startsWith("/apps/")) return new Response("<!doctype html><title>app</title>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
		return undefined;
	},
});
afterAll(() => hub.stop());

// One case: the steps run in order from a reset state (홈, no item, the list, every account and box); null is go("monitoring") without a target,
// a string starting with "#" is an address typed in (the hashchange path: parseHash, then go), anything else is go("monitoring", step).
type Step = string | null;
const n2 = encodeURIComponent(encodeURIComponent("n:결제/영수"));
const CASES: Step[][] = [
	[null], ["list"], [""], ["notice"], ["replies"],
	["i:mail"], ["i:kakao"], ["i:youtube"], ["i:site-mapia"], ["m:서버 디스크"], ["m:정상 감시"],
	["i:mail/mail-2/all"], ["i:mail/mail/all"], ["i:mail/mail/b-pay"], ["i:mail/mail/b-pay/set"], ["i:mail/mail/all/new"], ["i:mail/all/all/new"], ["i:mail/mail/b-pay/zz"],
	["i:mail-2"], ["i:mail-2/mail-2/b-work"], ["i:nobox/a/b"], ["i:nobox"],
	["p:mini|i:mail"], ["p:mini|m:peer-backup"],
	["c:mail:p-1"], ["c:mail:w-1"], ["c:settings:kakao"], ["c:settings:mail"], ["c:settings:w:login-local"],
	["c:mail:"], ["c:bogus"], ["c:"],
	["i:mail/mail-2/b-work", "i:mail"], ["i:mail/mail-2/b-work", "list"], ["i:mail/mail-2/b-work", null], ["i:mail/mail/b-pay/set", "i:mail/mail/b-pay"],
	["i:mail/mail-2/b-work", "m:서버 디스크"], ["m:서버 디스크", "list"], ["m:서버 디스크", null], ["m:서버 디스크", "c:bogus"], ["c:mail:p-1", "list"], ["c:mail:p-1", "i:kakao"],
	["#monitoring"], ["#monitoring/"], ["#monitoring/notice"], ["#monitoring/replies"], ["#monitoring/i:mail"], ["#monitoring/i%3Amail"], ["#monitoring/i%3Akakao"],
	["#monitoring/i%3Amail/mail/b-score"], ["#monitoring/i%3Amail/mail/b-score/set"], ["#monitoring/i%3Amail/mail/base/set"], ["#monitoring/i%3Amail/mail/all/new"],
	["#monitoring/i%3Amail/all/all/new"], ["#monitoring/i%3Amail/mail-2/b-work"], ["#monitoring/i%3Amail-2"], [`#monitoring/i%3Amail/all/${n2}`], [`#monitoring/i%3Amail/mail/${n2}`],
	["#monitoring/c:mail%3Ap-1"], ["#monitoring/c:mail%3Afx-1"], ["#monitoring/c%3Abogus"], ["#monitoring/m%3A%EC%84%9C%EB%B2%84%20%EB%94%94%EC%8A%A4%ED%81%AC"],
	["x:docs"], ["x:nope"], ["#monitoring/x%3Adocs"], ["#monitoring/x:docs"], ["x:docs", "i:mail", "x:docs"],
];
const label = (c: Step[]) => c.map(s => (s === null ? "(none)" : JSON.stringify(s))).join(" > ");
// What a route leaves, read in the same task as the go() that made it: the wide layout moves the history in place, so the address is final here.
const SNAP = `({ hash: location.hash, want: H.want, current, ctx: monCtx, sel: MON.sel, list: MON.list, filter: MON.filter, miss: MON.miss, acct: MX.acct, box: MX.box, scr: MX.scr })`;
const RESET = `go("home"); MON.sel = ""; MON.list = true; MON.filter = "fail"; MX.acct = "all"; MX.box = "all"; MX.scr = "";`;
const stepJs = (s: Step) => (s === null ? `go("monitoring");` : s.startsWith("#") ? `{ const h = parseHash(${JSON.stringify(s)}); go(h.view, h.t); }` : `go("monitoring", ${JSON.stringify(s)});`);

type Row = { in: string; out: Record<string, unknown> };
let v: View;
// A fresh page per case: the cases do not lean on each other, and WebKit refuses more than 100 history writes in 10 s on one page.
async function fresh(v: View, i: number) {
	await run(v, `localStorage.clear(); sessionStorage.clear()`).catch(() => undefined);
	await v.navigate(`${hub.origin}/?case=${i}`);
	await waitFor(v, `NT.loaded && NM.loaded && APPS.loaded && INTG.items.length === 3 && CONV.has("mail:p-1")`);
	await run(v, `go("monitoring")`);
	await waitFor(v, `MX.key === "i:mail" && MX.accts.size === 2 && document.querySelector('#mon-side .cv-row[data-k="i:mail"]')`);
}
beforeAll(async () => { v = await hub.view({ width: 1280, height: 900 }); }, 30_000);

test("every 모니터링 route string means what hub/monitoring-route.json recorded", async () => {
	const got: Row[] = [];
	for (const [i, c] of CASES.entries()) {
		await fresh(v, i);
		got.push({ in: label(c), out: await ev<Record<string, unknown>>(v, `(() => { ${RESET} ${c.map(stepJs).join(" ")} return ${SNAP}; })()`) });
	}
	if (process.env.MONITORING_ROUTE_WRITE) writeFileSync(TABLE, `${JSON.stringify(got, null, "\t")}\n`);
	const want = JSON.parse(readFileSync(TABLE, "utf8")) as Row[];
	expect(got.map(r => r.in)).toEqual(want.map(r => r.in));
	for (const [i, r] of got.entries()) expect(r.out, r.in).toEqual(want[i]!.out);
}, 120_000);

// On the phone the address settles asynchronously (histMove steps the history with history.go), so the route is run and the address read once it has settled
// on what the table recorded.
test("every 모니터링 route string settles on the address hub/monitoring-route.json recorded at 390px", async () => {
	const want = JSON.parse(readFileSync(TABLE, "utf8")) as Row[];
	expect(want.map(r => r.in)).toEqual(CASES.map(label));
	const phone = await hub.view({ width: 390, height: 844 });
	const got: Record<string, unknown>[] = [];
	for (const [i, c] of CASES.entries()) {
		await fresh(phone, i);
		await run(phone, `${RESET} ${c.map(stepJs).join(" ")}`);
		const hash = want[i]!.out.hash as string;
		await waitFor(phone, `location.hash === ${JSON.stringify(hash)}`).catch(() => undefined);
		got.push({ in: label(c), hash: await ev<string>(phone, "location.hash") });
	}
	expect(got).toEqual(want.map(r => ({ in: r.in, hash: r.out.hash })));
}, 120_000);
