// Mail and calendar through zele (Gmail API, IMAP/SMTP, Google Calendar with long-lived tokens, so nothing depends on a
// browser login), ported from 오모냥's zele-watch.ts. The gateway polls; calendar notices go straight to the alert
// channel with no model call, new mail becomes a mail conversation (hub/mail.ts postMail: web only; a thread in the mail
// channel too when the owner turned on 디스코드에도 올리기 in the mail app settings) and wakes the orchestrator there, and the
// morning brief is one orchestrator turn in chat. First run only records what exists, so old mail is never replayed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, DEFAULTS, log, writeAtomic } from "./config.ts";
import { isOwnAddress, ownAddresses, setOwnAddresses } from "./mail-state.ts";

type Item = Record<string, string | number | undefined>;
type Seen = { summary: string; start: string; end: string };
/** The newest message of a thread the watch has seen: its stamp (stampOf), whether it is the owner's own, and when it was noted (for the cap). */
type ThreadSeen = { n: string; own: boolean; at: number };
// `mail` holds the thread ids the older watch kept; `threads` replaces it and tells a new message in a thread that is already known.
type State = { seeded: boolean; mail: string[]; threads: Record<string, ThreadSeen>; events: Record<string, Seen>; soon: string[]; briefDate: string };
/** `message` names the newest message of the thread (stampOf): one value per message, so the hub can tell a repeat from an answer. */
export type NewMail = { id: string; message: string; account: string; from: string; to: string; /** 참조 (the list output carries it as `cc` when the account's Gmail/IMAP output has one). */ cc?: string; subject: string; snippet: string };
type Hooks = {
	alert: (text: string) => void;
	mail: (m: NewMail) => Promise<void>;
	/** A mail the owner wrote himself (its sender is one of his addresses): never a new mail, only a sign that the thread was answered. */
	sent?: (m: NewMail) => Promise<void>;
	/** The owner's accounts are known (startup, and again when they change): the stored mails are classified with them. */
	accounts?: (addresses: string[]) => void;
	/** Every thread this poll listed (inbox and sent folder, no extra zele call): `read` = no message of it is unread any more (read in Gmail,
	 *  another client or dotz), `replied` = its newest message is the owner's (he answered it, from dotz or anywhere else). Called once per poll. */
	states?: (items: { id: string; read?: boolean; replied?: boolean }[]) => void | Promise<void>;
	brief: (text: string) => void;
};

const STATE = join(DATA_DIR, "zele-state.json");
const zcfg = ((cfg as any).zele ?? {}) as { enabled?: boolean; poll_sec?: number; brief_hour?: number; mail_noise?: string[] };
const POLL_MS = Math.max(60, Number(zcfg.poll_sec ?? DEFAULTS.zele_poll_sec)) * 1000;
// With no account yet, look again after this long.
export const NO_ACCOUNT_RETRY_MS = 600_000;
const BRIEF_HOUR = Number(zcfg.brief_hour ?? DEFAULTS.zele_brief_hour);
// Whether mail and calendar run on this install: on in config and the zele CLI is here (mail may live on another machine).
export const zeleState = (): "on" | "off" | "missing" => (zcfg.enabled === false ? "off" : Bun.which("zele") ? "on" : "missing");
const MAIL_NOISE = [/coderabbitai\[bot\]/i, /^\s*[[(]광고[\])]/, /mkt@/i, /no-?reply@.*(newsletter|marketing)/i, ...(zcfg.mail_noise ?? []).map(s => new RegExp(s, "i"))];
const isNoise = (m: Item) => MAIL_NOISE.some(r => r.test(String(m.from ?? "")) || r.test(String(m.subject ?? "")));
const isHoliday = (ev: Item) => String(ev.calendar ?? "").endsWith("@virtual") || /holiday/i.test(String(ev.calendar ?? ""));
const isAllDay = (ev: Item) => !/\d{1,2}:\d{2}/.test(String(ev.start ?? ""));

