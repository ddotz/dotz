import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// 원문 보기 on a mail row of 모니터링 > 메일 (web/js/30-monitoring.js monConvNode, web/js/10-draft-original.js orgMailOf): the row folds the original open
// under its summary without leaving the list - sender, date, subject, the whole body and the file names - read from the mail's own conversation
// (GET /api/history?target=mail:<key>) and, for an HTML mail, its kept body (GET /api/mail/<key>/body). One fetch per mail; the row's own click still opens it.
// MAIL_ORIG_SHOTS=<dir> also writes {desktop,phone}-{list,open}.png there.
const SHOTS = process.env.MAIL_ORIG_SHOTS ?? "";
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const BODY = "안녕하세요.\n\n지난주 회의에서 말씀드린 견적서를 첨부해 보내드립니다.\n금액과 납기를 확인해 주시고, 수정할 부분이 있으면 금요일까지 알려 주세요.\n\n감사합니다.\n테스트 보낸이 드림";
type Mail = { key: string; subject: string; from: string; to: string; at: string; summary: string; html?: boolean; attachments?: { name: string; size: number }[]; event: boolean };
const MAILS: Mail[] = [
	{ key: "fx-text", subject: "견적서 보내드립니다", from: "Test Sender <sender@example.com>", to: "me@example.com", at: ago(1), summary: "요약\n- 견적서를 첨부했어요.\n- 금요일까지 확인이 필요해요.", attachments: [{ name: "견적서.pdf", size: 20480 }, { name: "일정표.xlsx", size: 4096 }], event: true },
	{ key: "fx-html", subject: "월간 소식지", from: "Newsletter <news@example.com>", to: "me@example.com", at: ago(2), summary: "이번 달 소식을 모았어요.", html: true, event: true },
	{ key: "fx-gone", subject: "기록이 없는 메일", from: "Nobody <nobody@example.com>", to: "me@example.com", at: ago(3), summary: "대화 기록이 지워진 메일이에요.", event: false },
];
const hits: Record<string, number> = {};
const card = (m: Mail) => ({ subject: m.subject, from: m.from, to: m.to, source: "kdb", at: m.at, summary: m.summary, read: true, can: [], html: !!m.html, attachments: m.attachments });
const history = (m: Mail) => m.event ? [{ kind: "mail", ts: m.at, conv: `mail:${m.key}`, target: `mail:${m.key}`, mail: m.key, subject: m.subject, from: m.from, to: m.to, source: "kdb", html: !!m.html, attachments: m.attachments, text: `${m.from} · ${m.subject}\n\n${m.summary}\n\n원문\n${BODY}` }] : [];
const hub = fakeHub({
	api: (req, url) => {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/integrations") return json({ items: [{ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], unread: 0, needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 0 } }], available: [] });
		if (p === "/api/conversations") return json({ items: MAILS.map(m => ({ target: `mail:${m.key}`, unread: 0, read: null, mail: card(m), last: { ts: m.at, text: m.subject, from: "bot" } })) });
		if (p === "/api/history") {
			const t = url.searchParams.get("target") ?? "", m = MAILS.find(x => `mail:${x.key}` === t);
			hits[t] = (hits[t] ?? 0) + 1;
			return json({ target: t, events: m ? history(m) : [] });
		}
		const body = /^\/api\/mail\/([^/]+)\/body$/.exec(p);
		if (body) return new Response("<p>이번 달 <b>소식지</b> 본문이에요.</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
		if (p === "/api/read") return json({ ok: true });
		return undefined;
	},
});
afterAll(() => hub.stop());

const rowJs = (title: string) => `[...document.querySelectorAll("#mon-tl > .mr")].find(r => r.querySelector(".rc-title").textContent === ${JSON.stringify(title)})`;
const shot = async (v: View, name: string) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await Bun.write(`${SHOTS}/${name}.png`, await v.screenshot()); };
async function openList(width: number, height: number): Promise<View> {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && typeof INTG !== "undefined" && INTG.items.length === 1 && CONV.has("mail:fx-text")`);
	await run(v, `MON.mailFilter = "all"; MON.land = "i:mail"; go("monitoring")`);
	await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]')`);
	await run(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]').click()`);
	await waitFor(v, `document.querySelectorAll("#mon-tl > .mr").length === 3`);
	return v;
}
const ITEM = `[...document.querySelectorAll(".menu .mi")].find(b => /^원문 (보기|접기)$/.test(b.textContent))`;
const openMenu = async (v: View, title: string) => {
	await run(v, `${rowJs(title)}.querySelector(".mr-more").click()`);
	await waitFor(v, `${ITEM}`);
	return ev<string>(v, `${ITEM}.textContent`);
};
const toggle = async (v: View, title: string) => {
	await openMenu(v, title);
	await run(v, `${ITEM}.click()`);
};

