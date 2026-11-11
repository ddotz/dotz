// `bun hub/mailbox-cli.ts fold`: an install that split one mail account into app instances by `filter.source` turns them into mailboxes of one instance,
// as data only (docs/mailbox.md "Folding per-source instances"). Without --apply it prints the plan and writes nothing. --apply keeps a backup and
// `undo <backup dir>` puts everything back. Stored mail is never rewritten: a `conds.src` box reads old mail by its source. Gateway off or on: it reads the files by mtime.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomic } from "./config.ts";
import type { AppRaw } from "./integrations.ts";
import { BASE_ID, cleanBox, loadMailboxes, saveMailboxes, type Box, type Mailboxes } from "./mailbox.ts";

const USAGE = "usage: mailbox-cli.ts fold [--base <instance>] [--from <instance,instance>] [--apply] [--data <dir>]\n       mailbox-cli.ts undo <backup dir> [--data <dir>]";
const APPS = "custom/apps.json", BOXES = "custom/mailboxes.json", DRAFTS = "custom/reply-drafts/config.json";
const toneOf = (instance: string) => `custom/reply-drafts/tone/${instance}.md`;
const NOT_CARRIED = ["discord", "delete_original", "push", "off"] as const;

type Drafts = { draftDefaults?: Record<string, unknown>; draftRules?: Record<string, unknown>; attachFolders?: Record<string, unknown> };
export type FoldPlan = { into: string; base?: string; boxes: Box[]; apps: Record<string, AppRaw>; removed: string[]; tones: { from: string; to: string }[]; notes: string[] };

