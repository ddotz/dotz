/** The subcommands and value-taking flags that `omp --help` lists. */
export interface OmpHelp {
	readonly commands: readonly string[];
	readonly valueFlags: readonly string[];
}

/**
 * Reads the COMMANDS block and every flag written `--name=<value>` or `--name <value>` (with its short form) out of `omp --help` text. Commands keep help order, flags are sorted.
 * Fixture: `tests/fixtures/omp-help.txt`; a new omp version that changes either list fails the constants test until the constants below are updated.
 */
export function parseOmpHelp(text: string): OmpHelp {
	const lines = text.split("\n");
	const commands: string[] = [];
	const start = lines.indexOf("COMMANDS");
	if (start >= 0) {
		for (const line of lines.slice(start + 1)) {
			const m = /^ {2}([a-z][\w-]*)\s{2,}\S/.exec(line);
			if (!m) break;
			commands.push(m[1]);
		}
	}
	const flags = new Set<string>();
	for (const line of lines) {
		const m = /^\s+(?:(-[A-Za-z]),\s+)?(--[a-z][\w-]*)(?:=<[^>]+>|\s<[^>]+>)/.exec(line);
		if (!m) continue;
		if (m[1]) flags.add(m[1]);
		flags.add(m[2]);
	}
	return { commands, valueFlags: [...flags].sort() };
}

/** The omp (v19.1.1) subcommands, as `parseOmpHelp` reads them from `tests/fixtures/omp-help.txt`. */
export const OMP_COMMANDS: ReadonlySet<string> = new Set([
	"acp", "agents", "anonymize", "auth", "auth-broker", "auth-gateway", "bash", "bench", "browser-relay", "cleanse", "clip", "collab", "commit", "completions", "compress", "config", "dry-balance", "find", "gallery", "gc", "git", "grep", "grievances", "if-bench", "images", "install", "join", "login", "models", "play", "plugin", "predict", "ps", "read", "render", "say", "search", "session", "setup", "sh", "share", "shell", "skill", "ssh", "stats", "stream", "tiny-models", "token", "toks", "ttsr", "update", "usage", "worktree", "zsh",
]);

/** The omp (v19.1.1) flags that take a value, as `parseOmpHelp` reads them from `tests/fixtures/omp-help.txt`. */
export const OMP_VALUE_FLAGS: ReadonlySet<string> = new Set([
	"--add-dir", "--alias", "--api-key", "--append-system-prompt", "--approval-mode", "--config", "--cwd", "--export", "--extension", "--goal", "--hook", "--max-cost", "--max-fps", "--max-time", "--mode", "--model", "--models", "--motion", "--plan", "--plan-yolo-into", "--plugin-dir", "--prewalk-into", "--profile", "--provider", "--restore", "--resume", "--service-tier", "--session-dir", "--skills", "--slow", "--smol", "--spinner-interval", "--system-prompt", "--system-prompt-template", "--thinking", "--tools", "--warn-cost", "-e", "-r",
]);

/** Where an `omp` start should run: `here` in the folder as typed (with the reason), in a new `checkout`, `continue` the last checkout's session, or `resume` the session `id`. */
export type ArgvClass =
	| { readonly kind: "here"; readonly why: string }
	| { readonly kind: "checkout" }
	| { readonly kind: "continue" }
	| { readonly kind: "resume"; readonly id: string };

const HERE_LONG: ReadonlyMap<string, string> = new Map([
	["--print", "print mode"],
	["--mode", "--mode"],
	["--cwd", "--cwd"],
	["--no-session", "--no-session"],
	["--session-dir", "--session-dir"],
	["--export", "--export"],
	["--fork", "--fork"],
	["--from-claude", "--from-claude"],
	["--from-codex", "--from-codex"],
	["--alias", "--alias"],
	["--help", "--help"],
	["--version", "--version"],
]);

const HERE_SHORT: ReadonlyMap<string, string> = new Map([
	["p", "print mode"],
	["h", "--help"],
	["V", "--version"],
]);

const here = (why: string): ArgvClass => ({ kind: "here", why });

/**
 * Decides from the arguments and environment of an `omp` start where it runs. `here` for env `DOTZ_LANE` or `OMP_CHECKOUT_OFF` set (non-empty), `DOTZ_ORCHESTRATOR=1`, a first positional that is in `commands`, and the flags print, mode, cwd, no-session, session-dir, export, fork, from-claude, from-codex, help, version.
 * `-c`/`--continue` is `continue`; `-r`/`--resume`/`--restore` followed by an id (`--resume=id` too) is `resume`, without an id (the picker) `here`. Any other start is `checkout`. The value of a value-taking flag is never read as a subcommand or prompt.
 */
export function classifyArgv(argv: readonly string[], commands: ReadonlySet<string>, env: Readonly<Record<string, string | undefined>>): ArgvClass {
	if (env.DOTZ_LANE) return here("DOTZ_LANE is set");
	if (env.DOTZ_ORCHESTRATOR === "1") return here("DOTZ_ORCHESTRATOR=1");
	if (env.OMP_CHECKOUT_OFF) return here("OMP_CHECKOUT_OFF is set");
	let continuing = false;
	let resumeId: string | undefined;
	let positionals = 0;
	let rest = false;
	const takeValue = (i: number): string | undefined => {
		const next = argv[i + 1];
		return next === undefined || next === "" || next.startsWith("-") ? undefined : next;
	};
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (!rest && tok === "--") {
			rest = true;
			continue;
		}
		if (rest || !tok.startsWith("-") || tok === "-") {
			positionals++;
			if (!rest && positionals === 1 && commands.has(tok)) return here(`subcommand ${tok}`);
			continue;
		}
		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			const name = eq < 0 ? tok : tok.slice(0, eq);
			const inline = eq < 0 ? undefined : tok.slice(eq + 1);
			const reason = HERE_LONG.get(name);
			if (reason) return here(reason);
			if (name === "--continue") {
				continuing = true;
				continue;
			}
			if (name === "--resume" || name === "--restore") {
				const id = inline ?? takeValue(i);
				if (!id) return here(`${name} without an id opens the picker`);
				if (inline === undefined) i++;
				resumeId = id;
				continue;
			}
			if (inline === undefined && OMP_VALUE_FLAGS.has(name)) i++;
			continue;
		}
		const shorts = tok.slice(1);
		for (const letter of shorts) {
			const reason = HERE_SHORT.get(letter);
			if (reason) return here(reason);
		}
		if (shorts === "c") continuing = true;
		else if (shorts === "r") {
			const id = takeValue(i);
			if (!id) return here("-r without an id opens the picker");
			i++;
			resumeId = id;
		} else if (shorts === "e") i++;
	}
	if (resumeId !== undefined) return { kind: "resume", id: resumeId };
	return continuing ? { kind: "continue" } : { kind: "checkout" };
}