describe("원문 보기 on a mail row", () => {
	for (const [name, w, h] of [["desktop", 1280, 900], ["phone", 390, 844]] as const) {
		test(`${name}: the row opens its original in place - sender, date, subject, the whole body, the file names - with one fetch`, async () => {
			const v = await openList(w, h);
			await shot(v, `${name}-list`);
			const before = hits["mail:fx-text"] ?? 0;
			await toggle(v, "견적서 보내드립니다");
			await waitFor(v, `${rowJs("견적서 보내드립니다")}.querySelector(".mr-op .od-body")`);
			const got = await ev<{ text: string; files: string[]; sel: string }>(v, `(() => { const r = ${rowJs("견적서 보내드립니다")}, p = r.querySelector(".mr-op"); return { text: p.textContent, files: [...p.querySelectorAll(".dr-fn")].map(f => f.textContent), sel: MON.sel }; })()`);
			expect(got.text).toContain("sender@example.com");
			expect(got.text).toContain("견적서 보내드립니다");
			expect(got.text).toContain("날짜");
			expect(got.text).toContain("금액과 납기를 확인해 주시고");
			expect(got.text).toContain("테스트 보낸이 드림");
			expect(got.files).toEqual(["견적서.pdf", "일정표.xlsx"]);
			expect(got.sel).toBe("i:mail");   // the toggle does not open the mail's conversation
			expect((hits["mail:fx-text"] ?? 0) - before).toBe(1);
			await run(v, `document.querySelector(".mr-op").scrollIntoView({ block: "center" })`);
			await shot(v, `${name}-open`);
			// folded and opened again: no second fetch
			await toggle(v, "견적서 보내드립니다");
			await waitFor(v, `!${rowJs("견적서 보내드립니다")}.querySelector(".mr-op")`);
			expect(await openMenu(v, "견적서 보내드립니다")).toBe("원문 보기");
			await run(v, `${ITEM}.click()`);
			await waitFor(v, `${rowJs("견적서 보내드립니다")}.querySelector(".mr-op .od-body")`);
			expect((hits["mail:fx-text"] ?? 0) - before).toBe(1);
		}, 30_000);
	}

	test("an HTML mail shows its kept body in the sandboxed frame", async () => {
		const v = await openList(1280, 900);
		await toggle(v, "월간 소식지");
		await waitFor(v, `${rowJs("월간 소식지")}.querySelector(".mr-op .od-body iframe")`);
		expect(await ev<string>(v, `${rowJs("월간 소식지")}.querySelector(".mr-op").textContent`)).toContain("news@example.com");
	}, 30_000);

	test("a mail with no kept original says so", async () => {
		const v = await openList(1280, 900);
		await toggle(v, "기록이 없는 메일");
		await waitFor(v, `${rowJs("기록이 없는 메일")}.querySelector(".mr-op .od-note")?.textContent === "원문을 찾을 수 없어요"`);
	}, 30_000);
});
