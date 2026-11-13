// Learning the user's tone: the user's own sent texts -> sentences of 3-120 characters, quoted history and signatures dropped,
// deduped, at most 40 -> the "## 예시" section of ONE tone profile (settings.ts: install, app or app+room). The sources are injected
// (a command runner for the sent-mail reader, a file, ready-made texts such as one messenger room's own lines), so tests never touch mail.
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addressesOf, AUTOMATED } from "../../../hub/reply-draft.ts";
import { SIDE_MAX } from "../../../hub/comments/past.ts";
import { readAppsFile } from "../../../hub/integrations.ts";
import { hasBoxes } from "../../../hub/mailbox.ts";
import { loadPlugins, pluginsLoaded, pluginSentMail } from "../../../hub/plugins.ts";
import { dataDir, loadPairs, markLearned, MAX_PAIRS, normText, type Pair, paths, readLearned, savePairs, writeExamples, type ToneKey } from "./settings.ts";
import { listDrafts } from "./store.ts";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (argv: string[], ms?: number) => Promise<RunResult>;

/** One mail of the owner's sent folder as a mail site or a plugin hands it over (webmail-no-api mail.ts `sent`, a plugin's `sentMail`). `to`: the receivers; `at`: epoch ms; `received`: the message it answered, when the source knows it (else read from the quote in `body`). */
export type SentMail = { to?: string; subject?: string; at: number; body: string; received?: string; /** The conversation id, when the source has one: an owner's move of that conversation then reaches this mail (lib/box-voice.ts). */ id?: string };

export const MAX_EXAMPLES = 40;
export const SWEEP_LIMIT = 200; // sent texts the first sweep reads for the identity (persona.ts)
const MIN_LEN = 3;
const MAX_LEN = 120;

export const realRunner: Runner = async (argv, ms = 90_000) => {
	const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const t = setTimeout(() => p.kill("SIGKILL"), ms);
	const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	const code = await p.exited;
	clearTimeout(t);
	return { code, stdout, stderr };
};

const HEADER = /^\s*(from|to|cc|bcc|subject|date|id|account|labels|thread|snippet)\s*:/i;
const HISTORY = [
	/^\s*on .{3,200}wrote:\s*$/i,
	/^\s*-{2,}\s*(original|forwarded)\b/i,
	/^\s*-{2,}\s*(원본\s*(메일|메시지)|전달된\s*메일)/,
	/^\s*_{5,}\s*$/,
	/^\s*(보낸\s*사람|From)\s*:/i,
	/^\s*.{0,80}님이.{0,80}작성/,
	/^\s*\d{4}년\s*\d{1,2}월\s*\d{1,2}일.{0,120}(님이|<\S+@\S+>)\s*$/, // a mail client's quote header wrapped over two lines
	/^\s*-- ?$/,
	/^\s*sent from my\b/i,
];

// The user's own words of one mail: header lines at the top, quoted lines, and everything after a quoted-history or signature marker are dropped.
export function ownText(mail: string): string {
	const lines = mail.replace(/\r\n?/g, "\n").split("\n");
	let i = 0;
	while (i < lines.length && (HEADER.test(lines[i]!) || !lines[i]!.trim())) i++;
	const out: string[] = [];
	for (const line of lines.slice(i)) {
		if (HISTORY.some(r => r.test(line))) break;
		if (/^\s*>/.test(line)) continue;
		out.push(line);
	}
	return out.join("\n");
}

// What the user's mail answered: the quoted lines and the history after the first marker (the reply's context for the identity sweep).
export function quotedText(mail: string): string {
	const lines = mail.replace(/\r\n?/g, "\n").split("\n");
	const at = lines.findIndex((l, i) => i > 0 && HISTORY.some(r => r.test(l)));
	const after = at < 0 ? [] : lines.slice(at + 1);
	return [...lines.filter(l => /^\s*>/.test(l)), ...after].map(l => l.replace(/^\s*>+\s?/, "")).join("\n").trim();
}

