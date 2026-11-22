// The reply card on the real 답장 대기 screen against a fake hub (reply clarity redesign, spec Amendments A and B). Every card has 보내기 · 고치기 · 보내지 않기 and says what
// goes with it (the files, or that there are none). 고치기 opens one panel: 반영 checks the version (the server's `edit`, or the queue read again), then writes the rows he marked, then `revise`,
// and never sends; 닫기 forgets everything. A send carries the hash of the version its card showed, and one the hub refuses as changed is drawn again from the fresh item.
// The fake hub keeps the server's side of the contract: an `edit` that also asks to send is a 400, a lint failure a 422, and a send whose hash names another version a
// 409 `changed` with the item as it is now. Shots are written only when REPLY_SHOTS names a folder.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeHub, inbox, json, on, type View } from "./test-web.ts";

const SHOTS = process.env.REPLY_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };

type Files = { name: string; size: string }[];
type Mail = { ref: string; to: string; subject: string; text: string; attachments?: Files };
type Draft = { state: string; text: string; hash: string; subject?: string; to?: string; cc?: string[]; attachments?: Files; edited?: true; mail?: Mail; [k: string]: unknown };
type Item = { ref: string; draft: Draft; send?: unknown; [k: string]: unknown };
type Body = Record<string, unknown>;
const NOW = Date.now();
const can = { send: true, revise: true, edit: true, drop: true, restore: false };
const rowsByDraftRef = new Map<string, { to: string[]; cc: string[]; mode: string; files: Files }>();
const PDF: Files = [{ name: "견적서.pdf", size: "120KB" }];
const mail = (ref: string, ago: number, text: string, o: Body = {}, draft: Body = {}): Item => {
	const it: Item = { item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at: NOW - ago, can,
		draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", subject: "Re: 자료 요청", text, hash: `${ref}-v1`, ...draft }, original: { who: "김팀장 <kim@example.com>", text: "자료 금요일까지 되나요?" }, ...o };
	rowsByDraftRef.set(ref, { to: ["kim@example.com"], cc: [], mode: "reply", files: [...(it.draft.attachments ?? [])] });
	return it;
};
const comment = (ref: string, ago: number, text: string, m?: Mail): Item => {
	if (m) rowsByDraftRef.set(m.ref, { to: [m.to], cc: [], mode: "reply", files: [...(m.attachments ?? [])] });
	return { item: `comment:${ref}`, ref, kind: "comment", app: "youtube", label: "유튜브", conv: "comment:yt", at: NOW - ago, can, original: { who: "viewer", text: "3부 자료도 받을 수 있을까요?" },
		draft: { state: "pending", toLabel: "대상", to: "유튜브 @viewer 댓글", text, hash: `${ref}-v1`, ...(m ? { mail: m } : {}) } };
};
const along = (ref: string, attachments?: Files): Mail => ({ ref, to: "viewer@example.com", subject: "3부 자료 보내드려요", text: "요청하신 3부 자료를 붙였습니다.", ...(attachments ? { attachments } : {}) });
const failed = (code: string, text: string, actions: string[]) => ({ state: "failed", at: NOW, reason: { code, text }, safeToAuto: false, attempts: 1, actions });
const LONG_OLD = ["안녕하세요, 김팀장님.", "", "요청하신 자료 건으로 답장드립니다.", "먼저 일정부터 말씀드릴게요.", "초안은 수요일에 드리겠습니다.", "검토 의견은 메일로 주시면 됩니다.", "회의는 온라인으로 하겠습니다.", "참석자는 지난번과 같습니다.", "견적서는 따로 보내드립니다.", "궁금한 점은 언제든 물어봐 주세요.", "", "감사합니다."];
const LONG_NEW = LONG_OLD.map((l, i) => (i === 4 ? "초안은 목요일 오전에 드리겠습니다." : i === 8 ? "견적서는 이 메일에 붙였습니다." : l));
const TALK = ["네, 토요일에 뵐게요.", "장소는 지난번 그곳으로 할게요."];
const queue: Item[] = [
	mail("RPEN01", 1000, "네, 금요일 오전까지 보내드릴게요.\n필요한 형식이 있으면 알려 주세요."),
	{ item: "card:main|KCARD1", ref: "KCARD1", kind: "card", app: "card", label: "세션이 쓴 카드", conv: "main", at: NOW - 2000, can: { ...can, edit: false }, draft: { state: "pending", toLabel: "", to: "", text: "세션이 직접 쓴 초안이에요.", hash: "KCARD1-v1" } },
	mail("REDT01", 3000, "자료는 금요일까지 드릴게요."),
	mail("RREV01", 4000, "확인해 보고 말씀드릴게요."),
	mail("REDT02", 5000, "회의는 3시에 뵙겠습니다."),
	mail("REDT04", 6000, "일정은 다음 주에 정할게요."),
	mail("REDT03", 7000, "견적은 내일 드릴게요."),
	mail("RKEY01", 8000, "주소는 문자로 보내 드릴게요."),
	mail("RESC01", 9000, "발표 자료는 전날까지 드릴게요."),
	mail("RROW01", 10_000, "첨부한 견적서 확인 부탁드려요.", {}, { attachments: PDF }),
	mail("RROW02", 11_000, "견적서를 붙여 보내 드려요.", {}, { attachments: PDF }),
	mail("RROW03", 12_000, "요청하신 견적서를 붙였습니다.\n확인하시고 궁금한 점은 알려 주세요.", {}, { attachments: PDF }),
	mail("RROW04", 12_500, "지난번 견적서를 다시 보내 드려요.", {}, { attachments: PDF }),
	mail("RROW05", 12_700, "견적서는 이번 주에 다시 보내 드릴게요.", {}, { attachments: PDF }),
	mail("RSUB01", 13_000, "수정한 자료를 보내 드립니다."),
	comment("DCOM01", 14_000, "메일로 보내드렸어요!", along("RMAILX1", [{ name: "자료_3부.pdf", size: "88KB" }])),
	comment("DCOM02", 15_000, "좋게 봐 주셔서 고마워요."),
	comment("DCOM03", 16_000, "메일로 안내를 보내드렸어요.", along("RMAILX3")),
	comment("DCOM04", 17_000, "메일로 보내드렸어요!", along("RMAILX4", [{ name: "자료_3부.pdf", size: "88KB" }])),
	comment("DCOM05", 18_000, "메일로 3부 자료 보내드렸어요.\n연습에 도움이 되면 좋겠어요!", along("RMAILX5", [{ name: "자료_3부.pdf", size: "88KB" }])),
	{ item: "kakao:KKAO01", ref: "KKAO01", kind: "kakao", app: "kakao", label: "카카오톡", conv: "kakao:room1", at: NOW - 19_000, can, original: { who: "이웃", text: "토요일 모임 오시나요?" },
		draft: { state: "pending", toLabel: "대화방", to: "동네 모임", text: TALK.join("\n"), parts: TALK, hash: "KKAO01-v1" } },
	mail("RSND01", 20_000, "오늘 안에 회신드릴게요."),
	mail("RDRP01", 21_000, "이 건은 전화로 말씀드릴게요."),
	mail("RCHG01", 22_000, "수요일에 보내 드릴게요."),
	mail("RDIF01", 23_000, "목요일까지 보내드릴게요. 감사합니다.", {}, { replaces: { ref: "ROLD01", text: "확인해 보고 말씀드릴게요. 감사합니다." } }),
	mail("RDIF02", 24_000, LONG_NEW.join("\n"), {}, { replaces: { ref: "ROLD02", text: LONG_OLD.join("\n") } }),
	mail("RNTC01", 25_000, "다음 주 일정을 보내 드립니다."),
	mail("RANS01", 26_000, "자료는 메일로 보내 드릴게요."),
	mail("RANS02", 27_000, "회의록은 내일 보내 드릴게요."),
	mail("RFRT01", 28_000, "곧 다시 연락드릴게요.", { send: failed("offline", "인터넷에 연결되지 않았어요", ["retry", "drop"]) }),
	mail("RFAS01", 29_000, "첨부한 3부 자료 확인해 주세요.", { send: failed("attach_mismatch", "글에서 말한 파일과 붙인 파일이 달라요", ["send_as_is", "redraft", "drop"]) }),
	mail("RFRT03", 30_000, "내일 오전에 다시 보내 드릴게요.", { send: failed("offline", "인터넷에 연결되지 않았어요", ["retry", "drop"]) }),
	mail("RUNS01", 31_000, "방금 보낸 메일 확인 부탁드려요.", { send: { state: "unsure", at: NOW, reason: { code: "net_cut", text: "보내는 중에 연결이 끊겼어요" }, attempts: 1, actions: ["resolve_sent", "open_channel", "resolve_retry"] } }),
	mail("RNAP01", 32_000, "내일 다시 연락드릴게요.", { send: failed("not_approved", "보내기로 고른 기록이 없어요", ["send"]) }),
	mail("RBCK01", 32_500, "다시 보내려던 답장이에요.", { back: { at: NOW, cause: "restart" } }),
];
const notice = (id: string, ref: string, labels: string[]) => ({ id, kind: "decision", title: `이 답장 보낼까요? (${ref})`, ts: new Date(NOW).toISOString(), text: "",
	decision: { to: `mail:${ref}`, state: "open", options: labels.map((label, i) => ({ n: i + 1, label })), draft: { ref, toLabel: "받는이", to: "kim@example.com", body: "다음 주 일정을 보내 드립니다." } } });
const SEND3 = ["보내기", "고치기", "보내지 않기"];
const notices = [notice("n1", "RNTC01", SEND3), notice("n2", "RANS01", [...SEND3, "이대로 보내기"]), notice("n3", "RLATE1", SEND3), notice("n4", "RANS02", SEND3)];

const posts = inbox<Body>();
const writesInOrder = inbox<{ path: string; body: Body }>();
const find = (ref: string) => queue.find(i => i.ref === ref)!;
const bump = (it: Item) => { it.draft.hash = it.draft.hash.replace(/\d+$/, n => String(Number(n) + 1)); };
const sends = (b: Body) => b.action === "send" || b.action === "retry" || (b.action === "resolve" && b.as === "retry");
const hub = fakeHub({
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/reply/queue") return json({ items: queue, counts: {}, triageMin: 1, undoSec: 10 });
		if (p === "/api/notices" && req.method === "GET") return json({ unread: 0, items: notices });
		if (p === "/api/upload" && req.method === "POST") {
			const f = (await req.formData()).get("file") as File;
			writesInOrder.push({ path: p, body: { name: f.name } });
			return json({ files: [{ path: `/uploads/${f.name}`, name: f.name }] });
		}
		if (p === "/api/reply/act" && req.method === "POST") {
			const b = (await req.json()) as Body, it = find(String(b.ref));
			posts.push(b); writesInOrder.push({ path: p, body: b });
			if (b.action === "edit" && "send" in b) return json({ ok: false, code: "bad_request", error: "bad_request" }, 400);
			if (b.action === "edit" && String(b.text).includes("무조건")) return json({ ok: false, code: "forbidden_word", error: "쓰지 않기로 한 표현이 들어 있어요", lint: ["쓰지 않기로 한 표현 '무조건'이 있어요"] }, 422);
			if ((sends(b) || (b.action === "edit" && typeof b.hash === "string")) && b.hash !== it.draft.hash) return json({ ok: false, code: "changed", error: "보내기를 고른 뒤 초안이 바뀌었어요", item: it }, 409);
			if (b.action === "edit") {
				const part = b.part === "mail" ? it.draft.mail! : it.draft;
				part.text = String(b.text);
				if (typeof b.subject === "string") part.subject = b.subject;
				it.draft.edited = true; bump(it);
			}
			if (sends(b)) it.send = { state: "sending", at: NOW, attempt: 1, actions: [] };
			return json({ ok: true, item: it }, b.action === "revise" ? 202 : 200);
		}
		const m = /^\/api\/drafts\/([^/]+)\/(recipients|files)$/.exec(p), r = m ? rowsByDraftRef.get(m[1]!) : undefined;
		if (!m || !r) return undefined;
		if (req.method === "POST") {
			const b = (await req.json()) as { remove?: number; upload?: { name: string }; library?: string } & Body, it = queue.find(i => i.ref === m[1] || i.draft.mail?.ref === m[1])!;
			writesInOrder.push({ path: p, body: b });
			if (m[2] === "recipients") Object.assign(r, b);
			else if (typeof b.remove === "number") r.files.splice(b.remove, 1);
			else r.files.push({ name: b.upload ? b.upload.name : String(b.library), size: "8KB" });
			if (it.ref === m[1]) Object.assign(it.draft, { to: r.to.join(", "), cc: r.cc, attachments: [...r.files] }); else Object.assign(it.draft.mail!, { to: r.to.join(", "), attachments: [...r.files] });
			bump(it);
		}
		return m[2] === "recipients" ? json({ to: r.to, cc: r.cc, mode: r.mode, editable: true, reply: true }) : json({ files: r.files, canAttach: true, library: false, editable: true, tracked: true, attachIssues: [] });
	},
});
const view = await hub.view({ width: 1280, height: 900 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);
const q = (sel: string) => JSON.stringify(sel);
const card = (ref: string) => `#mon-timeline .ra-card[data-ref="${ref}"]`;
const has = (sel: string) => ev<boolean>(`!!document.querySelector(${q(sel)})`);
const keys = (sel: string) => ev<string[]>(`[...document.querySelectorAll(${q(`${sel} [data-k]`)})].map(b => b.dataset.k)`);
const texts = (sel: string) => ev<string[]>(`[...document.querySelectorAll(${q(sel)})].map(n => n.textContent)`);
const value = (sel: string) => ev<string>(`document.querySelector(${q(sel)}).value`);
const off = (sel: string) => ev<boolean>(`document.querySelector(${q(sel)}).disabled`);
const click = (sel: string) => run(`document.querySelector(${q(sel)}).click()`);
const type = (sel: string, text: string) => run(`const f = document.querySelector(${q(sel)}); f.focus(); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event("input", { bubbles: true }))`);
const key = (sel: string, init: Body) => run(`document.querySelector(${q(sel)}).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...${JSON.stringify(init)} }))`);
const pick = (sel: string, name: string) => run(`const i = document.querySelector(${q(sel)}), dt = new DataTransfer(); dt.items.add(new File(["x"], ${JSON.stringify(name)}, { type: "application/pdf" })); i.files = dt.files; i.dispatchEvent(new Event("change"))`);
const fix = async (ref: string, c = card(ref)) => { await click(`${c} [data-k=fix]`); await waitFor(`!!document.querySelector(${q(`${c} [data-k=fix-apply]`)})`); };
const fixed = (ref: string) => waitFor(`!document.querySelector(${q(`${card(ref)} [data-k=fix-apply]`)}) && !RA.fix.has(${q(ref)}) && !RA.busy.has(${q(ref)})`);
const acted = (ref: string, action: string, n = 1) => posts.until(p => p.filter(b => b.ref === ref && b.action === action).length >= n, 10_000, `${n} ${action} of ${ref}`).then(p => p.filter(b => b.ref === ref && b.action === action));
const of = (ref: string) => posts.filter(b => b.ref === ref);
const centre = (v: View, sel: string) => v.evaluate(`(document.querySelector(${q(sel)}).scrollIntoView({ block: "center" }), new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(0)))))`);
const ACCENT_FILLED_CONTROLS = `[...document.querySelectorAll("#mon-timeline .btn:not(.tonal):not(.text)")].filter(b => b.getClientRects().length).map(b => b.dataset.k)`;

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof rqItemCard === "function" && RA.loaded && NT.loaded`);
await run(`document.documentElement.dataset.theme = "light"`);
await run(`go("monitoring", "replies")`);
await waitFor(`!!document.querySelector(${q(card("RUNS01"))})`);

test("every card has the same three actions, keyed send · fix · drop, and the screen fills one control", async () => {
	expect(await keys(`${card("RPEN01")} .rq-acts`)).toEqual(["send", "fix", "drop"]);
	expect(await keys(`${card("KCARD1")} .rq-acts`)).toEqual(["send", "fix", "drop"]);
	expect(await keys(`${card("KKAO01")} .rq-acts`)).toEqual(["send", "fix", "drop"]);
	expect(await has("#mon-timeline [data-k=revise], #mon-timeline [data-k=edit], #mon-timeline .rq-pencil")).toBe(false);
	expect(await ev(ACCENT_FILLED_CONTROLS)).toEqual(["send"]);
	for (const [name, ref] of [["01-mail-file", "RROW03"], ["02-comment-mail-file", "DCOM05"], ["03-kakao", "KKAO01"]] as const) {
		await waitFor(`!document.querySelector(${q(`${card(ref)} .od-note`)})`);
		await centre(view, card(ref));
		await shot(view, `${name}-1280.png`);
	}
});

test("고치기 opens one panel: the text is a field, with a line to the AI and 반영 · 닫기, and nothing in it sends; with nothing changed 반영 is off", async () => {
	await fix("REDT01");
	expect(await value(`${card("REDT01")} .rq-body [data-k=fix-text]`)).toBe("자료는 금요일까지 드릴게요.");
	expect((await keys(card("REDT01"))).filter(k => /^(send|send-as-is|retry|resolve-retry)$/.test(k))).toEqual([]);
	expect(await keys(`${card("REDT01")} .rq-edit`)).toEqual(["fix-note", "fix-apply", "fix-close"]);
	expect(await has(`${card("REDT01")} .rq-text`)).toBe(false);
	expect(await off(`${card("REDT01")} [data-k=fix-apply]`)).toBe(true);
	expect(await ev(`document.querySelector(${q(`${card("REDT01")} [data-k=fix-apply]`)}).classList.contains("tonal")`)).toBe(true);
	expect(await ev(ACCENT_FILLED_CONTROLS)).toEqual(["send"]);
	await click(`${card("REDT01")} [data-k=fix-apply]`);
	expect(of("REDT01")).toEqual([]);
});

test("a card the owner cannot rewrite by hand keeps its text as it is: its panel takes the line to the AI only", async () => {
	await fix("KCARD1");
	expect([await has(`${card("KCARD1")} [data-k=fix-text]`), await has(`${card("KCARD1")} .rq-text`)]).toEqual([false, true]);
	expect(await keys(`${card("KCARD1")} .rq-edit`)).toEqual(["fix-note", "fix-apply", "fix-close"]);
	await click(`${card("KCARD1")} [data-k=fix-close]`);
	await fixed("KCARD1");
	expect(of("KCARD1")).toEqual([]);
});

test("반영 with only the text changed posts edit with the text as written, and nothing else", async () => {
	await type(`${card("REDT01")} [data-k=fix-text]`, "자료는 목요일 오전까지 드릴게요.");
	expect(await off(`${card("REDT01")} [data-k=fix-apply]`)).toBe(false);
	await click(`${card("REDT01")} [data-k=fix-apply]`);
	expect(await acted("REDT01", "edit")).toEqual([{ ref: "REDT01", action: "edit", hash: "REDT01-v1", text: "자료는 목요일 오전까지 드릴게요." }]);
	await fixed("REDT01");
	expect(await texts(`${card("REDT01")} .rq-text`)).toEqual(["자료는 목요일 오전까지 드릴게요."]);
	expect(await has(`${card("REDT01")} [data-k=send]`)).toBe(true);
	expect(of("REDT01").map(b => b.action)).toEqual(["edit"]);
});

test("반영 with only the line to the AI filled posts revise with it, and nothing else", async () => {
	await fix("RREV01");
	await type(`${card("RREV01")} [data-k=fix-note]`, "더 짧게");
	await click(`${card("RREV01")} [data-k=fix-apply]`);
	expect(await acted("RREV01", "revise")).toEqual([{ ref: "RREV01", action: "revise", change: "더 짧게" }]);
	await fixed("RREV01");
	expect(of("RREV01")).toHaveLength(1);
});

test("반영 with both posts edit and then revise; when the edit is refused the AI is asked nothing and what was typed stays", async () => {
	await fix("REDT02");
	await type(`${card("REDT02")} [data-k=fix-text]`, "회의는 4시에 뵙겠습니다.");
	await type(`${card("REDT02")} [data-k=fix-note]`, "더 정중하게");
	await click(`${card("REDT02")} [data-k=fix-apply]`);
	await acted("REDT02", "revise");
	expect(of("REDT02")).toEqual([{ ref: "REDT02", action: "edit", hash: "REDT02-v1", text: "회의는 4시에 뵙겠습니다." }, { ref: "REDT02", action: "revise", change: "더 정중하게" }]);
	await fixed("REDT02");

	await fix("REDT04");
	await type(`${card("REDT04")} [data-k=fix-text]`, "무조건 다음 주에 정할게요.");
	await type(`${card("REDT04")} [data-k=fix-note]`, "더 짧게");
	await click(`${card("REDT04")} [data-k=fix-apply]`);
	await waitFor(`!!document.querySelector(${q(`${card("REDT04")} .ra-lint`)}) && !RA.busy.has("REDT04")`);
	expect([await value(`${card("REDT04")} [data-k=fix-text]`), await value(`${card("REDT04")} [data-k=fix-note]`)]).toEqual(["무조건 다음 주에 정할게요.", "더 짧게"]);
	expect(of("REDT04").map(b => b.action)).toEqual(["edit"]);
	await click(`${card("REDT04")} [data-k=fix-close]`);
	await fixed("REDT04");
});

test("Ctrl+Enter is 반영, and so is Enter in the line to the AI; Esc closes and keeps nothing", async () => {
	await fix("REDT03");
	await type(`${card("REDT03")} [data-k=fix-text]`, "견적은 모레 드릴게요.");
	await key(`${card("REDT03")} [data-k=fix-text]`, { key: "Enter", ctrlKey: true });
	expect(await acted("REDT03", "edit")).toEqual([{ ref: "REDT03", action: "edit", hash: "REDT03-v1", text: "견적은 모레 드릴게요." }]);
	await fixed("REDT03");

	await fix("RKEY01");
	await type(`${card("RKEY01")} [data-k=fix-note]`, "한 문장으로");
	await key(`${card("RKEY01")} [data-k=fix-note]`, { key: "Enter", isComposing: true });
	await key(`${card("RKEY01")} [data-k=fix-note]`, { key: "Enter", keyCode: 229 });
	await run(`document.querySelector(${q(`${card("RKEY01")} [data-k=fix-note]`)}).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))`);
	await key(`${card("RKEY01")} [data-k=fix-note]`, { key: "Enter", keyCode: 229 });
	await view.evaluate(`new Promise(r => setTimeout(() => r(0), 80))`);
	expect(of("RKEY01")).toEqual([]);
	await key(`${card("RKEY01")} [data-k=fix-note]`, { key: "Enter" });
	expect(await acted("RKEY01", "revise")).toEqual([{ ref: "RKEY01", action: "revise", change: "한 문장으로" }]);
	await fixed("RKEY01");

	await fix("RESC01");
	await type(`${card("RESC01")} [data-k=fix-text]`, "쓰다 만 글");
	await type(`${card("RESC01")} [data-k=fix-note]`, "쓰다 만 부탁");
	await key(`${card("RESC01")} [data-k=fix-text]`, { key: "Escape" });
	await fixed("RESC01");
	expect(await texts(`${card("RESC01")} .rq-text`)).toEqual(["발표 자료는 전날까지 드릴게요."]);
	await fix("RESC01");
	expect([await value(`${card("RESC01")} [data-k=fix-text]`), await value(`${card("RESC01")} [data-k=fix-note]`)]).toEqual(["발표 자료는 전날까지 드릴게요.", ""]);
	await click(`${card("RESC01")} [data-k=fix-close]`);
	await fixed("RESC01");
	expect(of("RESC01")).toEqual([]);
});

test("on the lead card 반영 takes the filled place of its 보내기, so the screen still fills one control", async () => {
	await fix("RPEN01");
	expect(await ev(ACCENT_FILLED_CONTROLS)).toEqual(["fix-apply"]);
	await click(`${card("RPEN01")} [data-k=fix-close]`);
	await fixed("RPEN01");
	expect(await ev(ACCENT_FILLED_CONTROLS)).toEqual(["send"]);
	expect(of("RPEN01")).toEqual([]);
});

test("a mail's 받는이 and 첨부 rows open only in the panel, where a change is only marked; 닫기 forgets every mark", async () => {
	const c = card("RROW01"), rows = () => writesInOrder.filter(l => l.path.includes("RROW01") || l.path === "/api/upload");
	await waitFor(`!!document.querySelector(${q(`${c} .dr-files .dr-fn`)})`);
	expect(await ev(`[".dr-recv", ".dr-files .dr-x", ".dr-files .dr-add"].map(s => !!document.querySelector(${q(c)}).querySelector(s))`)).toEqual([false, false, false]);
	await fix("RROW01");
	await waitFor(`!!document.querySelector(${q(`${c} .dr-recv [data-row=cc] .dr-rc-add`)}) && !!document.querySelector(${q(`${c} .dr-files .dr-x`)}) && !!document.querySelector(${q(`${c} .dr-files .dr-add`)})`);
	expect(await off(`${c} [data-k=fix-apply]`)).toBe(true);

	await click(`${c} .dr-files .dr-x`);
	await waitFor(`!document.querySelector(${q(`${c} .dr-files .dr-fn`)})`);
	expect([await has(`${c} .dr-files [data-k=none]`), await off(`${c} [data-k=fix-apply]`)]).toEqual([true, false]);
	await pick(`${c} .dr-files input[type=file]`, "일정표.pdf");
	await waitFor(`!!document.querySelector(${q(`${c} .dr-files .dr-fn`)})`);
	expect([await texts(`${c} .dr-files .dr-fn`), await has(`${c} .dr-files a.dr-att`)]).toEqual([["일정표.pdf"], false]);
	await click(`${c} .dr-recv [data-row=cc] .dr-rc-add`);
	await type(`${c} .dr-recv [data-row=cc] .dr-rc-in`, "lee@example.com");
	await click(`${c} .dr-recv [data-row=cc] .dr-rc-go`);
	await waitFor(`!!document.querySelector(${q(`${c} .dr-recv [data-row=cc] .dr-rc-t`)})`);
	expect(await texts(`${c} .dr-recv [data-row=cc] .dr-rc-t`)).toEqual(["lee@example.com"]);
	expect(rows()).toEqual([]);

	await click(`${c} [data-k=fix-close]`);
	await fixed("RROW01");
	expect(await texts(`${c} .dr-files .dr-fn`)).toEqual(["견적서.pdf"]);
	await fix("RROW01");
	await waitFor(`!!document.querySelector(${q(`${c} .dr-files .dr-x`)})`);
	expect([await texts(`${c} .dr-files .dr-fn`), await has(`${c} .dr-recv [data-row=cc] .dr-rc-t`), await off(`${c} [data-k=fix-apply]`)]).toEqual([["견적서.pdf"], false, true]);
	await click(`${c} [data-k=fix-close]`);
	await fixed("RROW01");
	expect([rows(), of("RROW01")]).toEqual([[], []]);
});

test("choosing 전체 답장 in the panel marks only that choice, the rows saying the hub fills the lists again; back on 답장 nothing is marked", async () => {
	const c = card("RROW01");
	await fix("RROW01");
	await waitFor(`!!document.querySelector(${q(`${c} .dr-recv [data-row=cc] .dr-rc-add`)})`);
	await click(`${c} .dr-recv [data-row=cc] .dr-rc-add`);
	await type(`${c} .dr-recv [data-row=cc] .dr-rc-in`, "lee@example.com");
	await click(`${c} .dr-recv [data-row=cc] .dr-rc-go`);
	await click(`${c} .dr-recv [data-k=mode-all]`);
	expect([await has(`${c} .dr-recv [data-row=refill]`), await has(`${c} .dr-recv [data-row=to]`), await off(`${c} [data-k=fix-apply]`)]).toEqual([true, false, false]);
	await click(`${c} .dr-recv [data-k=mode-reply]`);
	expect([await has(`${c} .dr-recv [data-row=refill]`), await texts(`${c} .dr-recv [data-row=to] .dr-rc-t`), await has(`${c} .dr-recv [data-row=cc] .dr-rc-t`), await off(`${c} [data-k=fix-apply]`)]).toEqual([false, ["kim@example.com"], false, true]);
	await click(`${c} [data-k=fix-close]`);
	await fixed("RROW01");
	expect(writesInOrder.filter(l => l.path.includes("RROW01"))).toEqual([]);
});

test("반영 checks the version with edit first, then writes the marked rows, then revise", async () => {
	const c = card("RROW02");
	await fix("RROW02");
	await waitFor(`!!document.querySelector(${q(`${c} .dr-recv [data-row=cc] .dr-rc-add`)}) && !!document.querySelector(${q(`${c} .dr-files .dr-x`)})`);
	await click(`${c} .dr-files .dr-x`);
	await pick(`${c} .dr-files input[type=file]`, "일정표.pdf");
	await click(`${c} .dr-recv [data-row=cc] .dr-rc-add`);
	await type(`${c} .dr-recv [data-row=cc] .dr-rc-in`, "lee@example.com");
	await click(`${c} .dr-recv [data-row=cc] .dr-rc-go`);
	await type(`${c} [data-k=fix-text]`, "일정표를 붙여 보내 드려요.");
	await type(`${c} [data-k=fix-note]`, "더 정중하게");
	await click(`${c} [data-k=fix-apply]`);
	await acted("RROW02", "revise");
	expect(writesInOrder.filter(l => l.path.includes("RROW02") || l.path === "/api/upload" || l.body.ref === "RROW02")).toEqual([
		{ path: "/api/reply/act", body: { ref: "RROW02", action: "edit", hash: "RROW02-v1", text: "일정표를 붙여 보내 드려요." } },
		{ path: "/api/drafts/RROW02/recipients", body: { cc: ["lee@example.com"] } },
		{ path: "/api/drafts/RROW02/files", body: { remove: 0, name: "견적서.pdf" } },
		{ path: "/api/upload", body: { name: "일정표.pdf" } },
		{ path: "/api/drafts/RROW02/files", body: { upload: { path: "/uploads/일정표.pdf", name: "일정표.pdf" } } },
		{ path: "/api/reply/act", body: { ref: "RROW02", action: "revise", change: "더 정중하게" } },
	]);
	await fixed("RROW02");
	expect(await texts(`${c} .dr-files .dr-fn`)).toEqual(["일정표.pdf"]);
});

// qa-clean-3 M3: a refused 반영 leaves nothing half-applied. Rows alone: the queue is read again first, and a draft that moved since the panel opened
// is refused `changed` with no row written; the next 반영 stands on the new version. With text: the hub's `edit` answers first, so its refusal writes no row.
test("반영 writes no row when the version moved or the edit is refused; the marks stay for the next 반영", async () => {
	const c = card("RROW05"), rows = () => writesInOrder.filter(l => l.path.includes("RROW05") || (l.path === "/api/upload" && l.body.name === "추가.pdf"));
	const refused = (code?: string) => waitFor(`!!RA.fail.get("RROW05") && ${code ? `RA.fail.get("RROW05").code === ${q(code)} && ` : ""}!RA.busy.has("RROW05") && !RA.fix.get("RROW05").busy`);
	await fix("RROW05");
	await waitFor(`!!document.querySelector(${q(`${c} .dr-files .dr-x`)})`);
	await click(`${c} .dr-files .dr-x`);
	Object.assign(find("RROW05").draft, { text: "다른 기기에서 고친 글이에요.", hash: "RROW05-v7" });
	await click(`${c} [data-k=fix-apply]`);
	await refused("changed");
	expect(rows()).toEqual([]);
	await click(`${c} [data-k=fix-apply]`);
	await fixed("RROW05");
	expect(rows()).toEqual([{ path: "/api/drafts/RROW05/files", body: { remove: 0, name: "견적서.pdf" } }]);

	await fix("RROW05");
	await waitFor(`!!document.querySelector(${q(`${c} .dr-files input[type=file]`)})`);
	await pick(`${c} .dr-files input[type=file]`, "추가.pdf");
	await type(`${c} [data-k=fix-text]`, "무조건 오늘 드릴게요.");
	await click(`${c} [data-k=fix-apply]`);
	await refused();
	expect(rows()).toHaveLength(1);
	await click(`${c} [data-k=fix-close]`);
	await fixed("RROW05");
	expect(rows()).toHaveLength(1);
});

test("반영 of rows alone writes them, and the next 보내기 goes with the version that has them", async () => {
	const c = card("RROW04");
	await fix("RROW04");
	await waitFor(`!!document.querySelector(${q(`${c} .dr-files .dr-x`)})`);
	await click(`${c} .dr-files .dr-x`);
	await click(`${c} [data-k=fix-apply]`);
	await fixed("RROW04");
	expect(writesInOrder.filter(l => l.path.includes("RROW04"))).toEqual([{ path: "/api/drafts/RROW04/files", body: { remove: 0, name: "견적서.pdf" } }]);
	expect(await has(`${c} .dr-files [data-k=none]`)).toBe(true);
	await click(`${c} [data-k=send]`);
	expect(await acted("RROW04", "send")).toEqual([{ ref: "RROW04", action: "send", hash: "RROW04-v2" }]);
	await waitFor(`!!document.querySelector(${q(`${c} .rq-send.sending`)})`);
});

test("a mail's subject is a field: changed alone it is saved with the text as it was, and the subject of a mail that rides along goes with its part", async () => {
	await fix("RSUB01");
	expect(await value(`${card("RSUB01")} [data-k=fix-subject]`)).toBe("Re: 자료 요청");
	await type(`${card("RSUB01")} [data-k=fix-subject]`, "Re: 자료 요청 (수정본)");
	await click(`${card("RSUB01")} [data-k=fix-apply]`);
	expect(await acted("RSUB01", "edit")).toEqual([{ ref: "RSUB01", action: "edit", hash: "RSUB01-v1", text: "수정한 자료를 보내 드립니다.", subject: "Re: 자료 요청 (수정본)" }]);
	await fixed("RSUB01");
	expect(await texts(`${card("RSUB01")} .rq-sub`)).toEqual(["Re: 자료 요청 (수정본)"]);

	const c = card("DCOM01");
	await fix("DCOM01");
	expect([await has(`${c} > [data-k=fix-subject]`), await value(`${c} .dr-mailpart [data-k=fix-subject]`)]).toEqual([false, "3부 자료 보내드려요"]);
	await type(`${c} .dr-mailpart [data-k=fix-subject]`, "3부 자료와 안내");
	await click(`${c} [data-k=fix-apply]`);
	expect(await acted("DCOM01", "edit")).toEqual([{ ref: "DCOM01", action: "edit", hash: "DCOM01-v1", text: "요청하신 3부 자료를 붙였습니다.", subject: "3부 자료와 안내", part: "mail" }]);
	await fixed("DCOM01");
});

test("a comment reply that carries a mail: the panel edits either part, that mail's rows open in it, and the line to the AI goes to the part shown", async () => {
	const c = card("DCOM04");
	await fix("DCOM04");
	await waitFor(`!!document.querySelector(${q(`${c} .dr-mailpart .dr-recv [data-row=to] .dr-rc-add`)}) && !!document.querySelector(${q(`${c} .dr-mailpart .dr-files .dr-x`)})`);
	expect([await value(`${c} [data-k=fix-text]`), await ev(`document.querySelector(${q(`${c} [data-k=part-reply]`)}).getAttribute("aria-pressed")`)]).toEqual(["메일로 보내드렸어요!", "true"]);
	await type(`${c} [data-k=fix-text]`, "메일로 3부 자료 보내드렸어요!");
	await click(`${c} [data-k=part-mail]`);
	await waitFor(`document.querySelector(${q(`${c} [data-k=fix-text]`)}).value === "요청하신 3부 자료를 붙였습니다."`);
	await type(`${c} [data-k=fix-text]`, "요청하신 3부 자료를 붙였습니다. 연습에 도움이 되면 좋겠어요.");
	await type(`${c} [data-k=fix-note]`, "더 정중하게");
	await click(`${c} [data-k=fix-apply]`);
	await acted("DCOM04", "revise");
	expect(of("DCOM04")).toEqual([
		{ ref: "DCOM04", action: "edit", hash: "DCOM04-v1", text: "메일로 3부 자료 보내드렸어요!", part: "reply" },
		{ ref: "DCOM04", action: "edit", hash: "DCOM04-v2", text: "요청하신 3부 자료를 붙였습니다. 연습에 도움이 되면 좋겠어요.", part: "mail" },
		{ ref: "DCOM04", action: "revise", change: "더 정중하게", part: "mail" },
	]);
	await fixed("DCOM04");
});

test("every card says what goes with it: each file with its size, or that there is none, also on a card with no head", async () => {
	await waitFor(`!!document.querySelector(${q(`${card("RROW03")} .dr-files .dr-fn`)}) && !!document.querySelector(${q(`${card("DCOM05")} .dr-mailpart .dr-files .dr-fn`)})`);
	expect([await texts(`${card("RROW03")} .dr-files .dr-fn`), (await texts(`${card("RROW03")} .dr-files .dr-fm`))[0]]).toEqual([["견적서.pdf"], expect.stringContaining("120KB")]);
	expect(await has(`${card("RPEN01")} .dr-files [data-k=none]`)).toBe(true);
	expect(await has(`${card("DCOM02")} > .rq-att[data-k=none]`)).toBe(true);
	expect(await has(`${card("KKAO01")} > .rq-att[data-k=none]`)).toBe(true);
	expect([await has(`${card("DCOM05")} > .rq-att[data-k=none]`), await texts(`${card("DCOM05")} .dr-mailpart .dr-files .dr-fn`), (await texts(`${card("DCOM05")} .dr-mailpart .dr-files .dr-fm`))[0]]).toEqual([true, ["자료_3부.pdf"], expect.stringContaining("88KB")]);
	expect(await has(`${card("DCOM03")} .dr-mailpart .dr-files [data-k=none]`)).toBe(true);

	await run(`document.body.appendChild(Object.assign(document.createElement("div"), { id: "bare-test" })).append(rqItemCard(RA.items.get("KKAO01"), { bare: true }), rqItemCard(RA.items.get("DCOM02"), { bare: true }), rqItemCard(RA.items.get("DCOM03"), { bare: true }))`);
	expect(await ev(`[...document.querySelectorAll("#bare-test .ra-card")].map(c => [c.dataset.ref, !!c.querySelector(".rq-hd"), !!c.querySelector(":scope > .rq-att[data-k=none]"), !!c.querySelector(".dr-mailpart .dr-files [data-k=none]")])`))
		.toEqual([["KKAO01", false, true, false], ["DCOM02", false, true, false], ["DCOM03", false, true, true]]);
	await run(`document.getElementById("bare-test").remove()`);
});

test("every act that sends carries the hash of the version its card showed; a failed send offers 다시 보내기 or 그래도 보내기, 고치기 and 보내지 않기", async () => {
	expect(await keys(`${card("RFRT01")} .rq-send`)).toEqual(["retry", "fix", "drop"]);
	expect(await keys(`${card("RFAS01")} .rq-send`)).toEqual(["send-as-is", "fix", "drop"]);
	expect(await keys(`${card("RUNS01")} .rq-send`)).toEqual(["resolve-sent", "open", "resolve-retry"]);
	expect(await keys(`${card("RNAP01")} .rq-send`)).toEqual(["send", "fix", "drop"]);
	await click(`${card("RNAP01")} [data-k=send]`);
	expect(await acted("RNAP01", "send")).toEqual([{ ref: "RNAP01", action: "send", hash: "RNAP01-v1" }]);
	await centre(view, card("RFRT03"));
	await shot(view, "06-failed-1280.png");
	await click(`${card("RSND01")} [data-k=send]`);
	expect(await acted("RSND01", "send")).toEqual([{ ref: "RSND01", action: "send", hash: "RSND01-v1" }]);
	await click(`${card("RFRT01")} [data-k=retry]`);
	expect(await acted("RFRT01", "retry")).toEqual([{ ref: "RFRT01", action: "retry", hash: "RFRT01-v1" }]);
	await click(`${card("RFAS01")} [data-k=send-as-is]`);
	expect(await acted("RFAS01", "send")).toEqual([{ ref: "RFAS01", action: "send", asIs: true, hash: "RFAS01-v1" }]);
	await click(`${card("RUNS01")} [data-k=resolve-retry]`);
	expect(await acted("RUNS01", "resolve")).toEqual([{ ref: "RUNS01", action: "resolve", as: "retry", hash: "RUNS01-v1" }]);
	await click(`${card("RDRP01")} [data-k=drop]`);
	expect(await acted("RDRP01", "drop")).toEqual([{ ref: "RDRP01", action: "drop" }]);
});

test("a 보내기 of a version the hub no longer holds sends nothing: the card is drawn again from the fresh item with a line saying so, and the next press sends that one", async () => {
	const c = card("RCHG01");
	Object.assign(find("RCHG01").draft, { text: "목요일에 보내 드릴게요.", hash: "RCHG01-v2" });
	expect(await texts(`${c} .rq-text`)).toEqual(["수요일에 보내 드릴게요."]);
	await click(`${c} [data-k=send]`);
	expect(await acted("RCHG01", "send")).toEqual([{ ref: "RCHG01", action: "send", hash: "RCHG01-v1" }]);
	await waitFor(`!!document.querySelector(${q(`${c} .rq-fail[data-code=changed]`)}) && !RA.busy.has("RCHG01")`);
	expect([await texts(`${c} .rq-text`), await has(`${c} .rq-send`), await off(`${c} [data-k=send]`)]).toEqual([["목요일에 보내 드릴게요."], false, false]);
	await click(`${c} [data-k=send]`);
	expect((await acted("RCHG01", "send", 2))[1]).toEqual({ ref: "RCHG01", action: "send", hash: "RCHG01-v2" });
	await waitFor(`!!document.querySelector(${q(`${c} .rq-send.sending`)})`);
	expect(await has(`${c} .rq-fail`)).toBe(false);
});

test("a rewritten draft marks the words that came in and strikes the ones that went; a long one folds to its changed lines", async () => {
	const words = (ref: string, tag: string) => texts(`${card(ref)} .rq-diff ${tag}`);
	expect(await words("RDIF01", "ins")).toEqual(["목요일까지 보내드릴게요."]);
	expect(await words("RDIF01", "del")).toEqual(["확인해 보고 말씀드릴게요."]);
	const withoutStruckWords = (ref: string) => ev<string>(`(() => { const b = document.querySelector(${q(`${card(ref)} .rq-diff`)}).cloneNode(true); b.querySelectorAll("del, .rq-dgap").forEach(n => n.remove()); return [...b.querySelectorAll(".rq-dl")].map(l => l.textContent.replace(/\\s+/g, " ").trim()).join("\\n"); })()`);
	expect(await withoutStruckWords("RDIF01")).toBe("목요일까지 보내드릴게요. 감사합니다.");
	expect(await has(`${card("RDIF01")} .rq-lb`)).toBe(true);
	expect(await has(`${card("RPEN01")} .rq-lb`)).toBe(false);

	const fold = () => ev<{ lines: number; gaps: number; open: string }>(`(() => { const c = document.querySelector(${q(card("RDIF02"))}); return { lines: c.querySelectorAll(".rq-dl").length, gaps: c.querySelectorAll(".rq-dgap").length, open: c.querySelector("[data-k=more]").getAttribute("aria-expanded") }; })()`);
	expect(await fold()).toEqual({ lines: 2, gaps: 3, open: "false" });
	expect(await words("RDIF02", "ins")).toEqual(["목요일 오전에", "이 메일에 붙였습니다."]);
	await centre(view, card("RDIF01"));
	await shot(view, "05-revised-diff-1280.png");
	await click(`${card("RDIF02")} [data-k=more]`);
	expect(await fold()).toEqual({ lines: LONG_NEW.length, gaps: 0, open: "true" });
	expect(await withoutStruckWords("RDIF02")).toBe(LONG_NEW.join("\n"));
	await run(`document.documentElement.dataset.theme = "dark"`);
	await centre(view, card("RDIF01"));
	await shot(view, "05-revised-diff-1280-dark.png");
	await run(`document.documentElement.dataset.theme = "light"`);
});

test("the panel of a mail holds its subject, 받는이 and 첨부 rows, the text and the line to the AI in the card's own places", async () => {
	const c = card("RROW03");
	await fix("RROW03");
	await waitFor(`!!document.querySelector(${q(`${c} .dr-recv [data-row=cc] .dr-rc-add`)}) && !!document.querySelector(${q(`${c} .dr-files .dr-x`)})`);
	expect(await ev(`[...document.querySelector(${q(c)}).children].map(n => n.matches(".dr-recv") ? "recv" : n.matches("[data-k=fix-subject]") ? "subject" : n.querySelector("[data-k=fix-text]") ? "text" : n.matches(".dr-files") ? "files" : n.querySelector("[data-k=fix-note]") ? "foot" : "").filter(Boolean)`))
		.toEqual(["recv", "subject", "text", "files", "foot"]);
	await type(`${c} [data-k=fix-note]`, "더 짧게, 존댓말로");
	await centre(view, c);
	await shot(view, "04-fix-panel-mail-1280.png");
	await click(`${c} [data-k=fix-close]`);
	await fixed("RROW03");
	expect(of("RROW03")).toEqual([]);
});

test("a notice whose draft the queue holds opens as the queue's card: its 고치기 saves through edit", async () => {
	await run(`noticeSheetOpen("n1")`);
	const c = `.rq-sheet .ra-card[data-ref="RNTC01"]`;
	await waitFor(`!!document.querySelector(${q(`${c} [data-k=fix]`)})`);
	await fix("RNTC01", c);
	await type(`${c} [data-k=fix-text]`, "다음 주 화요일 일정을 보내 드립니다.");
	await click(`${c} [data-k=fix-apply]`);
	expect(await acted("RNTC01", "edit")).toEqual([{ ref: "RNTC01", action: "edit", hash: "RNTC01-v1", text: "다음 주 화요일 일정을 보내 드립니다." }]);
	await run(`RQ.sheet.close()`);
	await waitFor(`!RQ.sheet && !!document.querySelector(${q(card("RANS01"))})`);
});

test("a draft sheet that opened before the queue held the draft offers the three choices and no field for the owner's own text, and hands over to the queue's card once the queue holds it", async () => {
	await run(`noticeSheetOpen("n3")`);
	await waitFor(`!!DK.h && document.querySelectorAll(".fs-ft .rq-acts .btn").length === 3`);
	expect(await ev(`[...document.querySelectorAll(".fs-ft .rq-acts .btn")].map(b => b.dataset.n)`)).toEqual(["1", "2", "3"]);
	expect(await has(".fs-card [data-k=fix-text], .fs-card [data-k=fix], .fs-card .rq-pencil")).toBe(false);
	queue.push(mail("RLATE1", 32_000, "늦게 큐에 들어온 초안이에요."));
	await view.evaluate(`rqLoad().then(() => 0)`);
	await waitFor(`!DK.h && !!document.querySelector('.rq-sheet .ra-card[data-ref="RLATE1"] [data-k=fix]')`);
	await run(`RQ.sheet.close()`);
	await waitFor(`!RQ.sheet && !!document.querySelector(${q(card("RLATE1"))})`);
});

test("a notice row answered in place goes by the option's label: 이대로 보내기 is send with asIs, and 고치기 opens the queue's card with its panel open", async () => {
	await ev(`(answerInline(ntById("n2"), { n: 4, label: "이대로 보내기" }), 0)`);
	expect(await acted("RANS01", "send")).toEqual([{ ref: "RANS01", action: "send", asIs: true, hash: "RANS01-v1" }]);
	await waitFor(`!RA.busy.has("RANS01")`);
	await ev(`(answerInline(ntById("n4"), { n: 2, label: "고치기" }), 0)`);
	await waitFor(`!!document.querySelector('.rq-sheet .ra-card[data-ref="RANS02"] [data-k=fix-text]')`);
	expect(of("RANS02")).toEqual([]);
	await click(`.rq-sheet .ra-card[data-ref="RANS02"] [data-k=fix-close]`);
	await run(`RQ.sheet.close()`);
	await waitFor(`!RQ.sheet`);
});

test("on a phone the three actions stay on one line and 고치기 opens the same panel", async () => {
	const v = await hub.view({ width: 390, height: 844 }, "/");
	const p = on(v);
	await p.waitFor(`typeof rqItemCard === "function" && RA.loaded`);
	await p.run(`document.documentElement.dataset.theme = "light"; go("monitoring", "replies")`);
	await p.waitFor(`!!document.querySelector(${q(card("RFRT03"))})`);
	const row = await p.ev<{ keys: string[]; tops: number[]; wide: boolean }>(`(() => { const r = document.querySelector(${q(`${card("RPEN01")} .rq-acts`)}), b = [...r.children]; return { keys: b.map(x => x.dataset.k), tops: [...new Set(b.map(x => Math.round(x.getBoundingClientRect().top)))], wide: r.scrollWidth > r.clientWidth }; })()`);
	expect(row).toEqual({ keys: ["send", "fix", "drop"], tops: [expect.any(Number)], wide: false });
	for (const [name, ref] of [["01-mail-file", "RROW03"], ["02-comment-mail-file", "DCOM05"], ["03-kakao", "KKAO01"], ["05-revised-diff", "RDIF01"], ["06-failed", "RFRT03"]] as const) {
		await p.waitFor(`!document.querySelector(${q(`${card(ref)} .od-note`)})`);
		await centre(v, card(ref));
		await shot(v, `${name}-390.png`);
	}
	await p.run(`document.querySelector(${q(`${card("RROW03")} [data-k=fix]`)}).click()`);
	await p.waitFor(`!!document.querySelector(${q(`${card("RROW03")} .dr-files .dr-x`)}) && !!document.querySelector(${q(`${card("RROW03")} [data-k=fix-note]`)})`);
	expect(await p.ev(`(() => { const c = document.querySelector(${q(card("RROW03"))}); return c.scrollWidth > c.clientWidth; })()`)).toBe(false);
	await centre(v, card("RROW03"));
	await shot(v, "04-fix-panel-mail-390.png");
});

test("a draft the gateway took back on a restart says why on its card and keeps its three actions", async () => {
	const c = card("RBCK01");
	await waitFor(`!!document.querySelector(${q(`${c} .rq-fail[data-code=back]`)})`);
	expect(await texts(`${c} .rq-fail`)).toEqual(["게이트웨이가 다시 시작돼서 보내지 않았어요. 보내려면 보내기를 눌러 주세요"]);
	expect(await keys(`${c} .rq-acts`)).toEqual(["send", "fix", "drop"]);
	expect(await has(`${card("RPEN01")} .rq-fail`)).toBe(false);
});
