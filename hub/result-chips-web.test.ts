// Result chips on finished rows (web/js/08-home.js resultChips, 19-project-main.js): a finished job that names a file, a commit and a link shows
// three chips under the project's 완료 and 결과 rows, each opening its own target; on 홈 (작업내역, 최근 끝난 작업) the row shows only a count marker
// that opens the same chips under it (owner 2026-11-09). One that names none shows nothing.
import { afterAll, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const ago = (min: number) => Date.now() - min * 60_000;
const agoIso = (min: number) => new Date(ago(min)).toISOString();
const FILE = { path: "/tmp/result-chips/공지 초안.pdf", name: "공지 초안.pdf", size: 2048 };
const COMMIT = { kind: "commit", hash: "00a4484c", url: "https://github.com/acme/site/commit/00a4484c1111111111111111111111111111aaaa" };
const LINK = { kind: "link", url: "https://github.com/acme/site/releases/tag/v1" };
const MADE = { files: [FILE], links: [COMMIT, LINK] };
const WORK = [
	{ id: "st_made", description: "배포 공지 다듬기", status: "done", started_at: ago(30), ended_at: ago(20), ...MADE },
	{ id: "st_none", description: "메일 분류", status: "done", started_at: ago(30), ended_at: ago(25) },
];
const LANES = [
	{ name: "docs", title: "공문 양식 읽기", status: "idle", startedAt: agoIso(60), lastText: "끝났어요" },
	{ name: "plain", title: "로그 훑기", status: "idle", startedAt: agoIso(60), lastText: "끝났어요" },
];
const RUNS = { "lane:docs": { kind: "done", since: agoIso(5) }, "lane:plain": { kind: "done", since: agoIso(6) } };
const note = (id: string, kind: string, key: string, title: string, extra = {}) => ({ id, kind, tone: "done", title, text: `${title} 끝났어요`, open: key, key, read: true, ts: agoIso(5), ...extra });
const NOTICES = [note("n1", "result", "lane:docs", "공문 양식 읽기", MADE), note("n2", "result", "lane:plain", "로그 훑기"), note("n3", "worklog", "w3", "배포 마무리", MADE), note("n4", "worklog", "w4", "메일 정리")];
const json = (v: unknown) => Response.json(v);
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle", lastText: "ok" }, lanes: LANES, terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, work: WORK, convs: [], work_now: Date.now(), runs: RUNS });
		if (p === "/api/notices") return json({ unread: 0, items: NOTICES });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/todo") return json({ phases: [] });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T>(v: View, body: string): Promise<T> => JSON.parse(String(await v.evaluate(`JSON.stringify((() => { ${body} })())`))) as T;
// Each chip under a row: its name, its meta word and where it goes.
const CHIPS = `const chips = box => box ? [...box.querySelectorAll(".hrx-f .fatt")].map(c => ({ n: c.querySelector(".fi-n").textContent, m: c.querySelector(".fi-m").textContent, href: c.getAttribute("href"), tab: c.getAttribute("target") })) : null;`;
const boot = async () => {
	const v = new Bun.WebView({ width: 1280, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/#home`);
	await waitFor(v, `document.querySelector('[data-k="ended-work"]') && document.querySelector('.bi[data-id="notices:worklog"] .hc-row')`);
	return v;
};
const expectThree = (c: { n: string; m: string; href: string | null; tab: string | null }[] | null) => {
	expect(c?.map(x => x.n)).toEqual(["공지 초안.pdf", "00a4484c", "github.com/tag/v1"]);
	expect(c!.slice(1).map(x => x.m)).toEqual(["커밋", "링크"]);
	expect(c![0]!.href).toContain(encodeURIComponent(FILE.path));
	expect(c!.map(x => x.tab)).toEqual(["_blank", "_blank", "_blank"]);
	expect(c![1]!.href).toBe(COMMIT.url);
	expect(c![2]!.href).toBe(LINK.url);
};

// The rows of 홈 that name results: a finished task and a finished session (최근 끝난 작업) and a 작업내역 row; then the same three without.
const ROWS = `const ended = document.querySelector('[data-k="ended-work"]'), log = document.querySelector('.bi[data-id="notices:worklog"]');
	const lane = n => ended.querySelector('[data-t="lane:' + n + '"]')?.closest(".hr"), work = id => ended.querySelector('[data-work="' + id + '"]');
	const row = t => [...log.querySelectorAll(".hc-row")].find(x => x.textContent.includes(t));
	const made = { work: work("st_made"), lane: lane("docs"), log: row("배포 마무리") }, none = [work("st_none"), lane("plain"), row("메일 정리")];
	const mark = x => { const b = x.querySelector(".hrx-n"); return b ? { text: b.textContent.trim(), tag: b.tagName, exp: b.getAttribute("aria-expanded") } : null; };`;

test("home: a row with results shows a one-line count marker and no chips; a row without shows neither", async () => {
	const v = await boot();
	const r = await q<Record<string, unknown>>(v, `${CHIPS} ${ROWS}
		return { marks: Object.values(made).map(mark), chips: Object.values(made).map(chips), noneMarks: none.map(mark), noneChips: none.map(chips),
			// the marker sits on the row's first line: the row is as tall as a row without results
			tall: [made.work, none[0]].map(x => Math.round(x.getBoundingClientRect().height)) };`);
	expect(r.marks).toEqual(Array(3).fill({ text: "결과 3", tag: "BUTTON", exp: "false" }));
	expect(r.chips).toEqual([[], [], []]);
	expect(r.noneMarks).toEqual([null, null, null]);
	expect(r.noneChips).toEqual([[], [], []]);
	const [a, b] = r.tall as number[];
	expect(a).toBe(b!);
});

test("home: the marker comes before the row's 완료 or time, which stay in one column at the right with or without results", async () => {
	const v = await boot();
	const r = await q<Record<string, unknown>>(v, `${ROWS}
		const st = x => x.querySelector(".hs, .m"), right = x => Math.round(st(x).getBoundingClientRect().right);
		const rows = Object.values(made);
		return { before: rows.map(x => !!(x.querySelector(".hrx-n").compareDocumentPosition(st(x)) & Node.DOCUMENT_POSITION_FOLLOWING)),
			gap: rows.map(x => Math.round(st(x).getBoundingClientRect().left - x.querySelector(".hrx-n").getBoundingClientRect().right)),
			made: rows.map(right), none: none.map(right), words: rows.map(x => st(x).textContent) };`);
	expect(r.before).toEqual([true, true, true]);
	expect(r.made).toEqual(r.none);
	expect(r.gap).toEqual([4, 4, 8]);
	// a finished row ends in how long ago it ended, not in the word 완료 (the dot and the aria-label say that)
	expect((r.words as string[])[0]).toMatch(/전$|^방금$/);
});

test("home: the marker opens the row's three chips under it, one row at a time; a second click or Escape closes them", async () => {
	const v = await boot();
	const r = await q<Record<string, unknown>>(v, `${CHIPS} ${ROWS}
		const out = {}, at = location.hash;
		for (const [k, x] of Object.entries(made)) { x.querySelector(".hrx-n").click(); out[k] = chips(x); out[k + "Exp"] = mark(x).exp; out[k + "Hash"] = location.hash === at; }
		// one open at a time: opening the 작업내역 row closed the two before it
		out.open = Object.values(made).map(x => mark(x).exp);
		// chips wrap side by side across the row, not one per line in its text column
		out.tops = [made.work, made.log].map(x => [...x.querySelectorAll(".hrx-f .fatt")].map(c => Math.round(c.getBoundingClientRect().top)));
		made.log.querySelector(".hrx-n").click();
		out.second = [mark(made.log).exp, chips(made.log)];
		const b = made.work.querySelector(".hrx-n"); b.click(); b.focus();
		b.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		out.esc = [mark(made.work).exp, chips(made.work)];
		return out;`);
	for (const k of ["work", "lane", "log"]) { expectThree(r[k] as never); expect(r[`${k}Exp`]).toBe("true"); expect(r[`${k}Hash`]).toBe(true); }
	expect(r.open).toEqual(["false", "false", "true"]);
	for (const [a, b, c] of (r.tops as number[][]).filter(t => t.length)) { expect(b).toBe(a!); expect(c!).toBeGreaterThan(a!); }
	expect(r.second).toEqual(["false", []]);
	expect(r.esc).toEqual(["false", []]);
});

test("home: an empty card is as tall as its content, not as its neighbour", async () => {
	const v = await boot();
	// the board places the two cards side by side once it has measured them
	await waitFor(v, `(() => { const t = id => document.querySelector('.bi[data-id="' + id + '"] > .card').getBoundingClientRect().top; return t("now:running") === t("now:ended"); })()`);
	const h = await q<Record<string, number>>(v, `const card = id => document.querySelector('.bi[data-id="' + id + '"] > .card');
		const body = c => Math.round([...c.children].reduce((m, n) => Math.max(m, n.getBoundingClientRect().bottom), 0) - c.getBoundingClientRect().top);
		const run = card("now:running"), end = card("now:ended");
		return { run: Math.round(run.getBoundingClientRect().height), runBody: body(run), end: Math.round(end.getBoundingClientRect().height), sameRow: Math.round(run.getBoundingClientRect().top - end.getBoundingClientRect().top) };`);
	expect(h.sameRow).toBe(0);
	expect(h.run).toBeLessThan(h.end!);
	expect(h.run).toBeLessThanOrEqual(h.runBody! + 20);
});

test("project detail: a finished task's 완료 row and a session's result row show three chips; a row with none shows nothing", async () => {
	const v = await boot();
	const r = await q<Record<string, unknown>>(v, `${CHIPS}
		const report = lane => ({ kind: "report", at: "${agoIso(5)}", lane, tone: "done", title: "확인됨", text: "", verified: true });
		const box = n => { const d = document.createElement("div"); d.append(n); return d; };
		return { work: chips(box(pmWorkRow(S.work[0]))), workNone: chips(box(pmWorkRow(S.work[1]))), report: chips(box(pmResultRow(report("docs")))), reportNone: chips(box(pmResultRow(report("plain")))), reportOld: chips(box(pmResultRow({ ...report("docs"), at: "${agoIso(120)}" }))),
			commitNone: chips(box(pmResultRow({ kind: "commit", at: "${agoIso(9)}", title: "고침", hash: "abc1234" }))),
			past: chips(pmRecent([{ name: "docs", title: "공문 양식 읽기", at: ${ago(5)} }], [])) };`);
	for (const k of ["work", "report", "past"]) expectThree(r[k] as never);
	expect([r.workNone, r.reportNone, r.reportOld, r.commitNone]).toEqual([[], [], [], []]);
});

test("a made HTML page opens in the canvas from its chip, a text file in the reader, anything else in a tab", async () => {
	const v = await boot();
	const r = await q<{ html: [boolean, string[] | null]; md: [boolean, string | null]; pdf: [boolean, boolean] }>(v, `
		let canvas = null, read = null;
		canvasOpen = (...a) => { canvas = a; }; viewer = p => { read = p; };
		const chip = name => resultChips({ files: [{ path: "/tmp/r/" + name, name }] }).querySelector(".fatt");
		const h = chip("보고서.html"), m = chip("메모.md"), p = chip("공지.pdf");
		h.click(); m.click();
		return { html: [h.hasAttribute("href"), canvas], md: [m.hasAttribute("href"), read], pdf: [p.hasAttribute("href"), p.getAttribute("target") === "_blank"] };`);
	expect(r.html).toEqual([false, ["/tmp/r/보고서.html", "보고서.html"]]);
	expect(r.md).toEqual([false, "/tmp/r/메모.md"]);
	expect(r.pdf).toEqual([true, true]);
});
