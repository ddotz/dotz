import { afterAll, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// web/DESIGN.md 목록 줄 구성 (row anatomy), measured in a headless browser on the main list surfaces with seeded rows, some carrying an extra
// marker (a result count, an unread count, an attachment, a tag): the row's status or time is its last visible content, every marker sits before
// it, its right edge is one x down the list, and a marker on a dense home card keeps the row one line tall until it is opened.
// Content is measured as text ink (a Range over each text node, clipped to its box) and icons, so a full-width block box does not count as content.
// Trailing row actions (an icon button: ✕, ⋯, 답장 쓰기, a fold chevron) stand after the status in their own fixed slot and are not content.
// 할일, 지금 진행 중 and 대기 중 on 홈 draw the same row as 최근 끝난 작업 (.hr) and are covered through it. Exempt: the chat list (채팅) has a time but
// no status column, and a monitoring row without a status ends with its count, which still shares the list's right edge.
const now = Date.now();
const iso = (ago: number) => new Date(now - ago).toISOString();
const file = (name: string) => ({ path: `/tmp/row-anatomy/${name}`, name, size: 1200 });
const API: Record<string, unknown> = {
	"/api/state": {
		name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, work_now: now,
		work: [
			{ id: "w1", description: "로그인 화면 고치기", status: "done", started_at: now - 600_000, ended_at: now - 300_000 },
			{ id: "w2", description: "결과 파일을 남긴 작업", status: "done", started_at: now - 600_000, ended_at: now - 200_000, files: [file("a.md"), file("b.png")] },
			{ id: "w3", description: "결과가 하나인 작업", status: "done", started_at: now - 600_000, ended_at: now - 100_000, files: [file("c.md")] },
		],
	},
	"/api/activity": { items: [], more: false, history: false },
	"/api/notices": { unread: 2, items: [
		{ id: "n1", kind: "worklog", title: "작업 기록", text: "문서를 고쳤어요", ts: iso(60_000), read: true },
		{ id: "n2", kind: "worklog", title: "작업 기록", text: "결과를 남긴 기록", ts: iso(120_000), read: true, files: [file("d.md")] },
		{ id: "n3", kind: "result", title: "결과", text: "보고서를 다 썼어요", ts: iso(30_000), read: false, files: [file("e.md")] },
		{ id: "n4", kind: "alert", title: "경고", text: "디스크가 거의 찼어요", ts: iso(90_000), read: false },
	] },
	"/api/custom": { projects: [{ key: "p1", name: "가계부" }, { key: "p2", name: "블로그" }, { key: "p3", name: "사진 정리" }] },
};
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname in API) return Response.json(API[url.pathname]);
		return url.pathname.startsWith("/api/") ? Response.json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
});

