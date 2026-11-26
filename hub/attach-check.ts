// Does what a mail draft says it sends match the files on it? The check behind the send gate (features/reply-drafts/lib/flow.ts sendDraft) and the card's
// `첨부 확인` line. Plain code over the draft's words and file names, no model, so it runs on every card read and right before every send; the only config is the
// install's own file words (hub/auto-attach.ts).
// It knows kinds of files, never particular ones: a draft that promises a file and has none, promises a kind it does not carry, carries a kind nobody
// promised or asked for, carries files the draft has nothing to do with, or carries several cuts of one file.
import { CLAIM, claimsAttachment, NON_FILE_SEND, ownClaimText, REFERS_BACK, SENDS_VERB } from "./attach-claim.ts";
import { withFileWords } from "./auto-attach.ts";

export type AttachIssueKind = "missing" | "partial" | "extra" | "unrelated" | "variants" | "skipped";
export type AttachIssue = { kind: AttachIssueKind; text: string };
export type AttachCheck = { subject?: string; body: string; files: readonly string[]; /** What the draft answers; a kind asked for here is not "extra". Absent for a new mail. */ request?: string };

type FileKind = "audio" | "document" | "image" | "video";
const KIND_LABEL: Record<FileKind, string> = { audio: "음원", document: "문서", image: "이미지", video: "영상" };
const KIND_EXT: [FileKind, RegExp][] = [
	["audio", /\.(?:mp3|wav|m4a|aac|flac|ogg|aiff?)$/i],
	["document", /\.(?:pdf|hwpx?|docx?|xlsx?|pptx?|txt|csv|zip|numbers|key|pages|rtf|odt|rar|7z)$/i],
	["image", /\.(?:png|jpe?g|gif|heic|webp)$/i],
	["video", /\.(?:mp4|mov|m4v|webm|avi)$/i],
];
const KIND_WORD: [FileKind, RegExp][] = [
	["audio", /(?:^|[^a-z])(?:mp3|wav)(?:[^a-z]|$)|음원|녹음\s*파일/i],
	["document", /pdf|문서|서류|견적서|청구서|계약서|제안서|보고서|이력서|양식|서식|신청서|스캔본/i],
	["image", /사진|이미지/],
	["video", /영상\s*파일|동영상/],
];
const NOISE_WORDS = "파일|자료|문서|부분|전체|공유|공유용|버전|ver|full|pdf|mp3|wav";
// The built-in words plus the install's own.
const words = withFileWords(extra => {
	const own: Partial<Record<FileKind, string>> = { document: extra.document, audio: extra.audio };
	const kinds = KIND_WORD.map(([k, re]): [FileKind, RegExp] => [k, new RegExp(`${re.source}${own[k] ?? ""}`, re.flags)]);
	const any = kinds.map(([, re]) => re.source).join("|");
	return { kinds, file: new RegExp(`${any}|파일|자료|첨부`, "i"), kind: new RegExp(any, "gi"), noise: new RegExp(`^(?:${NOISE_WORDS}${extra.document}${extra.audio}${extra.noise})$`, "i") };
});
const NEGATIVE = /못\s*보내|보내\s*(?:드리지|지)\s*못|보내\s*드릴 수 없|보낼 수 없|첨부\s*(?:파일)?\s*(?:은|는|이|가)?\s*(?:없|못|불가)|첨부(?:하지|할 수 없)|\bnot\s+(?:be\s+)?attach|\bno\s+attach/i;
const sentences = (text: string): string[] => text.split(/\n+|(?<=[.!?。])\s+/).map(s => s.trim()).filter(Boolean);
const claims = (sentence: string): boolean => claimsAttachment(sentence.replace(REFERS_BACK, " "));
const SEND_TALK = /보내|보낼|송부|발송|전달|전송|공유|첨부|\b(?:send|sending|attach|attaching|share|forward|email)\b/i;
const IF = /(?:주시|하시|보시|되시|으시|시|으)면\s(?!\s*(?:좋[은을]|괜찮[은을]|도움\s*(?:이\s*)?될))|\b(?:if|once)\b/i;
const LATER = /나중|따로|별도로|내일|추후|다음에|이따|\b(?:later|separately|afterwards?|next time)\b/i;
const FUTURE = /겠|[릴낼줄]\s*게|[릴낼]\s*께|예정|\bwill\b|'ll\b|\bgoing to\b|\bplan to\b/i;
const PAST = /(?:했|드렸|보냈|하였)(?:습니다|어요|으니|고)|\b(?:sent|attached|enclosed|I've|I have)\b/i;
const ASKS_TO_SEND = /(?:보내|보낼|공유|전달|전송|발송|송부|첨부)\s*(?:해\s*)?(?:주|달|줘)|\b(?:send|share|forward|attach)\s+(?:me|us)\b/gi;
const putsOff = (s: string): boolean => {
	if (!SEND_TALK.test(s) || PAST.test(s)) return false;
	const sendAt = s.replace(ASKS_TO_SEND, m => " ".repeat(m.length)).search(SEND_TALK), ifAt = s.search(IF);
	return (ifAt >= 0 && (sendAt < 0 || ifAt < sendAt)) || (LATER.test(s) && FUTURE.test(s));
};
const SALES_NOTICE = /판매\s*(?:중|하고\s*있|합니다|됩니다|처)/;
const holdsNothing = (s: string): boolean => NEGATIVE.test(s) || (SALES_NOTICE.test(s) && !CLAIM.test(s)) || putsOff(s);
const promises = (text: string): string[] => sentences(text).filter(s => claims(s) && !holdsNothing(s));
/** The one reading of "this draft promises a file" the send gate uses; the card's warning asks it too, so card and gate agree. */
export const promisesAttachment = (subject: string | undefined, body: string): boolean => promises(ownClaimText(subject, body)).length > 0;
const DECLINES = /판매\s*(?:중|하고\s*있|합니다|됩니다|처)|https?:\/\/|링크|(?:제공|공유|발송|전달)[^.\n]{0,10}(?:어렵|어려|불가|하지\s*않|못\s*하|할 수 없)/i;
const kindsIn = (text: string): Set<FileKind> => new Set(words().kinds.filter(([, re]) => re.test(text)).map(([k]) => k));
const kindOf = (name: string): FileKind | undefined => KIND_EXT.find(([, re]) => re.test(name))?.[0];
const labels = (kinds: Iterable<FileKind>) => [...kinds].map(k => KIND_LABEL[k]).join("·");

// The words that say which kind of file, not which work: a mail's "음원" or "문서" matches every file of that kind in a library.
export const withoutKindWords = (text: string): string => text.replace(words().kind, " ");

// What the received mail itself asks for: sentences that ask, above any quote of an earlier mail. "문서를 구입했어요. 음원 부탁드립니다" asks for the audio alone.
const ASKED = /부탁|주세요|주시|요청|신청|받을 수|받고 싶|\b(?:please|could you|can you)\b/i;
export const ownWords = (text: string): string => text.split(/-{3,}\s*Original Message/i)[0]!.split("\n").filter(l => !l.trimStart().startsWith(">")).join("\n");
const SENDER_ATTACHED = /첨부(?:한|하여|해\s*드린|드린|된|했)|\b(?:attached|enclosed)\b/i;
const askedKinds = (request: string): Set<FileKind> => kindsIn(sentences(ownWords(request)).filter(s => ASKED.test(s) && !(SENDER_ATTACHED.test(s) && !SEND_ASKED.test(s))).join("\n"));
const SEND_ASKED = /보내\s*(?:주|줘|달)|송부\s*(?:를\s*)?(?:부탁|요청|바랍|해\s*주)|(?:전달|공유|발송|전송|첨부)\s*(?:을\s*)?(?:부탁|해\s*주|해\s*줘|바랍)|받을 수|받고 싶|\b(?:please|kindly|could you|can you|would you|will you)\s+(?:\w+\s+)?(?:send|share|forward)\b|\b(?:send|share|forward)\s+(?:me|us)\b/i;
const sendAskedKinds = (request: string): Set<FileKind> => kindsIn(sentences(ownWords(request)).filter(s => SEND_ASKED.test(s)).join("\n"));

// "1탄, 2탄, 3탄", "1,2,3부": the numbered parts a sentence names. Names do not always carry the number, so parts are compared with a count of files, per kind.
const PART = /(\d+(?:\s*[,.·]\s*\d+)*)\s*(탄|부|권|편)/g;
const partsIn = (text: string): string[] => [...new Set([...text.matchAll(PART)].flatMap(m => m[1]!.split(/[,.·]/).map(n => `${n.trim()}${m[2]}`)))];

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
// Words that say "a file" or how it was marked: they tie a file to nothing.
const nameWords = (name: string): string[] => {
	const { noise } = words();
	return name.normalize("NFC").replace(/\.[^.]+$/, "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/([가-힣])([A-Za-z])|([A-Za-z])([가-힣])/g, "$1$3 $2$4").split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2 && !noise.test(w));
};
/** A Korean word carries particles ("달빛정원을", "나나미의"): the word, or the word without its last one or two letters. */
export function wordVariants(word: string): string[] {
	const v = [word];
	if (/[가-힣]$/.test(word)) for (const cut of [1, 2]) if (word.length - cut >= 2) v.push(word.slice(0, -cut));
	return v;
}
// A short word several of the files share (an author's name) tells none of them apart; a longer shared one is the title they have in common.
const SHARED_TITLE_MIN = 4;
const LATIN_TITLE = /^[a-z]{4,}$/;
// What a name adds to a title without being another work: the same work as instrumental, score or lyrics.
const VARIANT_WORD = /^(?:inst|instrumental|karaoke|score|lyrics|가사)$/;
const letters = (words: string[]) => words.join("").length;
function offTopic(files: readonly string[], text: string, raw: string): string[] {
	const words = files.map(f => [...new Set(nameWords(f).map(norm))]);
	const seen = words.flat();
	// A short shared abbreviation the draft says on its own ("MR") is the thing it sends, not a name that happens to match.
	const said = (w: string) => /^[a-z]{2,3}$/.test(w) && new RegExp(`(?:^|[^A-Za-z0-9])${w.toUpperCase()}(?:[^A-Za-z0-9]|$)`).test(raw);
	const telling = (w: string) => w.length >= SHARED_TITLE_MIN || seen.indexOf(w) === seen.lastIndexOf(w) || said(w);
	const says = (w: string) => wordVariants(w).some(v => v.length >= 2 && text.includes(v));
	// Several short words the files share and the draft says ("김철수 바람결") are the title they have in common, as one long word is; one alone (an author's name) is not.
	const sharedTitle = (i: number) => {
		const shared = words[i]!.filter(w => !telling(w) && says(w));
		return shared.length >= 2 && letters(shared) >= SHARED_TITLE_MIN;
	};
	const onTopic = (i: number) => words[i]!.some(w => telling(w) && says(w)) || sharedTitle(i);
	// A file with no telling word but variant markers ("달빛 inst", or just "달빛" once the install's noise words are dropped) is that work: judged by its short shared title, if the draft says it. Another work by the same author ("홍길동 새벽") has a telling word of its own, so it is not.
	const byTitle = (i: number) => {
		const own = words[i]!.filter(telling);
		return own.every(w => VARIANT_WORD.test(w)) && words[i]!.some(w => !telling(w) && says(w));
	};
	// A title in another script ("Comet" for "혜성") is known from a file of that work that carries both.
	const titles = new Set(words.flatMap((w, i) => (onTopic(i) ? w.filter(x => LATIN_TITLE.test(x)) : [])));
	return files.filter((_, i) => !onTopic(i) && !byTitle(i) && !words[i]!.some(w => titles.has(w)));
}

// The words of a name that say which file it is: "노래 음원 (1).mp3" and "노래 음원 (2).mp3" share all of theirs and are one file twice, "alpha song" and "beta song"
// too few. A date or a version ("26.10.22") tells nothing; a numbered word one side lacks ("1탄", "2탄") is a part of a series, a different file.
const fileWords = (name: string) => [...new Set(nameWords(name).map(norm))].filter(w => !/^\d+$/.test(w));
const numberedOnly = (a: string[], b: string[]) => a.some(w => /\d/.test(w) && !b.includes(w));
// "곡 - 파트A.pdf" and "곡 - 파트B.pdf": what follows the last " - " names the file; no word of it in common is two files of one title.
const tailWords = (name: string) => fileWords(name.replace(/\.[^.]+$/, "").split(/\s[-–—]\s/).slice(1).at(-1) ?? "");
const otherTail = (a: string, b: string) => {
	const x = tailWords(a), y = tailWords(b);
	return x.length > 0 && y.length > 0 && !x.some(w => y.includes(w));
};
const VARIANT_MIN = 4, VARIANT_SHARE = 0.6;
// One document as pdf and hwpx is two formats sent on purpose, not two cuts: only files of one format are compared.
const formatOf = (name: string) => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
function cutsOfOneFile(files: readonly string[]): string[] {
	const out = new Set<string>();
	files.forEach((a, i) => files.slice(i + 1).forEach(b => {
		if (formatOf(a) !== formatOf(b)) return;
		const x = fileWords(a), y = fileWords(b), both = letters(x.filter(w => y.includes(w)));
		if (numberedOnly(x, y) || numberedOnly(y, x) || otherTail(a, b)) return;
		if (both >= VARIANT_MIN && both >= VARIANT_SHARE * Math.min(letters(x), letters(y))) out.add(a).add(b);
	}));
	return [...out];
}

const GENERIC_FILE_WORD = /^(?:scan|scanned|scanner|img|image|images|photo|photos|pic|picture|dsc|dscn|screenshot|screen|shot|capture|doc|docs|document|file|untitled|attachment|download|copy|new|스캔|스캔본|스크린샷|사진|이미지|문서|파일|무제|캡처|사본|복사본|카카오톡|kakaotalk)$/;
const genericName = (name: string): boolean => nameWords(name).map(norm).filter(w => !/^\d+$/.test(w)).every(w => GENERIC_FILE_WORD.test(w));

const SUBJECT_PREFIX = /^(?:\s*(?:\[[^\]]*\]|(?:re|fw|fwd|답장|회신|전달)\s*:))+\s*/i;
const GREETING = /안녕하세요(?:[^\n.!?]*?님)?|\b(?:dear|hello|hi)\b[^\n,.!?]*[,.!?]?/gi;
const GENERIC_STEM = /^(?:안녕|감사|고맙|보내|보낼|드립|드리|드려|요청|자료|첨부|확인|문의|댓글|부족|말씀|편하게|바랍|부탁|회신|답장|메일|파일|연락|죄송|수고|혹시|다시|그럼|관련|내용|아래|함께|주세요|주시|해주|있으면|있으시|이번|제가|저는|저희|다른|어떤|해당|새로운|여러|모든)/;
const GENERIC_END = /(?:님|입니다|이에요|예요|올림|드림|합니다|니다)$/;
const GENERIC_ENGLISH = /^(?:the|and|for|you|your|with|please|find|attached|attach|attachment|thanks|thank|regards|best|sincerely|request|requested|sent|send|sending|here|are|let|know|have|any|questions|question|this|that|will|can|could|would|kind|hope|well|team|again|per|fw|fwd|file|files|document|documents|material|materials)$/;
function namesTopic(subject: string | undefined, body: string, request: string): boolean {
	const topicWords = (text: string, minLength: number) => withoutKindWords(text).replace(GREETING, " ").normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u)
		.filter(w => w.length >= minLength && !/^\d+$/.test(w) && !words().noise.test(w) && !GENERIC_STEM.test(w) && !GENERIC_END.test(w) && !GENERIC_ENGLISH.test(w));
	return topicWords(`${(subject ?? "").replace(SUBJECT_PREFIX, "")}\n${request}`, 2).length > 0 || topicWords(body, 3).length > 0;
}

