// Runs INSIDE the gateway's sandbox profile (run.ts starts it with the gateway's own profile file, HOME and PATH) and prints one
// line per check: [ok] when the sandbox did what it should. Any [FAIL] line makes the run fail.
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { realHome } from "./sandbox.ts";

const real = realHome();
const lines: string[] = [];
const rec = (name: string, ok: boolean, detail: string): void => void lines.push(`${ok ? "[ok]  " : "[FAIL]"} ${name}: ${detail}`);
const code = (e: unknown): string => String((e as { code?: string }).code ?? (e as Error).message);

const tcp = (host: string, port: number) =>
	new Promise<string>(done => {
		const s = connect({ host, port, timeout: 4000 });
		s.on("connect", () => (s.destroy(), done("connected")));
		s.on("error", e => done(`error ${code(e)}`));
		s.on("timeout", () => (s.destroy(), done("timeout")));
	});
const reach = await tcp("1.1.1.1", 443);
rec("TCP to 1.1.1.1:443 fails", reach !== "connected", reach);
const dns = await lookup("example.com").then(r => `resolved ${r.address}`, e => `error ${code(e)}`);
rec("DNS lookup of example.com fails", dns.startsWith("error"), dns);
const web = await fetch("https://example.com/", { signal: AbortSignal.timeout(5000) }).then(r => `http ${r.status}`, e => `error ${code(e)}`);
rec("HTTPS fetch of example.com fails", web.startsWith("error"), web);
const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("loopback-ok") });
for (const host of ["127.0.0.1", "localhost"]) {
	const got = await fetch(`http://${host}:${srv.port}/`).then(r => r.text(), e => `error ${code(e)}`);
	rec(`loopback ${host} works`, got === "loopback-ok", got);
}
srv.stop(true);

const attempt = (fn: () => void, okWord: string): string => {
	try {
		fn();
		return okWord;
	} catch (e) {
		return `denied ${code(e)}`;
	}
};
const probe = `${real}/.dotz/LOAD_QA_SANDBOX_PROBE_DELETE_ME`;
const wrote = attempt(() => (writeFileSync(probe, "probe"), rmSync(probe)), "WRITTEN (and deleted)");
rec("write under ~/.dotz fails", wrote.startsWith("denied"), wrote);
const listed = attempt(() => void readdirSync(`${real}/.dotz`), "READABLE");
rec("read of ~/.dotz fails", listed.startsWith("denied"), listed);
for (const dir of [".omo/agent", "Library/Mobile Documents"]) {
	const w = attempt(() => (writeFileSync(`${real}/${dir}/LOAD_QA_PROBE_DELETE_ME`, "p"), rmSync(`${real}/${dir}/LOAD_QA_PROBE_DELETE_ME`)), "WRITTEN (and deleted)");
	rec(`write under ~/${dir} fails`, w.startsWith("denied"), w);
}
const outside = attempt(() => (writeFileSync(`${real}/LOAD_QA_PROBE_DELETE_ME`, "p"), rmSync(`${real}/LOAD_QA_PROBE_DELETE_ME`)), "WRITTEN (and deleted)");
rec("write in the real home (outside the run dir) fails", outside.startsWith("denied"), outside);
const inFake = attempt(() => writeFileSync(`${process.env.HOME}/probe-ok.txt`, "p"), "written");
rec("write in the fake HOME works", inFake === "written", inFake);

for (const bin of ["/usr/bin/brctl", "/usr/bin/ssh", "/usr/bin/osascript", "/bin/launchctl", "/usr/bin/security", "/usr/bin/open", "/usr/bin/pbcopy", "/usr/bin/curl"]) {
	if (!existsSync(bin)) {
		rec(`exec ${bin} fails`, true, "not installed on this machine");
		continue;
	}
	const r = (() => {
		try {
			return `exit ${Bun.spawnSync([bin, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode}`;
		} catch (e) {
			return `error ${code(e)}`;
		}
	})();
	rec(`exec ${bin} fails`, r.startsWith("error"), r);
}
for (const [cmd, args] of [["zele", ["whoami"]], ["open", ["-a", "Aside"]], ["tailscale", ["status"]], ["ssh", ["host"]]] as const) {
	const p = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
	const which = Bun.spawnSync(["/usr/bin/which", cmd], { stdout: "pipe" }).stdout.toString().trim();
	rec(`bare '${cmd}' is the fake CLI`, which.includes("/load-qa/shims/"), `${which} exit ${p.exitCode}`);
}
console.log(lines.join("\n"));
process.exit(0);
