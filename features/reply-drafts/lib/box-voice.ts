// One learned voice per mailbox (docs/mailbox.md "Voice"): an account with mailboxes learns each one apart, only from what the owner himself wrote in it. The replies are the
// stored pairs (lib/pairs.ts), so learning reads no mail; hub/routes-mailbox.ts pastPass says which mailbox each sits in, read fresh, so a move or an undo rewrites nothing.
// The newest VOICE_MAX of a mailbox go into one model call, once, and again only when many of them changed; a mailbox with fewer than VOICE_MIN keeps the account's voice, and says so
// (voiceOf: the 말투 item of the mailbox settings, onboard.ts status). The result is the mailbox's tone file tone/<instance>/<box>.md, which a draft already reads (flow.ts toneKey);
// its own 고친 점 and hand-written sections stay, and a mailbox's 기본 지시 still goes over the voice (box.ts boxLines).
import { existsSync, readFileSync } from "node:fs";
import { boxesOf, loadMailboxes, type Box } from "../../../hub/mailbox.ts";
import type { ModelCall } from "../../../hub/reply-draft.ts";
import { pastPass } from "../../../hub/routes-mailbox.ts";
import { defaultCall } from "./flow.ts";
import { analyzeTone, backupTone, corpusFile, corpusOf } from "./persona.ts";
import { dataDir, HEADINGS, hasSamples, identityOf, isTuned, loadPairs, loadSettings, markLearned, normText, paths, readLearned, templatesOf, type Pair, type ToneKey, writeAtomic, writeSections } from "./settings.ts";
import { listDrafts } from "./store.ts";
import { pickExamples, realRunner, refreshPairs, SWEEP_LIMIT } from "./tone.ts";

export const VOICE_MIN = 20; // fewer replies than this show the mail they answered, not how he writes there: the account's voice is the better guess
export const VOICE_MAX = SWEEP_LIMIT; // the same newest batch the account's own sweep reads
const PER_PASS = 3; // a first pass over many mailboxes is spread over the next mails
const RETRY_MS = 24 * 60 * 60 * 1000;
const EXAMPLES_SHOWN = 5;

type Learned = { at: string; texts: number; seen: string[] };
/** single: one mailbox, the account's voice as ever. few / ready: the account's voice for now, too few replies / enough, waiting for its turn. own: learned here. kept: a voice this file already had, never rewritten by itself. */
export type Voice = { state: "single" | "few" | "ready" | "own" | "kept"; count: number; need: number; at?: string; texts?: number };

function readVoices(): Record<string, Learned> {
	if (!existsSync(paths.voices())) return {};
	try {
		return JSON.parse(readFileSync(paths.voices(), "utf8")) ?? {};
	} catch (e) {
		console.error(`reply draft: ${paths.voices()} unreadable: ${(e as Error).message}`);
		return {};
	}
}
const keyOf = (instance: string, box: string): ToneKey => ({ app: instance, room: box });
const idOf = (instance: string, box: string): string => `${instance}/${box}`;
const seenOf = (p: Pair): string => Bun.hash(normText(p.reply)).toString(36);
// A short draft body ("네, 감사합니다") must not take every reply that opens the same way.
const isOurs = (text: string, ours: string[]): boolean => ours.some(o => text === o || (o.length >= 40 && text.startsWith(o)));
// What the sweep reads (persona.ts corpusOf): his words, then what they answered as a quote.
const asText = (p: Pair): string => `${p.reply}\n${p.received.split("\n").map(l => `> ${l}`).join("\n")}`;

