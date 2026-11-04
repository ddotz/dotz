import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Points a dotz git checkout at the tracked .githooks (pre-push: the code health gate). core.hooksPath is in the clone's shared config, so all its
// worktrees get it. Called from the two places every checkout passes, so nobody installs it by hand: the bun test preload (hub/runtime/test-setup.ts,
// a developer clone, the one workers push from) and the gateway boot (updateBoot, an install clone). A hooksPath the owner set stays; a tarball has no
// .git and is left alone. A set that loses the config lock to a parallel test process needs no handling: that process wrote the same value.
export function installGitHooks(dir: string): void {
	if (!existsSync(join(dir, ".git")) || !existsSync(join(dir, ".githooks", "pre-push"))) return;
	const git = (...args: string[]) => spawnSync("git", ["-C", dir, "config", "--local", ...args], { encoding: "utf8", timeout: 5000 });
	if (!git("--get", "core.hooksPath").stdout?.trim()) git("core.hooksPath", ".githooks");
}
