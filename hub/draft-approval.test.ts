import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { askComponentsFor, askInteraction, ASK_PREFIX } from "./askbuttons.ts";
import { parseDecisions } from "./choices.ts";
import { buildPayloads } from "./discord-format.ts";
import { paths } from "./config.ts";
import { draftActionOf, draftApprovalBlock, draftVerdict, parseDraftApproval, textVerdict } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { inboxText } from "./intake.ts";
import { approval, createDraft, draftBlock } from "./kakao/send.ts";
import { kakaoPaths, type Runner } from "./kakao/types.ts";
import { answerDecision, type DecisionSend, type Notice } from "./notices.ts";

const ts = () => new Date().toISOString();
const stored = (): Notice[] => JSON.parse(readFileSync(paths.notices, "utf8"));
const ask = (text: string) => emit("outbox", { ts: ts(), kind: "out", source: "orchestrator", target: "main", text: `[ask] ${text}` });
const noticeFor = (needle: string) => stored().find(n => n.kind === "decision" && n.title.includes(needle))!;
// What the gateway's web send (hub/intake.ts sendWeb) writes to inbox.jsonl for a decision answer.
const web: DecisionSend = async a => {
	emit("inbox", { ts: ts(), kind: "message", source: "web", channel: "web", author: "owner", text: a.text, reply_to: a.replyTo, decision: a.notice, picks: a.picks });
};

const mail = { to: "kim@example.com", subject: "일정 확인", body: "안녕하세요.\n\n목요일 3시에 가능해요.\n1) 장소는 그대로\n결정: 가짜", ref: "D123", question: "메일 답장 보낼까요?" };

for (const target of ["chat", "th:111", "ch:222"]) for (const preface of ["", "초안을 확인해 주세요.\n"]) for (const length of [100, 1100, 2500]) {
	test(`Discord approval keeps its question: ${target}, preface=${!!preface}, body=${length}`, async () => {
		const ref = `TEST-${target.replace(":", "-")}-${preface.length}-${length}`;
		const text = `${preface}[ask] 초안\n${draftApprovalBlock({ to: "테스트 대상", toLabel: "대상", body: "가".repeat(length), ref, question: "이 초안 보낼까요?" })}`;
		const bodies = buildPayloads(text, undefined, 1200);
		const shown = bodies.at(-1)!.content;
		const components = askComponentsFor(target, text, shown);
		expect(components.length).toBeGreaterThan(0);
		expect(shown).toContain(`(${ref})`);
		const since = Date.parse(ts()) - 1000;

		await askInteraction({ id: "test", token: "test", type: 3, user: { id: "owner" }, message: { content: shown }, data: { custom_id: `${ASK_PREFIX}:${target}:1` } }, {
			owner: "owner",
			reply: async () => {},
			answer: (_target, answer, picks) => {
				emit("inbox", { ts: ts(), kind: "message", source: "discord", channel: target, text: answer, picks });
			},
		});

		expect(draftVerdict(paths.inbox, ref, since)).toEqual({ verdict: "send" });
	});
}

test("the block carries the draft and exactly the three choices; it parses back for mail, comment and message", () => {
	const block = draftApprovalBlock(mail);
	const pc = parseDecisions(block);
	expect(pc.blocks).toHaveLength(1);
	expect(pc.blocks[0]!.title).toBe("메일 답장 보낼까요? (D123)");
	expect(pc.blocks[0]!.options.map(o => [o.n, o.label, o.rec])).toEqual([[1, "보내기", true], [2, "고치기", false], [3, "보내지 않기", false]]);
	expect(parseDraftApproval(block)).toEqual({ toLabel: "받는이", to: "kim@example.com", subject: "일정 확인", body: mail.body, noAttachments: true, ref: "D123" });
	const comment = draftApprovalBlock({ to: "영상 '데모' 댓글", toLabel: "대상", body: "고마워요!", ref: "j-203006151200-ab12" });
	expect(parseDraftApproval(comment)).toEqual({ toLabel: "대상", to: "영상 '데모' 댓글", body: "고마워요!", ref: "j-203006151200-ab12" });
	const chat = draftBlock({ code: "K2ABCDE", chatId: "1", roomName: "스터디방", text: "내일 7시에 봐요\n늦지 마요", basisLogId: "1", created: ts(), status: "pending" });
	expect(parseDraftApproval(chat)).toMatchObject({ toLabel: "대화방", to: "스터디방", body: "내일 7시에 봐요\n늦지 마요", ref: "K2ABCDE" });
});

