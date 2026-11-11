// Entry of `dotz status` and `dotz restart` (hub/dotz-command.ts runs it with bun). Only node builtins and onboard/ modules are imported, never hub/config.ts:
// the command must start fast and must work when the gateway's config or data would not load. The data dir and port are read the way the launcher sets them up.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { EXIT, parseArgs, restartCommand, statusCommand, USAGE, type Deps } from "./dotz-ctl.ts";

const dir = process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
const text = (file: string): string | undefined => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined; // no such file is a normal answer here (no token yet, no config yet)
	}
};

const configuredPort = (): number => {
	try {
		return Number((JSON.parse(text(join(dir, "config.json")) ?? "{}") as { web?: { port?: number } }).web?.port);
	} catch {
		return Number.NaN; // a config that does not parse: the default port, the gateway has the same problem and the status says it is not answering
	}
};
const deps: Deps = {
	dir,
	port: Number(process.env.DOTZ_PORT) || configuredPort() || 7420,
	token: text(join(dir, "secrets", "hub-token"))?.trim() || undefined,
	service: { platform: process.platform, uid: process.getuid?.() ?? 501, home: homedir() },
	env: process.env,
	fetch,
	exec: async (argv, env) => {
		const p = Bun.spawn(argv, { env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL" });
		const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
		return { code: await p.exited, out: `${out}${err}` };
	},
	now: () => Date.now(),
	sleep: ms => new Promise(done => setTimeout(done, ms)),
	out: line => console.log(line),
	read: text,
	keychain: {
		platform: process.platform,
		env: process.env,
		home: homedir(),
		read: text,
		exists: file => statSync(file, { throwIfNoEntry: false }) !== undefined,
		security: async (argv, timeoutMs) => {
			try {
				const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
				const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
				return p.signalCode ? undefined : { code, out: err };
			} catch {
				return undefined; // no security binary, or it could not start: the check says nothing
			}
		},
	},
	tail: (file, lines) => {
		try {
			const size = statSync(file).size;
			const fd = openSync(file, "r");
			const buf = Buffer.alloc(Math.min(size, 64 * 1024));
			readSync(fd, buf, 0, buf.length, size - buf.length);
			closeSync(fd);
			return buf.toString("utf8").trimEnd().split("\n").slice(-lines);
		} catch {
			return []; // a log that does not exist yet has no lines to show
		}
	},
	tty: () => ({ in: Boolean(process.stdin.isTTY), out: Boolean(process.stdout.isTTY) }),
	ask: prompt =>
		new Promise(answer => {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			rl.question(prompt, line => {
				rl.close();
				answer(line);
			});
		}),
};

const parsed = parseArgs(process.argv.slice(2));
if (parsed.cmd === "usage") {
	for (const line of USAGE) console.error(line);
	process.exit(EXIT.usage);
}
process.exit(parsed.cmd === "status" ? await statusCommand(deps) : await restartCommand(deps, parsed));
