// The one shape of "ask the owner before anything is sent": a mail reply or send, an SNS comment, reply or post, a chat message.
// The features build the asking message with draftApprovalBlock; the gateway reads it back with parseDraftApproval, so the bell shows
// the draft itself and the bottom sheet offers 1) send 2) change 3) do not send. A pick maps to an action with draftActionOf.
//
//   > 받는이: <recipient or target>          (label: 받는이 | 대상 | 대화방, one line; a mail's 받는 사람 may be a comma list)
//   > 참조: <addresses>                      (optional, a mail that goes to 참조 as well, one comma list)
//   > 제목: <subject>                        (optional)
//   > 첨부: <name> (<size>)                  (optional, one line per file that goes out; "> 첨부: 없음" = the mail it answers had files and this
//                                            reply carries none, so the owner sees they are not included)
//   > 이어서: <what it follows> (<link>)  (optional, a draft made as a follow-up of an approved action, e.g. "댓글 답글에 이어서" + the comment's link)
//   > 규칙: <name>                         (optional, the 자동 초안 규칙 that drafted it: the card's badge)
//   >
//   > <body, every line quoted>
//   >                                       (optional second part, a mail that goes out with a comment reply and is approved by the same pick:)
//   > 함께 보낼 메일
//   > 받는이: <address>   > 제목: <subject>   > 첨부: <name> (<size>)   >   > <mail body, every line quoted>
//   결정: <question> (<ref>)                 (ref = the id the approve command takes: draft id, job id, draft code)
//   **1) 보내기**
//   <what happens>
//   **2) 고치기 …**   **3) 보내지 않기** ...
//
// 2) 고치기 is an option that needs detail (hub/choices.ts detailOf; the bot's own mark is a trailing " …" on the name): the web sheet and the
// Discord modal ask for the change first, and the answer is "2) 고치기 - <change>".
// The answer comes back as the owner's own inbox message with picks [{q: "<question> (<ref>)", n, label}] (hub/notices.ts answerDecision),
// which is what the per-feature approval checks read (hub/kakao/send.ts verdict, orchestrator turn "결정 답: ... → 1) 보내기").
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { DECISION_HEAD, issueBlock, parseDecisions } from "./choices.ts";

export const DRAFT_SEND = "보내기";
export const DRAFT_EDIT = "고치기";
export const DRAFT_DROP = "보내지 않기";
// Send modes a card may add after the three (`sendModes`): send one part of a reply + mail card, or say in your own words how to send it.
// The numbers 1-3 never move; these come after, and the free-text one is marked ` …` so the web and Discord ask for the text.
export const DRAFT_ONLY_MAIN = "답글만 보내기";
export const DRAFT_ONLY_MAIL = "메일만 보내기";
export const DRAFT_OWN = "어떻게 보낼지 직접 입력";
// A mail whose words and files disagree (hub/attach-check.ts) is not sent by 1) 보내기; its card carries the finding on one line and this 4th option,
// which sends it as it is. The refused send starts its text with ATTACH_REFUSED.
export const DRAFT_AS_IS = "이대로 보내기";
export const ATTACH_MARK = "-# ⚠️ 첨부 확인: ";
export const ATTACH_REFUSED = "첨부를 확인해 주세요:";
// The refusal says how to go on from any screen: Discord's buttons are spent by the pick that was refused, a typed "이대로 보내" answers too (draftVerdict).
export const ATTACH_AS_IS_HINT = "그래도 보내려면 카드에서 '이대로 보내기'를 고르거나 '이대로 보내'라고 답해 주세요";
const ATTACH_HELD = ". 첨부가 맞을 때까지는 보내지 않아요";
const asIsResult = (withMail: boolean) => (withMail ? "첨부가 맞지 않아도 답글과 메일을 이대로 보내요" : "첨부가 맞지 않아도 이 글을 이대로 보내요");
export type DraftAction = "send" | "edit" | "drop" | "send-main" | "send-mail" | "own" | "send-as-is";
export type DraftToLabel = "받는이" | "대상" | "대화방";
export const DRAFT_BODY_MAX = 6000;

export const NO_ATTACHMENT_WARNING = "본문에 파일을 보낸다고 썼지만 첨부파일이 없어요";
export const LIBRARY_MISS = "첨부 파일 폴더에서 맞는 파일을 찾지 못했어요";
// A mail sent through a source that cannot carry files (a webmail-no-api site): the 첨부 row says so and names the files that stay behind.
export const CANNOT_ATTACH = "이 메일은 파일을 붙여 보낼 수 없어요";
export const CANNOT_ATTACH_WARNING = `${CANNOT_ATTACH}. 파일은 직접 보내야 해요`;
const NOTE_BODY = "본문에는 보낸다고 썼어요";
const NOTE_ASKED = "받은 메일이 파일을 요청했어요";
// An outgoing file: size in bytes when building a block, as the block shows it ("340KB") once parsed.
export type DraftFileIn = { name: string; size?: number };
export type DraftFile = { name: string; size?: string };
export type DraftOrigin = { text: string; link?: string };
export type DraftApproval = { toLabel: string; to: string; /** What only the owner can decide, one point each (the card's 정할 것 list). */ decide?: string[]; cc?: string[]; mode?: "reply" | "all"; subject?: string; body: string; ref?: string; attachments?: DraftFile[]; noAttachments?: true; warning?: string; note?: string; origin?: DraftOrigin; rule?: string; mail?: DraftApproval; /** recipientCheck's finding against the quoted source above the draft. */ recipientWarning?: string; /** The card's `첨부 확인` line: where the words and the files disagree. */ attachIssues?: string[] };