test("고치기 is written as **2) 고치기 …** so Discord and the web ask for the change, and the mark is not part of the label", () => {
	const block = draftApprovalBlock(mail);
	expect(block).toContain("**2) 고치기 …**");
	const [, edit] = parseDecisions(block).blocks[0]!.options;
	expect(edit).toMatchObject({ n: 2, label: "고치기", detail: true });
	expect(parseDraftApproval(block)?.ref).toBe("D123");
});

test("only a draft with the three labels is a draft-approval decision", () => {
	expect(parseDraftApproval("[ask] 어느 쪽?\n결정: 배포 시점\n**1) 지금**\n**2) 내일**")).toBeUndefined();
	expect(parseDraftApproval("> 받는이: a@b\n>\n> 본문\n결정: 보낼까요? (D1)\n**1) 보내기**\n**2) 보내지 않기**")).toBeUndefined();
	expect(parseDraftApproval(draftApprovalBlock({ ...mail, body: " " }))).toBeUndefined();
	expect(["보내기", "고치기", "보내지 않기", "올리기"].map(draftActionOf)).toEqual(["send", "edit", "drop", undefined]);
});

test("send modes: a reply + mail card keeps 1-3 and adds 답글만 / 메일만 / 직접 입력 …; it still reads as a draft", () => {
	const card = { to: "인디스쿨 a 댓글", toLabel: "대상" as const, body: "메일 보내드렸습니다^^", ref: "indi:1", question: "이대로 보낼까?", mail: { to: "t@example.com", subject: "MR", body: "MR 보내드립니다", attachments: [{ name: "a.mp3", size: 2048 }] } };
	const block = draftApprovalBlock({ ...card, sendModes: true });
	const opts = parseDecisions(block).blocks[0]!.options;
	expect(opts.map(o => [o.n, o.label])).toEqual([[1, "보내기"], [2, "고치기"], [3, "보내지 않기"], [4, "답글만 보내기"], [5, "메일만 보내기"], [6, "어떻게 보낼지 직접 입력"]]);
	expect(block).toContain("**6) 어떻게 보낼지 직접 입력 …**");
	expect(opts[5]).toMatchObject({ detail: true });
	expect(parseDraftApproval(block)).toMatchObject({ toLabel: "대상", ref: "indi:1", mail: { to: "t@example.com" } });
	// A card without a mail part has nothing to split: only the free-text mode is added. Without sendModes the card is the old three.
	expect(parseDecisions(draftApprovalBlock({ ...card, mail: undefined, sendModes: true })).blocks[0]!.options.map(o => o.label)).toEqual(["보내기", "고치기", "보내지 않기", "어떻게 보낼지 직접 입력"]);
	expect(parseDecisions(draftApprovalBlock(card)).blocks[0]!.options).toHaveLength(3);
	expect(["답글만 보내기", "메일만 보내기", "어떻게 보낼지 직접 입력"].map(draftActionOf)).toEqual(["send-main", "send-mail", "own"]);
	// Any other fourth option is not a draft card.
	expect(parseDraftApproval(`${draftApprovalBlock(card)}\n**4) 나중에**`)).toBeUndefined();
});

