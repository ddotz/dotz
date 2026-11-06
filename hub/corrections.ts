// The correction ledger (corrections.jsonl): every owner message that reads like a correction, kept at arrival with what the nightly review
// otherwise cannot see (the whole text, attachment paths, the answer it reacts to, the conversation, a topic). This runs on every inbox event,
// so it is one regex, a read of the live event ring and one append: no model, no file read. hygiene.ts rotates the file.
import { appendFileSync } from "node:fs";
import { paths } from "./config.ts";
import { eventTarget, isPeerMessage, recentEvents, type HubEvent } from "./events.ts";

export const SCAN_CHARS = 400;   // a long message is a brief: a correction says so at its start, and a word deep in a brief is not one
const TEXT_MAX = 8000;
const PREVIOUS_MAX = 300;

// Tuned on a week of owner messages read and labeled by hand (hub/corrections.fixture.json, anonymized): recall 75%, precision 63%. Plain owner
// corrections read "여전히 안되네", "너무 ~함", "이거 왜 이래", so a word list of refusals alone misses most of them.
export const CORRECTION = /아니|말고|하지\s*마|왜|틀렸|잘못|여전히|아직|안\s*(?:돼|되|됨|됐|뜨|떠|보|나오|나와|나옴|맞|오|왔|와|했|함|나가)|이상(?:해|함|하|한)|너무|없애|맞(?:냐|음|아|나)|된거|되었나|되었는|중복|깨지|깨져|어긋|멈(?:춰|췄|추|춤)|죽은|필요 없|합쳐|그대로|계속해|부실|별로|똑같|ai\s*티|ai 같|slop|no,|don't|\bstop\b|\bwrong\b|\bstill\b|not working|\bbroken\b|\bagain\b/i;
// A gateway's handover (peer-monitor.ts) and other machine-written briefs open with a [tag]; they quote old complaints without being one.
const HANDOVER = /^\s*\[[^\]\n]{1,60}\]|handoff|handover|인계/i;
const COMMAND = /^\s*[/!]\S/;

// First match wins, so the narrow topics go first. Lessons are matched too (lessonTopic in reflect.ts), hence the English words.
// 표현 and 설명 are everyday verbs and nouns, so "copy" takes them only beside a complaint; a 문구 that is cut off is a display fault, not wording.
const TOPICS = [
	["linebreak", /줄바꿈|자막|line.?break/i],
	["copy", /ai\s*(?:티|같|특유|slop)|slop|문체|문구(?![이가은는을를]?\s*잘[리려림렸])|카피|wording|copywriting|(?:어색한|이상한|딱딱한|촌스러운)\s*(?:표현|설명)|(?:표현|설명)[이가은는을를]?\s*(?:너무|(?:좀\s*)?(?:어색|이상[해하한함]|별로|구려|구리|딱딱|촌스|장황|고쳐|고치|바꿔|바꾸|다듬|수정))/i],
	["no-card", /카드|선택지|복수 선택|decision card|choice card/i],
	["duplicate", /중복|합쳐|같은 역할|이원화|duplicate/i],
	["stalled", /멈(?:춰|췄|추|춤)|죽은|살아있|쉬고|쉰다|돌긴|계속해|마저해|진행중으로|작업중|진행상황|보고해|보냈냐|stall|stuck|\bhang|keep going/i],
	["misread", /그게 아니|그거 아|아니.{0,12}(?:라고|말한|물어|는데|야\b)|말고|^아니|물어보|알려줬|misread|misunderst|not what i/i],
	["missing-output", /안\s*(?:보|뜨|떠|나와|나오)|스샷|이미지|첨부|screenshot|attachment|artifact/i],
	["ui", /\bui\b|\bux\b|레이아웃|여백|아이콘|디자인|컴팩트|규격|\d+px|정렬|패널|사이드|화살표|색상|배경색|위치|좌우|상하단|layout|spacing|\bicon|design/i],
	["ignored-setting", /effort|배포 안|반영 안|설정해|규칙|컨펌|setting|\brule\b/i],
	["not-applied", /여전히|아직|적용|반영|구현|된거|되었|안\s*(?:돼|되|됨|됐|오|왔|와)|\bstill\b|not applied|not working|prototype|시제품|verif/i],
] as const;
export type Topic = (typeof TOPICS)[number][0] | "other";
export const TOPIC_NAMES: readonly Topic[] = [...TOPICS.map(t => t[0]), "other"];

export function topicOf(text: string): Topic {
	const head = text.slice(0, SCAN_CHARS);
	return TOPICS.find(([, re]) => re.test(head))?.[0] ?? "other";
}

export const isCorrectionText = (text: string): boolean => !HANDOVER.test(text) && !COMMAND.test(text) && CORRECTION.test(text.slice(0, SCAN_CHARS));

/** An owner's own typed message that reads like a correction; a button choice (picks, decision) answers a question and is none. */
export function isCorrection(e: HubEvent): boolean {
	if ((e.kind !== "message" && e.kind !== "lane_message") || isPeerMessage(e)) return false;
	return !(e.picks as unknown[] | undefined)?.length && !e.decision && isCorrectionText(e.text);
}

export type Correction = { ts: string; topic: Topic; conv: string; text: string; attachments: string[]; previous: string; message_id?: string };

function previousAnswer(conv: string, events: readonly HubEvent[]): string {
	const answer = events.findLast(o => o.kind === "out" && !o.update_key && eventTarget(o) === conv);
	return answer ? String(answer.text ?? "").replace(/\s+/g, " ").slice(0, PREVIOUS_MAX) : "";
}

type File = { path?: string; url?: string };
export function correctionEntry(e: HubEvent, events: readonly HubEvent[]): Correction {
	const conv = eventTarget(e) ?? "main";
	const files = [...((e.attachments as File[] | undefined) ?? []), ...((e.files as File[] | undefined) ?? [])];
	const id = e.message_id ?? e.mid;
	return { ts: e.ts, topic: topicOf(e.text), conv, text: e.text.slice(0, TEXT_MAX), attachments: files.flatMap(f => f.path ?? f.url ?? []), previous: previousAnswer(conv, events), ...(id ? { message_id: String(id) } : {}) };
}

/** One write of one line, so a line is never interleaved or half there. */
export function recordCorrection(e: HubEvent, file = paths.corrections): void {
	if (isCorrection(e)) appendFileSync(file, `${JSON.stringify(correctionEntry(e, recentEvents(300)))}\n`);
}