// zele prints times in the system locale: "10월 24일, 오전 11:00" here, "Oct 24, 11:00 AM" / "Oct 24 at 11:00 AM" in en-US.
// The owner reads "10/24 11:00" either way.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const ko = (t: unknown) =>
	String(t ?? "")
		.replace(/(\d{1,2})월 (\d{1,2})일/g, "$1/$2")
		.replace(/(오전|오후) (\d{1,2}):(\d{2})/g, (_, ap, h, mm) => `${(Number(h) % 12) + (ap === "오후" ? 12 : 0)}:${mm}`)
		.replace(/\b([A-Z][a-z]{2}) (\d{1,2})\b/g, (m, mon, d) => (MONTHS.includes(mon) ? `${MONTHS.indexOf(mon) + 1}/${d}` : m))
		.replace(/(\d{1,2}):(\d{2})\s*([AP])M/g, (_, h, mm, ap) => `${(Number(h) % 12) + (ap === "P" ? 12 : 0)}:${mm}`)
		.replace(/,? at |, /g, " ")
		.trim();
const when = (ev: Item) => (ev.end && ev.end !== ev.start ? `${ko(ev.start)} ~ ${ko(ev.end)}` : ko(ev.start));

const load = (): State => {
	const s = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { seeded: false, mail: [], events: {}, soon: [], briefDate: "" };
	s.threads ??= {};
	if (Array.isArray(s.events)) s.events = Object.fromEntries(s.events.map((id: string) => [id, { summary: "", start: "", end: "" }]));
	return s;
};
const seen = (ev: Item): Seen => ({ summary: String(ev.summary ?? ""), start: String(ev.start ?? ""), end: String(ev.end ?? "") });
const whenSeen = (e: Seen) => when(e as unknown as Item);
const norm = (s: string) => s.replace(/\s+/g, "").replace(/(예약|상담|미팅|회의)$/u, "").toLowerCase();
// An edit made from another app can come back under a new id; pair a new id with an event that vanished in the same
// poll when the titles match after trimming spaces and a trailing "예약/상담/미팅/회의", or one title contains the other.
const sameEvent = (a: Seen, b: Seen) => {
	const x = norm(a.summary);
	const y = norm(b.summary);
	return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};
async function stillThere(id: string): Promise<boolean> {
	const r = await Bun.$`zele cal get ${id}`.nothrow().quiet();
	return r.exitCode === 0 && !/status:\s*cancelled/i.test(r.stdout.toString());
}
const save = (s: State) => writeAtomic(STATE, `${JSON.stringify(s)}\n`);
const cap = (xs: string[]) => xs.slice(-2000);

async function zele(args: string[]): Promise<Item[]> {
	const proc = Bun.spawn(["zele", ...args], { stdout: "pipe", stderr: "pipe" });
	const kill = setTimeout(() => proc.kill("SIGKILL"), 90_000);
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	clearTimeout(kill);
	if ((await proc.exited) !== 0) throw new Error(`zele ${args.join(" ")}: ${(err || out).trim().slice(0, 200)}`);
	return ((Bun.YAML.parse(out) as { items?: Item[] } | null)?.items ?? []) as Item[];
}

// An IMAP/SMTP-only account has no calendar and zele refuses every `cal` command for it; that is an empty calendar, not a failed tick,
// so the mail part still seeds, saves and posts.
const NO_CALENDAR = /Calendar is not available for IMAP\/SMTP accounts/i;
const calendar = (list: (args: string[]) => Promise<Item[]>, args: string[]): Promise<Item[]> =>
	list(args).catch(error => {
		if (NO_CALENDAR.test(String((error as Error)?.message ?? error))) return [] as Item[];
		throw error;
	});

export async function zeleAccounts(): Promise<string[]> {
	if (!Bun.which("zele")) return [];
	const r = await Bun.$`zele whoami`.nothrow().quiet();
	const text = r.stdout.toString();
	if (r.exitCode !== 0 || /not authenticated/i.test(text)) return [];
	return [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])];
}

