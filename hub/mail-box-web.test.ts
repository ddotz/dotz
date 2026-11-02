import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// The mailbox of the mail app (web/js/30-mail-box.js) in a headless browser against a fake hub: Gmail-like rows (checkbox, star, bold unread),
// the six folders, the actions on one mail and on a selection (optimistic, reverted on ok:false, disabled with one line without the capability),
// the floating 메일 쓰기 sheet and the inline reply with attachment chips. Nothing is sent: the fake hub only records the draft posts.
// MAIL_UI_SHOTS=<dir> also writes {desktop,phone}-{light,dark}-{list,thread,compose}.png there.
const SHOTS = process.env.MAIL_UI_SHOTS ?? "";
const CAN = ["read", "unread", "archive", "unarchive", "trash", "star", "unstar"];
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

type Mail = { key: string; subject: string; from: string; to?: string; cc?: string; at: string; summary: string; read: boolean; archived?: boolean; starred?: boolean; dir?: "out"; can?: string[]; reply?: string; attachments?: unknown[] };
const fresh = (): Mail[] => [
	{ key: "fx-a", subject: "월간 점검 보고서 확인 요청", from: "Alex Sender <alex@example.com>", to: "me@example.com, Park <park@example.com>", cc: "Choi <choi@example.com>", at: ago(1), summary: "요약\n- 이번 달 점검이 끝났어요.\n- 금요일까지 결과 확인이 필요해요.", read: false, starred: true, can: CAN, reply: "needs", attachments: [{ name: "점검보고서.pdf", type: "application/pdf", size: 482113 }] },
	{ key: "fx-b", subject: "회의 일정 변경", from: "Kim <kim@example.com>", at: ago(3), summary: "목요일 회의를 금요일 오후로 옮기려고 해요. 가능한지 알려 달라고 해요.", read: false, can: CAN },
	{ key: "fx-c", subject: "견적서 보내드립니다", from: "Lee <lee@example.com>", at: ago(26), summary: "견적서를 첨부했어요. 검토 후 말씀해 주세요.", read: true, can: CAN, reply: "replied" },
	{ key: "fx-d", subject: "배송 안내", from: "Shop <shop@example.com>", at: ago(50), summary: "주문하신 상품이 출발했어요.", read: true, archived: true, can: CAN },
	{ key: "fx-e", subject: "Re: 견적서 보내드립니다", from: "me@example.com", to: "Lee <lee@example.com>", at: ago(25), summary: "확인했어요. 금요일까지 답드릴게요.", read: true, dir: "out", can: CAN },
	{ key: "fx-fail", subject: "처리가 안 되는 메일", from: "Oh <oh@example.com>", at: ago(5), summary: "서버가 거절하는 메일이에요.", read: false, can: CAN },
	{ key: "fx-company", subject: "회사 메일", from: "Work <work@example.com>", at: ago(6), summary: "회사 메일함은 can이 비어 있어요.", read: false, can: [] },
	{ key: "fx-old", subject: "읽음 표시를 못 하는 메일함", from: "Old <old@example.com>", at: ago(7), summary: "이 메일함은 can 정보가 없어요.", read: true },
];
let mails: Mail[] = fresh();
let posts: { path: string; body: any }[] = [];
let composeFails = false;

