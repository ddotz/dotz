import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { senpiLauncher } from "./senpi-bin.ts";

const fakeInstall = (shebang: string) => {
	const root = mkdtempSync(join(tmpdir(), "senpi-bin-"));
	const cli = join(realpathSync(root), "pkg", "cli.js");
	mkdirSync(join(root, "pkg"));
	mkdirSync(join(root, "bin"));
	writeFileSync(cli, `${shebang}\nconsole.log("hi")\n`);
	chmodSync(cli, 0o755);
	symlinkSync(cli, join(root, "bin", "senpi"));
	return { root, cli, path: join(root, "bin") };
};

test("a node-shebang senpi gets a launcher that execs bun on the same cli.js, and rpc arguments pass through", async () => {
	const { root, cli, path } = fakeInstall("#!/usr/bin/env node");
	const dir = join(root, "launch");
	const file = senpiLauncher(path, process.execPath, dir)!;
	expect(file).toBe(join(dir, "senpi-bun"));
	expect(statSync(file).mode & 0o111).not.toBe(0);
	expect(readFileSync(file, "utf8")).toContain(`'${cli}'`);
	writeFileSync(cli, "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)), typeof Bun)\n");
	const run = Bun.spawn([file, "--mode", "rpc", "--model", "a b"], { stdout: "pipe" });
	expect((await new Response(run.stdout).text()).trim()).toBe('["--mode","rpc","--model","a b"] object');
});

test("no launcher when senpi is missing or is not a node script (OmO resolves it as before)", () => {
	const dir = mkdtempSync(join(tmpdir(), "senpi-bin-"));
	expect(senpiLauncher(join(dir, "empty"), process.execPath, join(dir, "l1"))).toBeUndefined();
	const bunScript = fakeInstall("#!/usr/bin/env bun");
	expect(senpiLauncher(bunScript.path, process.execPath, join(dir, "l2"))).toBeUndefined();
});
