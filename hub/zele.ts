// Mail and calendar through zele (Gmail API, IMAP/SMTP, Google Calendar with long-lived tokens, so nothing depends on a
// browser login), ported from 오모냥's zele-watch.ts. The gateway polls; calendar notices go straight to the alert
// channel with no model call, new mail becomes a mail conversation (hub/mail.ts postMail: web only; a thread in the mail
// channel too when the owner turned on 디스코드에도 올리기 in the mail app settings) and wakes the orchestrator there, and the
// morning brief is one orchestrator turn in chat. First run only records what exists, so old mail is never replayed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, DEFAULTS, log, writeAtomic } from "./config.ts";
import { parseThread, triage } from "./mail-thread.ts";

type Item = Record<string, string | number | undefined>;
type Seen = { summary: string; start: string; end: string };
// mailVersion 2: a multi-message thread is keyed `<thread>.<count>`, so a new message in a seen thread is noticed.
type State = { seeded: boolean; mail: string[]; events: Record<string, Seen>; soon: string[]; briefDate: string; mailVersion?: number };
const MAIL_VERSION = 2;
/** `seq`: the thread's message count when this is a follow-up in a thread (its own conversation); `needsReply`: the owner is needed. */
export type NewMail = { id: string; account: string; from: string; to: string; subject: string; snippet: string; needsReply: boolean; seq?: number };
type Hooks = {
	alert: (text: string) => void;
	mail: (m: NewMail) => Promise<void>;
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

type Run = (args: string[]) => Promise<{ code: number; out: string; err: string }>;
const spawnZele: Run = async args => {
	const proc = Bun.spawn(["zele", ...args], { stdout: "pipe", stderr: "pipe" });
	const kill = setTimeout(() => proc.kill("SIGKILL"), 90_000);
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	clearTimeout(kill);
	return { code: await proc.exited, out, err };
};
let run = spawnZele;
/** Tests swap in a fake zele (hub/zele.test.ts); a changed PATH does not reach Bun.spawn in a running process. */
export const setZeleRunner = (r?: Run) => void (run = r ?? spawnZele);

async function zeleText(args: string[]): Promise<string> {
	const r = await run(args);
	if (r.code !== 0) throw new Error(`zele ${args.join(" ")}: ${(r.err || r.out).trim().slice(0, 200)}`);
	return r.out;
}
const zele = async (args: string[]): Promise<Item[]> => ((Bun.YAML.parse(await zeleText(args)) as { items?: Item[] } | null)?.items ?? []) as Item[];

async function ownAddresses(): Promise<string[]> {
	const r = await run(["whoami"]);
	if (r.code !== 0 || /not authenticated/i.test(r.out)) return [];
	return [...new Set(r.out.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])];
}
export const zeleAccounts = async (): Promise<string[]> => (Bun.which("zele") ? ownAddresses() : []);

// What the owner sees first in a mail conversation that is a later message of a thread.
const ANSWERED = "답장한 스레드에 새 메시지";
const UNANSWERED = "아직 답장하지 않은 스레드에 새 메시지";
const addrOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? "").trim().toLowerCase();

export async function tick(h: Hooks, now = new Date()): Promise<void> {
	const s = load();
	// A state written before mailVersion 2 has only bare thread ids: on this first tick a thread it already saw gets its
	// `<thread>.<count>` key recorded silently, so the upgrade does not replay every multi-message thread.
	const upgrading = s.seeded && (s.mailVersion ?? 1) < MAIL_VERSION;
	const mail = await zele(["mail", "list", "--filter", "is:unread newer_than:2d", "--limit", "40"]);
	let owner: Set<string> | undefined;
	const owners = async () => (owner ??= new Set((await ownAddresses()).map(a => a.toLowerCase())));
	for (const m of mail) {
		const thread = String(m.id);
		const count = Number(m.messages ?? 1) || 1;
		// One-message threads keep the bare id, so state from before the follow-up keys stays valid.
		const key = count > 1 ? `${thread}.${count}` : thread;
		if (s.mail.includes(key)) continue;
		s.mail.push(key);
		if (!s.seeded || (upgrading && count > 1 && s.mail.includes(thread))) continue;
		if (isNoise(m)) {
			log(`zele: skipped noise mail ${m.from} | ${m.subject}`);
			continue;
		}
		const account = String(m.account ?? "");
		const base = { id: thread, account, from: String(m.from ?? ""), to: String(m.to ?? ""), subject: String(m.subject ?? "") };
		const snippet = String(m.snippet ?? "");
		if (count === 1) {
			// `from` is the only message here, so the owner's own mail (e.g. sent to themselves) is caught without a read.
			if ((await owners()).has(addrOf(base.from))) {
				log(`zele: skipped own mail ${thread} | ${base.subject}`);
				continue;
			}
			await h.mail({ ...base, snippet: snippet.slice(0, 400), needsReply: true });
			continue;
		}
		let text: string;
		try {
			text = await zeleText(["mail", "read", thread, ...(account ? ["--account", account] : [])]);
		} catch (error) {
			// Not recorded, so the next poll reads it again.
			s.mail.pop();
			log(`zele: thread ${thread} not read: ${(error as Error).message}`);
			continue;
		}
		const messages = parseThread(text);
		const t = triage(messages, await owners());
		if (t.kind === "own") {
			log(`zele: skipped thread ${thread} (${count}): the newest message is the owner's`);
			continue;
		}
		// An acknowledgement after the owner's reply is not posted: a posted mail always gets a reply draft offered
		// (hub/mail.ts post -> offerDraft), and a thank-you needs neither a draft nor a conversation.
		if (t.kind === "ack") {
			log(`zele: skipped thread ${thread} (${count}): only an acknowledgement after the owner's reply`);
			continue;
		}
		const latest = messages.at(-1);
		const body = (latest?.body || snippet).slice(0, 400);
		await h.mail({ ...base, from: latest?.from || base.from, snippet: `${t.answered ? ANSWERED : UNANSWERED} · ${body}`, needsReply: true, seq: count });
	}

	const upcoming = (await zele(["cal", "events", "--days", "14", "--all", "--limit", "100"])).filter(ev => !isHoliday(ev));
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

	const soon = await zele(["cal", "events", "--from", now.toISOString(), "--to", "+45m", "--all"]);
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
	s.mailVersion = MAIL_VERSION;
	s.mail = cap(s.mail);
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