const card = (m: Mail) => ({ subject: m.subject, from: m.from, to: m.to, cc: m.cc, source: "company", at: m.at, summary: m.summary, dir: m.dir, read: m.read, archived: !!m.archived, starred: !!m.starred, can: m.can, reply: m.reply, attachments: m.attachments });
const history = (m: Mail) => [{ kind: "mail", ts: m.at, conv: `mail:${m.key}`, target: `mail:${m.key}`, mail: m.key, subject: m.subject, from: m.from, to: m.to, cc: m.cc, dir: m.dir, source: "company", html: false, attachments: m.attachments, text: `[mail] ${m.subject}\n\n${m.summary}\n\n원문\n안녕하세요.\n점검 결과를 보내 드립니다.\n확인 부탁드립니다.` }];
const APPLY: Record<string, (m: Mail) => void> = {
	read: m => { m.read = true; }, unread: m => { m.read = false; }, archive: m => { m.archived = true; }, unarchive: m => { m.archived = false; },
	star: m => { m.starred = true; }, unstar: m => { m.starred = false; }, trash: m => { mails = mails.filter(x => x !== m); },
};
const hub = fakeHub({
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/integrations") return json({ items: [{ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], unread: mails.filter(m => !m.read).length, needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 0 } }], available: [] });
		if (p === "/api/conversations") return json({ items: mails.map(m => ({ target: `mail:${m.key}`, unread: m.read || m.dir ? 0 : 1, read: null, mail: card(m), last: { ts: m.at, text: m.subject, from: "bot" } })) });
		if (p === "/api/history") { const t = url.searchParams.get("target") ?? "", m = mails.find(x => `mail:${x.key}` === t); return json({ target: t, events: m ? history(m) : [] }); }
		if (p === "/api/read" && req.method === "POST") { const b = (await req.json()) as { target: string }; const m = mails.find(x => `mail:${x.key}` === b.target); if (m) m.read = true; return json({ ok: true, moved: true }); }
		if (p === "/api/upload" && req.method === "POST") { const f = (await req.formData()).get("file") as File; return json({ files: [{ name: f.name, path: `/uploads/${f.name}`, size: f.size, type: f.type }] }); }
		if (p === "/api/mail/compose" && req.method === "POST") {
			const body = await req.json(); posts.push({ path: p, body });
			return composeFails ? json({ error: "초안을 만들지 못했어요" }, 500) : json({ ok: true, ref: "d-1", key: "compose-1" });
		}
		const one = /^\/api\/mail\/([^/]+)\/action$/.exec(p);
		if (one && req.method === "POST") {
			const body = (await req.json()) as { action: string }; posts.push({ path: p, body });
			if (one[1] === "fx-fail") return json({ ok: false, synced: false, note: "Gmail에 반영하지 못했어요" });
			const m = mails.find(x => x.key === one[1]); if (m) APPLY[body.action](m);
			if (m && Array.isArray(m.can) && !m.can.length) return json({ ok: true, synced: false, note: `이 메일함은 실제 메일함의 ${body.action === "archive" || body.action === "unarchive" ? "보관 처리를" : "읽음 표시를"} 바꿀 수 없어요. dotz에서만 바뀌었어요` });
			return json({ ok: true, synced: true });
		}
		if (p === "/api/mail/actions" && req.method === "POST") {
			const body = (await req.json()) as { keys: string[]; action: string }; posts.push({ path: p, body });
			// The real hub: the action always lands in dotz; a mailbox with no capability list of its own answers synced:false and one line.
			const line = `이 메일함은 실제 메일함의 ${body.action === "archive" || body.action === "unarchive" ? "보관 처리를" : "읽음 표시를"} 바꿀 수 없어요. dotz에서만 바뀌었어요`;
			return json({ ok: true, results: body.keys.map(k => { const m = mails.find(x => x.key === k); if (m) APPLY[body.action](m); return { key: k, ok: true, synced: !!(m && m.can && m.can.length), ...(m && !(m.can && m.can.length) ? { note: line } : {}) }; }) });
		}
		const del = /^\/api\/mail\/([^/]+)$/.exec(p);
		if (del && req.method === "DELETE") { posts.push({ path: p, body: null }); mails = mails.filter(x => x.key !== del[1]); return json({ ok: true }); }
	},
});
afterAll(() => hub.stop());
beforeEach(() => { mails = fresh(); posts = []; composeFails = false; });

const rowJs = (title: string) => `[...document.querySelectorAll("#mon-tl > .mr")].find(r => r.querySelector(".rc-title").textContent === ${JSON.stringify(title)})`;
const chips = (v: View) => ev<string[]>(v, `[...document.querySelectorAll("#mon-tl .mr-f")].map(b => b.textContent)`);
const titles = (v: View) => ev<string[]>(v, `[...document.querySelectorAll("#mon-tl > .mr .rc-title")].map(t => t.textContent)`);
const folder = async (v: View, k: string) => { await run(v, `document.querySelector('#mon-tl .mr-f[data-filter="${k}"]').click()`); await waitFor(v, `document.querySelector('#mon-tl .mr-f.on').dataset.filter === ${JSON.stringify(k)}`); };
const tick = (v: View, title: string) => run(v, `${rowJs(title)}.querySelector(".mr-chk").click()`);
const bar = (v: View, label: string) => `[...document.querySelectorAll("#mbox-bar .mbox-b")].find(b => b.getAttribute("aria-label") === ${JSON.stringify(label)})`;
const posted = (n: number) => waitForPosts(n);
const waitForPosts = async (n: number) => { const t0 = Date.now(); while (posts.length < n) { if (Date.now() - t0 > 8000) throw new Error(`timeout: ${posts.length}/${n} posts`); await new Promise(r => setImmediate(r)); } };