export function sentencesOf(text: string): string[] {
	return text
		.split("\n")
		.flatMap(l => l.split(/(?<=[.!?。…])\s+/))
		.map(s => s.replace(/\s+/g, " ").trim())
		.filter(s => s.length >= MIN_LEN && s.length <= MAX_LEN && !/https?:\/\/|\S+@\S+\.\S+/.test(s) && !/^[-=*_#~.\s]+$/.test(s));
}

export function pickExamples(texts: string[], max = MAX_EXAMPLES): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of texts) {
		for (const s of sentencesOf(ownText(t))) {
			const k = s.toLowerCase();
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(s);
			if (out.length >= max) return out;
		}
	}
	return out;
}

const FORWARD = /^\s*[-_=*\s]*(forwarded message|전달된 메일|original message)/i;
const FWD_SUBJECT = /^\s*(fwd?|전달)\s*:/i;

// The user's sent mail through the mail CLI (newest first as it lists them). `zele mail read` prints the whole thread, so only the messages
// whose From is the listed account are the user's words (`texts`); a mail without one falls back to what the read or the snippet gave.
// An own message that answers the nearest earlier message of someone else, sent to that sender, is also kept as a reply pair; forwards,
// automated senders, long texts and bot drafts sent unchanged (`ownerDrafts`: their bodies) are not pairs.
// `account`: one zele account (a mail app names it); without one zele lists every account, and each read uses the listed mail's own account.
export async function sentMail(run: Runner, limit = MAX_EXAMPLES, ownerDrafts: string[] = [], account?: string, enough = Infinity): Promise<{ texts: string[]; pairs: Pair[] }> {
	const listed = await run(["zele", "mail", "list", "--folder", "sent", "--limit", String(limit), ...(account ? ["--account", account] : [])]);
	if (listed.code !== 0) throw new Error(`보낸 메일 목록을 못 읽었어요: ${(listed.stderr || listed.stdout).trim().slice(0, 160)}`);
	const items = ((Bun.YAML.parse(listed.stdout) as { items?: Record<string, unknown>[] } | null)?.items ?? []).slice(0, limit);
	// Loaded on use: hub/zele.ts reads the gateway config when it is imported.
	const { parseThread } = await import("../../../hub/zele.ts");
	const bots = ownerDrafts.map(normText).filter(Boolean); // a bot draft as sent may end in a signature the draft did not have
	// zele names each mail's account only when it lists several: one account leaves the field out, and without an address no thread can be read as the user's.
	const sole = account ?? (items.some(m => !m.account) ? addressesOf((await run(["zele", "whoami"])).stdout)[0] : undefined);
	const texts: string[] = [];
	const pairs: Pair[] = [];
	const now = Date.now();
	for (const [n, m] of items.entries()) {
		if (pairs.length >= enough) break;
		const id = String(m.id ?? "");
		const me = addressesOf(String(m.account ?? sole ?? ""))[0];
		const readAs = account ?? (String(m.account ?? "").trim() || undefined);
		const body = id ? await run(["zele", "mail", "read", id, ...(readAs ? ["--account", readAs] : [])]) : undefined;
		const read = body && body.code === 0 && body.stdout.trim() ? body.stdout : "";
		const thread = me ? parseThread(read) : [];
		const own = (x: { from: string }) => addressesOf(x.from).includes(me!);
		if (!thread.some(own)) {
			const text = read || String(m.snippet ?? "");
			if (text.trim()) texts.push(text);
			continue;
		}
		const paired = new Set<number>();
		for (const [i, msg] of thread.entries()) {
			if (!own(msg)) continue;
			if (msg.body.trim()) texts.push(msg.body);
			const mine = ownText(msg.body).trim();
			if (!mine || mine.length > SIDE_MAX || FORWARD.test(msg.body) || FORWARD.test(mine) || FWD_SUBJECT.test(String(m.subject ?? "")) || bots.some(b => normText(mine).startsWith(b))) continue;
			const at = thread.findLastIndex((x, j) => j < i && !own(x));
			const earlier = thread[at];
			const sender = addressesOf(earlier?.from)[0];
			if (!earlier || !sender || paired.has(at) || !addressesOf(msg.to).includes(sender) || AUTOMATED.test(sender.split("@")[0]!)) continue;
			const received = ownText(earlier.body).trim();
			if (!received) continue;
			paired.add(at);
			const stamp = Date.parse(msg.date);
			pairs.push({ received, reply: mine, at: Number.isFinite(stamp) ? stamp : now - n, from: sender, ...(id ? { conv: id } : {}), ...(m.subject ? { subj: String(m.subject) } : {}), ...(me ? { account: me } : {}) });
		}
	}
	return { texts, pairs };
}

