// 자동 초안 규칙 CLI the bot runs when the owner manages them in a conversation: the same store and validation as the mail settings screen
// (hub/app-settings.ts draft_rules / draft_default through writeSettings), so a rule made here shows there at once and the other way round.
import { readSettings, writeSettings, type DraftRule } from "../../../hub/app-settings.ts";
import { appEntries } from "../../../hub/integrations.ts";
import { migrateLedger, moveHandRules, previewMigration, readLedger, undoLedger } from "../lib/ledger.ts";
import { dataDir } from "../lib/settings.ts";

export const USAGE = [
	"usage: rules.ts list [--app <mail instance>]",
	"  add --name <badge> --when <condition> [--how <instruction>] [--file <name or path>]... [--off] [--app <mail instance>]",
	"  edit <id> [--name ..] [--when ..] [--how ..] [--file ..]... [--no-files] [--on|--off] [--app ..]",
	"  remove <id> [--app ..]",
	"  default [--set <text> | --clear] [--app ..]   (the 기본 규칙 every draft of the app follows; no flag prints it)",
	"  ledger [--json]   (every record of the rule ledger: id, state, scope, kind, text)",
	"  migrate [--preview] | undo | hand   (move every rule into the ledger once, with a backup; --preview only prints per file the lines that would move and the records the ledger would get / put the files back byte for byte and remove the ledger / move the rules written by hand into tone files into the ledger)",
	"  --app: mail (default) or an instance id like mail-2. --file: a file of the app's 첨부 파일 폴더 (name or path inside it) or a full path; none = the folder's best match",
].join("\n");

type Out = { lines: string[]; code: number };

const flag = (args: string[], name: string): string | undefined => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const BARE = new Set(["--off", "--on", "--no-files", "--clear"]);
const flags = (args: string[], name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []));

const show = (r: DraftRule): string => [`${r.id} [${r.on ? "켜짐" : "꺼짐"}] ${r.name}`, `  언제: ${r.when}`, ...(r.how ? [`  어떻게: ${r.how}`] : []), ...(r.files.length ? [`  붙일 파일: ${r.files.join(", ")}`] : [])].join("\n");

const scopeName = (s: { app?: string; room?: string; to?: string; request?: string }): string => [s.app ?? "모두", s.room, s.to, s.request].filter(Boolean).join("/");

function ledgerCommand(cmd: string | undefined, rest: string[], dir: string): Out | undefined {
	switch (cmd) {
		case "ledger": {
			const all = readLedger(dir);
			return { lines: rest.includes("--json") ? [JSON.stringify(all, null, 1)] : all.length ? all.map(r => `${r.id} [${r.state}${r.into ? ` → ${r.into}` : ""}] ${scopeName(r.scope)} · ${r.kind} · ${r.text}`) : ["장부에 규칙이 없어요"], code: 0 };
		}
		case "migrate": {
			if (rest.includes("--preview")) {
				const plan = previewMigration(dir);
				return { lines: plan ? [...plan.files.flatMap(f => [`${f.file}: 옮길 규칙 ${f.lines.length}줄`, ...f.lines.map(l => `  ${l.kind} · ${l.text}`)]), "장부에 생길 기록:", ...plan.records.map(r => `  ${scopeName(r.scope)} · ${r.kind} · ${r.texts}줄`)] : ["옮길 규칙이 없거나 이미 옮겼어요"], code: 0 };
			}
			const done = migrateLedger(dir);
			return { lines: [done ? `규칙 ${done.records}개를 장부로 옮겼어요. 바뀐 파일 ${done.files.length}개는 ledger-backup에 복사해 뒀어요 (되돌리기: rules.ts undo)` : "옮길 규칙이 없거나 이미 옮겼어요"], code: 0 };
		}
		case "undo": {
			const files = undoLedger(dir);
			return { lines: [files ? `파일 ${files.length}개를 그대로 되돌리고 장부를 지웠어요: ${files.join(", ")}` : "되돌릴 이전 기록이 없어요"], code: files ? 0 : 1 };
		}
		case "hand":
			return { lines: [`손으로 쓴 규칙 ${moveHandRules(dir)}개를 장부로 옮겼어요`], code: 0 };
	}
}

