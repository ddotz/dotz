// On an install that is not a developer checkout (hub/selfupdate-local.ts lockedCodeDir), the orchestrator, lanes and their workers
// do not change the dotz code folder: a commit there later conflicts with every update. Pure checks, shared by the omp/OmO extension
// (extension/index.ts) and the Claude Code deny hook (hub/runtime/claude-deny-hook.ts).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const CODE_LOCK_REASON = "이 설치의 dotz 코드는 고치지 않아요. 개인 설정은 ~/.dotz/custom, features, RULES.md에 넣어요. 모두에게 필요한 수정은 보고로 남겨요.";

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch"]);
const SHELL_TOOLS = new Set(["bash", "eval"]);
// git [-C dir] [-c k=v] [--opt] <history-changing subcommand>
const GIT_CHANGE = /\bgit\b(?:\s+(?:-[Cc]\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*\s+(?:commit|am|cherry-pick|merge|rebase)(?![\w-])/;

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

// Why this tool call is refused, or undefined. `dir`: the locked code folder; `cwd`: where the call runs.
export function codeLockReason(tool: string, input: Record<string, unknown> | undefined, cwd: string, dir: string): string | undefined {
	const name = tool.toLowerCase();
	const root = real(dir);
	if (EDIT_TOOLS.has(name)) {
		const raw = input?.path ?? input?.file_path ?? input?.notebook_path;
		if (typeof raw !== "string" || !raw) return undefined;
		const path = raw.replace(/^~(?=\/|$)/, homedir());
		return inside(resolve(cwd, path), root) ? CODE_LOCK_REASON : undefined;
	}
	if (!SHELL_TOOLS.has(name)) return undefined;
	const text = String(input?.command ?? input?.code ?? "");
	if (!GIT_CHANGE.test(text)) return undefined;
	const home = homedir();
	const names = [dir, root].flatMap(d => (d.startsWith(`${home}/`) ? [d, `~${d.slice(home.length)}`, `$HOME${d.slice(home.length)}`] : [d]));
	return inside(String(input?.cwd ?? cwd), root) || names.some(n => text.includes(n)) ? CODE_LOCK_REASON : undefined;
}