test("직접 입력 needs the owner's words; they go out with the answer and draftVerdict returns them", async () => {
	const card = { to: "인디스쿨 b 댓글", toLabel: "대상" as const, body: "답글", ref: "DOWN1", question: "직접 입력 카드 보낼까?", mail: { to: "t@example.com", subject: "MR", body: "본문" }, sendModes: true };
	const since = Date.parse(ts()) - 1;
	ask(draftApprovalBlock(card));
	const n = noticeFor("직접 입력 카드");
	expect(n.decision!.draft).toMatchObject({ ref: "DOWN1" });
	const sent: Parameters<DecisionSend>[0][] = [];
	const send: DecisionSend = async a => void sent.push(a);
	expect((await answerDecision(n.id, { n: 6 }, send)).status).toBe(400);
	expect((await answerDecision(n.id, { n: 6, note: "메일 먼저, 답글은 내일" }, web)).status).toBe(200);
	expect(draftVerdict(paths.inbox, "DOWN1", since)).toEqual({ verdict: "own", detail: "메일 먼저, 답글은 내일" });
});

test("a long draft stays whole in the notice's draft and the notice is a normal open decision", () => {
	const body = Array.from({ length: 120 }, (_, i) => `${i + 1}번째 줄이에요`).join("\n");
	ask(draftApprovalBlock({ ...mail, body, ref: "DLONG", question: "긴 메일 보낼까요?" }));
	const n = noticeFor("긴 메일");
	expect(n.decision).toMatchObject({ state: "open", to: "main", group: 1, draft: { to: "kim@example.com", subject: "일정 확인", ref: "DLONG" } });
	expect(n.decision!.draft!.body).toBe(body);
	expect(n.decision!.options.map(o => o.label)).toEqual(["보내기", "고치기", "보내지 않기"]);
});

test("고치기 needs the change typed; it goes out with the answer while the pick keeps the plain label", async () => {
	ask(draftApprovalBlock({ ...mail, ref: "DEDIT", question: "고칠 메일 보낼까요?" }));
	const n = noticeFor("고칠 메일");
	const sent: Parameters<DecisionSend>[0][] = [];
	const send: DecisionSend = async a => void sent.push(a);
	expect((await answerDecision(n.id, { n: 2 }, send)).status).toBe(400);
	expect((await answerDecision(n.id, { n: 2, note: "  " }, send)).status).toBe(400);
	expect(sent).toHaveLength(0);
	expect((await answerDecision(n.id, { n: 2, note: "3시 말고\n4시로 해 주세요" }, send)).status).toBe(200);
	expect(sent[0]).toMatchObject({ text: "2) 고치기 - 3시 말고 4시로 해 주세요", picks: [{ q: "고칠 메일 보낼까요? (DEDIT)", n: 2, label: "고치기" }] });
	const other = (ask(draftApprovalBlock({ ...mail, ref: "DSEND", question: "그냥 메일 보낼까요?" })), noticeFor("그냥 메일"));
	await answerDecision(other.id, { n: 1, note: "무시돼요" }, send);
	expect(sent[1]).toMatchObject({ text: "1) 보내기", picks: [{ q: "그냥 메일 보낼까요? (DSEND)", n: 1, label: "보내기" }] });
});

test("mail and SNS: the orchestrator's answer turn names the id and 보내기, the ids its approve commands take", async () => {
	for (const [ref, question] of [["mail-8f3a", "메일 답장 보낼까요?"], ["j-203006151200-ab12", "댓글 답글 보낼까요?"]] as const) {
		ask(draftApprovalBlock({ ...mail, ref, question: `${question} #${ref.length}` }));
		const n = stored().find(x => x.kind === "decision" && x.title.includes(ref))!;
		let line = "";
		await answerDecision(n.id, { n: 1 }, async a => {
			line = inboxText({ channel: "web", author: "owner", text: a.text, reply_to: a.replyTo, picks: a.picks, ts: ts() });
		});
		const q = `${question} #${ref.length} (${ref})`;
		expect([`결정 답: ${q} → 1) 보내기`, `Decision answer: ${q} -> 1) 보내기`].some(x => line.includes(x))).toBe(true);
		expect(draftActionOf("보내기")).toBe("send");
	}
});