/** His own replies of an account by mailbox, newest first. Not his words, so left out: a sent draft of ours, also one he only asked to change, and a pair marked edited. */
export function ownPairs(instance: string): Map<string, Pair[]> {
	const place = pastPass(dataDir(), instance), out = new Map<string, Pair[]>(), all = loadPairs("mail"), learned = new Map<string, string>();
	for (const [id, v] of Object.entries(readVoices())) if (id.startsWith(`${instance}/`)) for (const s of v.seen) learned.set(s, id.slice(instance.length + 1));
	const ours = [...listDrafts().filter(d => d.status === "sent").map(d => d.body), ...all.filter(p => p.edited).map(p => p.reply)].map(normText).filter(Boolean);
	for (const p of all.sort((a, b) => b.at - a.at)) {
		const box = isOurs(normText(p.reply), ours) ? undefined : place({ ...p, source: p.source ?? "zele" }, learned.get(seenOf(p)));
		if (box) (out.get(box) ?? out.set(box, []).get(box)!).push(p);
	}
	return out;
}

/** A mailbox's own replies for a draft's examples; undefined below VOICE_MIN, so the draft takes the account's as ever. */
export function boxExamples(instance: string, box: string): Pair[] | undefined {
	const mine = ownPairs(instance).get(box);
	return mine && mine.length >= VOICE_MIN ? mine : undefined;
}

export function voiceOf(instance: string, box: string): Voice {
	if (boxesOf(dataDir(), instance).length < 2) return { state: "single", count: 0, need: VOICE_MIN };
	const count = ownPairs(instance).get(box)?.length ?? 0, had = readVoices()[idOf(instance, box)];
	const state = had ? "own" : identityOf(keyOf(instance, box)).length ? "kept" : count < VOICE_MIN ? "few" : "ready";
	return { state, count, need: VOICE_MIN, ...(had ? { at: had.at, texts: had.texts } : {}) };
}

export const voiceExamples = (instance: string, box: string): { received: string; reply: string }[] =>
	(ownPairs(instance).get(box) ?? []).slice(0, EXAMPLES_SHOWN).map(p => ({ received: p.received.slice(0, 400), reply: p.reply.slice(0, 1200) }));

const busy = new Set<string>();
export type Learn = "learned" | "few" | "empty" | "busy";

/** One model call over the newest VOICE_MAX replies of a mailbox. The file is copied first; 고친 점 and sections he wrote stay, and a first learning keeps the 답장 틀 and 예시 a file already had. */
export async function learnBox(instance: string, box: Box, call: ModelCall, now = new Date(), mine = ownPairs(instance).get(box.id) ?? []): Promise<Learn> {
	const id = idOf(instance, box.id), key = keyOf(instance, box.id);
	if (mine.length < VOICE_MIN) return "few";
	if (busy.has(id)) return "busy";
	busy.add(id);
	try {
		const used = mine.slice(0, VOICE_MAX), texts = used.map(asText);
		const a = await analyzeTone(texts, `메일함 "${box.name}"에서 보낸 메일`, call);
		if (!a.identity.length) return "empty";
		const had = !!readVoices()[id], examples = pickExamples(texts);
		backupTone(key, now);
		const sections: [string, string[]][] = [[HEADINGS.identity, a.identity]];
		if (had || !templatesOf(key).length) sections.push([HEADINGS.templates, a.templates]);
		if (examples.length && (had || !hasSamples(key))) sections.push([HEADINGS.samples, examples]);
		writeSections(key, sections);
		writeAtomic(corpusFile(key), `${corpusOf(texts)}\n`);
		writeAtomic(paths.voices(), `${JSON.stringify({ ...readVoices(), [id]: { at: now.toISOString(), texts: used.length, seen: used.map(seenOf) } })}\n`);
		return "learned";
	} finally {
		busy.delete(id);
	}
}

// A mailbox that fell under VOICE_MIN (mail moved out) goes back to the account's voice: what was learned leaves, 고친 점 and his sections stay.
function forget(instance: string, box: string, now: Date): void {
	const key = keyOf(instance, box), { [idOf(instance, box)]: _gone, ...rest } = readVoices();
	backupTone(key, now);
	writeSections(key, [[HEADINGS.identity, []], [HEADINGS.templates, []], [HEADINGS.samples, []]]);
	writeAtomic(paths.voices(), `${JSON.stringify(rest)}\n`);
}

