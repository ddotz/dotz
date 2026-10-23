// The code lock: shell git history changes and file edits under the dotz code folder are refused on an install that is not a developer checkout.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_LOCK_REASON, codeLockReason } from "./codeguard.ts";
import { lockedCodeDir } from "./selfupdate-local.ts";

let root: string, code: string, data: string, other: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "dotz-codeguard-")));
	code = join(root, "dotz");
	data = join(root, "data");
	other = join(root, "project");
	for (const d of [join(code, ".git"), data, other]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config = (keepLocal?: boolean) => writeFileSync(join(data, "config.json"), JSON.stringify({ self_update: keepLocal === undefined ? {} : { keep_local: keepLocal } }));

test("an install.sh clone or keep_local:false is locked, a developer checkout and keep_local:true are not", () => {
	config();
	expect(lockedCodeDir(data, code, {})).toBeUndefined();
	writeFileSync(join(code, ".git", "dotz-install"), "install.sh --git\n");
	expect(lockedCodeDir(data, code, {})).toBe(code);
	config(true);
	expect(lockedCodeDir(data, code, {})).toBeUndefined();
	config(false);
	rmSync(join(code, ".git", "dotz-install"));
	expect(lockedCodeDir(data, code, {})).toBe(code);
	config();
	expect(lockedCodeDir(data, code, { DOTZ_HOME: code })).toBe(code);
});

test("history-changing git in the code folder is refused", () => {
	const run = (command: string, cwd = other) => codeLockReason("bash", { command }, cwd, code);
	for (const sub of ["commit -am x", "am x.patch", "cherry-pick abc", "merge main", "rebase origin/main"]) {
		expect(run(`git -C ${code} ${sub}`)).toBe(CODE_LOCK_REASON);
		expect(run(`git ${sub}`, code)).toBe(CODE_LOCK_REASON);
		expect(run(`git ${sub}`, join(code, "hub"))).toBe(CODE_LOCK_REASON);
		expect(run(`cd ${code} && git ${sub}`)).toBe(CODE_LOCK_REASON);
	}
	expect(codeLockReason("eval", { code: `await Bun.$\`git -C ${code} commit -m x\`` }, other, code)).toBe(CODE_LOCK_REASON);
	expect(CODE_LOCK_REASON).toContain("이 설치의 dotz 코드는 고치지 않아요");
});

test("other git use and other folders are allowed", () => {
	const run = (command: string, cwd = other) => codeLockReason("bash", { command }, cwd, code);
	expect(run("git commit -m x")).toBeUndefined();
	expect(run(`git -C ${other} commit -m x`)).toBeUndefined();
	expect(run(`git -C ${code} status`)).toBeUndefined();
	expect(run("git log", code)).toBeUndefined();
	expect(run("git merge-base a b", code)).toBeUndefined();
	expect(run("ls", code)).toBeUndefined();
});

test("edits and writes under the code folder are refused, elsewhere allowed", () => {
	expect(codeLockReason("edit", { path: join(code, "hub", "main.ts") }, other, code)).toBe(CODE_LOCK_REASON);
	expect(codeLockReason("write", { path: "hub/new.ts" }, code, code)).toBe(CODE_LOCK_REASON);
	expect(codeLockReason("Edit", { file_path: join(code, "MODE.md") }, other, code)).toBe(CODE_LOCK_REASON);
	expect(codeLockReason("edit", { path: join(other, "a.ts") }, other, code)).toBeUndefined();
	expect(codeLockReason("edit", { path: join(root, "dotz-notes.md") }, other, code)).toBeUndefined();
	expect(codeLockReason("read", { path: join(code, "MODE.md") }, other, code)).toBeUndefined();
});
