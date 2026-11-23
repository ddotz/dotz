import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = new Date().toISOString();
const REF = "hand-layout-1";
const BODY = [
	"안녕하세요, Kim님.",
	"",
	"보내주신 자료 잘 받았습니다.",
	"제가 내일부터 자리를 비워서 꼼꼼히 보지 못하고, 우선 정리한 내용을 먼저 보내드립니다. 직접 다 확인한 내용은 아닌 점 양해 부탁드립니다.",
	"",
	"1. 첫째 항목 확인 건",
	" - 2025년 항목 4건(1,234,567원)이 표에는 들어가 있는데, 합계에는 빠져 있습니다.",
	" - 합계 쪽은 원장 금액을 그대로 가져오다 보니 들어가 있지 않습니다. 한쪽에만 들어간 차이를 기타(D27)가 메우고 있어서, 기타가 작게 보이는 상황입니다.",
	"  · 세부: 표 A는 12, 표 B는 15입니다.",
	"",
	"2. 둘째 항목 문의",
	" - 기준이 바뀌면 알려주시면 좋겠습니다.",
	"",
	"감사합니다",
];
const OPTS = [{ n: 1, label: "보내기", desc: "", rec: true }, { n: 2, label: "고치기", desc: "", rec: false, detail: true }, { n: 3, label: "보내지 않기", desc: "", rec: false }];
const draft = { toLabel: "받는이", to: "Kim <kim@example.com>", subject: "RE: 제목A" };
const notice = { id: "n-layout-1", ts: NOW, updated: NOW, kind: "decision", tone: "ask", title: `메일 보낼까요? (${REF})`, text: `${BODY.map(l => `> ${l}`).join("\n")}\n메일 보낼까요? (${REF})`, open: "web", src: "web", at: NOW, read: false,
	decision: { options: OPTS, to: "web", reply_to: NOW, group: 1, state: "open", draft: { ...draft, body: BODY.join("\n"), ref: REF } } };
const queueItem = { item: `card:web|${REF}`, ref: REF, kind: "card", app: "card", label: "메일 보낼까요?", conv: "web", notice: notice.id, at: Date.now(), can: { send: true, revise: true, edit: false, drop: true, restore: false },
	draft: { state: "pending", ...draft, text: BODY.join("\n") } };

const held = { queue: [queueItem] as object[] };
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/notices") return json({ items: [notice], unread: 1 });
		if (url.pathname === "/api/reply/queue") return json({ items: held.queue, counts: {}, triageMin: 3, undoSec: 10 });
	},
});
afterAll(() => hub.stop());

type Layout = { text: string[]; wrapped: number; notAtLeft: number[]; sharesRow: number[]; outOfOrder: number[]; earlyBreak: number[] };
const LAYOUT = `(sel => {
  const box = document.querySelector(sel), cs = getComputedStyle(box), r = box.getBoundingClientRect();
  const left = r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), right = r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT), nodes = [];
  let text = "";
  for (let t; (t = walker.nextNode());) { nodes.push([t, text.length]); text += t.data; }
  const at = i => { for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k][1] <= i) return [nodes[k][0], i - nodes[k][1]]; };
  const rects = (a, b) => { const g = document.createRange(), s = at(a), e = at(b - 1); g.setStart(s[0], s[1]); g.setEnd(e[0], e[1] + 1); return [...g.getClientRects()].filter(q => q.width > 0); };
  const lines = text.replace(/\\n$/, "").split("\\n"), out = { text: lines, wrapped: 0, notAtLeft: [], sharesRow: [], outOfOrder: [], earlyBreak: [] };
  let pos = 0, lastBottom = -Infinity;
  for (const [n, line] of lines.entries()) {
    const a = pos;
    pos += line.length + 1;
    if (!line.trim()) continue;
    const first = rects(a, a + 1)[0];
    if (!first || Math.abs(first.left - left) > 1) out.notAtLeft.push(n + 1);
    if (first && first.top < lastBottom - 1) out.sharesRow.push(n + 1);
    const words = [...line.matchAll(/\\S+/g)].map(m => rects(a + m.index, a + m.index + m[0].length)).filter(q => q.length);
    let rows = 1, early = false, order = true;
    for (let k = 1; k < words.length; k++) {
      const p = words[k - 1].at(-1), q = words[k][0];
      if (q.top < p.top - 1 || (Math.abs(q.top - p.top) <= 1 && q.left < p.right - 1)) order = false;
      if (q.top > p.top + 1) { rows++; if (words[k].length === 1 && p.right + q.width + 12 <= right) early = true; }
    }
    if (rows > 1) out.wrapped++;
    if (!order) out.outOfOrder.push(n + 1);
    if (early) out.earlyBreak.push(n + 1);
    lastBottom = Math.max(...words.flat().map(q => q.bottom));
  }
  return out;
})`;

const CARD = `Object.assign(draftCardNode(NT.items[0]), { id: "layout-card" })`;
const SURFACES = {
	"답장 확인 창 of a card the queue holds, opened again after 펼치기": { queue: [queueItem], sel: ".rq-sheet .rq-text", open: `ntDraftSheet(NT.items[0])`, again: `ntDraftSheet(NT.items[0])` },
	"답장 확인 창 of a card only its notice holds": { queue: [], sel: ".fs-body .dc-dr-b", open: `ntDraftSheet(NT.items[0])`, again: "" },
	"the 모니터링 card of a draft the queue holds, drawn again after 펼치기": { queue: [queueItem], sel: "#layout-card .rq-text", open: `document.body.append(${CARD})`, again: `document.getElementById("layout-card").replaceWith(${CARD})` },
	"the 모니터링 card of a draft only its notice holds, drawn again after 펼치기": { queue: [], sel: "#layout-card .dr-body", open: `document.body.append(${CARD})`, again: `document.getElementById("layout-card").replaceWith(${CARD})` },
};

for (const [name, s] of Object.entries(SURFACES)) {
	for (const [width, height] of [[1280, 900], [390, 844]] as const) {
		test(`${name}, ${width} wide: every line of the draft starts at the left edge, in order, on rows of its own, and folds only where the width ends`, async () => {
			held.queue = s.queue;
			const view = await hub.view({ width, height, console: () => undefined });
			try {
				const { waitFor, ev, run } = on(view);
				await view.navigate(`${hub.origin}/`);
				await waitFor(`typeof ntDraftSheet === "function" && RA.loaded && NT.loaded && NT.items.length === 1`);
				await run(s.open);
				await waitFor(`!!document.querySelector(${JSON.stringify(s.sel)})`);
				await run(`document.querySelectorAll("[data-k=more][aria-expanded=false]").forEach(b => b.click())`);
				if (s.again) await run(s.again);
				await waitFor(`document.querySelectorAll(${JSON.stringify(s.sel)}).length === 1 && document.getAnimations().every(a => a.playState !== "running")`);
				const got = await ev<Layout>(`${LAYOUT}(${JSON.stringify(s.sel)})`);
				expect(got.text).toEqual(BODY);
				expect({ notAtLeft: got.notAtLeft, sharesRow: got.sharesRow, outOfOrder: got.outOfOrder, earlyBreak: got.earlyBreak }).toEqual({ notAtLeft: [], sharesRow: [], outOfOrder: [], earlyBreak: [] });
				if (width === 390) expect(got.wrapped).toBeGreaterThan(0);
			} finally {
				view.close();
			}
		});
	}
}
