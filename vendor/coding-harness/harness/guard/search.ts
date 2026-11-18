import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { commandHead, expandShellVars, shellSegments, type ShellWord } from "./shell.ts";

function broadPath(raw: string): string | undefined {
	const home = homedir();
	const expanded = raw.trim().replace(/^~(?=\/|$)/, home).replace(/^\$\{HOME\}|^\$HOME(?![A-Za-z0-9_])/, home);
	if (!expanded.startsWith("/")) return undefined;
	const normalized = resolve(expanded);
	const roots = ["/", "/Users", home, join(home, "Library"), join(home, "Library", "Application Support")];
	return roots.includes(normalized) ? normalized : undefined;
}

function recursiveSearch(words: ShellWord[]): { name: string; args: ShellWord[] } | undefined {
	const found = commandHead(words);
	if (!found) return undefined;
	const { name, args } = found;
	const has = (re: RegExp) => args.some(a => re.test(a.text));
	if (["rg", "find", "du", "fd", "fdfind"].includes(name)) return { name, args };
	if (["grep", "egrep", "fgrep", "zgrep"].includes(name) && (has(/^-[A-Za-z]*[rR]/) || has(/^--(dereference-)?recursive$/))) return { name, args };
	if (name === "ls" && (has(/^-[A-Za-z]*R/) || has(/^--recursive$/))) return { name, args };
	return undefined;
}

/**
 * Why a grep/glob path or a recursive shell search is refused, or undefined. A path with an unquoted space splits into
 * "/Users/you/Library" + "Support/..."; a recursive search of the broad prefix once grew an omp process to 22GB, and these
 * paths are searched only by mistake.
 */
export function broadSearchProblem(toolName: string, input: unknown): string | undefined {
	const how = "경로를 따옴표로 감싸거나(공백 포함 경로가 쪼개집니다) 구체적인 하위 폴더를 쓰세요.";
	const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	const tool = toolName.toLowerCase();
	if (tool === "grep" || tool === "glob") {
		if (typeof record.path !== "string") return undefined;
		for (const part of record.path.split(";")) {
			const broad = broadPath(part);
			if (broad) return `orchestrator-guard: ${tool} 경로 "${part.trim()}" (${broad})는 너무 넓어서 막았어요. 전체를 재귀 탐색하면 메모리가 폭주합니다. ${how}`;
		}
		return undefined;
	}
	if (tool !== "bash" || typeof record.command !== "string") return undefined;
	const command = record.command;
	for (const { words } of shellSegments(command)) {
		const found = recursiveSearch(words);
		if (!found) continue;
		const unquoted = found.args.find(a => a.expands);
		if (unquoted) return `orchestrator-guard: \`${found.name}\` 재귀 탐색 인자 \`${unquoted.text}\`에 따옴표 없는 쉘 확장이 있어 막았어요. 값에 공백이 있으면 쪼개져 ~/Library 같은 넓은 경로를 통째로 훑습니다. 확장을 큰따옴표로 감싸세요(예: "$VAR"), ${how}`;
		for (const arg of found.args) {
			const broad = broadPath(expandShellVars(arg.text));
			if (broad) return `orchestrator-guard: \`${found.name}\` 경로 "${arg.text}" (${broad})는 너무 넓어서 막았어요. 전체를 재귀 탐색하면 메모리가 폭주합니다. ${how}`;
		}
	}
	return undefined;
}
