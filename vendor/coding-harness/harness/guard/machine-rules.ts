import { readFileSync } from "node:fs";
import { join } from "node:path";
import { harnessDir } from "../agent-home.ts";
import { commandHead, shellSegments } from "./shell.ts";

const BUN_ONLY = "bun 전용 규칙: npm/pnpm/yarn 설치 대신 `bun install` / `bun add`(전역은 `bun add -g`)를 쓰세요.";
const NO_CHROME = "Chrome.app 실행 금지 규칙: Kaku 터미널에서 Chrome이 반복 크래시합니다. 웹 페이지는 aside CLI(aside-browser 스킬)를 쓰세요.";
const BOMBADIL_CHROME = "Bombadil은 CHROME이 없으면 /Applications/Google Chrome.app을 띄웁니다(Kaku에서 크래시). 같은 명령 앞에 CHROME=\"$(ls -d ~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64 | tail -1)/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing\"를 붙이고 --headless로 실행하세요(skill://bombadil Setup 참고).";

/** Which machine rules a host turned on in `<harnessDir()>/machine-rules.json`. */
export interface MachineRules {
	bunOnly: boolean;
	noChrome: boolean;
}

const ALL_OFF: MachineRules = { bunOnly: false, noChrome: false };

/** The rules switched on by `<harnessDir()>/machine-rules.json` (`{"bunOnly": boolean, "noChrome": boolean}`), read on every call. A missing, unparsable or wrongly shaped file turns every rule off. */
export function machineRules(): MachineRules {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(harnessDir(), "machine-rules.json"), "utf8"));
	} catch {
		return ALL_OFF;
	}
	if (typeof parsed !== "object" || parsed === null || !("bunOnly" in parsed) || !("noChrome" in parsed)) return ALL_OFF;
	if (typeof parsed.bunOnly !== "boolean" || typeof parsed.noChrome !== "boolean") return ALL_OFF;
	return { bunOnly: parsed.bunOnly, noChrome: parsed.noChrome };
}

/**
 * AGENTS.md machine rules, enforced for every agent on a machine whose `machine-rules.json` turns them on (see `machineRules`): bun is the only package manager (`bunOnly`), and Google Chrome.app must not be launched (`noChrome`; under the Kaku terminal it aborts in TransformProcessType and loop-crashes Chrome; use the aside CLI).
 * Matched on the command word of each simple command, so quoted mentions (rg 'npm install', commit messages) pass.
 */
export function machineRuleProblem(command: string): string | undefined {
	const { bunOnly, noChrome } = machineRules();
	if (!bunOnly && !noChrome) return undefined;
	for (const { words } of shellSegments(command)) {
		const found = commandHead(words);
		if (!found) continue;
		const verbs = found.args.map(a => a.text).filter(t => !t.startsWith("-"));
		if (bunOnly && (found.name === "npm" || found.name === "pnpm") && ["i", "install", "add", "ci"].includes(verbs[0])) return `orchestrator-guard: ${BUN_ONLY}`;
		if (bunOnly && found.name === "yarn" && (["install", "add"].includes(verbs[0]) || (verbs[0] === "global" && verbs[1] === "add"))) return `orchestrator-guard: ${BUN_ONLY}`;
		if (!noChrome) continue;
		if (found.head.includes("Google Chrome.app/Contents/MacOS/")) return `orchestrator-guard: ${NO_CHROME}`;
		if (found.name === "open" && found.args.some(a => /^Google Chrome(\.app)?\/?$|\/Google Chrome\.app\/?$|^com\.google\.Chrome$/.test(a.text))) return `orchestrator-guard: ${NO_CHROME}`;
		if (found.name === "bombadil" && found.args[0]?.text === "browser" && ["test", "fuzz"].includes(found.args[1]?.text ?? "")) {
			const chrome = /(?:^|[\s;&|])(?:export\s+)?CHROME=("[^"]*"|'[^']*'|\S+)/.exec(command)?.[1];
			if (!chrome || chrome.includes("Google Chrome.app/")) return `orchestrator-guard: ${BOMBADIL_CHROME}`;
		}
	}
	return undefined;
}
