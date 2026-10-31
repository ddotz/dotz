// 자동 초안 규칙 CLI the bot runs when the owner manages them in a conversation: the same store and validation as the mail settings screen
// (hub/app-settings.ts draft_rules / draft_default through writeSettings), so a rule made here shows there at once and the other way round.
import { readSettings, writeSettings, type DraftRule } from "../../../hub/app-settings.ts";
import { appEntries } from "../../../hub/integrations.ts";
import { dataDir } from "../lib/settings.ts";

export const USAGE = [
	"usage: rules.ts list [--app <mail instance>]",
	"  add --name <badge> --when <condition> [--how <instruction>] [--file <name or path>]... [--off] [--app <mail instance>]",
	"  edit <id> [--name ..] [--when ..] [--how ..] [--file ..]... [--no-files] [--on|--off] [--app ..]",
	"  remove <id> [--app ..]",
	"  default [--set <text> | --clear] [--app ..]   (the 기본 규칙 every draft of the app follows; no flag prints it)",
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

export function runRules(args: string[], dir: string = dataDir()): Out {
	const [cmd, ...rest] = args;
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
