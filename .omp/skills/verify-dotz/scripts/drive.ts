import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { REPO, type Run, alive, call, readRun } from "./lib.ts";
import { appShellScript, autoReplyColdScript, autoReplyScript, fallbackKeysOffScript, fallbackKeysOnScript, fallbackUndoScript, mailAppColdScript, mailAppNoneScript, mailAppPickScript } from "./browser.ts";

const [feature, runId] = process.argv.slice(2);
const FEATURES = ["auto-reply", "app-shell", "comments-mail-app", "fallback-keys"];
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
const REAL_HOME = process.env.VERIFY_REAL_HOME ?? homedir();
const BROWSER_LOCK = join(REAL_HOME, ".cache", "verify-dotz", "browser.lock");
const LOCK_WAIT_MS = 600_000;

function takeBrowserLock(): void {
	mkdirSync(join(REAL_HOME, ".cache", "verify-dotz"), { recursive: true });
	const until = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			writeFileSync(BROWSER_LOCK, `${process.pid} ${runId}\n`, { flag: "wx" });
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const holder = Number(readFileSync(BROWSER_LOCK, "utf8").split(" ")[0]);
		if (!holder || !alive(holder)) {
			unlinkSync(BROWSER_LOCK);
			continue;
		}
		if (Date.now() > until) fail(`another verify-dotz drive (pid ${holder}) held the Aside browser for ${LOCK_WAIT_MS / 1000} s; see ${BROWSER_LOCK}`);
		Bun.sleepSync(500);
	}
}