export function attachIssues(d: AttachCheck): AttachIssue[] {
	// When the mail asked for a file, "모두 보내드리겠습니다" is about that file whether or not the sentence says so.
	const asked = d.request === undefined ? new Set<FileKind>() : askedKinds(`${d.subject ?? ""}\n${d.request}`);
	const claimText = ownClaimText(d.subject, d.body);
	const said = asked.size ? sentences(claimText).filter(s => (claims(s) || (SENDS_VERB.test(s) && !NON_FILE_SEND.test(s))) && !holdsNothing(s)) : promises(claimText);
	const promised = kindsIn(said.join("\n"));
	const has = new Set(d.files.flatMap(f => kindOf(f) ?? []));
	if (!d.files.length) {
		if (said.length) return [{ kind: "missing", text: `본문에 ${promised.size ? `${labels(promised)} ` : ""}파일을 보낸다고 썼지만 첨부파일이 없어요` }];
		const wanted = d.request === undefined ? new Set<FileKind>() : sendAskedKinds(d.request);
		return wanted.size && !sentences(d.body).some(s => NEGATIVE.test(s) || DECLINES.test(s) || putsOff(s)) ? [{ kind: "skipped", text: `받은 메일이 요청한 ${labels(wanted)} 파일이 안 붙었어요` }] : [];
	}
	const out: AttachIssue[] = [];
	const short = [...promised].filter(k => !has.has(k));
	if (short.length) out.push({ kind: "partial", text: `본문에 쓴 ${labels(short)} 파일이 안 붙었어요` });
	const parts = partsIn(said.join("\n"));
	const perKind = Math.max(...[...has].map(k => d.files.filter(f => kindOf(f) === k).length), 0);
	if (parts.length > perKind) out.push({ kind: "partial", text: `본문에 쓴 ${parts.join(", ")}보다 붙은 파일이 적어요` });
	const mentioned = kindsIn(d.body);
	const skipped = [...asked].filter(k => !has.has(k) && !mentioned.has(k));
	if (skipped.length) out.push({ kind: "partial", text: `받은 메일이 요청한 ${labels(skipped)} 파일이 안 붙었어요` });
	if (promised.size) {
		const asked = kindsIn(d.request ?? "");
		const over = [...has].filter(k => !promised.has(k) && !asked.has(k));
		if (over.length) out.push({ kind: "extra", text: `본문에도 받은 메일에도 없는 ${labels(over)} 파일이 붙었어요` });
	}
	const request = d.request === undefined ? "" : ownWords(d.request);
	const draftWords = `${d.subject ?? ""}\n${d.body}\n${request}`;
	const off = offTopic(d.files, norm(draftWords), draftWords);
	const unrelated = off.length < d.files.length ? off : namesTopic(d.subject, d.body, request) ? off.filter(f => !genericName(f)) : [];
	if (unrelated.length) out.push({ kind: "unrelated", text: `본문과 상관없어 보이는 파일이 있어요: ${unrelated.join(", ")}` });
	const cuts = cutsOfOneFile(d.files);
	if (cuts.length) out.push({ kind: "variants", text: `같은 파일의 다른 판이 함께 붙었어요: ${cuts.join(", ")}` });
	return out;
}