async function openList(width: number, height: number, theme: "light" | "dark" = "light"): Promise<View> {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S && typeof INTG !== "undefined" && INTG.items.length === 1 && CONV.has("mail:fx-a")`);
	await run(v, `if (dotzTheme.get() !== ${JSON.stringify(theme)}) dotzTheme.toggle()`);
	await run(v, `MON.mailFilter = "all"; MON.land = "i:mail"; go("monitoring")`);
	await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]')`);
	await run(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]').click()`);
	await waitFor(v, `document.querySelector("#mon-tl .mr") && document.querySelector("#mbox-bar")`);
	return v;
}
const openMail = async (v: View, title: string) => {
	await run(v, `${rowJs(title)}.click()`);
	await waitFor(v, `document.querySelector("#tl .mbox-reply")`);
};
const fill = (v: View, sel: string, value: string) => run(v, `const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("input", { bubbles: true }))`);
const attach = (v: View, scope: string, name: string, text: string) => run(v, `const i = document.querySelector(${JSON.stringify(`${scope} input[type=file]`)}), dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)})); i.files = dt.files; i.dispatchEvent(new Event("change"))`);
const shot = async (v: View, name: string) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await Bun.write(`${SHOTS}/${name}.png`, await v.screenshot()); };

describe("the list", () => {
	test("seven folders, a checkbox and a star on every row, the unread rows bold, the summary under the subject", async () => {
		const v = await openList(1280, 800);
		expect(await chips(v)).toEqual(["전체", "안 읽음4", "답장 필요1", "확인 대기", "답장함1", "보관함1", "보낸 메일1"]);
		expect(await titles(v)).toEqual(["월간 점검 보고서 확인 요청", "회의 일정 변경", "처리가 안 되는 메일", "회사 메일", "읽음 표시를 못 하는 메일함", "견적서 보내드립니다"]);
		const got = await ev<any>(v, `(() => { const rows = [...document.querySelectorAll("#mon-tl > .mr")]; return rows.map(r => ({ w: parseInt(getComputedStyle(r.querySelector(".rc-title")).fontWeight), label: r.getAttribute("aria-label"), chk: !!r.querySelector("input.mr-chk"), star: !!r.querySelector(".mr-star"), sum: [...r.children].find(c => c.matches(".mr-sum, ul.mr-sum"))?.textContent || "" })); })()`);
		expect(got[0].w).toBeGreaterThanOrEqual(700);
		expect(got[4].w).toBeLessThan(600);
		expect(got[0].label).toStartWith("안 읽음, ");
		expect(got[4].label).not.toStartWith("안 읽음");
		expect(got.every((g: any) => g.chk && g.star)).toBe(true);
		expect(got[0].sum).toContain("이번 달 점검이 끝났어요");
		expect(await ev<string>(v, `${rowJs("월간 점검 보고서 확인 요청")}.querySelector(".mr-star").getAttribute("aria-pressed")`)).toBe("true");
	}, 30_000);

	test("보관함 and 보낸편지함 hold the archived and the sent mail", async () => {
		const v = await openList(1280, 800);
		await folder(v, "archived");
		expect(await titles(v)).toEqual(["배송 안내"]);
		await folder(v, "sent");
		expect(await titles(v)).toEqual(["Re: 견적서 보내드립니다"]);
		expect(await ev<string>(v, `document.querySelector("#mon-tl > .mr .rc-src").textContent`)).toBe("나 → Lee");
	}, 30_000);
});

