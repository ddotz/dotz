import { withFileWords } from "./auto-attach.ts";

const CLAIM = /첨부\s*(?:파일|자료|문서|서류)?\s*(?:을|를|은|는)?\s*(?:합니다|했습니다|했어요|해요|드립니다|드려요|드릴게요|드렸습니다|드렸어요|해\s*드립니다|해\s*드려요|해\s*드릴게요|해\s*드렸습니다|해\s*드렸어요|하였습니다)|첨부(?:파일|자료|문서|서류)?\s*(?:을|를)?\s*(?:보내|함께)|\bI(?:'ve| have|'m| am)?\s+(?:attach|enclos)|\b(?:attached|enclosed)\s+(?:is|are)\b|\bsee\s+(?:the\s+)?attach|\bplease\s+find\b.*\b(?:attach|enclos)/i;
/** A refusal ("첨부하지 못했어요", "첨부 없음", "못 보내요") is not a claim. */
export const NO_CLAIM = /첨부\s*(?:파일)?\s*(?:은|는|이|가)?\s*(?:없|못|불가)|첨부(?:하지|할 수 없)|not\s+(?:be\s+)?attach|no\s+attach|보내\s*(?:드리지|지)\s*못|못\s*보내|보내\s*드릴 수 없|보낼 수 없/i;
/** Nouns that name a file when a draft says it sends one or a mail asks for one. */
export const FILE_NOUN = "파일|자료|문서|서류|(?<![a-z])(?:mp3|wav)(?![a-z])|동영상|견적서|청구서|계약서|제안서|보고서|이력서|영수증|사진|이미지|영상|음원|녹음|양식|서식|신청서|스캔본|스캔|첨부|pdf|hwpx?|docx?|xlsx?|pptx?|zip";
export const ENGLISH_NOUN = "file|pdf|document|photo|invoice|quote";
const SENDS = "보내\\s*드(?:립니다|려요|릴게요|릴께요|리겠습니다|렸습니다|렸어요|립니다만)|보냅니다|보내요|보낼게요|보냈(?:습니다|어요)|(?:송부|발송)\\s*(?:합니다|했습니다|했어요|드립니다|드려요|드릴게요|드리겠습니다|드렸습니다|드렸어요|해\\s*드립니다|해\\s*드렸습니다)|공유\\s*(?:드립니다|드려요|드릴게요|드리겠습니다|드렸습니다|드렸어요|해\\s*드립니다)";
/** A sentence that says it sends something now or did, whatever it is ("모두 보내드리겠습니다"): when the mail asked for a file, it is that file. */
export const SENDS_VERB = new RegExp(SENDS);
const sendsFile = withFileWords(({ document, audio, english: own }) => {
	const noun = `${FILE_NOUN}${document}${audio}`;
	const english = `${ENGLISH_NOUN}${own}`;
	return new RegExp(`(?:${noun})[가-힣]{0,2}\\s*(?:을|를|은|는|도|만)?\\s*(?:[가-힣A-Za-z0-9]+\\s+){0,2}(?:${SENDS})|(?:보내\\s*드린|보낸)\\s*(?:${noun})|\\b(?:I'm sending|I'll send|I sent|I've sent|sending you|here is|here's)\\b[^.\\n]{0,40}\\b(?:${english})s?\\b`, "i");
});
/** The text says it attaches or sends a file: the rule behind the card's amber note and the send gate's `missing` issue. */
export const claimsAttachment = (text: string): boolean => (CLAIM.test(text) || sendsFile().test(text)) && !NO_CLAIM.test(text);
/** "보내드린 문서는 ...", "보낸 PDF": a phrase that refers back to a file of an earlier mail. The card notes it; the send gate drops it before it judges. */
export const REFERS_BACK = /(?:보내\s*드린|보낸)\s*\S+/g;
const REPLY_WORD = "re|fwd?|aw|sv|답장|회신|전달|reply|forward";
const ECHOED_SUBJECT = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:(?:${REPLY_WORD})\\s*(?:\\[\\d+\\])?\\s*:|\\[(?:${REPLY_WORD})\\])`, "i");
/** The words a draft wrote itself: a reply's or forward's subject ("Re: 견적서 첨부합니다") echoes the received mail and claims nothing. */
export const ownClaimText = (subject: string | undefined, body: string): string => `${subject && !ECHOED_SUBJECT.test(subject) ? subject : ""}\n${body}`;
