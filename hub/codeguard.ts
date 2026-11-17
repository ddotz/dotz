// On an install that is not a developer checkout (hub/selfupdate-local.ts lockedCodeDir), the orchestrator, lanes and their workers
// do not change the dotz code folder: a commit there later conflicts with every update. Pure checks, shared by the omp/OmO extension
// (extension/index.ts) and the Claude Code deny hook (hub/runtime/claude-deny-hook.ts).
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const CODE_LOCK_REASON = "이 설치의 dotz 코드는 고치지 않아요. 개인 설정은 ~/.dotz/custom, features, RULES.md에 넣어요. 모두에게 필요한 수정은 보고로 남겨요.";

const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "notebook_edit", "apply_patch", "ast_edit"]);
const SHELL_TOOLS = new Set(["bash", "eval"]);
// git [-C dir] [-c k=v] [--opt] <history-changing subcommand>
const GIT_CHANGE = /\bgit\b(?:\s+(?:-[Cc]\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*\s+(?:commit|am|cherry-pick|merge|rebase)(?![\w-])/;

const SECTION = /^\[([^\]\n]+?)(?:#[^\]\n]*)?\][ \t]*$/;
const PATCH_FILE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to|Edit File):[ \t]*(.+?)(?: all)?[ \t]*$/;
const MOVE_TO = /^MV[ \t]+(\S.*?)[ \t]*$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const texts = (value: unknown): string[] => (typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

const real = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
};
const inside = (path: string, dir: string): boolean => {
	const p = resolve(path);
	return [p, real(p)].some(x => x === dir || x.startsWith(`${dir}/`));
};

function unwrap(tool: string, input: unknown): { name: string; fields: Record<string, unknown> } | undefined {
	const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	if (!WRITE_TOOLS.has(tool.toLowerCase())) return undefined;
	const device = /^xd:\/\/([\w-]+)/.exec(String(fields.path ?? ""))?.[1];
	if (!device) return { name: tool.toLowerCase(), fields };
	try {
		return unwrap(device, JSON.parse(String(fields.content)));
	} catch {
		return undefined;
	}
}

/** The local files a write-capable tool call names, whatever its edit mode: `path`, `file_path`, `notebook_path` and `paths[]`, the `[PATH#TAG]` section headers and `MV` destination of omp's hashline `input`, the `*** Add/Update/Delete File`, `*** Move to` and `*** Edit File` lines of an apply_patch or sloppy `input`, a patch-mode `rename`, and the arguments of a tool written to through `xd://<tool>`. Other tools and internal URLs name none. */
export function writtenPaths(tool: string, input: unknown): string[] {
	const call = unwrap(tool, input);
	if (!call) return [];
	const { fields } = call;
	const found = [...texts(fields.path), ...texts(fields.file_path), ...texts(fields.notebook_path), ...texts(fields.paths)].map(p => SECTION.exec(p.trim())?.[1] ?? p);
	if (Array.isArray(fields.edits)) for (const edit of fields.edits) found.push(...texts((edit as { rename?: unknown } | null)?.rename));
	for (const line of typeof fields.input === "string" ? fields.input.split("\n") : []) {
		const text = line.replace(/\r$/, "");
		const named = SECTION.exec(text)?.[1] ?? PATCH_FILE.exec(text)?.[1] ?? MOVE_TO.exec(text)?.[1];
		if (named) found.push(named.trim().replace(/^(["'])(.*)\1$/, "$2"));
	}
	return [...new Set(found.map(p => p.trim()).filter(p => p && !URL_SCHEME.test(p)))];
}

const GLOB_CHAR = /[*?[{]/;

/** The folders an ast_edit call may rewrite under, absolute: each `paths` entry that is a folder, the fixed prefix of a glob, and the cwd when `paths` is missing or empty (omp then searches the cwd tree). Files and other tools give none. */
export function writeScopes(tool: string, input: unknown, cwd: string): string[] {
	const call = unwrap(tool, input);
	if (call?.name !== "ast_edit") return [];
	const given = texts(call.fields.paths).map(p => p.trim()).filter(Boolean);
	if (!given.length) return [resolve(cwd)];
	const scopes: string[] = [];
	for (const raw of given) {
		if (URL_SCHEME.test(raw)) continue;
		const path = raw.replace(/^~(?=\/|$)/, homedir());
		if (GLOB_CHAR.test(path)) {
			const segments = path.split("/");
			const first = segments.findIndex(s => GLOB_CHAR.test(s));
			scopes.push(resolve(cwd, segments.slice(0, first).join("/") || (path.startsWith("/") ? "/" : ".")));
		} else if (statSync(resolve(cwd, path), { throwIfNoEntry: false })?.isDirectory()) scopes.push(resolve(cwd, path));
	}
	return scopes;
}

/** Whether an ast_edit folder scope and a protected folder or file share ground: the scope sits inside it or contains it. */
export const scopeReaches = (scope: string, target: string): boolean => inside(scope, target) || inside(target, scope);

// Why this tool call is refused, or undefined. `dir`: the locked code folder; `cwd`: where the call runs.
export function codeLockReason(tool: string, input: Record<string, unknown> | undefined, cwd: string, dir: string): string | undefined {
	const name = tool.toLowerCase();
	const root = real(dir);
	if (WRITE_TOOLS.has(name)) {
		const reached = (raw: string) => inside(resolve(cwd, raw.replace(/^~(?=\/|$)/, homedir())), root);
		const locked = writtenPaths(name, input).some(reached) || writeScopes(name, input, cwd).some(scope => scopeReaches(scope, root));
		return locked ? CODE_LOCK_REASON : undefined;
	}
	if (!SHELL_TOOLS.has(name)) return undefined;
	const text = String(input?.command ?? input?.code ?? "");
	if (!GIT_CHANGE.test(text)) return undefined;
	const home = homedir();
	const names = [dir, root].flatMap(d => (d.startsWith(`${home}/`) ? [d, `~${d.slice(home.length)}`, `$HOME${d.slice(home.length)}`] : [d]));
	return inside(String(input?.cwd ?? cwd), root) || names.some(n => text.includes(n)) ? CODE_LOCK_REASON : undefined;
}
