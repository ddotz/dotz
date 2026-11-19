import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { REPO, type Run, call, readRun } from "./lib.ts";
import { appShellScript, autoReplyColdScript, autoReplyScript } from "./browser.ts";

const [feature, runId] = process.argv.slice(2);
const FEATURES = ["auto-reply", "app-shell"];
if (!feature || !runId || !FEATURES.includes(feature)) {
	console.error(`usage: bun .omp/skills/verify-dotz/scripts/drive.ts <${FEATURES.join("|")}> <run-id>`);
	process.exit(2);
}
const run = readRun(runId);
const out = join(run.dir, feature);
if (existsSync(join(out, "manifest.json"))) {
	console.error(`${feature} was already driven in run ${runId}; launch a new run to drive it again`);
	process.exit(2);
}
mkdirSync(out, { recursive: true });

const paths = (JSON.parse(readFileSync(join(REPO, ".omp/verify/features.json"), "utf8")) as { id: string; paths: string[] }[]).find(f => f.id === feature)?.paths ?? [];
if (run.tree === "head") {
	const changed = Bun.spawnSync(["git", "status", "--porcelain", "--", ...paths.map(p => `:(glob)${p}`)], { cwd: REPO, stdout: "pipe" }).stdout.toString().trim();
	if (changed) {
		console.error(`run ${runId} serves HEAD but these ${feature} files differ from HEAD; launch with --tree worktree or commit them:\n${changed}`);
		process.exit(1);
	}
}

const notes: string[] = [];
const note = (line: string): void => {
	notes.push(line);
	console.log(line);
};
const fail = (why: string): never => {
	note(`FAIL ${why}`);
	writeFileSync(join(out, "checks.log"), `${notes.join("\n")}\n`);
	process.exit(1);
};

const ART = /^@@ART (\S+) (\S+)$/;
function browser(step: string, script: string): string[] {
	const env = { ...process.env, HOME: process.env.VERIFY_REAL_HOME ?? homedir() };
	const r = Bun.spawnSync(["aside", "repl", "--file", "-"], { stdin: Buffer.from(script), stdout: "pipe", stderr: "pipe", env, timeout: 118_000 });
	const lines = r.stdout.toString().split("\n");
	const written: string[] = [];
	const kept: string[] = [];
	for (const line of lines) {
		const m = ART.exec(line);
		if (!m) {
			kept.push(line);
			continue;
		}
		writeFileSync(join(out, m[1]!), Buffer.from(m[2]!, "base64"));
		written.push(m[1]!);
	}
	writeFileSync(join(out, `${step}.log`), `${kept.join("\n")}\n${r.stderr.toString()}`);
	written.push(`${step}.log`);
	if (r.exitCode !== 0 || kept.some(l => l.startsWith("@@FAIL"))) fail(`browser step ${step} failed (exit ${r.exitCode}); see ${relative(REPO, join(out, `${step}.log`))}`);
	return written;
}

function groupNetwork(): string {
	const pids = Bun.spawnSync(["ps", "-axo", "pid=,pgid="], { stdout: "pipe" })
		.stdout.toString()
		.split("\n")
		.map(l => l.trim().split(/\s+/).map(Number))
		.filter(([, pgid]) => pgid === run.pgid)
		.map(([pid]) => String(pid));
	return Bun.spawnSync(["lsof", "-nP", "-a", "-p", pids.join(","), "-i"], { stdout: "pipe" }).stdout.toString();
}
function noExternalNetwork(when: string): void {
	const table = groupNetwork();
	writeFileSync(join(out, `network-${when}.txt`), table);
	const external = table.split("\n").filter(l => /TCP|UDP/.test(l) && !/LISTEN/.test(l) && !/(127\.0\.0\.1|\[::1\]|localhost)[^ ]*->(127\.0\.0\.1|\[::1\]|localhost)/.test(l));
	if (external.length) fail(`the run's processes hold non-loopback sockets ${when}:\n${external.join("\n")}`);
	note(`network ${when}: no socket of the run's processes leaves the loopback (${relative(REPO, join(out, `network-${when}.txt`))})`);
}

const calls = (): string => (existsSync(join(run.dir, "outbound", "calls.log")) ? readFileSync(join(run.dir, "outbound", "calls.log"), "utf8") : "");
const browserRun: Pick<Run, "port" | "loginCookie"> = run;
const artifacts: string[] = [];

