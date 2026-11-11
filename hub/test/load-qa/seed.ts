// Deterministic fake data for the load-QA install: mails of three accounts, reply drafts, notices, comment cards that carry a mail draft, and
// attachment libraries (local, fake iCloud). Created through the real stores where that is fast; where a store is too slow or capped the
// on-disk format is written directly and read back through the real readers (`--verify`). Only generated values; only under /tmp/load-qa/.
//   bun hub/test/load-qa/seed.ts --dir /tmp/load-qa/<name> --scale small|large [--mail-real all] [--now <iso>]
// Every seeded time is relative to the run's own clock ("now"), because the real feed judges age (WATCH_DAYS) by the clock it runs on. `--now` moves
// that clock for the whole process, so the seed and the feed still agree on it.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ACCOUNTS, ALERTS, CLOSING, COMMENT_TEXT, DOMAINS, FILE_FOLDERS, FILE_STEMS, FILE_SUFFIX, GIVEN, GREETING, KAKAO_LINES, KAKAO_ROOMS, POST_TITLES, ROLE_TEXT, SURNAMES, type Account, type Role } from "./names.ts";

export type Scale = "small" | "large";
export const LOAD_ROOT = "/tmp/load-qa";
const SEED = 20261105;
// kakao / compose / commentOnly are parts of `drafts` (compose = the mail draft riding on a comment reply); commentOnly are comment replies with no mail.
const SIZES = {
	small: { mails: 100, drafts: 20, notices: 50, kakao: 4, compose: 2, commentOnly: 2, library: 12, days: 10 },
	large: { mails: 5000, drafts: 500, notices: 1000, kakao: 60, compose: 40, commentOnly: 20, library: 120, days: 60 },
} as const;
const REAL_MAIL_MAX = 500;