// Learned again only when many of the newest replies are not the ones learned from, and never over his corrections or sections (persona.ts learnFirst: 다시 배우기 can). A move and its undo cancel out.
function stale(instance: string, box: string, mine: Pair[], had: Learned | undefined): boolean {
	const key = keyOf(instance, box);
	if (!had) return !identityOf(key).length;
	if (isTuned(key)) return false;
	const now = new Set(mine.slice(0, VOICE_MAX).map(seenOf)), then = new Set(had.seen);
	return Math.max([...now].filter(s => !then.has(s)).length, [...then].filter(s => !now.has(s)).length) >= Math.max(VOICE_MIN, then.size / 4);
}

/** Beside the pair refresh of a draft (offer.ts): costs no model call unless a mailbox is due, a mailbox tries at most once a day, and an account with one mailbox does nothing. */
export async function refreshVoices(instance: string, call: ModelCall, log: (line: string) => void = console.error, now = new Date()): Promise<void> {
	const boxes = boxesOf(dataDir(), instance);
	if (boxes.length < 2) return;
	const own = ownPairs(instance), voices = readVoices(), tried = readLearned();
	let left = PER_PASS;
	for (const box of boxes) {
		const mine = own.get(box.id) ?? [], id = idOf(instance, box.id), had = voices[id], mark = `${id}@box~tried`;
		if (mine.length < VOICE_MIN) {
			if (had) forget(instance, box.id, now);
			continue;
		}
		if (!left || !stale(instance, box.id, mine, had) || now.getTime() - Date.parse(tried[mark] ?? "") < RETRY_MS) continue;
		left--;
		markLearned([mark], now);
		await learnBox(instance, box, call, now, mine).catch(e => log(`reply draft: voice of mailbox ${id} not learned: ${(e as Error).message}`));
	}
}

/** 다시 배우기: learned now when the mailbox has enough; with too few, the sent folder is read in the background and learning follows without him. */
export async function relearnBox(instance: string, box: Box, call: ModelCall = defaultCall(loadSettings().model), refresh: () => Promise<void> = () => refreshPairs(realRunner)): Promise<{ result: Learn; voice: Voice }> {
	const result = await learnBox(instance, box, call);
	if (result === "few") void refresh().then(() => refreshVoices(instance, call)).catch(e => console.error(`reply draft: sent mail of mailbox ${idOf(instance, box.id)} not read: ${(e as Error).message}`));
	return { result, voice: voiceOf(instance, box.id) };
}

/** One mailbox's line for setup and status. */
export function voiceLine(instance: string, b: Box): string {
	const v = voiceOf(instance, b.id);
	return `메일함 ${b.name}: ${v.state === "own" ? `보낸 글 ${v.texts}개로 따로 배웠어요` : v.state === "kept" ? "따로 적어 둔 말투를 써요" : v.state === "ready" ? `보낸 글 ${v.count}개가 모여 곧 따로 배워요. 지금은 계정 말투예요` : `보낸 글이 ${v.count}개라 계정 말투를 써요 (${v.need}개부터 따로 배워요)`}`;
}

/** Setup and status: a line per mailbox, so one on the account's voice says so. */
export function voiceLines(): string[] {
	return Object.keys(loadMailboxes(dataDir()).accounts).flatMap(instance => {
		const boxes = boxesOf(dataDir(), instance);
		return boxes.length < 2 ? [] : boxes.map(b => voiceLine(instance, b));
	});
}

/** Setup: every account's mailboxes learned once, then the lines above. */
export async function learnVoices(call: ModelCall): Promise<string[]> {
	for (const instance of Object.keys(loadMailboxes(dataDir()).accounts)) await refreshVoices(instance, call);
	return voiceLines();
}