const waitFor = (v: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
	v.evaluate(
		`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`,
	);

type Surface = {
	name: string;
	go: string; // opens the screen
	ready: string; // true once its rows are drawn
	mount?: string; // draws seeded rows with the screen's own row builder where the screen needs a live source to fill itself
	rows: string; // the rows of one list
	end: string; // the status or time inside a row (absent on a row that has neither)
	markers: string; // extra markers that must precede it
	trail?: string; // trailing row actions, outside the content
	dense?: boolean; // a home card: a marker keeps the row at the single-line height
};
const MON_ROWS = `[{ k: "a", name: "가격 지켜보기", av: monIcon("bell"), hint: "어제 바뀜", badge: ["정상", "ok"] },
  { k: "b", name: "메일", av: monIcon("mail"), hint: "새 메일", unread: 3, badge: ["정상", "ok"] },
  { k: "c", name: "카카오톡", av: monIcon("chat"), hint: "", chips: [["미답장 2", "warn"]], badge: ["주의", "warn"] },
  { k: "d", name: "상태 없는 항목", av: monIcon("chat"), hint: "새 소식", unread: 2 }]`;
const MAIL_ROWS = `const at = new Date().toISOString();
  MAILS.set("mail:ra1", { subject: "견적서 보내 드려요", from: "김철수 <kim@example.com>", at, source: "gmail" });
  MAILS.set("mail:ra2", { subject: "첨부가 있는 메일", from: "이영희 <lee@example.com>", at, source: "gmail", attachments: [{ name: "a.pdf", size: 1000 }, { name: "b.pdf", size: 1000 }] });
  MAILS.set("mail:ra3", { subject: "답장이 필요한 메일", from: "박민수 <park@example.com>", at, source: "gmail", unreplied: true, reply: "needed" });
  const box = el("div", { id: "ra-mail" }, ...["mail:ra1", "mail:ra2", "mail:ra3"].map(t => monConvNode(t, "메일")));
  document.querySelector("#mon-side").append(box)`;
const SURFACES: Surface[] = [
	{ name: "home 최근 끝난 작업", go: `go("home")`, ready: `document.querySelectorAll('#v-home [data-k="ended-work"] > .hr').length === 3`,
		rows: `#v-home [data-k="ended-work"] > .hr`, end: ".hs", markers: ".hrx-n", trail: ".btn.text", dense: true },
	{ name: "home 작업내역", go: `go("home")`, ready: `document.querySelectorAll('#v-home .hc-list[data-cap="worklog"] > .hc-row').length >= 2`,
		rows: `#v-home .hc-list[data-cap="worklog"] > .hc-row`, end: ".m", markers: ".hrx-n", trail: ".nt-x", dense: true },
	{ name: "notices", go: `go("notices")`, ready: `document.querySelectorAll("#v-notices .nsc-r").length >= 4`,
		rows: "#v-notices .nsc-r", end: ".t", markers: ".tag", trail: ".ib" },
	{ name: "projects", go: `go("projects")`, ready: `document.querySelectorAll("#pl-list .pl-row").length === 3`,
		mount: `ts(prjChat(PRJ.projects[1])).unread = 4; pjPaintRows()`,
		rows: "#pl-list .pl-row", end: ".li-end > .tag", markers: ".pl-nb" },
	{ name: "monitoring list", go: `go("monitoring")`, ready: `document.querySelector("#mon-side")`,
		mount: `clear(document.querySelector("#mon-side")).append(...monSideNodes(${MON_ROWS}))`,
		rows: "#mon-side .cv-row", end: ".cv-m2 > .tag", markers: ".nb, .tag, .dot" },
	{ name: "mail list", go: `go("monitoring")`, ready: `document.querySelector("#mon-side")`,
		mount: MAIL_ROWS, rows: "#ra-mail > .mr", end: ".rc-time", markers: ".tag, .mr-clip", trail: ".ib, .mr-more, .mr-draft" },
];

// Violations of one surface, one line each: "<rule> <row index> <detail>".
const MEASURE = (s: Surface) => `(() => {
  const out = [], rows = [...document.querySelectorAll(${JSON.stringify(s.rows)})].filter(r => r.getBoundingClientRect().height > 0);
  if (!rows.length) return JSON.stringify(["no-rows"]);
  const trail = ${JSON.stringify(s.trail || "")};
  const isTrail = e => trail && e.closest(trail);
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  // Text ink and icons of a row, as boxes; a chips panel opened under a row (.hrx-f) is not part of its line.
  const ink = row => {
    const boxes = [];
    const walk = n => {
      if (n.nodeType === 3) {
        if (!n.textContent.trim()) return;
        const p = n.parentElement, pr = p.getBoundingClientRect(), rg = document.createRange(); rg.selectNodeContents(n);
        for (const r of rg.getClientRects()) if (r.width > 0) boxes.push({ el: p, l: Math.max(r.left, pr.left), r: Math.min(r.right, pr.right), t: r.top, b: r.bottom });
        return;
      }
      if (n.nodeType !== 1 || !vis(n) || isTrail(n) || n.classList.contains("hrx-f")) return;
      if (n.matches("svg, img, .dot")) { const r = n.getBoundingClientRect(); boxes.push({ el: n, l: r.left, r: r.right, t: r.top, b: r.bottom }); return; }
      for (const c of n.childNodes) walk(c);
    };
    walk(row);
    return boxes;
  };
  const rights = [], lefts = [];
  rows.forEach((row, i) => {
    const boxes = ink(row), right = Math.max(...boxes.map(b => b.r));
    rights.push(right);
    lefts.push(Math.min(...boxes.map(b => b.l)));
    const end = [...row.querySelectorAll(${JSON.stringify(s.end)})].filter(vis).pop();
    if (!end) return;
    const e = end.getBoundingClientRect(), endInk = Math.max(...boxes.filter(b => end.contains(b.el)).map(b => b.r));
    if (right - endInk > 1) out.push("end-not-last " + i + " " + JSON.stringify(boxes.filter(b => b.r > endInk + 1).map(b => b.el.textContent.trim() || b.el.className.baseVal || b.el.className).join(" ")));
    for (const m of row.querySelectorAll(${JSON.stringify(s.markers)})) {
      if (m === end || m.contains(end) || end.contains(m) || !vis(m) || isTrail(m)) continue;
      const r = m.getBoundingClientRect();
      if (r.bottom > e.top && r.top < e.bottom && r.left >= e.right - 1) out.push("marker-after-end " + i + " " + JSON.stringify(m.textContent.trim()));
    }
  });
  if (Math.max(...rights) - Math.min(...rights) > 1) out.push("right-edge " + JSON.stringify(rights.map(Math.round)));
  if (Math.max(...lefts) - Math.min(...lefts) > 1) out.push("left-edge " + JSON.stringify(lefts.map(Math.round)));
  // A row that gained a marker is compared with its unmarked neighbours: no taller (dense: no taller than the shortest single-line row).
  const marked = rows.filter(r => r.querySelector(${JSON.stringify(s.markers)})), plain = rows.filter(r => !r.querySelector(${JSON.stringify(s.markers)}));
  const h = r => r.getBoundingClientRect().height, dense = ${!!s.dense};
  if (dense && (!marked.length || !plain.length)) out.push("dense-seed " + marked.length + "/" + plain.length);
  else if (marked.length && plain.length && Math.max(...marked.map(h)) > (dense ? Math.min(...plain.map(h)) : Math.max(...plain.map(h))) + 2)
    out.push((dense ? "dense-height " : "marker-height ") + JSON.stringify([...marked, ...plain].map(h).map(Math.round)));
  return JSON.stringify(out);
})()`;

const open = async (width: number) => {
	const v = new Bun.WebView({ width, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof go === "function" && S && NT.loaded`);
	return v;
};
const measure = async (v: InstanceType<typeof Bun.WebView>, s: Surface) => {
	await v.evaluate(`(${s.go}, 0)`);
	await waitFor(v, s.ready);
	if (s.mount) await v.evaluate(`(() => { ${s.mount}; return 0; })()`);
	return (JSON.parse((await v.evaluate(MEASURE(s))) as string) as string[]).map(x => `${s.name}: ${x}`);
};

for (const width of [390, 1280])
	test(`${width}px: list rows end with their status or time at one x, markers before it, dense rows stay one line`, async () => {
		const v = await open(width);
		const found: string[] = [];
		for (const s of SURFACES) found.push(...(await measure(v, s)));
		expect(found).toEqual([]);
	}, 60_000);

// The check itself can fail: a marker put after the status (the 홈 결과 N mistake) and a two-line marker are both caught.
// Each plant is measured in the same evaluate, so a home repaint between the two calls cannot wipe it first.
test("a marker after the status, or one that makes a home row two lines, is reported", async () => {
	const v = await open(1280);
	const s = SURFACES[0];
	await v.evaluate(`(${s.go}, 0)`);
	await waitFor(v, s.ready);
	const after = JSON.parse((await v.evaluate(`(() => { const row = [...document.querySelectorAll(${JSON.stringify(s.rows)})].find(r => !r.querySelector(".hrx-n")); const m = el("span", { class: "hrx-n", text: "결과 2" }); m.style.flex = "none"; row.querySelector(".hs").after(m); return ${MEASURE(s)}; })()`)) as string) as string[];
	expect(after.some(x => x.startsWith("end-not-last"))).toBe(true);
	expect(after.some(x => x.startsWith("right-edge"))).toBe(true);
	const tall = JSON.parse((await v.evaluate(`(() => { for (const m of document.querySelectorAll(".hrx-n")) m.remove(); const row = document.querySelector(${JSON.stringify(s.rows)}); row.querySelector(".hb").append(el("span", { class: "hrx-n", text: "결과 2" })); row.querySelector(".hb .hrx-n").style.display = "block"; return ${MEASURE(s)}; })()`)) as string) as string[];
	expect(tall.some(x => x.startsWith("dense-height") || x.startsWith("dense-seed"))).toBe(true);
}, 60_000);