// The recipient of a reply is the address the source wrote, copied as is (2026-10-31: a comment's "thanever2@hannail.net" and the owner
// having to say "hanmail.net 으로 주소 고쳐서 다시 보내"). recipientCheck compares a draft's recipient with the addresses in the source text
// (the comment or mail it answers): an address the source does not have is a mismatch; one copied as is whose domain is one letter away
// (edit distance 1-2) from a common mail domain is named as a likely typo with the corrected address, so the owner decides before 보내기.
// The address is never changed here. Undefined when nothing is off.
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
export const addressesIn = (text: string): string[] => [...new Set((text.match(ADDRESS) ?? []).map(a => a.toLowerCase()))];
const MAIL_DOMAINS = ["hanmail.net", "naver.com", "gmail.com", "daum.net", "kakao.com", "nate.com"];
// Levenshtein distance with adjacent swaps counted as one edit, stopping early past 2.
function distance(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 2) return 3;
	const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
	for (let i = 1; i <= a.length; i++)
		for (let j = 1; j <= b.length; j++) {
			d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
		}
	return d[a.length]![b.length]!;
}
/** The common mail domain `domain` is likely a typo of (1-2 edits away, not itself), if any. */
export function domainTypo(domain: string): string | undefined {
	const d = domain.toLowerCase();
	if (MAIL_DOMAINS.includes(d)) return undefined;
	let best: string | undefined, min = 3;
	for (const k of MAIL_DOMAINS) {
		const n = distance(d, k);
		if (n < min) (best = k), (min = n);
	}
	return best;
}
export function recipientCheck(to: string, source: string): string | undefined {
	const have = addressesIn(source), want = addressesIn(to);
	if (!want.length) return undefined;
	const missing = have.length ? want.filter(a => !have.includes(a)) : [];
	const typo = want.flatMap(a => {
		const [user, d] = a.split("@") as [string, string], near = domainTypo(d);
		return near ? [`${a} → ${user}@${near}?`] : [];
	});
	const out = [
		...(missing.length ? [`${missing.join(", ")}는 원문에 적힌 주소(${have.join(", ")})에 없어요`] : []),
		...(typo.length ? [`도메인 오타 같아요: ${typo.join(", ")}`] : []),
	];
	return out.length ? out.join(" · ") : undefined;
}
// Every mail recipient a card names (each "받는이:" / "참조:" line, quoted or not: a bot-written comment + mail card may carry the mail's
// 받는이 inside the quoted reply) checked against its source: the "원문:" lines it quotes and the quote above the draft (`above`).
const SOURCE_LINE = /^\s*>?\s*(?:[①-⑳]\s*)?(?:댓글\s*|메일\s*)?원문[^:：\n]{0,20}[:：]\s*(.*)$/;
const TO_LINE = /^\s*>?\s*(?:받는이|받는 사람|참조)\s*[:：]\s*(.+)$/;
export function cardRecipientCheck(text: string, above = ""): string | undefined {
	const lines = text.split("\n");
	const to = lines.flatMap(l => TO_LINE.exec(l)?.[1] ?? []).join(", ");
	const source = [above, ...lines.flatMap(l => SOURCE_LINE.exec(l)?.[1] ?? [])].join("\n");
	return recipientCheck(to, source);
}
/** The line a card shows its recipient finding on, right under its first line (Discord and the notice show the card's text). */
export const RECIPIENT_MARK = "-# ⚠️ 받는이 확인: ";
/** A send-approval card with its recipient finding as one line under the first line (none when nothing is off). */
export function withRecipientMark(text: string): string {
	const lines = text.split("\n").filter(l => !l.trim().startsWith(RECIPIENT_MARK.trim()));
	const w = parseDraftApproval(lines.join("\n"))?.recipientWarning;
	if (w) lines.splice(1, 0, `${RECIPIENT_MARK}${w}`);
	return lines.join("\n");
}
// One part of a card: the reply (or the mail) with its recipient line, files and body.
export type DraftPart = { /** The mail draft id its files are staged under: the "함께 보낼 메일 (<id>)" line, so the card can open them. */ id?: string; origin?: DraftOrigin; rule?: string; to: string; toLabel?: DraftToLabel; cc?: string[]; subject?: string; body: string; attachments?: DraftFileIn[]; attachmentsNone?: boolean; asksFile?: boolean; libraryMiss?: boolean; /** The source cannot send files: the names of the files staged for it (they do not go out), [] when none. */ cannotAttach?: string[]; /** Where this part's words and files disagree (flow.ts draftAttachIssues): the card's `첨부 확인` line and its 4th option. */ attachIssues?: string[] };
// `mail`: the mail that goes out right after this comment reply, shown below it in the same card (hub/comments).
export type DraftInput = DraftPart & { ref: string; question?: string; /** What only the owner can decide: a "정할 것:" list above the 결정 line, one "- " line each. */ decide?: string[]; sendResult?: string; mail?: DraftPart; sendModes?: boolean };
export const MAIL_MARK = "함께 보낼 메일";
const MAIL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
const MAIL_LINE = /^함께 보낼 메일(?: \(([A-Za-z0-9][A-Za-z0-9_.-]{1,63})\))?$/;