describe("actions on a selection", () => {
	test("읽음 / 안읽음 / 완료 post one bulk action and move the rows at once", async () => {
		const v = await openList(1280, 800);
		await tick(v, "월간 점검 보고서 확인 요청"); await tick(v, "회의 일정 변경");
		expect(await ev<string>(v, `document.querySelector("#mbox-bar .mbox-n").textContent`)).toBe("2개 선택");
		await run(v, `${bar(v, "읽음으로 표시")}.click()`);
		await posted(1);
		expect(posts[0]).toEqual({ path: "/api/mail/actions", body: { keys: ["fx-a", "fx-b"], action: "read" } });
		await waitFor(v, `document.querySelectorAll("#mon-tl > .mr.mr-new").length === 2`);
		expect(await chips(v)).toContain("안 읽음2");
		await run(v, `${bar(v, "안 읽음으로 표시")}.click()`);
		await posted(2);
		expect(posts[1].body.action).toBe("unread");
		await waitFor(v, `document.querySelectorAll("#mon-tl > .mr.mr-new").length === 4`);
		await run(v, `${bar(v, "완료(보관)")}.click()`);
		await posted(3);
		expect(posts[2].body).toEqual({ keys: ["fx-a", "fx-b"], action: "archive" });
		await waitFor(v, `document.querySelectorAll("#mon-tl > .mr").length === 4`);
		await folder(v, "archived");
		expect(await titles(v)).toEqual(["월간 점검 보고서 확인 요청", "회의 일정 변경", "배송 안내"]);
	}, 30_000);

	test("a refused action goes back and its note is told once", async () => {
		const v = await openList(1280, 800);
		await tick(v, "처리가 안 되는 메일");
		await run(v, `${bar(v, "읽음으로 표시")}.click()`);
		await posted(1);
		expect(posts[0].path).toBe("/api/mail/fx-fail/action");
		await waitFor(v, `document.querySelector(".toast, #toast, .snack")?.textContent.includes("Gmail에 반영하지 못했어요")`);
		expect(await ev<number>(v, `[...document.querySelectorAll("body *")].filter(e => e.children.length === 0 && e.textContent === "Gmail에 반영하지 못했어요").length`)).toBe(1);
		expect(await ev<boolean>(v, `${rowJs("처리가 안 되는 메일")}.classList.contains("mr-new")`)).toBe(true);
	}, 30_000);

	test("a mailbox that will not follow still changes in dotz, and says so in one line", async () => {
		const v = await openList(1280, 800);
		await tick(v, "회사 메일");
		// company, a webmail site: the card says can: [], so the hub cannot follow, but the action still happens here. The action still lands in dotz and the hub's one line says the mailbox did not follow.
		expect(await ev<boolean>(v, `${bar(v, "읽음으로 표시")}.disabled`)).toBe(false);
		expect(await ev<boolean>(v, `${bar(v, "완료(보관)")}.disabled`)).toBe(false);
		await run(v, `${bar(v, "완료(보관)")}.click()`);
		await posted(1);
		expect(posts[0]).toEqual({ path: "/api/mail/fx-company/action", body: { action: "archive" } });
		await waitFor(v, `!${rowJs("회사 메일")}`);
		expect(await ev<number>(v, `[...document.querySelectorAll("body *")].filter(e => e.children.length === 0 && e.textContent.includes("실제 메일함의 보관 처리를 바꿀 수 없어요")).length`)).toBe(1);
	}, 30_000);

	test("삭제 asks first, then uses the old route for a mailbox with no capability list", async () => {
		const v = await openList(1280, 800);
		await tick(v, "읽음 표시를 못 하는 메일함");
		await run(v, `${bar(v, "삭제")}.click()`);
		await waitFor(v, `document.querySelector("dialog[open] .btn.danger")`);
		await run(v, `document.querySelector("dialog[open] .btn.danger").click()`);
		await posted(1);
		expect(posts[0]).toEqual({ path: "/api/mail/fx-old", body: null });
		await waitFor(v, `!${rowJs("읽음 표시를 못 하는 메일함")}`);
	}, 30_000);
});