// `zele mail read <thread>` prints a header, then one block per message split by a line of `─`: `From: Name <addr> [unread]`, `To:`, `Date:`,
// optional `Auth:`, a blank line, the body. A block without a `From:` line (the header) is not a message.
export type ThreadMessage = { from: string; date: string; body: string };
const SEPARATOR = /^\s*─{3,}\s*$/;
export function parseThread(text: string): ThreadMessage[] {
	const blocks: string[][] = [[]];
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		if (SEPARATOR.test(line)) blocks.push([]);
		else blocks.at(-1)!.push(line);
	}
	const out: ThreadMessage[] = [];
	for (const lines of blocks) {
		const at = lines.findIndex(l => /^From:\s/.test(l));
		if (at < 0) continue;
		const blank = lines.findIndex((l, i) => i > at && !l.trim());
		const head = lines.slice(at, blank < 0 ? lines.length : blank);
		out.push({
			from: lines[at].replace(/^From:\s*/, "").replace(/\s*\[unread\]\s*$/i, "").trim(),
			date: head.find(l => /^\s*Date:\s/.test(l))?.replace(/^\s*Date:\s*/, "").trim() ?? "",
			body: blank < 0 ? "" : lines.slice(blank + 1).join("\n").trim(),
		});
	}
	return out;
}

// Where a client starts quoting the earlier mail; everything from there on is not the new text.
const QUOTE_START = [/^On .+wrote:\s*$/i, /^20\d\d[.\-/년 ].*작성:?\s*$/, /^-{2,}\s*(Original Message|원본 메시지)\s*-{2,}$/i, /^(From|보낸 사람):\s/i];
/** The new text of a message: quoted lines, the quoted earlier mail and a `-- ` signature dropped. */
export function newText(body: string): string {
	const kept: string[] = [];
	for (const line of body.split("\n")) {
		const t = line.trim();
		if (QUOTE_START.some(r => r.test(t)) || line === "-- " || t === "--") break;
		if (!t.startsWith(">")) kept.push(line);
	}
	return kept.join("\n").trim();
}

const REQUEST = /부탁|요청|문의|가능|할 수 있|please|could|can you/i;
// An ack has to say thanks or "received": a short note without it ("see the file", "3pm then") may still need the owner.
const THANKS = /감사|고맙|잘 받았|받았습니다|확인했습니다|thank|received|got it/i;
/** A short thank-you or "received" note: a thanks word, no question, no request words, at most 4 lines / 300 chars. An empty note is not one,
 * since it may carry only an attachment the owner has to look at. */
export function isAck(body: string): boolean {
	const text = newText(body);
	return THANKS.test(text) && !/[?？]/.test(text) && !REQUEST.test(text) && text.split("\n").filter(l => l.trim()).length <= 4 && text.length <= 300;
}

/** The thread is answered and everything the other side wrote after the owner's last message is only an acknowledgement. */
export function onlyAcksAfterOwner(messages: ThreadMessage[], own: ReadonlySet<string>): boolean {
	const reply = messages.findLastIndex(m => isOwnAddress(m.from, own));
	return reply >= 0 && reply < messages.length - 1 && messages.slice(reply + 1).every(m => isAck(m.body));
}

const zeleRead = async (id: string, account: string): Promise<string> => {
	const r = await Bun.$`zele mail read ${id} ${account ? ["--account", account] : []}`.nothrow().quiet();
	if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim().slice(0, 200));
	return r.stdout.toString();
};

// zele lists a thread with the count and the date of its newest message; together they name that message (a new answer raises the count).
const stampOf = (m: Item): string => `${m.messages ?? ""}|${m.date ?? ""}`;
const THREADS_MAX = 2000;
const newMail = (m: Item): NewMail => ({ id: String(m.id), message: stampOf(m), account: String(m.account ?? ""), from: String(m.from ?? ""), to: String(m.to ?? ""), ...(m.cc ? { cc: String(m.cc) } : {}), subject: String(m.subject ?? ""), snippet: String(m.snippet ?? "").slice(0, 400) });

