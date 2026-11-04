// Does what a mail draft says it sends match the files on it? The check behind the send gate (features/reply-drafts/lib/flow.ts sendDraft) and the card's
// `첨부 확인` line. Plain code over the draft's words and file names: no model, no fs, no config, so it runs on every card read and right before every send.
// It knows kinds of files, never particular ones: a draft that promises a file and has none, promises a kind it does not carry, carries a kind nobody
// promised or asked for, carries files the draft has nothing to do with, or carries several cuts of one file.
export type AttachIssueKind = "missing" | "partial" | "extra" | "unrelated" | "variants";
export type AttachIssue = { kind: AttachIssueKind; text: string };
export type AttachCheck = { subject?: string; body: string; files: readonly string[]; /** What the draft answers; a kind asked for here is not "extra". Absent for a new mail. */ request?: string };

type FileKind = "audio" | "document" | "image" | "video";
const KIND_LABEL: Record<FileKind, string> = { audio: "음원", document: "문서·문서", image: "이미지", video: "영상" };
const KIND_EXT: [FileKind, RegExp][] = [
	["audio", /\.(?:mp3|wav|m4a|aac|flac|ogg|aiff?)$/i],
	["document", /\.(?:pdf|hwpx?|docx?|xlsx?|pptx?|txt|csv|zip)$/i],
	["image", /\.(?:png|jpe?g|gif|heic|webp)$/i],
	["video", /\.(?:mp4|mov|m4v|webm|avi)$/i],
];
const KIND_WORD: [FileKind, RegExp][] = [
	["audio", /(?:^|[^a-z])(?:mr|mp3|wav)(?:[^a-z]|$)|음원|음원|녹음\s*파일/i],
	["document", /문서|보고서|전체본|pdf|문서|서류|견적서|청구서|계약서|제안서|보고서|이력서|양식|서식|신청서|스캔본/i],
	["image", /사진|이미지/],
	["video", /영상\s*파일|동영상/],
];
const FILE_WORD = new RegExp(`${KIND_WORD.map(([, re]) => re.source).join("|")}|파일|자료|첨부`, "i");
// A promise made now. "보내드리겠습니다" counts unless it waits on the reader ("곡을 알려 주시면 보내드리겠습니다"); "보내드린 문서는 ..." only refers back.
const SEND_NOW = /보내\s*드(?:립니다|려요|릴게요|릴께요|리겠습니다)|보냅니다|보낼게요|첨부\s*(?:합니다|해요|드립니다|드려요|드릴게요|해\s*드립니다|해\s*드려요|해\s*드릴게요)|\b(?:attached|attaching|I'm sending|I am sending)\b/i;
const NOT_NOW = /(?:주시|하시|보시|되시|으시|시|으)면\s|못\s*보내|보내\s*(?:드리지|지)\s*못|보내\s*드릴 수 없|보낼 수 없|첨부\s*(?:파일)?\s*(?:은|는|이|가)?\s*(?:없|못|불가)|첨부(?:하지|할 수 없)|\bnot\s+attach|\bno\s+attach|판매/i;
const sentences = (text: string): string[] => text.split(/\n+|(?<=[.!?。])\s+/).map(s => s.trim()).filter(Boolean);
const promises = (text: string): string[] => sentences(text).filter(s => SEND_NOW.test(s) && FILE_WORD.test(s) && !NOT_NOW.test(s));
const kindsIn = (text: string): Set<FileKind> => new Set(KIND_WORD.filter(([, re]) => re.test(text)).map(([k]) => k));
const kindOf = (name: string): FileKind | undefined => KIND_EXT.find(([, re]) => re.test(name))?.[0];
const labels = (kinds: Iterable<FileKind>) => [...kinds].map(k => KIND_LABEL[k]).join("·");

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
// Words that say "a file" or how it was marked: they tie a file to nothing.
const NOISE = /^(?:문서|문서집|보고서|전체본|파일|자료|문서|부분|전체|공유|공유용|회의|독서|정기|정기회의|회의실|보조|요약|버전|ver|mr|full|pdf|mp3|wav)$/i;
const nameWords = (name: string): string[] => name.normalize("NFC").replace(/\.[^.]+$/, "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/([가-힣])([A-Za-z])|([A-Za-z])([가-힣])/g, "$1$3 $2$4").split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2 && !NOISE.test(w));
/** A Korean word carries particles ("달빛정원을", "나나미의"): the word, or the word without its last one or two letters. */
export function wordVariants(word: string): string[] {
	const v = [word];
	if (/[가-힣]$/.test(word)) for (const cut of [1, 2]) if (word.length - cut >= 2) v.push(word.slice(0, -cut));
	return v;
}
// A short word several of the files share (an author's name) tells none of them apart; a longer shared one is the title they have in common.
const SHARED_TITLE_MIN = 4;
function offTopic(files: readonly string[], text: string): string[] {
	const words = files.map(f => [...new Set(nameWords(f).map(norm))]);
	const seen = words.flat();
	const telling = (w: string) => w.length >= SHARED_TITLE_MIN || seen.indexOf(w) === seen.lastIndexOf(w);
	return files.filter((_, i) => !words[i]!.some(w => telling(w) && wordVariants(w).some(v => v.length >= 2 && text.includes(v))));
}

// What is left of a name once marks, brackets and digits are gone: "노래 MR (1).mp3" and "노래 MR (2).mp3" are one file twice.
const stem = (name: string) => norm(name.replace(/\.[^.]+$/, "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ")).replace(/\d+/g, "");
function sharedRun(a: string, b: string): number {
	let best = 0;
	for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
		let n = 0;
		while (i + n < a.length && j + n < b.length && a[i + n] === b[j + n]) n++;
		best = Math.max(best, n);
	}
	return best;
}
const VARIANT_MIN = 4, VARIANT_SHARE = 0.6;
function cutsOfOneFile(files: readonly string[]): string[] {
	const out = new Set<string>();
	files.forEach((a, i) => files.slice(i + 1).forEach(b => {
		if (kindOf(a) !== kindOf(b)) return;
		const x = stem(a), y = stem(b), run = sharedRun(x, y);
		if (run >= VARIANT_MIN && run >= VARIANT_SHARE * Math.min(x.length, y.length)) out.add(a).add(b);
	}));
	return [...out];
}

export function attachIssues(d: AttachCheck): AttachIssue[] {
	const said = promises(`${d.body}`);
	const promised = kindsIn(said.join("\n"));
	const has = new Set(d.files.flatMap(f => kindOf(f) ?? []));
	if (!d.files.length) return said.length ? [{ kind: "missing", text: `본문에 ${promised.size ? `${labels(promised)} ` : ""}파일을 보낸다고 썼지만 첨부파일이 없어요` }] : [];
	const out: AttachIssue[] = [];
	const short = [...promised].filter(k => !has.has(k));
	if (short.length) out.push({ kind: "partial", text: `본문에 쓴 ${labels(short)} 파일이 안 붙었어요` });
	if (promised.size) {
		const asked = kindsIn(d.request ?? "");
		const over = [...has].filter(k => !promised.has(k) && !asked.has(k));
		if (over.length) out.push({ kind: "extra", text: `본문에도 받은 메일에도 없는 ${labels(over)} 파일이 붙었어요` });
	}
	const text = norm(`${d.subject ?? ""}\n${d.body}`);
	const off = offTopic(d.files, text);
	if (off.length && off.length < d.files.length) out.push({ kind: "unrelated", text: `본문과 상관없어 보이는 파일이 있어요: ${off.join(", ")}` });
	const cuts = cutsOfOneFile(d.files);
	if (cuts.length) out.push({ kind: "variants", text: `같은 파일의 다른 판이 함께 붙었어요: ${cuts.join(", ")}` });
	return out;
}