// Reply pairs from a sent folder a site or plugin read: the same rules as sentMail (no forwards, automated receivers, long texts or bot drafts), the answered
// message from `received` or the quote in the body. `source` tags each pair, so a draft of that source is the only one that sees them.
export function sentPairs(items: SentMail[], source: string, ownerDrafts: string[] = []): Pair[] {
	const bots = ownerDrafts.map(normText).filter(Boolean);
	const out: Pair[] = [];
	for (const m of items) {
		const mine = ownText(m.body).trim();
		const received = (m.received ?? quotedText(m.body)).trim();
		const to = addressesOf(m.to)[0];
		if (!mine || !received || mine.length > SIDE_MAX || FORWARD.test(m.body) || FORWARD.test(mine) || FWD_SUBJECT.test(m.subject ?? "") || (to && AUTOMATED.test(to.split("@")[0]!)) || bots.some(b => normText(mine).startsWith(b))) continue;
		out.push({ received, reply: mine, at: m.at, source, ...(to ? { from: to } : {}), ...(m.id ? { conv: m.id } : {}), ...(m.subject ? { subj: m.subject } : {}) });
	}
	return out;
}

// Bodies of the drafts the user sent without changing a word: not his own wording, so they make no pair.
export const botDrafts = (): string[] => listDrafts().filter(d => d.status === "sent" && !d.changes.length).map(d => d.body);

// The sent mail is also kept as reply pairs for the prompt's examples (lib/pairs.ts), merged with the ones already stored.
async function learnSentMail(run: Runner, accounts: (string | undefined)[]): Promise<string[]> {
	const bots = botDrafts();
	const texts: string[] = [];
	const pairs: Pair[] = [];
	for (const account of accounts) {
		const r = await sentMail(run, SWEEP_LIMIT, bots, account);
		texts.push(...r.texts);
		pairs.push(...r.pairs);
	}
	if (pairs.length) savePairs("mail", [...loadPairs("mail"), ...pairs]);
	return texts;
}

// Whether this install's config.json turned zele on (all its accounts are read) and the CLI is here; an installed CLI alone is not enough.
export function zeleEnabled(config: Record<string, any> | undefined): boolean {
	return config?.zele?.enabled === true && !!Bun.which("zele");
}

function installConfig(): Record<string, any> | undefined {
	try {
		return JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8"));
	} catch {
		return undefined;
	}
}

// Where this install's sent mail can be read: every account when config.json turned zele on (`[undefined]`); else, with zele installed, the accounts
// the mail apps of custom/apps.json name (a mail that comes from a watch has no zele switch but zele sends its replies); else nowhere.
export function sentAccounts(config: Record<string, any> | undefined): (string | undefined)[] {
	if (zeleEnabled(config)) {
		const listed = config?.zele?.accounts;
		// Read as hub/zele.ts reads it: the entries that are addresses count, anything else is dropped.
		const only = (Array.isArray(listed) ? listed : []).filter((a): a is string => typeof a === "string").map(a => a.trim()).filter(Boolean);
		return only.length ? only : [undefined];
	}
	if (!Bun.which("zele")) return [];
	// The built-in instance has no `app`: its key is the app.
	const named = Object.entries(readAppsFile(dataDir())).filter(([id, a]) => !a?.deleted && (a?.app ?? id) === "mail").map(([, a]) => a?.filter?.account?.trim());
	return [...new Set(named.filter((a): a is string => !!a))];
}