function releaseBrowserLock(): void {
	try {
		if (readFileSync(BROWSER_LOCK, "utf8").startsWith(`${process.pid} `)) unlinkSync(BROWSER_LOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
process.on("exit", releaseBrowserLock);

function browser(step: string, script: string): string[] {
	const env = { ...process.env, HOME: REAL_HOME };
	takeBrowserLock();
	const r = Bun.spawnSync(["aside", "repl", "--file", "-"], { stdin: Buffer.from(script), stdout: "pipe", stderr: "pipe", env, timeout: 118_000 });
	releaseBrowserLock();
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
} else if (feature === "comments-mail-app") {
	const json = async (path: string): Promise<any> => (await call(run, path, { as: "owner" })).json();
	const config = join(run.data, "custom", "comments", "config.json");
	mkdirSync(join(run.data, "custom", "sns"), { recursive: true });
	mkdirSync(join(run.data, "custom", "comments"), { recursive: true });
	writeFileSync(join(run.data, "custom", "sns", "config.json"), `${JSON.stringify({ youtube: {} })}\n`);
	writeFileSync(config, `${JSON.stringify({ enabled: true, sources: { youtube: { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: [], autoDraft: false, autoMail: true } } })}\n`);
	const none = await json("/api/integrations");
	const mailsNone = (none.items as { app: string }[]).filter(i => i.app === "mail");
	if (!(none.items as { key: string }[]).some(i => i.key === "youtube") || mailsNone.length) fail(`arrange: expected the youtube app and no mail app, got ${JSON.stringify(none.items.map((i: { key: string }) => i.key))}`);
	note("arrange: custom/sns/config.json + custom/comments/config.json (the owner's own config files) give a YouTube comment source with autoMail on and no mail app; /api/integrations lists no mail app");
	noExternalNetwork("before");
	artifacts.push(...browser("browser-none", mailAppNoneScript(browserRun)));
	note("none: the 메일 앱 choice is disabled and the sheet says 연결된 메일 앱이 없어요 (sheet-none-390.png)");

	writeFileSync(join(run.data, "custom", "apps.json"), `${JSON.stringify({ "mail-work": { label: "회사 메일" } })}\n`);
	const connected = await json("/api/integrations");
	if (!(connected.items as { key: string; app: string }[]).some(i => i.key === "mail-work" && i.app === "mail")) fail(`arrange: /api/integrations lists no mail-work instance: ${JSON.stringify(connected.items)}`);
	const sourceBefore = (await json("/api/comments/sources")).sources[0];
	if (sourceBefore.mailApp !== null) fail(`mailApp is ${sourceBefore.mailApp} before the pick, expected null`);
	note("arrange: custom/apps.json adds the mail instance 회사 메일 (mail-work); before: /api/comments/sources mailApp null");
	artifacts.push(...browser("browser-pick", mailAppPickScript(browserRun)));
	const saved = JSON.parse(readFileSync(config, "utf8")).sources.youtube;
	if (saved.mailApp !== "mail-work" || saved.autoMail !== true) fail(`after the pick custom/comments/config.json holds ${JSON.stringify(saved)}, expected mailApp mail-work and autoMail true`);
	const sourceAfter = (await json("/api/comments/sources")).sources[0];
	if (sourceAfter.mailApp !== "mail-work") fail(`/api/comments/sources answers mailApp ${sourceAfter.mailApp} after the pick`);
	note(`after: custom/comments/config.json youtube source has mailApp mail-work, autoMail true; /api/comments/sources answers mailApp mail-work`);
	if (/zele mail (send|reply)/.test(calls())) fail("a zele send reached the stub during a settings change");
	note("after: no zele send in outbound/calls.log");
	noExternalNetwork("after");
	artifacts.push(...browser("browser-cold", mailAppColdScript(browserRun)));
	note("cold: fresh tabs at 390 and 1280 open the sheet and show 메일 앱: 회사 메일, enabled");
} else if (feature === "fallback-keys") {
	const OPUS = "anthropic/claude-opus-5-5";
	const json = { "content-type": "application/json" };
	const allowOnDisk = (): unknown => (JSON.parse(readFileSync(join(run.data, "config.json"), "utf8")) as { guard?: { allow_api_key?: unknown } }).guard?.allow_api_key;
	type ChainView = { model: string; key_file?: string; down_reason?: string }[];
	const chainNow = async (): Promise<ChainView> => ((await (await call(run, "/api/models", { as: "owner" })).json()) as { fallbacks: { orchestrator: { chain: ChainView } } }).fallbacks.orchestrator.chain;
	mkdirSync(join(run.data, "secrets"), { recursive: true });
	writeFileSync(join(run.data, "secrets", "anthropic-api-key"), "verify-placeholder-key\n", { mode: 0o600 });
	note("arrange: a placeholder key <data>/secrets/anthropic-api-key (API keys are off and no orchestrator runs, so it is never sent)");
	const chain = ["anthropic/claude-sonnet-5-5:high", { model: OPUS, key_file: "anthropic-api-key", when: "quota", enabled: true }];
	const put = await call(run, "/api/fallbacks", { as: "owner", method: "PUT", headers: json, body: JSON.stringify({ target: "orchestrator", chain }) });
	if (put.status !== 200) fail(`PUT /api/fallbacks: ${put.status} ${await put.text()}`);
	const arranged = await chainNow();
	if (arranged.length !== 2 || arranged[1]?.down_reason !== "api_key_off") fail(`the arranged chain is not [subscription step, key step down for api_key_off]: ${JSON.stringify(arranged)}`);
	note(`arrange: the orchestrator chain is ${arranged.map(e => e.model + (e.key_file ? " (API key)" : "")).join(" -> ")}; the key step is down with down_reason api_key_off`);
	const before = allowOnDisk();
	if (before === true) fail("guard.allow_api_key is already true before the drive");
	const agent = await call(run, "/api/guard/allow-api-key", { as: "agent", method: "PUT", body: JSON.stringify({ allow: true, confirm: true }) });
	if (agent.status !== 403 || allowOnDisk() !== before) fail(`an agent PUT answered ${agent.status} and left guard.allow_api_key ${JSON.stringify(allowOnDisk())}`);
	note(`before: guard.allow_api_key ${JSON.stringify(before)}; an agent (hub token) PUT {allow: true, confirm: true} answered 403 and config.json is unchanged`);
	noExternalNetwork("before");
	artifacts.push(...browser("browser-keys-on", fallbackKeysOnScript(browserRun)));
	if (allowOnDisk() !== true) fail(`after 켜기 guard.allow_api_key is ${JSON.stringify(allowOnDisk())}, expected true`);
	note("on: 취소 left the switch off; 켜기 in the confirm wrote guard.allow_api_key true to config.json");
	artifacts.push(...browser("browser-keys-off", fallbackKeysOffScript(browserRun)));
	if (allowOnDisk() !== false) fail(`after one tap off guard.allow_api_key is ${JSON.stringify(allowOnDisk())}, expected false`);
	note("off: one tap with no question wrote guard.allow_api_key false; the step's API 키 사용 안 함(설정) tag opened the explanation and the switch");
	artifacts.push(...browser("browser-undo", fallbackUndoScript(browserRun)));
	const restored = await chainNow();
	if (JSON.stringify(restored.map(e => [e.model, e.key_file ?? ""])) !== JSON.stringify(arranged.map(e => [e.model, e.key_file ?? ""]))) fail(`after 되돌리기 the chain is ${JSON.stringify(restored)}`);
	note("undo: 삭제 saved the chain without the first step and raised 되돌리기 with no dialog; 되돌리기 saved the previous chain again (read back from /api/models)");
	noExternalNetwork("after");
} else {
	artifacts.push(...browser("browser-shell", appShellScript(browserRun)));
	noExternalNetwork("after");
}

artifacts.push("network-after.txt", ...(feature === "app-shell" ? [] : ["network-before.txt"]));
writeFileSync(join(out, "checks.log"), `${notes.join("\n")}\n`);
artifacts.push("checks.log");
const kinds = artifacts.map(a => `${a}:${a.endsWith(".png") ? "screenshot" : "log"}`);
const command = `bun .omp/skills/verify-dotz/scripts/drive.ts ${feature} ${runId}`;
const manifest = Bun.spawnSync(
	["bun", join(REAL_HOME, ".omp/agent/harness/gate/evidence.ts"), "manifest", "--repo", REPO, "--feature", feature, "--driver", ".omp/skills/verify-dotz/scripts/drive.ts", "--command", command, "--run", out, ...kinds],
	{ stdout: "inherit", stderr: "inherit" },
);
if (manifest.exitCode !== 0) process.exit(1);
console.log(`manifest: ${relative(REPO, join(out, "manifest.json"))}`);