describe("메일 쓰기", () => {
	test("the floating button opens a sheet; attachments are chips that can be removed; saving posts a draft, never a send", async () => {
		const v = await openList(1280, 800);
		expect(await ev<string>(v, `getComputedStyle(document.querySelector(".mbox-fab")).position`)).toBe("fixed");
		await run(v, `document.querySelector(".mbox-fab").click()`);
		await waitFor(v, `document.querySelector(".mbox-sheet")`);
		await fill(v, '.mbox-sheet [data-k="mail-to"]', "lee@example.com");
		await fill(v, '.mbox-sheet [data-k="mail-subject"]', "견적 문의");
		await fill(v, '.mbox-sheet [data-k="mail-body"]', "견적을 부탁드립니다.");
		await attach(v, ".mbox-sheet", "견적.txt", "hello");
		await waitFor(v, `document.querySelector('.mbox-sheet .mbox-chip[data-name="견적.txt"]')`);
		expect(await ev<string>(v, `document.querySelector('.mbox-sheet .mbox-chip[data-name="견적.txt"]').textContent`)).toContain("5B");
		await attach(v, ".mbox-sheet", "빼기.txt", "x");
		await waitFor(v, `document.querySelector('.mbox-sheet .mbox-chip[data-name="빼기.txt"] .mbox-cx')`);
		await run(v, `document.querySelector('.mbox-sheet .mbox-chip[data-name="빼기.txt"] .mbox-cx').click()`);
		expect(await ev<number>(v, `document.querySelectorAll(".mbox-sheet .mbox-chip").length`)).toBe(1);
		await shot(v, "scratch-compose");
		await run(v, `document.querySelector(".mbox-sheet .mbox-save").click()`);
		await posted(1);
		expect(posts[0]).toEqual({ path: "/api/mail/compose", body: { to: "lee@example.com", cc: "", subject: "견적 문의", body: "견적을 부탁드립니다.", attachments: [{ name: "견적.txt", path: "/uploads/견적.txt", size: 5 }] } });
		await waitFor(v, `!document.querySelector(".mbox-sheet")`);
	}, 30_000);

	test("minimize keeps what was typed", async () => {
		const v = await openList(1280, 800);
		await run(v, `document.querySelector(".mbox-fab").click()`);
		await waitFor(v, `document.querySelector(".mbox-sheet")`);
		await fill(v, '.mbox-sheet [data-k="mail-subject"]', "초안");
		await run(v, `document.querySelector(".mbox-sheet .mbox-min").click()`);
		expect(await ev<boolean>(v, `document.querySelector(".mbox-sheet").classList.contains("min")`)).toBe(true);
		await run(v, `document.querySelector(".mbox-fab").click()`);
		expect(await ev<string>(v, `document.querySelector('.mbox-sheet [data-k="mail-subject"]').value`)).toBe("초안");
	}, 30_000);
});

describe("the open mail", () => {
	test("답장 / 전체답장 / 전달 at the bottom: quoted original collapsed, chips survive a failed save, the draft names the mail and the mode", async () => {
		const v = await openList(1280, 800);
		await openMail(v, "월간 점검 보고서 확인 요청");
		expect(await ev<string[]>(v, `[...document.querySelectorAll("#tl .mbox-mode")].map(b => b.textContent)`)).toEqual(["답장", "전체답장", "전달"]);
		await run(v, `document.querySelector('#tl .mbox-mode[data-mode="reply"]').click()`);
		await waitFor(v, `document.querySelector("#tl .mbox-reply.open")`);
		expect(await ev<string>(v, `document.querySelector('#tl [data-k="mail-to"]').value`)).toBe("alex@example.com");
		expect(await ev<string>(v, `document.querySelector('#tl [data-k="mail-subject"]').value`)).toBe("Re: 월간 점검 보고서 확인 요청");
		expect(await ev<boolean>(v, `document.querySelector("#tl .mbox-quote").open`)).toBe(false);
		expect(await ev<string>(v, `document.querySelector("#tl .mbox-qt").textContent`)).toContain("점검 결과를 보내 드립니다");
		await fill(v, '#tl [data-k="mail-body"]', "확인했어요.");
		await attach(v, "#tl .mbox-reply", "결과.txt", "abc");
		await waitFor(v, `document.querySelector('#tl .mbox-chip[data-name="결과.txt"]')`);
		composeFails = true;
		await run(v, `document.querySelector('#tl [data-k="mail-reply-save"]').click()`);
		await posted(1);
		await waitFor(v, `document.querySelector('#tl [data-k="mail-reply-save"]') && !document.querySelector('#tl [data-k="mail-reply-save"]').disabled`);
		expect(await ev<number>(v, `document.querySelectorAll('#tl .mbox-chip[data-name="결과.txt"]').length`)).toBe(1);
		expect(await ev<string>(v, `document.querySelector('#tl [data-k="mail-body"]').value`)).toBe("확인했어요.");
		composeFails = false;
		await run(v, `document.querySelector('#tl [data-k="mail-reply-save"]').click()`);
		await posted(2);
		expect(posts[1].body).toEqual({ to: "alex@example.com", cc: "", subject: "Re: 월간 점검 보고서 확인 요청", body: "확인했어요.", attachments: [{ name: "결과.txt", path: "/uploads/결과.txt", size: 3 }], reply_to: "fx-a", mode: "reply" });
		await waitFor(v, `!document.querySelector("#tl .mbox-reply.open")`);
	}, 30_000);

	test("전체답장 adds the other recipients and 전달 starts empty with Fwd:", async () => {
		const v = await openList(1280, 800);
		await openMail(v, "월간 점검 보고서 확인 요청");
		await run(v, `document.querySelector('#tl .mbox-mode[data-mode="all"]').click()`);
		await waitFor(v, `document.querySelector('#tl [data-k="mail-cc"]')`);
		const cc = await ev<string>(v, `document.querySelector('#tl [data-k="mail-cc"]').value`);
		expect(cc).toContain("park@example.com");
		expect(cc).toContain("choi@example.com");
		await run(v, `document.querySelector('#tl .mbox-mode[data-mode="forward"]').click()`);
		await waitFor(v, `document.querySelector('#tl [data-k="mail-subject"]').value.startsWith("Fwd: ")`);
		expect(await ev<string>(v, `document.querySelector('#tl [data-k="mail-to"]').value`)).toBe("");
	}, 30_000);

	test("완료(보관) in the open mail posts one action and goes back to the list", async () => {
		const v = await openList(1280, 800);
		await openMail(v, "월간 점검 보고서 확인 요청");
		await run(v, `document.querySelector('#tl [data-k="mail-open-archive"]').click()`);
		await posted(1);
		expect(posts[0]).toEqual({ path: "/api/mail/fx-a/action", body: { action: "archive" } });
		await waitFor(v, `document.querySelector("#mon-tl .mr") && !${rowJs("월간 점검 보고서 확인 요청")}`);
	}, 30_000);
});