if (feature === "auto-reply") {
	const mail = { source: "zele", id: `verify${run.runId.replace(/[^A-Za-z0-9]/g, "")}`, messageId: `verify-msg-${run.runId}`, subject: "회의 일정 문의", from: "Sender A <sender@example.invalid>", to: "verify@example.invalid", body: "안녕하세요.\n이번 주 목요일 오후에 회의 가능할까요?", summary: "목요일 오후 회의가 되는지 묻는 메일이에요", needsReply: true };
	const posted = (await (await call(run, "/api/mail", { as: "agent", method: "POST", body: JSON.stringify(mail) })).json()) as { ok?: boolean; key?: string; target?: string; error?: string };
	if (!posted.ok || !posted.key || !posted.target) fail(`POST /api/mail: ${JSON.stringify(posted)}`);
	note(`arrange: mail arrived through POST /api/mail as the zele poller posts it: ${posted.target}`);
	const seed = Bun.spawnSync(["bun", join(import.meta.dir, "seed-auto-reply.ts"), run.runId], {
		cwd: run.code,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOME: run.home, DOTZ_DIR: run.data, PATH: `${join(run.dir, "bin")}:${process.env.PATH ?? ""}`, VERIFY_MAIL: JSON.stringify({ key: posted.key, target: posted.target, from: mail.from, subject: mail.subject, body: mail.body, self: mail.to, id: mail.id }), VERIFY_DRAFT_BODY: "안녕하세요.\n목요일 오후 3시 괜찮습니다.\n감사합니다." },
	});
	if (seed.exitCode !== 0) fail(`seed-auto-reply.ts: ${seed.stderr.toString()}`);
	const draft = JSON.parse(seed.stdout.toString()) as { id: string; text: string };
	const sent = (await (await call(run, "/api/send", { as: "agent", method: "POST", body: JSON.stringify({ target: posted.target, text: draft.text }) })).json()) as { delivered?: boolean };
	if (!sent.delivered) fail(`POST /api/send did not deliver the card: ${JSON.stringify(sent)}`);
	note(`arrange: draft ${draft.id} built by buildDraft with a canned model answer, card posted through POST /api/send as the bot posts it`);

	const drafts = (): { id: string; status: string }[] => (JSON.parse(readFileSync(join(run.data, "custom", "reply-drafts", "drafts.json"), "utf8")) as { drafts: { id: string; status: string }[] }).drafts;
	const before = drafts().find(d => d.id === draft.id)?.status;
	if (before !== "pending") fail(`draft ${draft.id} is ${before} before the click, expected pending`);
	if (calls().includes(`zele mail reply ${mail.id}`)) fail("a zele send for this mail was recorded before the click");
	note(`before: drafts.json ${draft.id} status pending; no zele send in outbound/calls.log`);
	noExternalNetwork("before");

	artifacts.push(...browser("browser-send", autoReplyScript(browserRun)));

	const after = drafts().find(d => d.id === draft.id)?.status;
	const replyLine = calls().split("\n").find(l => l.includes(`zele mail reply ${mail.id} --to sender@example.invalid`));
	if (after !== "sent") fail(`draft ${draft.id} is ${after} after 보내기, expected sent`);
	if (!replyLine) fail("no `zele mail reply` reached the stub after 보내기");
	note(`after: drafts.json ${draft.id} status sent; the stub recorded: ${replyLine}`);
	writeFileSync(join(out, "outbound-calls.log"), calls());
	artifacts.push("outbound-calls.log");
	noExternalNetwork("after");
	artifacts.push(...browser("browser-cold", autoReplyColdScript(browserRun, posted.target)));
	note("cold: the mail conversation shows 보낸 답장 at 390 and 1280; 답장 대기 lists the sent mail (sender@example.invalid) under 보낸 것 after a reload");
} else {
	artifacts.push(...browser("browser-shell", appShellScript(browserRun)));
	noExternalNetwork("after");
}

artifacts.push("network-after.txt", ...(feature === "auto-reply" ? ["network-before.txt"] : []));
writeFileSync(join(out, "checks.log"), `${notes.join("\n")}\n`);
artifacts.push("checks.log");
const kinds = artifacts.map(a => `${a}:${a.endsWith(".png") ? "screenshot" : "log"}`);
const command = `bun .omp/skills/verify-dotz/scripts/drive.ts ${feature} ${runId}`;
const manifest = Bun.spawnSync(
	["bun", join(process.env.VERIFY_REAL_HOME ?? homedir(), ".omp/agent/harness/gate/evidence.ts"), "manifest", "--repo", REPO, "--feature", feature, "--driver", ".omp/skills/verify-dotz/scripts/drive.ts", "--command", command, "--run", out, ...kinds],
	{ stdout: "inherit", stderr: "inherit" },
);
if (manifest.exitCode !== 0) process.exit(1);
console.log(`manifest: ${relative(REPO, join(out, "manifest.json"))}`);