// `zele mail list` lists threads and `from` is the sender of the newest message of the thread, so the state of a thread follows its LAST
// message: the owner's own (a sign the thread was answered) or someone else's (a new mail, again, if it is newer than what the watch saw).
// The list is not limited to unread: an answer in a thread the owner already read must still be seen, so each thread's newest message
// (stampOf) is compared with the one noted in `threads`; a thread never seen before still needs to be unread to count as new mail.
// The sent folder is read too, so a reply he wrote after reading the thread (no longer unread) still closes it.
// A thank-you the other side sends after the owner's reply is read from the thread and not posted: it needs no draft and no conversation.
// A thread that cannot be read is posted, so a failure only makes the watch louder.
export async function tick(h: Hooks, now = new Date(), list: (args: string[]) => Promise<Item[]> = zele, read: (id: string, account: string) => Promise<string> = zeleRead): Promise<void> {
	const s = load();
	const mail = await list(["mail", "list", "--filter", "newer_than:2d", "--limit", "60"]);
	const sent = await list(["mail", "list", "--folder", "sent", "--filter", "newer_than:2d", "--limit", "40"]).catch(error => (log(`zele: sent folder not read: ${(error as Error).message}`), [] as Item[]));
	const own = ownAddresses([...mail, ...sent].flatMap(m => (m.account ? [String(m.account)] : [])));
	const note = (m: Item, isOwn: boolean) => void ((s.threads[String(m.id)] = { n: stampOf(m), own: isOwn, at: now.getTime() }));
	for (const m of [...mail, ...sent]) {
		if (!isOwnAddress(String(m.from ?? ""), own)) continue;
		const before = s.threads[String(m.id)];
		if (before?.own && before.n === stampOf(m)) continue;
		// His older message, still listed (the sent folder) after the other side wrote a newer one, is not an answer to it.
		if (before && Number.parseInt(before.n, 10) > Number(m.messages)) continue;
		note(m, true);
		await h.sent?.(newMail(m));
	}
	for (const m of mail) {
		const key = String(m.id);
		if (isOwnAddress(String(m.from ?? ""), own)) continue;
		const before = s.threads[key];
		const older = !before && s.mail.includes(key);
		if (before && !before.own && before.n === stampOf(m)) continue;
		note(m, false);
		// Never seen before: only an unread thread is new mail (a read one is old news). Seen before: its newest message is new, read or not.
		if (older || (!before && m.flags !== undefined && !/unread/i.test(String(m.flags)))) continue;
		if (!s.seeded) continue;
		if (isNoise(m)) {
			log(`zele: skipped noise mail ${m.from} | ${m.subject}`);
			continue;
		}
		if (before?.own) {
			const messages = await read(key, String(m.account ?? "")).then(parseThread, error => (log(`zele: thread ${key} not read: ${(error as Error).message}`), []));
			if (onlyAcksAfterOwner(messages, own)) {
				log(`zele: skipped thread ${key}: only an acknowledgement after the owner's reply`);
				continue;
			}
		}
		await h.mail(newMail(m));
	}
	// The mailbox's own state of every listed thread, on every poll: what dotz shows follows it (hub/mail.ts syncMailStates).
	const states = new Map<string, { id: string; read?: boolean; replied?: boolean }>();
	for (const m of [...mail, ...sent]) {
		const id = String(m.id ?? "");
		if (!id || states.has(id)) continue;
		const read = m.flags === undefined ? undefined : !/unread/i.test(String(m.flags));
		states.set(id, { id, ...(read !== undefined ? { read } : {}), ...(isOwnAddress(String(m.from ?? ""), own) ? { replied: true } : {}) });
	}
	if (states.size) await h.states?.([...states.values()]);

	const upcoming = (await calendar(list, ["cal", "events", "--days", "14", "--all", "--limit", "100"])).filter(ev => !isHoliday(ev));
	const current = new Map(upcoming.map(ev => [String(ev.id), seen(ev)]));
	for (const [id, e] of Object.entries(s.events)) if (!current.has(id) && !e.summary) delete s.events[id];
	const vanished = Object.entries(s.events).filter(([id]) => !current.has(id));
	const fresh: [string, Seen][] = [];
	for (const [id, e] of current) {
		const prev = s.events[id];
		if (!prev) fresh.push([id, e]);
		else if (s.seeded && prev.summary && (prev.summary !== e.summary || ko(prev.start) !== ko(e.start) || ko(prev.end) !== ko(e.end))) h.alert(`일정 변경: ${whenSeen(prev)} · ${prev.summary} -> ${whenSeen(e)} · ${e.summary}`);
		s.events[id] = e;
	}
	for (const [id, e] of fresh) {
		const i = vanished.findIndex(([, v]) => sameEvent(v, e));
		if (i >= 0) {
			const [oldId, old] = vanished.splice(i, 1)[0];
			delete s.events[oldId];
			if (s.seeded) h.alert(`일정 변경: ${whenSeen(old)} · ${old.summary} -> ${whenSeen(e)} · ${e.summary}`);
		} else if (s.seeded) h.alert(`새 일정: ${whenSeen(e)} · ${e.summary}`);
	}
	// A vanished event is cancelled only if zele no longer finds it; otherwise it moved out of the 14-day window or
	// passed, and it is simply forgotten.
	for (const [id, e] of vanished) {
		if (s.seeded && !(await stillThere(id))) h.alert(`일정 취소: ${whenSeen(e)} · ${e.summary}`);
		delete s.events[id];
	}

	const soon = await calendar(list, ["cal", "events", "--from", now.toISOString(), "--to", "+45m", "--all"]);
	for (const ev of soon) {
		const key = `${ev.id}:${ev.start}`;
		if (s.soon.includes(key)) continue;
		s.soon.push(key);
		if (s.seeded && !isAllDay(ev) && !isHoliday(ev)) h.alert(`곧 시작: ${when(ev)} · ${ev.summary}`);
	}

	const today = now.toLocaleDateString("sv-SE");
	if (s.seeded && now.getHours() >= BRIEF_HOUR && s.briefDate !== today) {
		s.briefDate = today;
		h.brief(`morning brief for ${today}: summarize today's calendar (zele cal events --today --all) and the unread mail that matters (zele mail list --filter "is:unread newer_than:1d"), short. Skip if there is nothing.`);
	}
	if (!s.seeded) log(`zele: first run recorded ${mail.length} mails, ${upcoming.length} events (no notices)`);
	s.seeded = true;
	s.mail = cap(s.mail);
	const noted = Object.entries(s.threads);
	if (noted.length > THREADS_MAX) s.threads = Object.fromEntries(noted.sort((a, b) => b[1].at - a[1].at).slice(0, THREADS_MAX));
	s.soon = cap(s.soon);
	save(s);
}

export async function startZele(h: Hooks): Promise<void> {
	if (zcfg.enabled === false) return;
	const accounts = await zeleAccounts();
	if (!accounts.length) {
		log("zele: no accounts (zele login), mail and calendar watching off; checking again in 10 min");
		setTimeout(() => void startZele(h), NO_ACCOUNT_RETRY_MS);
		return;
	}
	setOwnAddresses("zele", accounts);
	h.accounts?.(accounts);
	log(`zele: watching ${accounts.join(", ")} every ${POLL_MS / 1000}s`);
	let fails = 0;
	const loop = async () => {
		try {
			await tick(h);
			fails = 0;
		} catch (error) {
			fails++;
			log(`zele: ${(error as Error).message}`);
			if (fails === 3) h.alert(`메일·일정 확인이 3번 연속 실패했어요: ${(error as Error).message.slice(0, 200)}. zele whoami / zele login으로 계정을 확인해 주세요.`);
		}
		setTimeout(loop, POLL_MS);
	};
	void loop();
}