type Rng = ReturnType<typeof prng>;
function prng(seed: number) {
	let a = seed >>> 0;
	const next = (): number => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (n: number): number => Math.floor(next() * n);
	const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
	const chance = (p: number): boolean => next() < p;
	const weighted = <T>(xs: readonly (readonly [T, number])[]): T => {
		let x = next() * xs.reduce((s, [, w]) => s + w, 0);
		for (const [v, w] of xs) if ((x -= w) < 0) return v;
		return xs[0]![0];
	};
	return { next, int, pick, chance, weighted };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Moves the process clock (Date.now() and new Date()) to run from `ms` on, so the hub's now() and the seed's times share one clock. */
function moveClock(ms: number): void {
	const RealDate = Date, offset = ms - RealDate.now();
	globalThis.Date = class extends RealDate {
		constructor(...args: [] | [number | string | Date] | ConstructorParameters<typeof RealDate>) {
			if (args.length === 0) super(RealDate.now() + offset);
			else super(...(args as [number]));
		}
		static override now = (): number => RealDate.now() + offset;
	} as DateConstructor;
}

/** Resolves symlinks of the deepest existing ancestor, so /tmp (a link to /private/tmp on macOS) compares like the real path. */
function realish(p: string): string {
	let head = resolve(p), tail = "";
	for (;;) {
		try {
			return join(realpathSync(head), tail);
		} catch {
			tail = join(basename(head), tail);
			const up = dirname(head);
			if (up === head) return resolve(p);
			head = up;
		}
	}
}

export function checkDir(dir: string): string {
	const abs = realish(dir);
	if (!abs.startsWith(`${realish(LOAD_ROOT)}${sep}`)) throw new Error(`seed refuses ${dir}: the data dir must be under ${LOAD_ROOT}/`);
	if (abs === realish(join(homedir(), ".dotz")) || abs.startsWith(`${realish(join(homedir(), ".dotz"))}${sep}`)) throw new Error("seed never touches ~/.dotz");
	return resolve(dir);
}

type Person = { name: string; addr: string; role: Role };
const handle = (r: Rng, name: string): string => `${name}${r.int(900) + 100}`;
function makePerson(r: Rng, role: Role): Person {
	const [ko, roman] = r.pick(GIVEN);
	return { name: `${r.pick(SURNAMES)}${ko}`, addr: `${handle(r, roman)}@${r.pick(DOMAINS)}`, role };
}
const header = (p: { name: string; addr: string }): string => `${p.name} <${p.addr}>`;

type Spec = {
	acct: Account; id: string; key: string; out: boolean; person: Person; others: Person[]; ccs: Person[]; subject: string; body: string; html?: string; summary?: string;
	at: number; attach: { name: string; type: string; data: string }[]; needsReply: boolean; list: boolean; asks: boolean;
};

function fileName(r: Rng): { name: string; type: string } {
	const ext = r.weighted([["pdf", 6], ["jpg", 2], ["xlsx", 1]] as const);
	return { name: `${r.pick(FILE_STEMS)}${r.pick(FILE_SUFFIX)}.${ext}`, type: ext === "pdf" ? "application/pdf" : ext === "jpg" ? "image/jpeg" : "application/vnd.ms-excel" };
}

function makeSpecs(r: Rng, n: number, base: number, days: number, keyOf: (source: string, id: string) => string): Spec[] {
	const pool = Math.max(6, Math.ceil(n / 80));
	const people = new Map<string, Person[]>();
	const peopleOf = (a: Account, role: Role): Person[] => {
		const k = `${a.inst}/${role}`;
		if (!people.has(k)) people.set(k, Array.from({ length: pool }, () => makePerson(r, role)));
		return people.get(k)!;
	};
	const step = (days * 86_400_000) / n;
	return Array.from({ length: n }, (_, i): Spec => {
		const acct = r.weighted(ACCOUNTS.map(a => [a, a.weight] as const));
		const role = r.weighted(acct.roles);
		const text = ROLE_TEXT[role];
		const person = r.pick(peopleOf(acct, role));
		const out = r.chance(0.08);
		const others = !out && r.chance(0.12) ? [r.pick(peopleOf(acct, "person"))] : [];
		const ccs = !out && r.chance(0.15) ? Array.from({ length: 1 + r.int(2) }, () => r.pick(peopleOf(acct, r.pick(["person", "vendor", "teacher"] as const)))) : [];
		const lines = [r.pick(text.lines), r.pick(text.lines)];
		const long = r.chance(0.05);
		const body = [r.pick(GREETING), "", ...(long ? Array.from({ length: 40 }, () => r.pick(text.lines)) : lines), "", r.pick(CLOSING), person.name].join("\n");
		const subject = `${out ? "Re: " : ""}${r.pick(text.subjects)}${r.chance(0.3) ? ` - ${r.pick(["이번 주", "다음 주", "급해요", "확인 요청"])}` : ""}`;
		const id = `m${i.toString(36).padStart(5, "0")}`;
		const list = role === "vendor" && subject.startsWith("[광고]");
		const at = base - 60_000 - (n - 1 - i) * step + Math.round((r.next() - 0.5) * step * 0.6);
		return {
			acct, id, key: keyOf(acct.source, id), out, person, others, ccs, subject, body, list, asks: text.asks, at,
			...(r.chance(0.3) ? { html: body.split("\n").filter(Boolean).map(l => `<p>${l}</p>`).join("") } : {}),
			...(r.chance(0.55) ? { summary: `${person.name}님이 ${subject.replace(/^Re: /, "")} 건으로 연락했어요.` } : {}),
			attach: r.chance(0.06) ? Array.from({ length: 1 + r.int(2) }, () => ({ ...fileName(r), data: Buffer.from(`fake attachment ${i}\n`.repeat(40 + r.int(60))).toString("base64") })) : [],
			needsReply: text.asks && r.chance(0.6),
		};
	});
}

const fromOf = (s: Spec): string => header(s.out ? { name: s.acct.owner, addr: s.acct.address } : s.person);
const toOf = (s: Spec): string => (s.out ? header(s.person) : [header({ name: s.acct.owner, addr: s.acct.address }), ...s.others.map(header)].join(", "));
const ccOf = (s: Spec): string | undefined => (s.ccs.length ? s.ccs.map(header).join(", ") : undefined);

function mailInput(s: Spec) {
	return {
		source: s.acct.source, id: s.id, subject: s.subject, from: fromOf(s), to: toOf(s), ...(ccOf(s) ? { cc: ccOf(s) } : {}), body: s.body,
		...(s.html ? { html: s.html } : {}), ...(s.summary ? { summary: s.summary } : {}), at: iso(s.at), messageId: `<${s.id}@${s.acct.address.split("@")[1]}>`,
		needsReply: s.needsReply, account: s.acct.address, ...(s.list ? { list: true } : {}), ...(s.out ? { direction: "out" as const } : {}),
		...(s.attach.length ? { attachments: s.attach } : {}),
	};
}

type Lib = { dir: string; files: number; notDownloaded: number; wanted: { name: string; path: string }[] };
const ICLOUD = ["fake-icloud", "com~apple~CloudDocs"];
const bytesOf = (name: string): string => `fake library file ${name}\n`.repeat(60);

/** One library: a stem + suffix per file, the same name in two folders on purpose. `files` are downloaded ones; the rest keep only `.name.icloud`. */
function libraryNames(n: number): { folder: string; name: string }[] {
	return Array.from({ length: n }, (_, i) => {
		const k = Math.floor(i / 2), round = Math.floor(k / (FILE_STEMS.length * FILE_SUFFIX.length));
		return { folder: FILE_FOLDERS[i % FILE_FOLDERS.length]!, name: `${FILE_STEMS[k % FILE_STEMS.length]}${FILE_SUFFIX[Math.floor(k / FILE_STEMS.length) % FILE_SUFFIX.length]}${round ? ` ${round + 1}` : ""}.pdf` };
	});
}

function makeLibraries(dir: string, n: number): { local: Lib; library: Lib; folder: Lib } {
	const put = (file: string, text: string) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, text));
	const cloud = join(dir, ...ICLOUD);
	const names = libraryNames(n);
	const local = join(dir, "attach-local");
	for (const f of names) put(join(local, f.folder, f.name), bytesOf(f.name));

	// beta: a real folder of per-file symlinks into the fake iCloud tree, like the real library; every third target is not downloaded (placeholder only).
	const library = join(dir, "attach-icloud-library"), betaCloud = join(cloud, "Library-beta");
	const wanted: Lib["wanted"] = [];
	let missing = 0;
	for (const [i, f] of names.entries()) {
		const target = join(betaCloud, f.folder, f.name), link = join(library, f.folder, f.name);
		if (i % 3 === 0) {
			put(join(betaCloud, f.folder, `.${f.name}.icloud`), "fake icloud placeholder\n");
			missing++;
			if (wanted.length < 8) wanted.push({ name: f.name, path: link });
		} else put(target, bytesOf(f.name));
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(target, link);
	}

	// gamma: the folder itself is a symlink into the fake iCloud tree; files inside are real or placeholders.
	const gammaCloud = join(cloud, "Gamma"), folder = join(dir, "attach-gamma");
	let gammaMissing = 0;
	for (const [i, f] of names.entries()) {
		if (i % 4 === 1) (put(join(gammaCloud, f.folder, `.${f.name}.icloud`), "fake icloud placeholder\n"), gammaMissing++);
		else put(join(gammaCloud, f.folder, f.name), bytesOf(f.name));
	}
	symlinkSync(gammaCloud, folder);
	return { local: { dir: local, files: n, notDownloaded: 0, wanted: [] }, library: { dir: library, files: n - missing, notDownloaded: missing, wanted }, folder: { dir: folder, files: n - gammaMissing, notDownloaded: gammaMissing, wanted: [] } };
}

