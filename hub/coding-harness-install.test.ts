import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codingHarnessDir, installCodingHarness, type RunInstall } from "./coding-harness-install.ts";
import { advance } from "./runtime/test-clock.ts";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "coding-harness-"));
	roots.push(root);
	put(root, files);
	return root;
}

function put(root: string, files: Record<string, string>): void {
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), text);
	}
}

function payload(id: string, extra: Record<string, string> = {}): Record<string, string> {
	return { SHIPPED_FROM: `${id}\n`, "harness/package.json": '{"name":"h"}', "harness/bun.lock": "lock", "extensions/done-gate.ts": `gate ${id}`, "harness/gate/bootstrap.ts": `boot ${id}`, ...extra };
}

function recorder(): { run: RunInstall; calls: string[] } {
	const calls: string[] = [];
	const run: RunInstall = async cwd => {
		calls.push(cwd);
		mkdirSync(join(cwd, "node_modules"), { recursive: true });
		return { code: 0, out: "" };
	};
	return { run, calls };
}

const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const shipped = (dest: string) => read(dest, "SHIPPED_FROM").trim();
const install = (vendored: string, dest: string, runInstall: RunInstall) => installCodingHarness({ vendored, dest, runInstall });

function target(): { data: string; dest: string } {
	const data = tree({});
	return { data, dest: join(data, "coding-harness") };
}

