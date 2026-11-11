import { json } from "../hub/routes-util.ts";
import { PtyHost, ptyRoute } from "../hub/pty.ts";
import type { SetupText } from "./setup-jobs.ts";

// The logins that need a real terminal during the web onboarding (Aside CLI, zele, Claude Code, omp). The command of each id is decided by this table
// alone: a request carries an id and, at most, the terminal size, never an argv, a path or an environment. The PTY runs that command and nothing
// else, so when it exits the terminal closes (it never falls to a shell). Terminal output is not logged: hub/pty.ts keeps only a small in-memory replay.

export const TERM_IDS = ["aside-login", "zele-login", "claude-login", "omp-login"] as const;
export type TermId = (typeof TERM_IDS)[number];
export const isTermId = (s: string): s is TermId => (TERM_IDS as readonly string[]).includes(s);
const assertNever = (x: never): never => {
	throw new Error(`unhandled terminal id ${String(x)}`);
};

/** The argv for an id, or undefined when its program is not installed. */
export function termArgv(id: TermId): string[] | undefined {
	const bin = (name: string): string | undefined => Bun.which(name, { PATH: process.env.PATH });
	switch (id) {
		case "aside-login":
			return bin("aside") ? [bin("aside")!, "login"] : undefined;
		case "zele-login":
			return bin("zele") ? [bin("zele")!, "login"] : undefined;
		case "claude-login":
			return bin(process.env.DOTZ_CLAUDE ?? "claude") ? [bin(process.env.DOTZ_CLAUDE ?? "claude")!, "auth", "login"] : undefined;
		case "omp-login":
			return bin("omp") ? [bin("omp")!, "login"] : undefined;
		default:
			return assertNever(id);
	}
}

const SIZE_KEYS = new Set(["cols", "rows"]);
const EXIT_ONLY = new Response("event: exit\ndata: {\"code\":null}\n\n", { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });

export function createTerms(argvOf: (id: TermId) => string[] | undefined = termArgv) {
	const hosts = new Map<TermId, PtyHost>();

	/** parts: what follows /api/setup/term/ in the path. */
	return async function route(req: Request, url: URL, parts: string[], text: SetupText): Promise<Response> {
		const [id, action] = parts;
		if (!id || !isTermId(id) || parts.length > 2) return json({ error: text.errors.unknownTerm }, 404);
		if (!action && req.method === "POST") {
			const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
			if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some(k => !SIZE_KEYS.has(k))) return json({ error: text.errors.termBody }, 400);
			const argv = argvOf(id);
			if (!argv) return json({ error: text.owner.missing.replace("{name}", id) }, 409);
			let host = hosts.get(id);
			if (!host || !host.alive) {
				host = new PtyHost({ cmd: argv });
				hosts.set(id, host);
				host.start(Math.min(300, Math.max(20, Number(b.cols) || 80)), Math.min(120, Math.max(5, Number(b.rows) || 24)));
			}
			return json({ ok: true, id });
		}
		const host = hosts.get(id);
		if (action === "stream" && req.method === "GET") return host?.alive ? ((await ptyRoute(req, new URL(`/api/pty/stream${url.search}`, url), host)) as Response) : EXIT_ONLY.clone();
		if ((action === "input" || action === "resize") && req.method === "POST") {
			if (!host?.alive) return json({ error: text.errors.termNotRunning }, 409);
			return (await ptyRoute(req, new URL(`/api/pty/${action}`, url), host)) as Response;
		}
		return json({ error: text.errors.unknownTerm }, 404);
	};
}