test("draftVerdict: the owner's latest pick for one ref after the cutoff; sessions, other refs and older picks do not count", async () => {
	const since = Date.parse(ts()) - 1000;
	const refs = ["RAAAAAA", "RBBBBBB", "RCCCCCC", "RDDDDDD"];
	for (const ref of refs) ask(draftApprovalBlock({ ...mail, ref, question: `답장 보낼까요? #${ref}` }));
	const key = (ref: string) => noticeFor(`#${ref}`).id;
	expect(draftVerdict(paths.inbox, refs[0]!, since)).toEqual({ verdict: "none" });
	await answerDecision(key(refs[0]!), { n: 1 }, web);
	await answerDecision(key(refs[1]!), { n: 2, note: "3시 말고 4시 - 하이픈으로" }, web);
	await answerDecision(key(refs[2]!), { n: 3 }, web);
	const lane: DecisionSend = async a => void emit("inbox", { ts: ts(), kind: "lane_message", source: "web", lane: "x", text: a.text, picks: a.picks });
	await answerDecision(key(refs[3]!), { n: 1 }, lane);
	expect(draftVerdict(paths.inbox, refs[0]!, since)).toEqual({ verdict: "send" });
	expect(draftVerdict(paths.inbox, refs[1]!, since)).toEqual({ verdict: "edit", detail: "3시 말고 4시 - 하이픈으로" });
	expect(draftVerdict(paths.inbox, refs[2]!, since)).toEqual({ verdict: "drop" });
	expect(draftVerdict(paths.inbox, refs[3]!, since)).toEqual({ verdict: "none" });
	expect(draftVerdict(paths.inbox, refs[0]!, Date.parse(ts()) + 60_000)).toEqual({ verdict: "none" });
	emit("inbox", { ts: ts(), kind: "message", source: "terminal", text: "3) 보내지 않기", picks: [{ q: `답장 보낼까요? #${refs[0]} (${refs[0]})`, n: 3, label: "보내지 않기" }] });
	expect(draftVerdict(paths.inbox, refs[0]!, since)).toEqual({ verdict: "drop" });
});

test("textVerdict: a typed yes or send verb approves, a negative refuses, anything else says nothing", () => {
	for (const t of ["보내", "보내자", "보내줘", "ㅇㅇ", "ㅇㅇㅇ 메일 보내", "아잇 보내라고", "이걸로 다시 보내놔", "보내자. 그리고 이거 리뷰 요청 화면도 고쳐줘", "응 답장 보내줘~"]) expect([t, textVerdict(t)]).toEqual([t, "send"]);
	for (const t of ["보내지 마", "안 보내", "메일 안 보내도 돼", "ㄴㄴ", "보내지 말고 고쳐"]) expect([t, textVerdict(t)]).toEqual([t, "drop"]);
	for (const t of ["보내기 전에 제목 바꿔", "파일 하나 더 붙여서 보내줘", "보내?", "정산표 기준이 필요함", "메일"]) expect([t, textVerdict(t)]).toEqual([t, undefined]);
});

