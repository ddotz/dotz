// Shared fixture of the selfupdate tests: real temp git repos (a bare origin, the checkout the updater works on, a second clone that pushes
// newer commits; no network). The three repos are built once per test process and copied for each test, so a test pays a copy instead of
// four git calls.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, DATA_DIR } from "./config.ts";
import type { AutoHooks } from "./selfupdate.ts";

export const git = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.toString().trim();
};
export const commit = (dir: string, file: string, text: string, msg: string) => {
	writeFileSync(join(dir, file), text);
	git(dir, "add", file);
	git(dir, "commit", "-q", "-m", msg);
};
export const head = (dir: string) => git(dir, "rev-parse", "HEAD");

// "Tests" fail while a file named FAIL is in the checkout.
export const failFileTestCmd = ["sh", "-c", "test ! -f FAIL"];

export const setSelfUpdateCfg = (v: Record<string, unknown> | undefined) => {
	(cfg as Record<string, unknown>).self_update = v;
	rmSync(join(DATA_DIR, "self-update.json"), { force: true });
};

// Records what main.ts would do after an auto-check: worklog lines, alerts, idle-gated restarts.
export const autoHooks = () => {
	const h = { worklog: [] as string[], alerts: [] as string[], restarts: 0 };
	const api: AutoHooks = { worklog: t => void h.worklog.push(t), alert: t => void h.alerts.push(t), restartIdle: () => (h.restarts++, "queued") };
	return { h, api };
};

let template: string | undefined;
function buildTemplate(): string {
	const t = mkdtempSync(join(tmpdir(), "dotz-selfupdate-tpl-"));
	process.on("exit", () => rmSync(t, { recursive: true, force: true }));
	git(t, "init", "-q", "--bare", "origin.git");
	git(t, "clone", "-q", "origin.git", "pusher");
	commit(join(t, "pusher"), "a.txt", "1\n", "first");
	git(join(t, "pusher"), "push", "-q", "origin", "HEAD:main");
	git(t, "clone", "-q", "origin.git", "work");
	return t;
}

export type Repos = { root: string; origin: string; work: string; pusher: string; logDir: string; push: (file: string, text: string, msg: string) => void; remove: () => void };

// A fresh root holding origin.git, work and pusher, both clones pointing at this root's origin, and a logs folder path (not created).
export function makeRepos(): Repos {
	template ??= buildTemplate();
	const root = mkdtempSync(join(tmpdir(), "dotz-selfupdate-"));
	cpSync(template, root, { recursive: true });
	const origin = join(root, "origin.git");
	const work = join(root, "work");
	const pusher = join(root, "pusher");
	for (const d of [work, pusher]) git(d, "remote", "set-url", "origin", origin);
	return {
		root,
		origin,
		work,
		pusher,
		logDir: join(root, "logs"),
		push: (file, text, msg) => {
			commit(pusher, file, text, msg);
			git(pusher, "push", "-q", "origin", "HEAD:main");
		},
		remove: () => rmSync(root, { recursive: true, force: true }),
	};
}
