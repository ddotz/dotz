import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { REPO, type Run, alive, call, readRun } from "./lib.ts";
import { appShellScript, autoReplyColdScript, autoReplyScript, fallbackKeysOffScript, fallbackKeysOnScript, fallbackUndoScript, fourTabAddressScript, fourTabAppsScript, fourTabCreateScript, fourTabDeleteScript, fourTabPanelScript, mailAppColdScript, mailAppNoneScript, mailAppPickScript, seenResultsScript } from "./browser.ts";

const [feature, runId] = process.argv.slice(2);
const FEATURES = ["auto-reply", "app-shell", "comments-mail-app", "fallback-keys", "seen-results", "four-tab"];
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
	const r = Bun.spawnSync(["aside", "repl", "--", script], { stdout: "pipe", stderr: "pipe", env, timeout: 118_000 });
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
	const errors = r.stderr.toString();
	writeFileSync(join(out, `${step}.log`), `${kept.join("\n")}\n${errors}`);
	written.push(`${step}.log`);
	const threw = [...kept, ...errors.split("\n")].some(l => l.startsWith("@@FAIL") || /^\[error \| \d+ms\]$/.test(l));
	if (r.exitCode !== 0 || threw) fail(`browser step ${step} failed (exit ${r.exitCode}); see ${relative(REPO, join(out, `${step}.log`))}`);
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
	type Item = { key: string; app: string };
	const owner = async (path: string): Promise<unknown> => (await call(run, path, { as: "owner" })).json();
	const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? new Map(Object.entries(v)).get(k) : undefined);
	const listOf = (v: unknown, k: string): unknown[] => {
		const list = field(v, k);
		if (!Array.isArray(list)) fail(`${k}: expected a list, got ${JSON.stringify(v)}`);
		return Array.isArray(list) ? list : [];
	};
	const items = async (): Promise<Item[]> => listOf(await owner("/api/integrations"), "items").map(i => ({ key: String(field(i, "key")), app: String(field(i, "app")) }));
	const firstSource = async (): Promise<{ mailApp: unknown }> => ({ mailApp: field(listOf(await owner("/api/comments/sources"), "sources")[0], "mailApp") });
	const config = join(run.data, "custom", "comments", "config.json");
	mkdirSync(join(run.data, "custom", "sns"), { recursive: true });
	mkdirSync(join(run.data, "custom", "comments"), { recursive: true });
	writeFileSync(join(run.data, "custom", "sns", "config.json"), `${JSON.stringify({ youtube: {} })}\n`);
	writeFileSync(config, `${JSON.stringify({ enabled: true, sources: { youtube: { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: [], autoDraft: false, autoMail: true } } })}\n`);
	const none = await items();
	if (!none.some(i => i.key === "youtube") || none.some(i => i.app === "mail")) fail(`arrange: expected the youtube app and no mail app, got ${JSON.stringify(none.map(i => i.key))}`);
	note("arrange: custom/sns/config.json + custom/comments/config.json (the owner's own config files) give a YouTube comment source with autoMail on and no mail app; /api/integrations lists no mail app");
	noExternalNetwork("before");
	artifacts.push(...browser("browser-none", mailAppNoneScript(browserRun)));
	note("none: the 메일 앱 choice is disabled and the sheet says 연결된 메일 앱이 없어요 (sheet-none-390.png)");

	writeFileSync(join(run.data, "custom", "apps.json"), `${JSON.stringify({ "mail-work": { label: "회사 메일" } })}\n`);
	const connected = await items();
	if (!connected.some(i => i.key === "mail-work" && i.app === "mail")) fail(`arrange: /api/integrations lists no mail-work instance: ${JSON.stringify(connected)}`);
	const sourceBefore = await firstSource();
	if (sourceBefore.mailApp !== null) fail(`mailApp is ${sourceBefore.mailApp} before the pick, expected null`);
	note("arrange: custom/apps.json adds the mail instance 회사 메일 (mail-work); before: /api/comments/sources mailApp null");
	artifacts.push(...browser("browser-pick", mailAppPickScript(browserRun)));
	const saved = field(field(JSON.parse(readFileSync(config, "utf8")), "sources"), "youtube");
	if (field(saved, "mailApp") !== "mail-work" || field(saved, "autoMail") !== true) fail(`after the pick custom/comments/config.json holds ${JSON.stringify(saved)}, expected mailApp mail-work and autoMail true`);
	const sourceAfter = await firstSource();
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
} else if (feature === "seen-results") {
	const lane = "verify-n13";
	const send = async (body: Record<string, unknown>): Promise<void> => {
		const r = (await (await call(run, "/api/send", { as: "agent", method: "POST", body: JSON.stringify(body) })).json()) as { delivered?: boolean; reason?: string; error?: string };
		if (!r.delivered) fail(`POST /api/send ${JSON.stringify(body)}: ${JSON.stringify(r)}`);
	};
	type Listed = { id: string; key?: string; kind: string; msg?: string; src?: string; at?: string; read: boolean };
	const notice = async (): Promise<Listed | undefined> => ((await (await call(run, "/api/notices?limit=300", { as: "owner" })).json()) as { items: Listed[] }).items.find(n => n.key === `lane:${lane}`);
	await send({ target: "worklog", update_key: `lane:${lane}`, text: "[done] 검증용 세션의 빌드가 끝났어요" });
	const fillers = 40;
	for (let i = 1; i <= fillers; i++) await send({ target: "worklog", text: `검증용 기록 ${i}번째 줄이에요` });
	const last = `검증용 기록 ${fillers}번째 줄이에요`;
	const before = await notice();
	if (!before?.at || before.read !== false || before.kind !== "result") fail(`the session result notice is not an unread result after arranging: ${JSON.stringify(before)}`);
	note(`arrange: a session's line posted to 작업내역 through POST /api/send (update_key lane:${lane}) made result notice ${before.id} (src ${before.src}, msg ${before.msg}, at ${before.at}), then ${fillers} later 작업내역 lines`);
	note(`before: GET /api/notices lists ${before.id} read=false`);
	noExternalNetwork("before");
	artifacts.push(...browser("browser-seen", seenResultsScript(browserRun, lane, before.at, last)));
	const after = await notice();
	if (after?.read !== true) fail(`the result notice is not read after its row was seen: ${JSON.stringify(after)}`);
	note(`after: GET /api/notices lists ${after.id} read=true; the browser step recorded it unread after opening lane:${lane} and after opening 작업내역 with the row off screen (browser-seen.log)`);
	noExternalNetwork("after");
} else if (feature === "four-tab") {
	const APP = "verify-tool", LABEL = "검증 도구", PAGE = "verify tool page";
	const toolSrc = `const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><title>verify tool</title><h1>${PAGE}</h1>", { headers: { "content-type": "text/html; charset=utf-8" } }) }); console.log(s.port);`;
	const tool = Bun.spawn(["bun", "-e", toolSrc], { stdout: "pipe", stderr: "inherit" });
	process.on("exit", () => tool.kill());
	const toolPort = Number(new TextDecoder().decode((await tool.stdout.getReader().read()).value).trim());
	if (!(toolPort > 0)) fail("the stand-in web app did not start");
	mkdirSync(join(run.data, "custom", "apps", APP), { recursive: true });
	writeFileSync(join(run.data, "custom", "apps", APP, "app.json"), `${JSON.stringify({ label: LABEL, kind: "tool", web: { url: `http://127.0.0.1:${toolPort}`, path: "/", mode: "rewrite" }, health: "/" })}\n`);
	const body: unknown = await (await call(run, "/api/apps", { as: "owner" })).json();
	const listedApps: unknown[] = typeof body === "object" && body !== null && "items" in body && Array.isArray(body.items) ? body.items : [];
	const listed = listedApps.find(a => typeof a === "object" && a !== null && "id" in a && a.id === APP);
	const status = typeof listed === "object" && listed !== null && "status" in listed ? listed.status : undefined;
	if (status !== "running") fail(`arrange: GET /api/apps lists ${APP} as ${JSON.stringify(listed)}, expected running`);
	note(`arrange: custom/apps/${APP}/app.json (the owner's own manifest) points at a stand-in page on 127.0.0.1:${toolPort}; GET /api/apps lists it running`);
	noExternalNetwork("before");
	artifacts.push(...browser("browser-addresses", fourTabAddressScript(browserRun, APP)));
	note("addresses: #projects, #project/builtin:custom, #monitoring/replies, #apps, #apps/<id>, #apps/<missing> opened cold at 390 and 1280 and lit the tab listed in addresses.log");
	artifacts.push(...browser("browser-apps", fourTabAppsScript(browserRun, APP, LABEL, PAGE)));
	note("apps: 승인 대기 is the first row at 390 with nothing waiting; the web app opened in the pane right of the list at 1280 and full width at 390; 상단 고정 put it first and a reload kept it; 고정 해제 put it back (apps.log)");
	const NAME = "검증 프로젝트";
	const onDisk = (file: string): unknown => (existsSync(join(run.data, file)) ? JSON.parse(readFileSync(join(run.data, file), "utf8")) : {});
	const part = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? new Map(Object.entries(v)).get(k) : undefined);
	const workNames = (): string[] => Object.values(part(onDisk("channels.json"), "work") ?? {}).map(String);
	if (workNames().includes(NAME)) fail(`arrange: channels.json already names a project ${NAME}`);
	artifacts.push(...browser("browser-create", fourTabCreateScript(browserRun, NAME)));
	const key = /^@@KEY (ch:\d+)$/m.exec(readFileSync(join(out, "browser-create.log"), "utf8"))?.[1];
	if (!key) fail("the create step printed no project key");
	const id = String(key).slice(3);
	const made = [part(part(onDisk("channels.json"), "work"), id), part(part(part(onDisk("projects.json"), "projects"), String(key)), "title"), part(part(part(onDisk("projects.json"), "projects"), String(key)), "purpose")];
	if (made[0] !== NAME || made[1] !== NAME || !made[2]) fail(`after 만들기 the data dir holds ${JSON.stringify(made)} for ${key}`);
	if (workNames().filter(n => n === NAME).length !== 1) fail(`the refused second 만들기 left ${JSON.stringify(workNames())} in channels.json`);
	note(`create: + 새 프로젝트 at 390 refused an empty name, made ${key} and opened its chat; channels.json work[${id}] and projects.json ${key} hold the name and purpose; the same name again was refused in the sheet and made no second project (create.log)`);
	artifacts.push(...browser("browser-panel", fourTabPanelScript(browserRun, String(key), NAME)));
	note(`panel: 현황 at 1280 opened the overview beside the conversation at #project/${key} without a new history entry and kept the typed draft, also after closing; #project/${key} opened cold at 390 and 1280 is the chat with the panel; 뒤로 from 현황 at 390 returned to 대화 (panel.log)`);
	artifacts.push(...browser("browser-delete", fourTabDeleteScript(browserRun, String(key), NAME)));
	const gone = [part(part(onDisk("channels.json"), "work"), id), part(part(onDisk("projects.json"), "projects"), String(key))];
	if (gone[0] !== undefined || gone[1] !== undefined) fail(`after 삭제 the data dir still holds ${JSON.stringify(gone)} for ${key}`);
	note(`delete: ⋯ → 프로젝트 삭제 from the project's chat head landed on #chat/main; channels.json and projects.json no longer hold ${key} (delete.log)`);
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
process.exit(0);