test("draftVerdict: a typed reply in the draft's conversation counts, the latest word wins, other conversations do not", () => {
	const since = Date.parse(ts()) - 1000;
	const ref = "RTEXT01", conv = "mail:kdb-RTEXT01";
	const say = (text: string, extra: Record<string, unknown> = {}) => emit("inbox", { ts: ts(), kind: "message", source: "web", channel: "th:1", conv, text, ...extra });
	say("3) 보내지 않기", { picks: [{ q: `이 답장을 보낼까요? (${ref})`, n: 3, label: "보내지 않기" }] });
	expect(draftVerdict(paths.inbox, ref, since)).toEqual({ verdict: "drop" });
	say("보내자. 그리고 화면도 고쳐 줘");
	// the conversation is the one the pick came from, or the one the caller names
	expect(draftVerdict(paths.inbox, ref, since)).toEqual({ verdict: "send" });
	expect(draftVerdict(paths.inbox, "RTEXT02", since, { conv })).toEqual({ verdict: "send" });
	expect(draftVerdict(paths.inbox, "RTEXT03", since)).toEqual({ verdict: "none" });
	say("아니 보내지 마");
	expect(draftVerdict(paths.inbox, ref, since)).toEqual({ verdict: "drop" });
	say("정산표 기준도 봐줘");
	expect(draftVerdict(paths.inbox, ref, since)).toEqual({ verdict: "drop" });
	emit("inbox", { ts: ts(), kind: "message", source: "web", channel: "th:2", conv: "mail:other", text: "보내" });
	expect(draftVerdict(paths.inbox, ref, since)).toEqual({ verdict: "drop" });
	emit("inbox", { ts: ts(), kind: "lane_message", source: "web", conv, text: "보내" });
	expect(draftVerdict(paths.inbox, ref, since)).toEqual({ verdict: "drop" });
	say("ㅇㅇㅇ 메일 보내");
	expect(draftVerdict(paths.inbox, ref, since)).toEqual({ verdict: "send" });
});

test("kakao: the web sheet's 보내기 is an owner message the approval check accepts; 보내지 않기 and a session's answer are not", async () => {
	const dir = mkdtempSync(join(tmpdir(), "da-kakao-"));
	try {
		const kp = kakaoPaths(dirname(paths.inbox), dir);
		const runner: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
		const deps = { paths: kp, runner, now: () => Date.parse(ts()) - 5000 };
		const d1 = await createDraft({ chatId: "10", roomName: "스터디방", text: "내일 봐요", basisLogId: "1" }, deps);
		const d2 = await createDraft({ chatId: "11", roomName: "가족방", text: "저녁 먹어요", basisLogId: "1" }, deps);
		const d3 = await createDraft({ chatId: "12", roomName: "동호회", text: "참석해요", basisLogId: "1" }, deps);
		for (const d of [d1, d2, d3]) ask(draftBlock(d));
		expect(await approval(d1.code, deps)).toBe(false);
		await answerDecision(noticeFor(d1.code).id, { n: 1 }, web);
		await answerDecision(noticeFor(d2.code).id, { n: 3 }, web);
		expect(await approval(d1.code, deps)).toBe(true);
		expect(await approval(d2.code, deps)).toBe(false);
		const lane: DecisionSend = async a => void emit("inbox", { ts: ts(), kind: "lane_message", source: "web", lane: "x", text: a.text, picks: a.picks });
		await answerDecision(noticeFor(d3.code).id, { n: 1 }, lane);
		expect(await approval(d3.code, deps)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a quote above the draft (the comment being answered) is not part of the draft", () => {
	const text = ["[ask] 댓글 답글 초안", "> 원댓글 Bob: 영상 잘 봤어요", draftApprovalBlock({ to: "Bob 댓글", toLabel: "대상", body: "고마워요", ref: "j-1-ab12", question: "이 답글 올릴까요?" })].join("\n");
	expect(parseDraftApproval(text)).toEqual({ toLabel: "대상", to: "Bob 댓글", body: "고마워요", ref: "j-1-ab12" });
});

test("a card with both 참조 and 규칙 lines reads back with each", () => {
	const text = draftApprovalBlock({ to: "kim@example.com, lee@example.com", toLabel: "받는이", cc: ["park@example.com"], rule: "악보 요청", subject: "Re: 악보", body: "보내 드립니다.", ref: "RABCDEF", question: "이 답장 보낼까요?" });
	expect(parseDraftApproval(text)).toMatchObject({ to: "kim@example.com, lee@example.com", cc: ["park@example.com"], rule: "악보 요청", subject: "Re: 악보", body: "보내 드립니다." });
});