// The install's sent mail for the identity sweep, from the accounts sentAccounts names.
export async function installSentMail(run: Runner): Promise<string[]> {
	const accounts = sentAccounts(installConfig());
	return accounts.length ? learnSentMail(run, accounts) : [];
}

export const PAIR_SWEEP = 3000; // newest first: past this, closer examples stop paying off for the read it costs
const PAIR_DAILY = 40;
const DAY = 24 * 60 * 60 * 1000;
const WEBMAIL_MAIL = join(import.meta.dir, "..", "..", "webmail-no-api", "bin", "mail.ts");
const SITE_RUN_MS = 30 * 60_000;

// The mail sites of this install whose spec has a sent folder (webmail-no-api onboarding captures it).
export function sentSites(): string[] {
	const dir = join(dataDir(), "custom", "webmail");
	try {
		return readdirSync(dir).filter(site => {
			try {
				return !!JSON.parse(readFileSync(join(dir, site, "spec.json"), "utf8")).sent;
			} catch {
				return false;
			}
		}).sort();
	} catch {
		return [];
	}
}

// The JSON lines of `mail.ts <site> sent`; any other line (a log, a message) is not a mail.
export const parseSent = (stdout: string): SentMail[] =>
	stdout.split("\n").filter(l => l.startsWith("{")).flatMap(l => {
		try {
			const m = JSON.parse(l);
			return typeof m?.body === "string" && typeof m.at === "number" ? [m as SentMail] : [];
		} catch {
			return [];
		}
	});

async function siteSent(run: Runner, site: string, limit: number): Promise<SentMail[]> {
	const r = await run(["bun", WEBMAIL_MAIL, site, "sent", "--limit", String(limit)], SITE_RUN_MS);
	const items = parseSent(r.stdout);
	if (!items.length && r.code !== 0) throw new Error(`${site} sent folder not read: ${(r.stderr || r.stdout).trim().slice(0, 160)}`);
	return items;
}

export type PluginSent = (limit: number | ((plugin: string) => number)) => ReturnType<typeof pluginSentMail>;
const pluginsSent: PluginSent = async limit => {
	if (!pluginsLoaded()) await loadPlugins(dataDir());
	return pluginSentMail(limit);
};