export function runRules(args: string[], dir: string = dataDir()): Out {
	const [cmd, ...rest] = args;
	const ledger = ledgerCommand(cmd, rest, dir);
	if (ledger) return ledger;
	const app = flag(rest, "--app") ?? "mail";
	if (app.split("-")[0] !== "mail" || !appEntries(dir).some(e => e.key === app && !e.gone)) return { lines: [`메일 앱이 아니거나 없는 앱이에요: ${app}`], code: 2 };
	const views = readSettings(dir, app);
	const rules = (views.find(v => v.key === "draft_rules")?.value ?? []) as DraftRule[];
	const base = String(views.find(v => v.key === "draft_default")?.value ?? "");
	const save = (values: Record<string, unknown>): DraftRule[] => (writeSettings(dir, app, values).find(v => v.key === "draft_rules")?.value ?? []) as DraftRule[];
	const id = rest.find((a, i) => !a.startsWith("--") && (i === 0 || !rest[i - 1]!.startsWith("--") || BARE.has(rest[i - 1]!)));
	try {
		switch (cmd) {
			case "list":
				return { lines: [`${app} 기본 규칙: ${base || "없음"}`, ...(rules.length ? rules.map(show) : ["자동 초안 규칙이 없어요"])], code: 0 };
			case "add": {
				const name = flag(rest, "--name"), when = flag(rest, "--when");
				if (!name || !when) return { lines: [USAGE], code: 2 };
				const after = save({ draft_rules: [...rules, { name, when, how: flag(rest, "--how") ?? "", files: flags(rest, "--file"), on: !rest.includes("--off") }] });
				return { lines: [`규칙을 만들었어요`, show(after[after.length - 1]!)], code: 0 };
			}
			case "edit": {
				const old = rules.find(r => r.id === id);
				if (!old) return { lines: [id ? `규칙 ${id}을(를) 찾지 못했어요` : USAGE], code: id ? 1 : 2 };
				const files = rest.includes("--no-files") ? [] : flags(rest, "--file").length ? flags(rest, "--file") : old.files;
				const next = { ...old, name: flag(rest, "--name") ?? old.name, when: flag(rest, "--when") ?? old.when, how: flag(rest, "--how") ?? old.how, files, on: rest.includes("--off") ? false : rest.includes("--on") ? true : old.on };
				const after = save({ draft_rules: rules.map(r => (r.id === old.id ? next : r)) });
				return { lines: [`규칙을 고쳤어요`, show(after.find(r => r.id === old.id)!)], code: 0 };
			}
			case "remove": {
				const old = rules.find(r => r.id === id);
				if (!old) return { lines: [id ? `규칙 ${id}을(를) 찾지 못했어요` : USAGE], code: id ? 1 : 2 };
				save({ draft_rules: rules.filter(r => r.id !== old.id) });
				return { lines: [`규칙 ${old.id} ${old.name}을(를) 지웠어요`], code: 0 };
			}
			case "default": {
				const set = rest.includes("--clear") ? "" : flag(rest, "--set");
				if (set === undefined) return { lines: [`${app} 기본 규칙: ${base || "없음"}`], code: 0 };
				save({ draft_default: set });
				return { lines: [set ? `기본 규칙을 저장했어요: ${set.trim()}` : "기본 규칙을 비웠어요"], code: 0 };
			}
			default:
				return { lines: [USAGE], code: 2 };
		}
	} catch (e) {
		return { lines: [`저장하지 못했어요: ${(e as Error).message}`], code: 1 };
	}
}

if (import.meta.main) {
	const out = runRules(process.argv.slice(2));
	for (const l of out.lines) (out.code === 0 ? console.log : console.error)(l);
	process.exit(out.code);
}