export function fileSizeText(b: number): string {
	return b >= 1073741824 ? `${(b / 1073741824).toFixed(1)}GB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : b >= 1024 ? `${Math.round(b / 1024)}KB` : `${Math.max(0, Math.round(b))}B`;
}

// The draft says it attaches something ("첨부합니다", "attached"). A refusal ("첨부하지 못", "첨부 없음") is not a claim.
const CLAIM = /첨부\s*(?:파일|자료|문서|서류)?\s*(?:을|를|은|는)?\s*(?:합니다|했습니다|했어요|해요|드립니다|드려요|드릴게요|해\s*드립니다|해\s*드려요|해\s*드릴게요|하였습니다)|첨부(?:파일|자료|문서|서류)?\s*(?:을|를)?\s*(?:보내|함께)|\b(?:attached|attaching)\b|\bI(?:'ve| have)?\s+attach|\bplease\s+find\b.*\battach/i;
const NO_CLAIM = /첨부\s*(?:파일)?\s*(?:은|는|이|가)?\s*(?:없|못|불가)|첨부(?:하지|할 수 없)|not\s+attach|no\s+attach|보내\s*(?:드리지|지)\s*못|못\s*보내|보내\s*드릴 수 없|보낼 수 없/i;
// Nouns that name a file when a draft says it sends one or a mail asks for one.
const FILE_NOUN = "문서|파일|자료|문서|견적서|청구서|계약서|제안서|보고서|이력서|영수증|사진|이미지|영상|음원|녹음|양식|서식|신청서|스캔본|스캔|첨부|pdf|hwpx?|docx?|xlsx?|pptx?|zip";
const SENDS = "보내\\s*드(?:립니다|려요|릴게요|릴께요|리겠습니다|렸습니다|렸어요|립니다만)|보냅니다|보내요|보낼게요|보냈(?:습니다|어요)";
// "달빛정원 자료 문서 보내드립니다", "보내드린 문서는": the draft says it sends a file-like thing.
const SENDS_FILE = new RegExp(`(?:${FILE_NOUN})[가-힣]{0,2}\\s*(?:을|를|은|는|도|만)?\\s*(?:[가-힣A-Za-z0-9]+\\s+){0,2}(?:${SENDS})|(?:보내\\s*드린|보낸)\\s*(?:${FILE_NOUN})|\\b(?:I'm sending|I'll send|I sent|I've sent|sending you|here is|here's)\\b[^.\\n]{0,40}\\b(?:file|pdf|document|score|document|photo|invoice|quote)s?\\b`, "i");
const ASK = /부탁|보내\s*주|보내\s*줘|보내\s*달|(?:공유|전달)\s*해?\s*(?:주|달)|주세요|주시면|주실 수|주실래/;
const ASK_EN = /\b(?:please|could you|can you|would you)\b[^.\n]{0,40}\b(?:send|share|attach|forward)\b[^.\n]{0,40}\b(?:file|pdf|document|score|document|photo|invoice|quote|copy)s?\b/i;
export const claimsAttachment = (text: string): boolean => (CLAIM.test(text) || SENDS_FILE.test(text)) && !NO_CLAIM.test(text);
// The mail being answered asks for a file ("문서 부탁드립니다", "견적서 보내주세요").
export const asksForFile = (text: string): boolean =>
	ASK_EN.test(text) || text.split(/[.!?\n]+/).some(sentence => new RegExp(FILE_NOUN, "i").test(sentence) && ASK.test(sentence));

const quote = (s: string) => s.split("\n").map(l => (l ? `> ${l}` : ">"));

const fileLine = (f: DraftFileIn) => `> 첨부: ${f.name.replace(/\s+/g, " ").trim()}${f.size !== undefined ? ` (${fileSizeText(f.size)})` : ""}`;

function partLines(d: DraftPart): string[] {
	const files = (d.attachments ?? []).map(fileLine);
	const note = files.length ? "" : (d.toLabel ?? "받는이") !== "받는이" ? "" : claimsAttachment(`${d.subject ?? ""}\n${d.body}`) ? NOTE_BODY : d.asksFile ? NOTE_ASKED : "";
	// A mail always says what goes with it, files or 없음, so a missing file is seen before 보내기 (owner 2026-10-26).
	const mail = (d.toLabel ?? "받는이") === "받는이";
	const left = (d.cannotAttach ?? []).map(n => n.replace(/\s+/g, " ").trim());
	const reasons = [...(d.cannotAttach && (left.length || note) ? [CANNOT_ATTACH] : []), ...(left.length ? [`빠진 파일: ${left.join(", ")}`] : []), ...(note ? [note] : []), ...(note && d.libraryMiss ? [LIBRARY_MISS] : [])];
	const none = reasons.length ? `> 첨부: 없음 (${reasons.join(" · ")})` : d.attachmentsNone || mail ? "> 첨부: 없음" : "";
	const cc = (d.cc ?? []).map(a => a.replace(/\s+/g, " ").trim()).filter(Boolean);
	const head = [`> ${d.toLabel ?? "받는이"}: ${d.to.replace(/\s+/g, " ").trim()}`, ...(cc.length ? [`> 참조: ${cc.join(", ")}`] : []), ...(d.subject ? [`> 제목: ${d.subject.replace(/\s+/g, " ").trim()}`] : []), ...(files.length ? files : none ? [none] : []), ...(d.origin ? [`> 이어서: ${d.origin.text.replace(/\s+/g, " ").trim()}${d.origin.link ? ` (${d.origin.link.replace(/\s+/g, "")})` : ""}`] : []), ...(d.rule ? [`> 규칙: ${d.rule.replace(/\s+/g, " ").trim()}`] : []), ">"];
	return [...head, ...quote(d.body.replace(/\r\n?/g, "\n").trim())];
}

export function draftApprovalBlock(d: DraftInput): string {
	const issues = [...(d.attachIssues ?? []), ...(d.mail?.attachIssues ?? [])].map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
	const options = [
		{ name: DRAFT_SEND, result: `${d.sendResult ?? `${d.to.replace(/\s+/g, " ").trim()}에 이 글을 그대로 보내요`}${issues.length ? ATTACH_HELD : ""}` },
		{ name: `${DRAFT_EDIT} …`, result: d.mail ? "답글과 메일 중 어느 쪽을 어떻게 고칠지 알려 주면 고쳐서 다시 물어봐요" : "어떻게 고칠지 알려 주면 고쳐서 다시 물어봐요" },
		{ name: DRAFT_DROP, result: d.mail ? "답글과 메일을 모두 버려요" : "이 초안은 버려요" },
		...(issues.length ? [{ name: DRAFT_AS_IS, result: asIsResult(!!d.mail) }] : []),
		...(d.sendModes && d.mail
			? [
					{ name: DRAFT_ONLY_MAIN, result: "답글만 올리고 메일은 보내지 않아요" },
					{ name: DRAFT_ONLY_MAIL, result: "메일만 보내고 답글은 나중에 올려요" },
				]
			: []),
		...(d.sendModes ? [{ name: `${DRAFT_OWN} …`, result: "어떻게 보낼지 적어 주면 그대로 해요" }] : []),
	];
	const mail = d.mail ? [">", `> ${MAIL_MARK}${d.mail.id && MAIL_ID.test(d.mail.id) ? ` (${d.mail.id})` : ""}`, ...partLines({ ...d.mail, toLabel: "받는이" })] : [];
	const decide = (d.decide ?? []).map(oneLine).filter(Boolean);
	return [...(issues.length ? [`${ATTACH_MARK}${issues.join(" · ")}`] : []), ...partLines(d), ...mail, ...(decide.length ? [DECIDE_MARK, ...decide.map(q => `- ${q}`)] : []), issueBlock(`${d.question ?? "보낼까요?"} (${d.ref})`, options)].join("\n");
}

// The points only the owner can decide sit on their own lines above the 결정 line, so the question stays one short line (its "(<ref>)" is what
// the answer is matched by) and each point reads on its own (owner 2026-11-02). A card made before that kept them in the question,
// "<question> 정할 것: a., b." joined by ", ": decideOf reads both.
const DECIDE_MARK = "정할 것:";
const DECIDE_HEAD = /^\s*정할 것\s*[:：]\s*$/;
const DECIDE_ITEM = /^\s*-\s+(.*\S)\s*$/;
const DECIDE_OLD = /\s정할 것\s*[:：]\s*(.+?)\s*(?:\([A-Za-z0-9][A-Za-z0-9_.:-]{1,63}\))?$/;
// Parentheses would read as the card's "(<ref>)"; line breaks would end the item.
const oneLine = (q: string) => q.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
export function decideOf(text: string): string[] {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (DECIDE_HEAD.test(lines[i]!)) {
			const out: string[] = [];
			for (let j = i + 1; j < lines.length; j++) {
				const m = DECIDE_ITEM.exec(lines[j]!);
				if (!m) break;
				out.push(m[1]!);
			}
			if (out.length) return out;
		}
		const h = DECISION_HEAD.exec(lines[i]!);
		const old = h ? DECIDE_OLD.exec(` ${h[1]}`) : null;
		if (old) return old[1]!.split(/(?<=[.!?])\s*,\s+/).map(s => s.trim()).filter(Boolean);
	}
	return [];
}

// The card text with its `첨부 확인` line and 4th option set to `issues` (none = both go): the same card draftApprovalBlock would write now, so a card
// whose files changed after it was posted follows them. The options after the third are renumbered; unchanged text when nothing differs.
const OPTION = /^(\*\*)(\d+)\)\s*(.*?)(\*\*)\s*$/;
export function withAttachIssues(text: string, issues: readonly string[]): string {
	const now = issues.map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
	const lines = text.split("\n").filter(l => !l.trim().startsWith(ATTACH_MARK.trim()));
	const at = now.length ? lines.findIndex(l => /^\s*>/.test(l)) : -1;
	if (at >= 0) lines.splice(at, 0, `${ATTACH_MARK}${now.join(" · ")}`);
	const head = lines.findIndex(l => DECISION_HEAD.test(l));
	const opts = () => lines.flatMap((l, i) => (i > head && OPTION.test(l.trim()) ? [{ at: i, name: OPTION.exec(l.trim())![3]!.trim() }] : []));
	let o = head < 0 ? [] : opts();
	if (o.length >= 3 && o[0]!.name === DRAFT_SEND) {
		const own = o.find(x => x.name === DRAFT_AS_IS);
		if (own) lines.splice(own.at, 2);
		o = opts();
		if (now.length) lines.splice(o[3]?.at ?? o[2]!.at + 2, 0, `**4) ${DRAFT_AS_IS}**`, asIsResult(text.includes(`> ${MAIL_MARK}`)));
		o = opts();
		o.forEach((x, i) => (lines[x.at] = lines[x.at]!.replace(/\d+\)/, `${i + 1})`)));
		const held = lines[o[0]!.at + 1];
		if (held !== undefined) lines[o[0]!.at + 1] = `${held.endsWith(ATTACH_HELD) ? held.slice(0, -ATTACH_HELD.length) : held}${now.length ? ATTACH_HELD : ""}`;
	}
	return lines.join("\n");
}

// The card text with one part's `> 첨부:` rows set to the files staged for it now ("main" = the reply, "mail" = the 함께 보낼 메일 part), so a file
// attached after the card was posted shows on it and its "no file" warning goes (owner 2026-11-02). Every other line stays as it is.
// Unchanged text when the rows already name these files, or when nothing is staged and the card names no file.
export function withStagedFiles(text: string, files: DraftFileIn[], part: "main" | "mail" = "main"): string {
	const lines = text.split("\n");
	const quoted = (l: string) => /^\s*>\s?(.*)$/.exec(l)?.[1];
	const cut = lines.findIndex(l => MAIL_LINE.test(quoted(l) ?? ""));
	if (part === "mail" && cut < 0) return text;
	const [from, to] = part === "main" ? [0, cut < 0 ? lines.length : cut] : [cut + 1, lines.length];
	let head = -1;
	for (let i = from; i < to && head < 0; i++) if (HEADER.test(quoted(lines[i]!) ?? "")) head = i;
	if (head < 0) return text;
	const rows: number[] = [];
	let at = -1;
	let end = head + 1;
	for (; end < to; end++) {
		const q = quoted(lines[end]!);
		if (q === undefined) break;
		if (ATTACH.test(q)) rows.push(end);
		else if (ORIGIN.test(q) || RULE.test(q)) at = at < 0 ? end : at;
		else if (!CC.test(q) && !SUBJECT.test(q)) break;
	}
	const old = rows.map(i => lines[i]!);
	let next = files.map(fileLine);
	if (!next.length) {
		if (old.every(l => /^\s*>\s?첨부\s*[:：]\s*없음/.test(l))) return text;
		const d = parseQuotedDraft(text);
		const p = part === "main" ? d : d?.mail;
		next = [p && p.toLabel === "받는이" && claimsAttachment(`${p.subject ?? ""}\n${p.body}`) ? `> 첨부: 없음 (${NOTE_BODY})` : "> 첨부: 없음"];
	}
	if (next.join("\n") === old.join("\n")) return text;
	const place = rows[0] ?? (at >= 0 ? at : end);
	const out = lines.flatMap((l, i) => (rows.includes(i) ? [] : [l]));
	const shift = rows.filter(i => i < place).length;
	out.splice(place - shift, 0, ...next);
	return out.join("\n");
}

// A card made before a change to how drafts are read (the always-shown 첨부 row, 2026-10-26) re-read from its own text with the current
// rules: the head (recipient, subject, files, warning, origin) is replaced, the body and ref stay (the stored text may be cut shorter).
const HEAD_KEYS = ["toLabel", "to", "decide", "cc", "subject", "attachments", "noAttachments", "warning", "note", "origin", "rule", "recipientWarning", "attachIssues"] as const;
export function refreshDraft(old: DraftApproval, text: string): DraftApproval {
	const fresh = parseQuotedDraft(text);
	if (!fresh) return old;
	const head = (o: DraftApproval, f: DraftApproval): DraftApproval => {
		const out: Record<string, unknown> = { ...o };
		for (const k of HEAD_KEYS) {
			if (f[k] === undefined) delete out[k];
			else out[k] = f[k];
		}
		return out as DraftApproval;
	};
	const next = head(old, fresh);
	if (old.mail && fresh.mail) next.mail = { ...head(old.mail, fresh.mail), ...(fresh.mail.ref ? { ref: fresh.mail.ref } : {}) };
	return next;
}

// The stored asking message of a card whose 받는 사람·참조 changed (hub/draft-recipients.ts): its 받는이 line and 참조 line become the new ones,
// everything else (제목, 첨부, 이어서, body) stays, so the card is re-read as the same card after a restart.
export function rewriteDraftTo(text: string, to: string, cc: readonly string[]): string {
	const lines = text.split("\n");
	const head = lines.findIndex(l => /^>\s*받는이\s*[:：]/.test(l));
	if (head < 0) return text;
	const out = [...lines.slice(0, head), `> 받는이: ${to.replace(/\s+/g, " ").trim()}`, ...(cc.length ? [`> 참조: ${cc.join(", ")}`] : [])];
	let i = head + 1;
	for (; i < lines.length; i++) {
		const line = lines[i]!;
		if (/^>\s*참조\s*[:：]/.test(line)) continue;
		if (!/^>\s*(?:제목|첨부|이어서)\s*[:：]/.test(line)) break;
		out.push(line);
	}
	return [...out, ...lines.slice(i)].join("\n");
}

const HEADER = /^(받는이|대상|대화방)\s*[:：]\s*(.*)$/;
const CC = /^참조\s*[:：]\s*(.*)$/;
const SUBJECT = /^제목\s*[:：]\s*(.*)$/;
const ATTACH = /^첨부\s*[:：]\s*(.*)$/;
const ORIGIN = /^이어서\s*[:：]\s*(.*?)(?:\s+\(((?:https?:\/\/|#|\/)\S*)\))?$/;
const RULE = /^규칙\s*[:：]\s*(.+)$/;
const NONE_NOTE = /^없음\s*\((.+)\)$/;
// "a.pdf (352KB)", also with a note after the size as a session writes it by hand ("a.pdf (352KB, 3쪽)").
const FILE_SIZE = /^(.*\S)\s+\((\d+(?:\.\d+)?(?:B|KB|MB|GB))(?:\s*[,·][^()]*)?\)$/;
const REF = /\(([A-Za-z0-9][A-Za-z0-9_.:-]{1,63})\)\s*$/;

const DRAFT_MODES = new Set([DRAFT_AS_IS, DRAFT_ONLY_MAIN, DRAFT_ONLY_MAIL, DRAFT_OWN]);
const ATTACH_LINE = /^\s*-#\s*⚠️\s*첨부 확인\s*[:：]\s*(.+?)\s*$/m;
// The draft a message asks approval for; undefined when the message is not a draft-approval decision (one block whose options are
// 보내기 / 고치기 / 보내지 않기, then only send modes, with a quoted draft above it).
export function parseDraftApproval(text: string): DraftApproval | undefined {
	const pc = parseDecisions(text);
	const block = pc.blocks.length === 1 ? pc.blocks[0]! : undefined;
	const labels = block?.options.map(o => o.label) ?? [];
	if (!block || labels.slice(0, 3).join("|") !== [DRAFT_SEND, DRAFT_EDIT, DRAFT_DROP].join("|") || !labels.slice(3).every(l => DRAFT_MODES.has(l))) return undefined;
	const draft = parseQuotedDraft(text);
	const ref = REF.exec(block.title)?.[1];
	return draft && ref ? { ...draft, ref } : draft;
}

// One block of a message that asks about several drafts at once ("<question> (<ref>)" over 보내기 / 고치기 / 보내지 않기): its notice carries no
// `draft` (parseDraftApproval reads a one-block message only), yet the draft behind it can be sent or dropped elsewhere (the 모니터링 queue),
// so hub/notices.ts settleHandledDrafts asks for it by this ref.
export function blockDraftRef(title: string, labels: string[]): string | undefined {
	if (labels.slice(0, 3).join("|") !== [DRAFT_SEND, DRAFT_EDIT, DRAFT_DROP].join("|") || !labels.slice(3).every(l => DRAFT_MODES.has(l))) return undefined;
	return REF.exec(title)?.[1];
}

// The quoted draft of a message as a draft (recipient line, optional subject, body), whatever the options below it are; undefined when the
// message quotes none. Blank lines in the body are collapsed to one (a mail quoted with doubled breaks reads as normal paragraphs).
export function parseQuotedDraft(text: string): DraftApproval | undefined {
	let fence = false;
	const quoted: string[] = [];
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		const m = fence ? null : /^\s*>\s?(.*)$/.exec(line);
		if (m) quoted.push(m[1]!);
	}
	if (!quoted.length) return undefined;
	const first = quoted.findIndex(l => HEADER.test(l));
	// A quote above the draft (the comment being answered) is not part of it; it is the source its recipient is checked against.
	const above = first > 0 ? quoted.splice(0, first) : [];
	const decide = decideOf(text);
	const issues = ATTACH_LINE.exec(text)?.[1]?.split(" · ").map(s => s.trim()).filter(Boolean) ?? [];
	const checked = (d: DraftApproval | undefined): DraftApproval | undefined => {
		const w = d ? cardRecipientCheck(text, above.join("\n")) : undefined;
		return d ? { ...d, ...(decide.length ? { decide } : {}), ...(w ? { recipientWarning: w } : {}), ...(issues.length ? { attachIssues: issues } : {}) } : d;
	};
	const cut = quoted.findIndex(l => MAIL_LINE.test(l));
	if (cut < 0) return checked(parseDraftLines(quoted));
	const id = MAIL_LINE.exec(quoted[cut]!)?.[1];
	const mail = parseDraftLines(quoted.slice(cut + 1));
	const main = checked(parseDraftLines(quoted.slice(0, cut)));
	return main && mail ? { ...main, mail: id ? { ...mail, ref: id } : mail } : main;
}

// One part (the reply or the mail) from its quoted lines: recipient line, optional subject / files / origin, then the body.
function parseDraftLines(quoted: string[]): DraftApproval | undefined {
	let toLabel = "받는이";
	let to = "";
	let subject: string | undefined;
	let cc: string[] = [];
	const attachments: DraftFile[] = [];
	let none = false;
	let note: string | undefined;
	let origin: DraftOrigin | undefined;
	let rule: string | undefined;
	let i = 0;
	for (; i < quoted.length; i++) {
		const h = HEADER.exec(quoted[i]!) ?? undefined;
		const c = to && !cc.length ? CC.exec(quoted[i]!) : null;
		const s = SUBJECT.exec(quoted[i]!);
		const a = to ? ATTACH.exec(quoted[i]!) : null;
		const o = to && !origin ? ORIGIN.exec(quoted[i]!) : null;
		const r = to && rule === undefined ? RULE.exec(quoted[i]!) : null;
		if (h && !to) {
			toLabel = h[1]!;
			to = h[2]!.trim();
		} else if (c) cc = c[1]!.split(/\s*,\s*/).map(a => a.trim()).filter(Boolean);
		else if (s && subject === undefined) subject = s[1]!.trim();
		else if (r) rule = r[1]!.trim();
		else if (o && o[1]!.trim()) origin = { text: o[1]!.trim(), ...(o[2] ? { link: o[2] } : {}) };
		else if (a) {
			const v = a[1]!.trim();
			const m = FILE_SIZE.exec(v);
			const nn = NONE_NOTE.exec(v);
			// One line naming several files ("a.xlsx, b.pdf", a hand-written block) is one file per name.
			const parts = v.split(/\s*,\s+/);
			if (v === "없음") none = true;
			else if (nn) note = nn[1]!.trim();
			else if (parts.length > 1 && parts.every(x => /\.[A-Za-z0-9]{1,5}(?:\s+\([^()]+\))?$/.test(x)))
				for (const x of parts) {
					const pm = FILE_SIZE.exec(x);
					attachments.push(pm ? { name: pm[1]!, size: pm[2]! } : { name: x });
				}
			else if (v) attachments.push(m ? { name: m[1]!, size: m[2]! } : { name: v });
		} else break;
	}
	const body = quoted.slice(i).join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "");
	if (!body) return undefined;
	const clipped = body.slice(0, DRAFT_BODY_MAX);
	const warn = toLabel === "받는이" && !attachments.length && (!!note || claimsAttachment(`${subject ?? ""}\n${clipped}`));
	return { toLabel, to, ...(cc.length ? { cc } : {}), ...(subject ? { subject } : {}), body: clipped, ...(attachments.length ? { attachments } : none || toLabel === "받는이" ? { noAttachments: true as const } : {}), ...(warn ? { warning: note?.startsWith(CANNOT_ATTACH) ? CANNOT_ATTACH_WARNING : NO_ATTACHMENT_WARNING } : {}), ...(note ? { note } : {}), ...(origin ? { origin } : {}), ...(rule ? { rule } : {}) };
}

// The quoted draft of a message (recipient line first, as draftApprovalBlock writes it), as standard "> " lines; undefined when the message
// quotes no draft (a quote that does not start with the recipient line is something else, e.g. the mail being answered).
export function quotedDraft(text: string): string | undefined {
	let fence = false;
	let out: string[] | undefined;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		const m = fence ? null : /^\s*>\s?(.*)$/.exec(line);
		if (!m) {
			if (out) break;
			continue;
		}
		if (!out && !HEADER.test(m[1]!)) continue;
		(out ??= []).push(m[1]! ? `> ${m[1]}` : ">");
	}
	return out?.join("\n").replace(/(?:\n>)+$/, "");
}

const ACTIONS: Record<string, DraftAction> = { [DRAFT_SEND]: "send", [DRAFT_EDIT]: "edit", [DRAFT_DROP]: "drop", [DRAFT_ONLY_MAIN]: "send-main", [DRAFT_ONLY_MAIL]: "send-mail", [DRAFT_OWN]: "own", [DRAFT_AS_IS]: "send-as-is" };
// What a picked label means; anything else (a label outside the three and the send modes) is not a draft answer.
export function draftActionOf(label: string): DraftAction | undefined {
	return Object.hasOwn(ACTIONS, label) ? ACTIONS[label] : undefined;
}
// The draft answers that carry the owner's text: 2) 고치기 - <change>, 어떻게 보낼지 직접 입력 - <how>.
export const draftNeedsText = (label: string): boolean => {
	const a = draftActionOf(label);
	return a === "edit" || a === "own";
};

export type DraftVerdict = { verdict: DraftAction | "none"; detail?: string };
const OWNER_SOURCES = new Set(["web", "discord", "terminal"]);
const TAIL_BYTES = 2 * 1024 * 1024;

// The owner's own words about a waiting draft, typed instead of a tap: "보내자", "ㅇㅇㅇ 메일 보내", "아잇 보내라고" approve, "보내지 마", "안 보내",
// "ㄴㄴ" refuse. Only the first clause counts ("보내자. 그리고 화면도 고쳐" approves), and it approves only when it is nothing but a yes or a send
// verb with filler words, so "파일 하나 더 붙여서 보내줘" or "보내기 전에 제목 바꿔" says nothing (the draft is not what he asked for). A question says nothing.
const TEXT_NO = /보내지\s*(?:마|말|않)|안\s*보내|보내면\s*안|ㄴㄴ|보류|취소|그만/;
const TEXT_YES = /^(?:ㅇ{2,}|ㅇㅋ|응|네|넵|예|ok|okay|오케이|좋아|좋아요|그래|ㄱ|ㄱㄱ|고|고고)$/i;
const TEXT_SEND = /^(?:보내(?:기|자|줘|줘요|주세요|요|라|라고|라니까|놔|놔라|버려|도)?|(?:전송|발송)(?:해|해줘|해요|하자|하라고)?)$/;
const TEXT_AS_IS = /이대로|그대로/;
const TEXT_FILLER = /^(?:아|아잇|아니|그냥|빨리|얼른|어서|이제|그럼|일단|좀|메일|답장|회신|답글|댓글|이거|그거|이걸로|그걸로|이대로|그대로|다시|바로|지금|돼|됨)$/;
export function textVerdict(text: string): "send" | "drop" | undefined {
	const m = /^\s*([^.!?\n]*)([.!?\n]?)/.exec(text);
	const first = (m?.[1] ?? "").trim();
	if (!first || m?.[2] === "?") return undefined;
	if (TEXT_NO.test(first)) return "drop";
	const words = first.split(/[\s,~ㅎ]+/).filter(Boolean);
	return words.some(w => TEXT_YES.test(w) || TEXT_SEND.test(w)) && words.every(w => TEXT_YES.test(w) || TEXT_SEND.test(w) || TEXT_FILLER.test(w)) ? "send" : undefined;
}

// What the owner decided for the draft `ref` (the id in the question's trailing "(<ref>)") after `sinceMs`, read from the inbox log.
// Only the owner's own messages count (web, discord, terminal; not a session's lane_message) and the latest word wins: a pick on the card,
// or a typed reply (textVerdict) in the conversation the draft was asked in (`conv`, or the one a pick for this ref came from). For 고치기 the
// detail is the change the owner typed ("2) 고치기 - <change>"), for 직접 입력 how to send it.
export function draftVerdict(inboxPath: string, ref: string, sinceMs: number, opts: { conv?: string } = {}): DraftVerdict {
	if (!existsSync(inboxPath)) return { verdict: "none" };
	const size = statSync(inboxPath).size;
	const start = Math.max(0, size - TAIL_BYTES);
	const buf = Buffer.alloc(size - start);
	const fd = openSync(inboxPath, "r");
	try {
		readSync(fd, buf, 0, buf.length, start);
	} finally {
		closeSync(fd);
	}
	const lines = buf.toString("utf8").split("\n");
	if (start > 0) lines.shift();
	const tag = `(${ref})`;
	type Entry = { ts?: unknown; kind?: unknown; source?: unknown; text?: unknown; picks?: unknown; conv?: unknown; channel?: unknown };
	const owned: Entry[] = [];
	for (const line of lines) {
		let e: Entry;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (!e || e.kind !== "message" || typeof e.source !== "string" || !OWNER_SOURCES.has(e.source) || typeof e.ts !== "string" || !(Date.parse(e.ts) > sinceMs)) continue;
		owned.push(e);
	}
	const picksOf = (e: Entry) => (Array.isArray(e.picks) ? (e.picks as { q?: unknown; label?: unknown }[]) : []).filter(p => typeof p?.q === "string" && p.q.includes(tag) && typeof p.label === "string" && !!draftActionOf(p.label));
	const where = new Set<string>(opts.conv ? [opts.conv] : []);
	for (const e of owned) if (picksOf(e).length) for (const c of [e.conv, e.channel]) if (typeof c === "string" && c) where.add(c);
	let out: DraftVerdict = { verdict: "none" };
	for (const e of owned) {
		const picks = picksOf(e);
		for (const p of picks) {
			const verdict = draftActionOf(p.label as string)!;
			const detail = draftNeedsText(p.label as string) && typeof e.text === "string" ? e.text.split(" - ").slice(1).join(" - ").trim() : "";
			out = { verdict, ...(detail ? { detail } : {}) };
		}
		// A typed reply: a message without picks, in the draft's own conversation.
		if (picks.length || Array.isArray(e.picks) || typeof e.text !== "string" || ![e.conv, e.channel].some(c => typeof c === "string" && where.has(c))) continue;
		const said = textVerdict(e.text);
		if (said) out = { verdict: said === "send" && TEXT_AS_IS.test(e.text) ? "send-as-is" : said };
	}
	return out;
}
