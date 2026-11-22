import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noreplyMail } from "../hub/commit-identity.ts";

// The guards an OmO task worker of a lane or the orchestrator gets (extension/index.ts): every tool_call handler the extension
// registers runs in order, the first block wins, as in the host.
const SCRIPT = `
const handlers = []; const base = { on: (n, f) => n === "tool_call" && handlers.push(f) };
const pi = new Proxy(base, { get: (t, p) => (p in t ? t[p] : p === "zod" ? undefined : () => undefined) });
(await import("./extension/index.ts")).default(pi);
const out = [];
for (const event of JSON.parse(process.env.WORKER_EVENTS)) {
	let verdict;
	for (const f of handlers) if ((verdict = await f(event, { cwd: process.env.WORKER_CWD }))?.block) break;
	out.push(verdict?.block ? verdict.reason : null);
}
console.log(JSON.stringify(out));
process.exit(0);`;

type Event = { toolName: string; input: Record<string, unknown> };

function verdicts(env: Record<string, string>, events: Event[]): (string | null)[] {
	const base = { ...process.env, DOTZ_RUNTIME: "omo", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } as Record<string, string | undefined>;
	for (const k of ["DOTZ_ORCHESTRATOR", "DOTZ_CONV", "DOTZ_LANE", "OMO_SENPI_TASK_DEPTH"]) delete base[k];
	Object.assign(base, env, { WORKER_EVENTS: JSON.stringify(events) });
	const r = Bun.spawnSync([process.execPath, "-e", SCRIPT], { cwd: join(import.meta.dir, ".."), env: base as Record<string, string>, stdout: "pipe", stderr: "pipe" });
	expect(r.exitCode, r.stderr.toString()).toBe(0);
	return JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "[]");
}

const TERM = "quillback-fixture-term";
let root: string, data: string, work: string;
const git = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};
const commit = (file: string, text: string) => {
	writeFileSync(join(work, file), text);
	git(work, "add", file);
	git(work, "-c", "user.name=pat-dev", "-c", `user.email=${noreplyMail("pat-dev", "4242")}`, "commit", "-q", "-m", file);
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-worker-guard-"));
	data = join(root, "data");
	mkdirSync(join(data, "secrets"), { recursive: true });
	writeFileSync(join(data, "secrets", "privacy-terms.txt"), `${TERM}\n`);
	const publicRemote = join(root, "ddotz", "dotz.git"); // the public repo, by its path
	mkdirSync(publicRemote, { recursive: true });
	git(publicRemote, "init", "-q", "--bare", "-b", "main");
	work = join(root, "work");
	mkdirSync(work);
	git(work, "init", "-q", "-b", "main");
	git(work, "remote", "add", "origin", publicRemote);
	commit("base", "base");
	git(work, "push", "-q", "origin", "main");
	git(work, "checkout", "-q", "-b", "feature");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const shell = (command: string): Event => ({ toolName: "bash", input: { command } });
const cell = (code: string): Event => ({ toolName: "eval", input: { language: "js", code } });

test("a lane's task worker is refused a push to the public repo carrying a privacy-list term, and every other external command; ordinary commands pass", () => {
	commit("notes", `a line naming ${TERM}\n`);
	const env = { DOTZ_DIR: data, DOTZ_LANE: "alpha", OMO_SENPI_TASK_DEPTH: "1", WORKER_CWD: work };
	const [privacy, lanePush, cellPush, publish, piped, sharedWrite, ls, cellLs, sharedRead] = verdicts(env, [
		shell(`cd ${work} && git push origin feature:main`),
		shell(`cd ${work} && git push origin HEAD:lane/alpha`),
		cell(`await tool.bash({ command: "git push origin HEAD:lane/alpha", cwd: "${work}" })`),
		shell("bun publish"),
		shell("bun test 2>&1 | tail -5; echo $?"),
		{ toolName: "write", input: { path: join(data, "state.json"), content: "{}" } },
		shell(`ls ${work}`),
		cell(`print(await read("${join(work, "base")}"))`),
		cell(`print(await read("${join(data, "state.json")}"))`),
	]);
	expect(privacy).toContain("privacy list");
	for (const refused of [lanePush, cellPush, publish, piped, sharedWrite]) expect(refused).toEqual(expect.any(String));
	expect([ls, cellLs, sharedRead]).toEqual([null, null, null]);
});

test("an orchestrator's task worker gets the external-command block too", () => {
	const env = { DOTZ_DIR: data, DOTZ_ORCHESTRATOR: "1", OMO_SENPI_TASK_DEPTH: "1", WORKER_CWD: work };
	const [pr, ls] = verdicts(env, [shell("gh pr create --title t --body b"), shell("git status --short")]);
	expect(pr).toEqual(expect.any(String));
	expect(ls).toBeNull();
});