describe("installCodingHarness", () => {
	test("the first install copies the vendored files and runs bun install once; a second call changes nothing", async () => {
		const vendored = tree(payload("aaa111", { "skills/x/SKILL.md": "skill" }));
		const { data, dest } = target();
		const { run, calls } = recorder();

		const first = await install(vendored, dest, run);
		expect(first.join("\n")).toContain("installed aaa111");
		expect(shipped(dest)).toBe("aaa111");
		expect(read(dest, "harness/.setup-version").trim()).toBe("aaa111");
		expect(read(dest, "skills/x/SKILL.md")).toBe("skill");
		expect(existsSync(join(dest, "INSTALLING"))).toBe(false);
		expect(calls).toEqual([join(dest, "harness")]);
		expect(codingHarnessDir(data)).toBe(dest);

		const before = statSync(join(dest, "skills/x/SKILL.md")).mtimeMs;
		expect(await install(vendored, dest, run)).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(statSync(join(dest, "skills/x/SKILL.md")).mtimeMs).toBe(before);
	});

	test("a new SHIPPED_FROM replaces changed files, deletes dropped ones and keeps the harness's own state", async () => {
		const v1 = tree(payload("aaa111", { "skills/old/SKILL.md": "old", "skills/keep/SKILL.md": "same", "skills/deep/a/b.md": "deep" }));
		const { data, dest } = target();
		const { run, calls } = recorder();
		await install(v1, dest, run);
		put(dest, { "gate-state/x.json": "{}", "harness/logs/y.log": "log", "orchestrator-state/s.json": "s", ".setup-version": "v" });

		const v2 = tree(payload("bbb222", { "skills/keep/SKILL.md": "same", "skills/new/SKILL.md": "new" }));
		const second = await install(v2, dest, run);

		expect(second.join("\n")).toContain("installed bbb222");
		expect(shipped(dest)).toBe("bbb222");
		expect(read(dest, "harness/.setup-version").trim()).toBe("bbb222");
		expect(read(dest, "extensions/done-gate.ts")).toBe("gate bbb222");
		expect(read(dest, "skills/new/SKILL.md")).toBe("new");
		expect(existsSync(join(dest, "skills/old"))).toBe(false);
		expect(existsSync(join(dest, "skills/deep"))).toBe(false);
		expect(read(dest, "gate-state/x.json")).toBe("{}");
		expect(read(dest, "harness/logs/y.log")).toBe("log");
		expect(read(dest, "orchestrator-state/s.json")).toBe("s");
		expect(read(dest, ".setup-version")).toBe("v");
		expect(calls).toHaveLength(1);
		expect(codingHarnessDir(data)).toBe(dest);
	});

	test("bun install runs again when the lockfile changed or node_modules is missing, and not otherwise", async () => {
		const { dest } = target();
		const { run, calls } = recorder();
		await install(tree(payload("aaa111")), dest, run);

		await install(tree(payload("bbb222")), dest, run);
		expect(calls).toHaveLength(1);

		const v3 = tree(payload("ccc333", { "harness/bun.lock": "lock 2" }));
		await install(v3, dest, run);
		expect(calls).toHaveLength(2);

		rmSync(join(dest, "harness/node_modules"), { recursive: true });
		await install(v3, dest, run);
		expect(calls).toHaveLength(3);
		expect(await install(v3, dest, run)).toEqual([]);
	});

	test("a shipped folder the owner removed, in a payload that drops it, installs at the first start", async () => {
		const { data, dest } = target();
		const { run } = recorder();
		await install(tree(payload("aaa111", { "skills/foo/SKILL.md": "foo" })), dest, run);
		rmSync(join(dest, "skills/foo"), { recursive: true });

		const lines = await install(tree(payload("bbb222")), dest, run);

		expect(lines.join("\n")).toContain("installed bbb222");
		expect(lines.join("\n")).not.toContain("failed");
		expect(shipped(dest)).toBe("bbb222");
		expect(read(dest, "extensions/done-gate.ts")).toBe("gate bbb222");
		expect(codingHarnessDir(data)).toBe(dest);
		expect(await install(tree(payload("bbb222")), dest, run)).toEqual([]);
	});

	test("a shipped folder that becomes a plain file installs at the first start, and the reverse", async () => {
		const { data, dest } = target();
		const { run } = recorder();
		await install(tree(payload("aaa111", { "skills/tool/SKILL.md": "v1", "skills/plain": "was a file" })), dest, run);

		const v2 = tree(payload("bbb222", { "skills/tool": "v2 is a file", "skills/plain/SKILL.md": "now a folder" }));
		for (let start = 1; start <= 3; start++) {
			const lines = await install(v2, dest, run);
			expect(lines.join("\n")).not.toContain("failed");
			expect(shipped(dest)).toBe("bbb222");
			expect(read(dest, "skills/tool")).toBe("v2 is a file");
			expect(read(dest, "skills/plain/SKILL.md")).toBe("now a folder");
			expect(codingHarnessDir(data)).toBe(dest);
		}
	});

	test("a half-finished install leaves the old SHIPPED_FROM, no usable folder, and the next call finishes it", async () => {
		const { data, dest } = target();
		const { run } = recorder();
		await install(tree(payload("aaa111")), dest, run);

		put(dest, { "skills/x": "leftover file" });
		const v2 = tree(payload("bbb222", { "skills/x/SKILL.md": "s" }));
		const lines = await install(v2, dest, run);

		expect(lines.join("\n")).toContain("failed");
		expect(shipped(dest)).toBe("aaa111");
		expect(existsSync(join(dest, "INSTALLING"))).toBe(true);
		expect(codingHarnessDir(data)).toBeUndefined();

		rmSync(join(dest, "skills/x"));
		const again = await install(v2, dest, run);
		expect(again.join("\n")).toContain("installed bbb222");
		expect(shipped(dest)).toBe("bbb222");
		expect(read(dest, "extensions/done-gate.ts")).toBe("gate bbb222");
		expect(read(dest, "skills/x/SKILL.md")).toBe("s");
		expect(existsSync(join(dest, "INSTALLING"))).toBe(false);
		expect(codingHarnessDir(data)).toBe(dest);
	});

	test("a shipped path through a symlink inside the folder refuses the install and writes nothing through it", async () => {
		const { data, dest } = target();
		const { run } = recorder();
		await install(tree(payload("aaa111")), dest, run);
		const elsewhere = tree({});
		symlinkSync(elsewhere, join(dest, "skills"));

		const lines = await install(tree(payload("bbb222", { "skills/x/SKILL.md": "s" })), dest, run);

		expect(lines.join("\n")).toContain("symlink");
		expect(existsSync(join(elsewhere, "x"))).toBe(false);
		expect(shipped(dest)).toBe("aaa111");
		expect(codingHarnessDir(data)).toBeUndefined();
	});

	test("the INSTALLING marker is there while the install runs, and a marker left by a killed run makes the next call install again", async () => {
		const { data, dest } = target();
		const seen: { marker: boolean; usable: string | undefined }[] = [];
		const watching: RunInstall = async cwd => {
			seen.push({ marker: existsSync(join(dest, "INSTALLING")), usable: codingHarnessDir(data) });
			mkdirSync(join(cwd, "node_modules"), { recursive: true });
			return { code: 0, out: "" };
		};
		const vendored = tree(payload("aaa111"));
		await install(vendored, dest, watching);
		expect(seen).toEqual([{ marker: true, usable: undefined }]);
		expect(codingHarnessDir(data)).toBe(dest);

		writeFileSync(join(dest, "INSTALLING"), "aaa111\n");
		writeFileSync(join(dest, "extensions/done-gate.ts"), "torn");
		expect(codingHarnessDir(data)).toBeUndefined();
		const lines = await install(vendored, dest, watching);
		expect(lines.join("\n")).toContain("installed aaa111");
		expect(read(dest, "extensions/done-gate.ts")).toBe("gate aaa111");
		expect(existsSync(join(dest, "INSTALLING"))).toBe(false);
		expect(codingHarnessDir(data)).toBe(dest);
	});

	test("a failed bun install is logged, leaves the folder unusable and is retried by the next call", async () => {
		const { data, dest } = target();
		const vendored = tree(payload("aaa111"));
		let attempts = 0;
		const failing: RunInstall = async cwd => {
			if (++attempts === 1) return { code: 1, out: "network down" };
			mkdirSync(join(cwd, "node_modules"), { recursive: true });
			return { code: 0, out: "" };
		};

		const lines = await install(vendored, dest, failing);
		expect(lines.join("\n")).toContain("bun install failed");
		expect(lines.join("\n")).toContain("network down");
		expect(shipped(dest)).toBe("aaa111");
		expect(codingHarnessDir(data)).toBeUndefined();

		const again = await install(vendored, dest, failing);
		expect(attempts).toBe(2);
		expect(again.join("\n")).toContain("dependencies installed");
		expect(codingHarnessDir(data)).toBe(dest);
		expect(await install(vendored, dest, failing)).toEqual([]);
		expect(attempts).toBe(2);
	});

	test("a bun install that throws counts as failed", async () => {
		const { data, dest } = target();
		const lines = await install(tree(payload("aaa111")), dest, () => Promise.reject(new Error("spawn bun ENOENT")));
		expect(lines.join("\n")).toContain("bun install failed");
		expect(lines.join("\n")).toContain("spawn bun ENOENT");
		expect(codingHarnessDir(data)).toBeUndefined();
	});

	test("a bun install that outlasts its bound is stopped and counted as failed", async () => {
		const { data, dest } = target();
		let aborted = false;
		const hanging: RunInstall = (_cwd, signal) =>
			new Promise(() => {
				signal.addEventListener("abort", () => {
					aborted = true;
				});
			});

		const done = installCodingHarness({ vendored: tree(payload("aaa111")), dest, runInstall: hanging, installTimeoutMs: 120_000 });
		await advance(119_000);
		expect(aborted).toBe(false);
		await advance(1_000);
		const lines = await done;

		expect(aborted).toBe(true);
		expect(lines.join("\n")).toContain("bun install failed");
		expect(lines.join("\n")).toContain("exit 124");
		expect(codingHarnessDir(data)).toBeUndefined();
	});

	test("an executable file stays executable", async () => {
		const vendored = tree(payload("aaa111", { "harness/worker-bin/bun": "#!/bin/sh\n" }));
		chmodSync(join(vendored, "harness/worker-bin/bun"), 0o755);
		const { dest } = target();
		await install(vendored, dest, recorder().run);
		expect(statSync(join(dest, "harness/worker-bin/bun")).mode & 0o111).not.toBe(0);
	});

	test("a SHIPPED_FILES entry that leaves the folder, is absolute or runs through a symlink deletes nothing outside", async () => {
		const parent = tree({ "outside.txt": "keep", "victim/v.txt": "keep" });
		const dest = join(parent, "coding-harness");
		const { run } = recorder();
		await install(tree(payload("aaa111")), dest, run);
		symlinkSync(join(parent, "victim"), join(dest, "linked"));
		writeFileSync(join(dest, "SHIPPED_FILES"), ["../outside.txt", "harness/../../outside.txt", "/etc/hosts", "..", "linked/v.txt"].join("\n") + "\n");

		const lines = await install(tree(payload("bbb222")), dest, run);

		expect(lines.join("\n")).toContain("installed bbb222");
		expect(read(parent, "outside.txt")).toBe("keep");
		expect(read(parent, "victim/v.txt")).toBe("keep");
		expect(existsSync("/etc/hosts")).toBe(true);
		expect(codingHarnessDir(parent)).toBe(dest);
	});

	test("a vendored tree without SHIPPED_FROM installs nothing", async () => {
		const { data, dest } = target();
		const noId = payload("x");
		delete noId.SHIPPED_FROM;
		const lines = await install(tree(noId), dest, recorder().run);
		expect(lines.join("\n")).toContain("no SHIPPED_FROM");
		expect(existsSync(dest)).toBe(false);
		expect(codingHarnessDir(data)).toBeUndefined();
	});
});