// Keeps the past reply pairs (and who each answered) current, with no model call and no profile change. Each source reads on its own: zele (the accounts
// of sentAccounts), every mail site with a sent folder, every plugin with `sentMail`. The first read of a source takes the newest PAIR_SWEEP (zele stops at MAX_PAIRS pairs), later ones
// at most once a day the newest PAIR_DAILY. The day mark is set before reading, so a failure waits a day; one source failing never stops the others.
// An install that has mailboxes reads each source once more for the mailbox facts of its stored pairs (conv, subj, account): the pairs file is copied first, nothing is lost, and an install without mailboxes never pays for this.
export async function refreshPairs(run: Runner, now = new Date(), plugins: PluginSent = pluginsSent): Promise<void> {
	const learned = readLearned();
	const boxed = hasBoxes(dataDir()), file = paths.pairs("mail"), bak = `${file}.bak-boxes`;
	if (boxed && existsSync(file) && !existsSync(bak)) copyFileSync(file, bak);
	const first = (mark: string, tagged: string): boolean => !learned[mark] || (boxed && !learned[tagged]);
	const due = (id: string): boolean => {
		if (now.getTime() - Date.parse(learned[`pairs-${id}~day`] ?? "") < DAY) return false;
		markLearned([`pairs-${id}~day`], now);
		return true;
	};
	const keep = (pairs: Pair[]): void => {
		if (pairs.length) savePairs("mail", [...loadPairs("mail"), ...pairs]);
	};
	const bots = botDrafts();
	const jobs: [string, () => Promise<void>][] = [];
	const accounts = sentAccounts(installConfig());
	if (accounts.length && due("mail")) {
		jobs.push(["mail", async () => {
			const whole = first("pairs-mail@2", "pairs-mail@3");
			for (const account of accounts) keep((await sentMail(run, whole ? PAIR_SWEEP : PAIR_DAILY, bots, account, MAX_PAIRS)).pairs);
			if (whole) markLearned(["pairs-mail@2", ...(boxed ? ["pairs-mail@3"] : [])], now);
		}]);
	}
	for (const site of sentSites()) {
		if (!due(site)) continue;
		jobs.push([site, async () => {
			const whole = first(`pairs-${site}@1`, `pairs-${site}@2`);
			keep(sentPairs(await siteSent(run, site, whole ? PAIR_SWEEP : PAIR_DAILY), site, bots));
			if (whole) markLearned([`pairs-${site}@1`, ...(boxed ? [`pairs-${site}@2`] : [])], now);
		}]);
	}
	jobs.push(["plugins", async () => {
		for (const p of await plugins(name => (due(`plugin-${name}`) ? (first(`pairs-plugin-${name}@1`, `pairs-plugin-${name}@2`) ? PAIR_SWEEP : PAIR_DAILY) : 0))) {
			keep(sentPairs(p.items, p.source, bots));
			markLearned([`pairs-plugin-${p.plugin}@1`, ...(boxed ? [`pairs-plugin-${p.plugin}@2`] : [])], now);
		}
	}]);
	for (const [id, job] of jobs) {
		try {
			await job();
		} catch (e) {
			console.error(`reply draft: past ${id} pairs not refreshed: ${(e as Error).message}`);
		}
	}
}

export type LearnOpts = { fromFile?: string; run?: Runner; zeleOn?: boolean; /** The accounts the sent mail is read from (sentAccounts); absent = every account when zeleOn. */ accounts?: (string | undefined)[]; texts?: string[]; textsLabel?: string };
export type LearnResult = { examples: string[]; from: string[]; texts: string[]; warning?: string };

// The sent-mail source (zele) belongs to the mail app only; any key can take a file or ready-made texts.
export async function learnTone(key: ToneKey | "install", opts: LearnOpts): Promise<LearnResult> {
	const texts: string[] = [];
	const from: string[] = [];
	if (opts.texts?.length) {
		texts.push(...opts.texts);
		from.push(opts.textsLabel ?? `보낸 글 ${opts.texts.length}개`);
	}
	if (opts.fromFile) {
		texts.push(readFileSync(opts.fromFile, "utf8"));
		from.push("파일");
	}
	let warning: string | undefined;
	const accounts = opts.accounts ?? (opts.zeleOn ? [undefined] : []);
	if (accounts.length && opts.run && key !== "install" && key.app === "mail" && key.room === undefined) {
		try {
			const mails = await learnSentMail(opts.run, accounts);
			texts.push(...mails);
			if (mails.length) from.push(`보낸 메일 ${mails.length}통`);
		} catch (e) {
			warning = (e as Error).message;
		}
	}
	const examples = pickExamples(texts);
	if (examples.length) writeExamples(key, examples);
	return { examples, from, texts, ...(warning ? { warning } : {}) };
}

export const toneSummary = (r: LearnResult): string =>
	(r.examples.length
		? `말투를 배웠어요: ${r.from.join(", ")}에서 문장 ${r.examples.length}개를 예시로 저장했어요.`
		: "배울 수 있는 보낸 글이 없어서 정중한 기본 말투로 쓰고, 고치기로 알려 주시면 그대로 따라가요.") + (r.warning ? ` (${r.warning})` : "");