describe.if(!!SHOTS)("screenshots", () => {
	for (const [name, w, h] of [["desktop", 1280, 800], ["phone", 390, 844]] as const) {
		for (const theme of ["light", "dark"] as const) {
			test(`${name} ${theme}`, async () => {
				const v = await openList(w, h, theme);
				await tick(v, "월간 점검 보고서 확인 요청"); await tick(v, "견적서 보내드립니다");
				await shot(v, `${name}-${theme}-list`);
				await run(v, `document.querySelectorAll("#mon-tl .mr-chk").forEach(c => c.checked && c.click())`);
				await openMail(v, "월간 점검 보고서 확인 요청");
				await run(v, `document.querySelector('#tl .mbox-mode[data-mode="reply"]').click()`);
				await waitFor(v, `document.querySelector("#tl .mbox-reply.open")`);
				await fill(v, '#tl [data-k="mail-body"]', "확인했어요. 금요일까지 결과를 보내 드릴게요.");
				await attach(v, "#tl .mbox-reply", "결과보고서.pdf", "x".repeat(2048));
				await waitFor(v, `document.querySelector('#tl .mbox-chip[data-name="결과보고서.pdf"]')`);
				await run(v, `document.querySelector("#tl .mbox-reply").scrollIntoView({ block: "end" })`);
				await shot(v, `${name}-${theme}-thread`);
				await run(v, `go("monitoring", "i:mail")`);
				await waitFor(v, `document.querySelector(".mbox-fab")`);
				await run(v, `document.querySelector(".mbox-fab").click()`);
				await waitFor(v, `document.querySelector(".mbox-sheet")`);
				await fill(v, '.mbox-sheet [data-k="mail-to"]', "lee@example.com");
				await fill(v, '.mbox-sheet [data-k="mail-subject"]', "견적 문의");
				await fill(v, '.mbox-sheet [data-k="mail-body"]', "안녕하세요.\n견적서를 보내 주실 수 있을까요?");
				await attach(v, ".mbox-sheet", "요청서.docx", "y".repeat(40_000));
				await waitFor(v, `document.querySelector('.mbox-sheet .mbox-chip[data-name="요청서.docx"]')`);
				await shot(v, `${name}-${theme}-compose`);
			}, 60_000);
		}
	}
});