const writeJson = (file: string, value: unknown): void => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`));

let seededDir: string | undefined;

export async function seed(dirArg: string, scale: Scale, opts: { realMail?: "all" | "auto"; now?: string } = {}) {
	const dir = checkDir(dirArg);
	if (seededDir && seededDir !== dir) throw new Error(`seed already ran for ${seededDir} in this process; run it in a fresh process for ${dir}`);
	seededDir = dir;
	if (opts.now !== undefined) {
		if (Number.isNaN(Date.parse(opts.now))) throw new Error(`seed: --now is not a time: ${opts.now}`);
		moveClock(Date.parse(opts.now));
	}
	const size = SIZES[scale], r = prng(SEED), base = Date.now(), nowIso = iso(base);
	const timings: Record<string, number> = {};
	const timed = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
		const t0 = performance.now();
		try {
			return await fn();
		} finally {
			timings[name] = Math.round(performance.now() - t0);
		}
	};

	// hub/config.ts reads DOTZ_DIR (and config.json) at import: set both before the first dynamic import below.
	process.env.DOTZ_DIR = dir;
	mkdirSync(dir, { recursive: true });
	const keep = Math.max(500, Math.ceil(size.mails * 1.2));
	const cfgFile = join(dir, "config.json");
	const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {};
	writeJson(cfgFile, { ...cfg, mail: { ...cfg.mail, keep, own_addresses: ACCOUNTS.map(a => a.address) } });

	const Mail = await import("../../mail.ts"), MailState = await import("../../mail-state.ts"), Files = await import("../../files.ts"), Cfg = await import("../../config.ts");
	const Settings = await import("../../../features/reply-drafts/lib/settings.ts"), Drafts = await import("../../../features/reply-drafts/lib/store.ts");
	const Flow = await import("../../../features/reply-drafts/lib/flow.ts"), Notices = await import("../../notices-store.ts");
	const CommentStore = await import("../../comments/store.ts"), CommentAsk = await import("../../comments/ask.ts"), Linked = await import("../../comments/linked.ts"), Match = await import("../../comments/mail-match.ts");

	// Apps: three mail instances (own source, account and recipients), YouTube, Instagram and Kakao on.
	const libs = await timed("libraries", () => makeLibraries(dir, size.library));
	await timed("config", () => {
		writeJson(join(dir, "custom", "apps.json"), Object.fromEntries(ACCOUNTS.map(a => [a.inst, { ...(a.inst === "mail" ? {} : { app: "mail" }), label: a.label, filter: { source: a.source, account: a.address } }])));
		writeJson(join(dir, "custom", "sns", "config.json"), {
			version: 1,
			youtube: { channel_id: "UCfakechannel0000000000", base_language: "ko", languages: [], privacy: "private", upload_via: "api" },
			instagram: { user_id: "17841400000000000", username: "fake_account", post_via: "api" },
			timezone: "Asia/Seoul", posting_times: ["18:00"], approval: "each", inbox_dir: join(dir, "custom", "sns", "inbox"), quota: { daily_budget: 9000 },
		});
		// made-up logins, so the comment adapters pass "login is not set up"; hub/test/load-qa/fake-net.ts answers their API calls
		writeJson(join(dir, "secrets", "youtube-oauth.json"), { client_id: "fake-client-id", client_secret: "fake-client-secret", refresh_token: "fake-refresh-token" });
		writeJson(join(dir, "secrets", "instagram.json"), { access_token: "fake-ig-token", user_id: "17841400000000000", username: "fake_account", obtained_at: nowIso });
		const kakao = join(dir, "features", "kakao", "feature.md");
		mkdirSync(dirname(kakao), { recursive: true });
		writeFileSync(kakao, readFileSync(join(import.meta.dir, "..", "..", "..", "features", "kakao", "feature.md"), "utf8").replace(/^enabled:\s*false\s*$/m, "enabled: true"));
		Settings.saveSettings({
			enabled: true, auto: true,
			apps: Object.fromEntries([...ACCOUNTS.map(a => a.inst), "youtube", "instagram", "kakao"].map(a => [a, { auto: true }])),
			attachFolders: { mail: libs.local.dir, "mail-beta": libs.library.dir, "mail-gamma": libs.folder.dir },
		});
		Settings.ensureSwitch();
		for (const a of ACCOUNTS) {
			Settings.writeIdentity({ app: a.inst }, a.tone.identity, a.tone.templates);
			Settings.writeSections({ app: a.inst }, [[Settings.HEADINGS.rules, a.tone.rules], [Settings.HEADINGS.samples, a.tone.samples], [Settings.HEADINGS.forbidden, a.tone.forbidden]]);
		}
		for (const app of ["youtube", "instagram", "kakao"]) Settings.writeExamples({ app }, ["네, 감사합니다!", "확인했어요. 곧 답드릴게요."]);
	});

	// Mails: the real postMail (a probe of its cost) for a subset, the rest written in its record format in one go (every postMail rewrites the whole file).
	const specs = makeSpecs(r, size.mails, base, size.days, Mail.mailKey);
	const wantDraft = specs.filter(s => !s.out && s.needsReply).slice(-(size.drafts - size.kakao - size.compose));
	const drafted = new Set(wantDraft.map(s => s.key));
	const realAll = opts.realMail === "all" || size.mails <= REAL_MAIL_MAX;
	const realSet = specs.filter(s => realAll || s.out || drafted.has(s.key) || s.attach.length > 0);
	const deps = { createThread: async () => ({ id: "0" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: () => {}, wake: () => {}, now: () => nowIso };
	const samples: number[] = [];
	await timed("mail.postMail", async () => {
		for (const [i, s] of realSet.entries()) {
			const t0 = performance.now();
			await Mail.postMail(mailInput(s), deps);
			if (i % 100 === 99) samples.push(Math.round(performance.now() - t0));
		}
	});
	const realKeys = new Set(realSet.map(s => s.key));
	const bulk = await timed("mail.bulk", async () => {
		const out: import("../../mail.ts").MailRecord[] = [];
		for (const s of specs) {
			if (realKeys.has(s.key)) continue;
			const cue = { from: fromOf(s), to: toOf(s), cc: ccOf(s), subject: s.subject, text: s.summary || s.body, list: s.list };
			const needs = (s.needsReply && !MailState.replyExclusion(cue)) || MailState.replyExpected(cue);
			if (s.html) {
				mkdirSync(join(Mail.MAIL_FILES, s.key), { recursive: true });
				writeFileSync(Mail.BODY_FILE(s.key), s.html);
			}
			out.push({
				...(s.list ? { list: true as const } : {}), account: s.acct.address, key: s.key, source: s.acct.source, id: s.id, subject: s.subject, from: fromOf(s), to: toOf(s),
				...(ccOf(s) ? { cc: ccOf(s) } : {}), at: iso(s.at), ...(s.summary ? { summary: s.summary } : { preview: Mail.mailPreview(s.body) }),
				...(s.html ? { html: true as const } : {}), ...(needs ? { reply: "needs" as const } : {}), msg: `<${s.id}@${s.acct.address.split("@")[1]}>`,
			});
		}
		return out;
	});

	// Drafts: 500 pending through the real store first (it keeps the newest 200), then the file written whole.
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", ids = new Set<string>();
	const newId = (): string => {
		for (;;) {
			const id = `R${Array.from({ length: 6 }, () => alphabet[r.int(32)]).join("")}`;
			if (!ids.has(id)) return ids.add(id), id;
		}
	};
	const asks = ["내일 오후에 가능하세요?", "확인했습니다. 곧 안내드릴게요.", "일정은 금요일로 잡아 두었어요.", "말씀하신 자료는 첨부했습니다."];
	const recs: import("../../../features/reply-drafts/lib/store.ts").DraftRec[] = [];
	const created = (at: number): string => iso(Math.min(base - 30_000, at + 60_000 * (5 + r.int(600))));
	const wantedFor = (inst: string, i: number) => (inst === "mail-beta" && libs.library.wanted.length && i % 5 === 0 ? { wantFiles: [libs.library.wanted[i % libs.library.wanted.length]!] } : {});
	for (const [i, s] of wantDraft.entries()) {
		const all = s.others.length > 0 || s.ccs.length > 0;
		const to = [s.person.addr, ...s.others.map(p => p.addr)].join(", ");
		recs.push({
			id: newId(), kind: "mail", app: s.acct.inst, source: "zele", mailId: s.id, ref: s.key, account: s.acct.address, to, ...(all ? { cc: s.ccs.map(p => p.addr), mode: "all" as const } : { mode: "reply" as const }),
			...(r.chance(0.1) ? { rule: { id: "r1", name: "일정 안내" } } : {}), subject: `Re: ${s.subject}`, body: [s.acct.tone.templates[0], r.pick(asks), r.pick(CLOSING)].join("\n"),
			status: "pending", created: created(s.at), changes: [], questions: [], ...(s.attach.length ? { origAttachments: s.attach.length } : {}), ...(i % 17 === 0 ? { asksFile: true, libraryMiss: true } : {}), ...wantedFor(s.acct.inst, i),
			item: { kind: "mail", app: s.acct.inst, from: fromOf(s), to: [s.acct.address, ...s.others.map(p => p.addr)], ...(s.ccs.length ? { cc: s.ccs.map(p => p.addr) } : {}), self: [s.acct.address], subject: s.subject, text: s.body },
		});
	}
	const kakaoRecs = Array.from({ length: size.kakao }, (_, i) => {
		const room = KAKAO_ROOMS[i % KAKAO_ROOMS.length]!, line = r.pick(KAKAO_LINES);
		return { id: newId(), kind: "chat" as const, app: "kakao", room, source: "kakao", mailId: `kakao-${i}`, ref: `kakao:${i}`, to: room, body: r.pick(asks), status: "pending" as const, created: iso(base - 60_000 * (10 + r.int(2000))), changes: [], questions: [], item: { kind: "chat" as const, app: "kakao", room, from: `${r.pick(SURNAMES)}${r.pick(GIVEN)[0]}`, text: line } };
	});
	const composeRecs = Array.from({ length: size.compose }, (_, i) => {
		const id = newId(), person = makePerson(r, "student");
		return { person, rec: { id, kind: "mail" as const, app: "mail", source: "zele", mailId: `compose-${id}`, ref: `compose-${id.toLowerCase()}`, compose: true, asksFile: true, to: person.addr, subject: "요청하신 자료 보내드립니다", body: "안녕하세요, 하늘 선생입니다.\n요청하신 자료를 보내드립니다.\n감사합니다.", status: "pending" as const, created: iso(base - 60_000 * (10 + i * 7)), changes: [], questions: [], item: { kind: "mail" as const, app: "mail", from: person.addr, text: "안녕하세요, 하늘 선생입니다.\n요청하신 자료를 보내드립니다.\n감사합니다." } } };
	});
	const allRecs = [...recs, ...kakaoRecs, ...composeRecs.map(c => c.rec)];
	const lost = await timed("drafts.store", () => {
		for (const d of allRecs) Drafts.addDraft(structuredClone(d));
		return allRecs.length - Drafts.listDrafts().filter(d => d.status === "pending").length;
	});
	await timed("drafts.direct", () => writeFileSync(Settings.paths.drafts(), `${JSON.stringify({ drafts: allRecs, keys: allRecs.map(d => d.ref) }, null, 1)}\n`, { mode: 0o600 }));

	// Mail rows show the draft chip: set through the real setter for the real-posted ones, baked in for the bulk ones.
	await timed("mail.suggest", () => {
		for (const d of recs) {
			const s = { kind: "reply-draft" as const, label: "답장 초안", ref: d.id, state: "draft" as const, at: d.created };
			if (realKeys.has(d.ref)) Mail.setMailSuggest(d.ref, s);
		}
	});
	await timed("mail.merge", () => {
		const merged = [...Mail.mailRecords(), ...bulk].sort((a, b) => a.at.localeCompare(b.at)).slice(-Mail.mailKeep());
		Cfg.writeAtomic(join(dir, "mail-conversations.json"), `${JSON.stringify(merged, null, 2)}\n`);
	});

	// Staged files for a few drafts, so their cards list attachments.
	const staged = recs.filter(d => d.app === "mail").slice(0, Math.max(3, Math.floor(recs.length / 20)));
	for (const d of staged) {
		const name = libraryNames(2)[0]!.name, file = join(dir, "draft-files", d.id, "0", name);
		mkdirSync(dirname(file), { recursive: true });
		copyFileSync(join(libs.local.dir, FILE_FOLDERS[0]!, name), file);
	}

	// Comment replies of YouTube and Instagram; the combined ones carry the mail draft of the commenter who also wrote a mail.
	const comments = await timed("comments", () => {
		const cs = CommentStore.createStore(CommentStore.commentsDir(dir));
		const sources = {
			youtube: { key: "youtube", kind: "youtube" as const, label: "유튜브 댓글", watch: ["*"], autoDraft: true, mailMatch: true, autoMail: true, mailApp: "mail" },
			instagram: { key: "instagram", kind: "instagram" as const, label: "인스타그램 댓글", watch: ["*"], autoDraft: true, mailMatch: true, autoMail: true, mailApp: "mail" },
		};
		cs.saveConfig({ enabled: true, sources });
		const wrote = specs.filter(s => !s.out && s.acct.inst === "mail" && s.needsReply && s.person.role === "student");
		const total = size.compose + size.commentOnly;
		const list: import("../../comments/contract.ts").Comment[] = [], drafts: import("../../comments/store.ts").Draft[] = [];
		const cards: { src: (typeof sources)[keyof typeof sources]; c: (typeof list)[number]; d: (typeof drafts)[number]; mail?: Rec }[] = [];
		type Rec = import("../../../features/reply-drafts/lib/store.ts").DraftRec;
		for (let i = 0; i < total * 2; i++) {
			const combined = i < size.compose, src = sources[i % 2 ? "instagram" : "youtube"], mailSpec = combined ? wrote[i % wrote.length] : undefined;
			const author = mailSpec ? mailSpec.person.name : `${r.pick(SURNAMES)}${r.pick(GIVEN)[0]}`, addr = mailSpec?.person.addr ?? "";
			const native = `n${i}`, at = base - 3_600_000 - i * 600_000;
			const c = { id: `cm:${src.key}:${native}`, source: src.key, native, thread: `p${i % 7}`, author, text: r.pick(COMMENT_TEXT).replace("{addr}", addr).trim(), postTitle: r.pick(POST_TITLES), at, mine: false, collector: src.key };
			list.push(c);
			if (i >= total) continue;
			const mail = combined ? composeRecs[i]!.rec : undefined;
			const notes = mailSpec ? Match.matchLines({ found: true, mail: { id: mailSpec.key, from: fromOf(mailSpec), subject: mailSpec.subject, snippet: "" }, score: { accepted: true, byName: true, reasons: [`보낸 사람 이름이 댓글 작성자(${author})와 같음`] }, answered: false, others: 0 }) : [];
			const d = { code: `CD${String(i).padStart(4, "0")}`, commentId: c.id, source: src.key, thread: c.thread, text: "관심 가져 주셔서 감사합니다!", status: "pending" as const, created: at + 60_000, changes: [], clean: false, notes, ...(mail ? { mail: mail.id, mailAt: at + 60_000 } : {}) };
			drafts.push(d);
			cards.push({ src, c, d, ...(mail ? { mail } : {}) });
		}
		cs.addComments(list);
		for (const d of drafts) cs.putDraft(d);
		return { total: list.length, drafts: drafts.length, combined: size.compose, cards };
	});

	// Notices: every card and mail through the real feed (they land the way the gateway makes them), captured as made, then the file written whole.
	const events: { ts: string; e: Record<string, unknown> }[] = [];
	const out = (ts: string, text: string) => events.push({ ts, e: { ts, kind: "out", source: "orchestrator", target: "alert", text } });
	for (const d of allRecs) if (!d.compose) out(d.created, Flow.askText(d, []));
	for (const k of comments.cards) out(iso(k.d.created), CommentAsk.commentAsk(k.src, k.c, k.d, undefined, k.mail ? Linked.mailPartOf(k.mail) : undefined));
	const mailRows = [...Mail.mailRecords(), ...bulk].filter(m => m.dir !== "out").sort((a, b) => a.at.localeCompare(b.at));
	// The store trims to NOTICE_CAP (300) and never drops an open decision, so once the 500 draft cards are in, every other new row is trimmed at
	// once. Mails and alerts are therefore fed first (oldest first, each captured as made), the cards after them; the rows written below are
	// every row the feed made, which the store alone could not hold (a finding: hub/notices-rules.ts NOTICE_CAP).
	const mailEvent = (m: (typeof mailRows)[number]) => ({ ts: m.at, e: { ts: m.at, kind: "mail", incoming: true, source: m.source, channel: `mail:${m.key}`, conv: `mail:${m.key}`, mail: m.key, subject: m.subject, from: m.from, ...(m.to ? { to: m.to } : {}), ...(m.cc ? { cc: m.cc } : {}), ...(m.summary ? { summary: m.summary } : {}), ...(m.preview ? { preview: m.preview } : {}), text: Mail.mailText({ from: m.from, subject: m.subject, ...(m.summary ? { summary: m.summary } : {}) }) } });
	const alerts = Math.min(20, Math.max(0, size.notices - events.length));
	for (let i = 0; i < alerts; i++) out(iso(base - 90_000 * (i + 1)), `${ALERTS[i % ALERTS.length]} (${i + 1})`);
	const alertEvents = events.splice(events.length - alerts, alerts);
	const first = [...mailRows.slice(-Math.max(0, size.notices - events.length - alerts)).map(mailEvent), ...alertEvents].sort((a, b) => a.ts.localeCompare(b.ts));
	events.sort((a, b) => a.ts.localeCompare(b.ts));
	const seen = new Set<string>(), made: (typeof Notices.items)[number][] = [];
	await timed("notices.feed", () => {
		for (const { e } of [...first, ...events]) {
			Notices.feed(e as import("../../events.ts").HubEvent);
			for (const n of Notices.items) if (!seen.has(n.id)) (seen.add(n.id), made.push(n));
		}
	});
	if (made.length !== size.notices) throw new Error(`seed: the feed made ${made.length} notices, wanted ${size.notices}`);
	const kept = Notices.items.length;
	for (const [i, n] of made.entries()) n.id = i.toString(16).padStart(8, "0");
	await timed("notices.direct", () => Cfg.writeAtomic(Cfg.paths.notices, `${JSON.stringify(made, null, 1)}\n`));

	const total = Object.values(timings).reduce((a, b) => a + b, 0);
	const manifest = {
		dir, scale, seed: SEED, base: nowIso,
		accounts: ACCOUNTS.map(a => ({ inst: a.inst, source: a.source, label: a.label, address: a.address, mails: specs.filter(s => s.acct === a).length, drafts: recs.filter(d => d.app === a.inst).length, attachFolder: a.inst === "mail" ? libs.local.dir : a.inst === "mail-beta" ? libs.library.dir : libs.folder.dir })),
		apps: [...ACCOUNTS.map(a => a.inst), "youtube", "instagram", "kakao"],
		counts: { mails: Math.min(Mail.mailKeep(), specs.length), mailsOut: specs.filter(s => s.out).length, draftsPending: allRecs.length, mailDrafts: recs.length, kakaoDrafts: kakaoRecs.length, composeDrafts: composeRecs.length, notices: made.length, comments: comments.total, commentDrafts: comments.drafts, combined: comments.combined },
		attachmentDirs: { local: libs.local.dir, icloudLibrary: libs.library.dir, icloudFolder: libs.folder.dir, fakeIcloud: join(dir, ...ICLOUD), notDownloaded: { library: libs.library.notDownloaded, folder: libs.folder.notDownloaded }, wantFiles: libs.library.wanted },
		ids: { newestMailKey: specs.at(-1)!.key, oldestMailKey: specs[0]!.key, draftedMailKey: wantDraft.at(-1)?.key, pendingDraftId: recs.at(-1)?.id, composeDraftId: composeRecs[0]?.rec.id, kakaoDraftId: kakaoRecs[0]?.id, combinedCommentDraft: comments.cards.find(k => k.mail)?.d.code },
		config: { "mail.keep": keep, "mail.own_addresses": ACCOUNTS.map(a => a.address), note: "zele.enabled (flag zele) turns the default mail instance on; the install config writer must keep mail.* above" },
		store: { mailRealPosts: realSet.length, mailBulk: bulk.length, postMailMsPerCallEvery100th: samples, draftsLostByStore: lost, draftsKeptByStore: allRecs.length - lost, noticesKeptByStore: kept, noticesMade: made.length },
		timingsMs: { ...timings, total },
	};
	writeJson(join(dir, "seed-manifest.json"), manifest);
	return manifest;
}

/** Reads the seeded dir back through the real readers (fresh process: nothing is cached from the seed). */
export async function verify(dirArg: string) {
	const dir = checkDir(dirArg);
	process.env.DOTZ_DIR = dir;
	const Mail = await import("../../mail.ts"), Drafts = await import("../../../features/reply-drafts/lib/store.ts"), Notices = await import("../../notices-store.ts");
	const Library = await import("../../../features/reply-drafts/lib/library.ts"), Settings = await import("../../../features/reply-drafts/lib/settings.ts"), CommentStore = await import("../../comments/store.ts");
	const Integrations = await import("../../integrations.ts");
	const cs = CommentStore.createStore(CommentStore.commentsDir(dir)), s = Settings.loadSettings(), recs = Mail.mailRecords();
	return {
		mails: recs.length, mailsOut: recs.filter(m => m.dir === "out").length, mailsBySource: Object.fromEntries(ACCOUNTS.map(a => [a.source, recs.filter(m => m.source === a.source).length])),
		mailsWithSuggest: recs.filter(m => m.suggest).length, draftsPending: Drafts.listDrafts().filter(d => d.status === "pending").length, kakaoDrafts: Drafts.listDrafts().filter(d => d.app === "kakao").length,
		composeDrafts: Drafts.listDrafts().filter(d => d.compose).length, notices: Notices.items.length, openDecisions: Notices.items.filter(n => n.decision?.state === "open").length,
		comments: cs.comments().length, commentDrafts: cs.drafts().length, combined: cs.drafts().filter(d => d.mail).length,
		apps: Integrations.appEntries(dir).map(e => e.key).sort(), library: Object.fromEntries(Object.entries(s.attachFolders ?? {}).map(([k, v]) => [k, Library.listLibrary(v).length])),
	};
}

if (import.meta.main) {
	const arg = (name: string): string | undefined => {
		const i = process.argv.indexOf(`--${name}`);
		return i < 0 ? undefined : process.argv[i + 1];
	};
	const dir = arg("dir"), scale = arg("scale") ?? "small";
	if (!dir || (scale !== "small" && scale !== "large")) {
		console.error("usage: bun hub/test/load-qa/seed.ts --dir /tmp/load-qa/<name> --scale small|large [--mail-real all] [--now <iso>] [--verify]");
		process.exit(2);
	}
	if (process.argv.includes("--verify")) {
		console.log(JSON.stringify(await verify(dir)));
		process.exit(0);
	}
	const m = await seed(dir, scale, { realMail: arg("mail-real") === "all" ? "all" : "auto", ...(arg("now") ? { now: arg("now")! } : {}) });
	const child = Bun.spawn([process.execPath, import.meta.path, "--verify", "--dir", dir], { stdout: "pipe", stderr: "inherit", env: { ...process.env, DOTZ_DIR: dir } });
	const read = JSON.parse(await new Response(child.stdout).text()) as Awaited<ReturnType<typeof verify>>;
	const want = [["mails", m.counts.mails], ["draftsPending", m.counts.draftsPending], ["notices", m.counts.notices], ["comments", m.counts.comments], ["commentDrafts", m.counts.commentDrafts], ["combined", m.counts.combined]] as const;
	const bad = want.filter(([k, v]) => read[k] !== v);
	console.log(JSON.stringify({ scale, counts: m.counts, read, timingsMs: m.timingsMs, store: m.store }));
	if ((await child.exited) !== 0 || bad.length) {
		console.error(`verify mismatch: ${bad.map(([k, v]) => `${k} seeded ${v} read ${read[k]}`).join("; ") || "child failed"}`);
		process.exit(1);
	}
	process.exit(0);
}