const fileJson = <T>(file: string, empty: T): T => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : empty);
const flag = (args: string[], name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const isMail = (id: string, r: AppRaw) => r && typeof r === "object" && !r.deleted && (r.app === "mail" || id === "mail");

/** The plan as data. `from` defaults to every other mail instance with a `filter.source` on the same account as `into`. `base` folds into 일반 instead of a box of its own. */
export function foldPlan(apps: Record<string, AppRaw>, drafts: Drafts, opts: { into: string; base?: string; from?: string[] }, toneExists: (instance: string) => boolean): FoldPlan {
	const target = apps[opts.into];
	if (!target || !isMail(opts.into, target)) throw new Error(`메일 앱이 아니거나 없는 앱이에요: ${opts.into}`);
	// Mail of a source no instance claims reads as the default `mail`, and only an instance without a source of its own lists it.
	if (opts.into !== "mail" || target.filter?.source) throw new Error("합치는 곳은 출처가 따로 없는 기본 mail 앱이어야 해요");
	const account = target.filter?.account;
	const from = opts.from ?? Object.keys(apps).filter(id => id !== opts.into && isMail(id, apps[id]!) && !!apps[id]!.filter?.source && apps[id]!.filter?.account === account);
	if (!from.length) throw new Error("합칠 메일 앱이 없어요");
	if (opts.base && !from.includes(opts.base)) throw new Error(`--base는 합칠 앱 중 하나여야 해요: ${opts.base}`);
	const boxes: Box[] = [], tones: FoldPlan["tones"] = [], notes: string[] = [], watches = new Set(target.watches ?? []);
	for (const id of from) {
		const r = apps[id];
		if (!r || !isMail(id, r)) throw new Error(`메일 앱이 아니거나 없는 앱이에요: ${id}`);
		if (r.filter?.account !== account) throw new Error(`다른 계정의 앱은 합칠 수 없어요: ${id}`);
		const base = id === opts.base, boxId = base ? BASE_ID : id.replace(/^mail-/, "");
		// What an instance shared with the target stays inherited; one that differs keeps exactly its own, so no mail starts following rules it did not follow before.
		const own = (k: keyof Drafts) => JSON.stringify(drafts[k]?.[id] ?? null), same = (k: keyof Drafts) => own(k) === JSON.stringify(drafts[k]?.[opts.into] ?? null);
		const inherit = same("draftDefaults") && same("draftRules") && same("attachFolders");
		const box = cleanBox({ id: boxId, base, name: base ? "일반" : (r.label ?? boxId), ...(r.notify === false ? { notify: false } : {}), conds: { src: !base && r.filter?.source ? [r.filter.source] : [] }, ...(inherit ? {} : { alone: true,
			how: drafts.draftDefaults?.[id] ?? "", rules: drafts.draftRules?.[id] ?? [], folders: typeof drafts.attachFolders?.[id] === "string" ? [drafts.attachFolders[id]] : [] }) });
		if (!box) throw new Error(`메일함을 만들 수 없어요: ${id}`);
		boxes.push(box);
		for (const w of [...(r.watches ?? []), ...(r.filter?.watches ?? [])]) watches.add(w);
		if (toneExists(id)) tones.push({ from: toneOf(id), to: `custom/reply-drafts/tone/${opts.into}/${boxId}.md` });
		for (const k of NOT_CARRIED) if (r[k] !== undefined) notes.push(`${id}의 ${k} 설정은 옮기지 않아요. ${opts.into} 앱 설정에서 다시 확인해요.`);
	}
	const next = Object.fromEntries(Object.entries(apps).filter(([id]) => !from.includes(id)));
	next[opts.into] = { ...target, ...(watches.size ? { watches: [...watches] } : {}) };
	return { into: opts.into, ...(opts.base ? { base: opts.base } : {}), boxes, apps: next, removed: from, tones, notes };
}

/** Where a plan leaves the store: its boxes on the account, boxes it does not name kept. */
export function foldedStore(store: Mailboxes, plan: FoldPlan): Mailboxes {
	const had = store.accounts[plan.into]?.boxes ?? [], ids = new Set(plan.boxes.map(b => b.id));
	return { ...store, accounts: { ...store.accounts, [plan.into]: { boxes: [...plan.boxes.filter(b => b.base), ...had.filter(b => !ids.has(b.id)), ...plan.boxes.filter(b => !b.base)] } } };
}

/** Applies a plan: a backup folder first, then apps.json, mailboxes.json and the copied tone files. The old tone files stay for drafts still waiting. Returns the backup folder. */
export function applyFold(dir: string, plan: FoldPlan, stamp: string): string {
	const backup = join(dir, "custom", `mailbox-fold-${stamp}`);
	mkdirSync(backup, { recursive: true });
	const had = existsSync(join(dir, BOXES));
	copyFileSync(join(dir, APPS), join(backup, "apps.json"));
	if (had) copyFileSync(join(dir, BOXES), join(backup, "mailboxes.json"));
	const tones = plan.tones.filter(t => !existsSync(join(dir, t.to)));
	writeAtomic(join(backup, "manifest.json"), `${JSON.stringify({ boxes: had, tones: tones.map(t => t.to) }, null, 2)}\n`);
	for (const t of tones) {
		mkdirSync(dirname(join(dir, t.to)), { recursive: true });
		copyFileSync(join(dir, t.from), join(dir, t.to));
	}
	saveMailboxes(dir, foldedStore(loadMailboxes(dir), plan));
	writeAtomic(join(dir, APPS), `${JSON.stringify(plan.apps, null, 2)}\n`);
	return backup;
}

export function undoFold(dir: string, backup: string): void {
	const m = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")) as { boxes: boolean; tones: string[] };
	copyFileSync(join(backup, "apps.json"), join(dir, APPS));
	if (m.boxes) copyFileSync(join(backup, "mailboxes.json"), join(dir, BOXES));
	else rmSync(join(dir, BOXES), { force: true });
	for (const t of m.tones) rmSync(join(dir, t), { force: true });
}

const describe = (p: FoldPlan): string[] => [
	`${p.removed.join(", ")} -> ${p.into}`,
	...p.boxes.map(b => `  ${b.base ? "[기본] " : ""}${b.name} (${b.id}): 출처 ${b.conds.src.join(", ") || "없음"}, ${b.alone ? `자기 지시 ${b.how ? "있음" : "없음"}, 규칙 ${b.rules.length}개, 폴더 ${b.folders.length}곳` : `${p.into} 설정을 그대로 따름`}`),
	...p.tones.map(t => `  말투 복사: ${t.from} -> ${t.to}`),
	...p.notes.map(n => `  확인: ${n}`),
];

export function run(args: string[], dataDir: string, stamp: string): { lines: string[]; code: number } {
	const [cmd, arg] = args, dir = flag(args, "--data") ?? dataDir;
	if (cmd === "undo" && arg) {
		undoFold(dir, arg);
		return { lines: [`되돌렸어요: ${arg}`], code: 0 };
	}
	if (cmd !== "fold") return { lines: [USAGE], code: 2 };
	try {
		const from = flag(args, "--from")?.split(",").map(s => s.trim()).filter(Boolean), base = flag(args, "--base");
		const plan = foldPlan(fileJson<Record<string, AppRaw>>(join(dir, APPS), {}), fileJson<Drafts>(join(dir, DRAFTS), {}), { into: "mail", ...(base ? { base } : {}), ...(from ? { from } : {}) }, id => existsSync(join(dir, toneOf(id))));
		if (!args.includes("--apply")) return { lines: [...describe(plan), "시험 실행이라 아무것도 바꾸지 않았어요. 바꾸려면 --apply를 붙여요."], code: 0 };
		return { lines: [...describe(plan), `옮겼어요. 되돌리려면: bun hub/mailbox-cli.ts undo ${applyFold(dir, plan, stamp)}`], code: 0 };
	} catch (e) {
		return { lines: [(e as Error).message], code: 2 };
	}
}

if (import.meta.main) {
	const { DATA_DIR } = await import("./config.ts");
	const out = run(process.argv.slice(2), DATA_DIR, new Date().toISOString().replace(/\D/g, "").slice(0, 14));
	console.log(out.lines.join("\n"));
	process.exit(out.code);
}
