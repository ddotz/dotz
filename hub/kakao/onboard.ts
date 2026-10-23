// One-sentence KakaoTalk onboarding ("카톡 연결해줘"): a resumable step machine with ONE progress message edited in place and
// as few owner asks as possible (credentials and permissions are asked together). Every side effect goes through the injected
// Runner / Hub / Ports, so tests run the real machine against fakes. This file imports none of the other kakao modules;
// hub/kakao/cli.ts wires the real ones. The login id, password and database key never pass through here.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KAKAO_BUNDLE, type HubFull, type KakaoConfig, type KakaoPaths, kakaoPaths, type LoginStatus, type Runner } from "./types.ts";

export const PROGRESS_KEY = "kakao-setup";
// The gateway only accepts watch names of [a-z0-9-].
export const WATCH_NAME = "kakao-new";
export const CARD_ID = "kakao";
export const OFF_LINE = "카톡 연동이 꺼져 있어요. 켜려면 '카톡 연결해줘'라고 말해 주세요";
export const RUNNING_LINE = "카톡 연결이 이미 진행 중이에요. 진행 상황은 알림 메시지 하나에 계속 고쳐 써요";

export const STEPS = [
	{ id: "deps", name: "필요한 프로그램" },
	{ id: "app", name: "카카오톡 앱" },
	{ id: "ask", name: "입력 요청" },
	{ id: "permissions", name: "권한" },
	{ id: "credentials", name: "계정 정보" },
	{ id: "login", name: "로그인" },
	{ id: "derive", name: "데이터 연결" },
	{ id: "read", name: "읽기 확인" },
	{ id: "watch", name: "새 메시지 모니터링" },
	{ id: "card", name: "상태 카드" },
	{ id: "enable", name: "켜기" },
] as const;
export type StepId = (typeof STEPS)[number]["id"];
export const stepName = (id: StepId) => STEPS.find(s => s.id === id)!.name;

export type OnboardState = {
	status: "running" | "stopped" | "done";
	steps: Partial<Record<StepId, "done" | "skipped">>;
	current?: StepId;
	stoppedAt?: { step: StepId; reason: string; action: string };
	authId?: string;
	started: string;
	finished?: string;
	pid?: number;
	target?: string;
	badLogins?: number;
	counts?: { rooms: number; draftable: number };
};

// What the machine needs from the other kakao modules; cli.ts builds these from db.ts / creds.ts / login.ts.
export type Ports = {
	hasKmsg: () => boolean;
	appInstalled: () => Promise<boolean>;
	accessibilityGranted: () => Promise<boolean>;
	hasCredentials: () => Promise<boolean>;
	// Moves the gateway's secret file into the Keychain and deletes it either way; true when the Keychain took it.
	importAuthFile: () => Promise<boolean>;
	clearCredentials: () => Promise<void>;
	login: () => Promise<{ status: LoginStatus }>;
	resumeAfterConfirm: () => Promise<{ status: LoginStatus }>;
	// Derives the database location and stores the key in the Keychain itself; the key never comes back here.
	derive: () => Promise<{ dbPath: string; userId: number }>;
	readCounts: (config: KakaoConfig) => Promise<{ rooms: number; draftable: number; maxLogId: string }>;
};

export type Deps = {
	paths: KakaoPaths;
	runner: Runner;
	hub: HubFull;
	ports: Ports;
	target: string;
	repo: string;
	execPath: string;
	brew: string;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	pid: number;
	isAlive: (pid: number) => boolean;
	log?: (line: string) => void;
	// Login-only run (`cli login`): same asks, no progress message, no saved state.
	solo?: boolean;
};

const MIN = 60_000;
const POLL_MS = 3000;
const INSTALL_MS = 10 * MIN;
const APP_WAIT_MS = 30 * MIN;
const PERM_WAIT_MS = 20 * MIN;
const FDA_HINT_MS = 2 * MIN;
const AUTH_WAIT_MS = 31 * MIN;
const MAX_LOGIN_ROUNDS = 6;
const STORE_URL = "macappstore://apps.apple.com/app/id869223134";
const BREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
const AGAIN = "'카톡 연결해줘'라고 다시 말해 주세요";

type Perm = "fda" | "ax";
const PERM_PANE: Record<Perm, string> = {
	fda: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
	ax: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};
const PERM_NAME: Record<Perm, string> = { fda: "전체 디스크 접근", ax: "손쉬운 사용" };

class Stop extends Error {
	constructor(
		readonly step: StepId,
		readonly reason: string,
		readonly action: string,
	) {
		super(reason);
	}
}

export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function atomicWrite(file: string, text: string, mode = 0o644): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode });
	chmodSync(tmp, mode);
	renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export const readState = (paths: KakaoPaths) => readJson<OnboardState>(paths.onboard);

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function isOn(paths: KakaoPaths): boolean {
	return readJson<KakaoConfig>(paths.config)?.enabled === true;
}

export const watchScriptPath = (paths: KakaoPaths) => join(paths.dataDir, "custom", "kakao", "watch.sh");
export const cardFile = (paths: KakaoPaths) => join(paths.dataDir, "custom", "cards", CARD_ID, "card.json");
export const featureFile = (paths: KakaoPaths) => join(paths.dataDir, "features", "kakao", "feature.md");

const cliLine = (d: Pick<Deps, "execPath" | "repo" | "paths">, args: string) =>
	`DOTZ_DIR=${shq(d.paths.dataDir)} ${shq(d.execPath)} ${shq(join(d.repo, "hub", "kakao", "cli.ts"))} ${args}`;

class Machine {
	view = new Map<StepId, string>();
	todo = new Map<string, string>();
	lastText = "";
	asked = false;
	resumeAt?: StepId;
	private mode: "run" | "fail" | "done" = "run";

	constructor(
		readonly d: Deps,
		public st: OnboardState,
	) {}

	private get target() {
		return this.st.target ?? this.d.target;
	}

	private save() {
		if (!this.d.solo) atomicWrite(this.d.paths.onboard, `${JSON.stringify(this.st, null, 1)}\n`);
	}

	private render(): string {
		const lines: string[] = [];
		if (this.mode === "done") {
			const c = this.st.counts;
			return [
				"[done] 카톡 연결이 끝났어요",
				"- 아직 보는 대화방이 없어요. 모니터링 > 앱 > 카카오톡에서 보고 싶은 대화방을 골라 주세요",
				"- 고른 대화방의 새 메시지만 확인해요",
				"- 답장 초안은 승인한 것만 보내요",
			].join("\n");
		}
		if (this.mode === "fail") lines.push("[fail] 카톡 연결이 멈췄어요. 아래 할 일을 하고 이어서 해 주세요.");
		else {
			const resumed = this.resumeAt ? `${stepName(this.resumeAt)}부터 이어서 해요.` : "";
			lines.push(this.todo.size ? `[ask] ${resumed} 아래 일을 해 주세요. 끝나면 바로 이어서 진행해요.`.replace("  ", " ") : `[run] ${resumed || "카톡 연결을 진행하고 있어요."}`);
		}
		for (const s of STEPS) if (this.view.has(s.id)) lines.push(`- ${s.name}: ${this.view.get(s.id)}`);
		if (this.todo.size) {
			lines.push("", "할 일");
			[...this.todo.values()].forEach((t, i) => lines.push(`${i + 1}. ${t}`));
		}
		return lines.join("\n");
	}

	async post() {
		if (this.d.solo) return;
		const text = this.render();
		if (text === this.lastText) return;
		this.lastText = text;
		try {
			await this.d.hub.post("/api/send", { target: this.target, text, update_key: PROGRESS_KEY });
		} catch (e) {
			this.d.log?.(`progress post failed: ${(e as Error).message}`);
		}
	}

	private async begin(id: StepId, view = "하는 중") {
		this.st.current = id;
		this.view.set(id, view);
		this.save();
		await this.post();
	}

	private async wait(id: StepId, what: string) {
		this.view.set(id, `기다리는 중(${what})`);
		await this.post();
	}

	private finish(id: StepId, note?: string) {
		this.st.steps[id] = "done";
		this.view.set(id, note ? `끝(${note})` : "끝");
		this.save();
	}

	private exec(argv: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}) {
		return this.d.runner(argv, opts).catch(() => ({ code: 127, stdout: "", stderr: "" }));
	}

	private async hubGet(path: string) {
		try {
			return await this.d.hub.get(path);
		} catch {
			return { status: 0, json: undefined as any };
		}
	}

	private permTodo(p: Perm) {
		return `${PERM_NAME[p]} 설정 창에서 + 를 눌러 ${this.d.execPath} 를 추가하고 켜 주세요`;
	}

	private async missingPerms(): Promise<Perm[]> {
		const out: Perm[] = [];
		// The KakaoTalk container exists only after the app's first launch; ~/Library/Safari is protected the same way and is always there.
		let ls = await this.exec(["/bin/ls", join(this.d.paths.home, "Library", "Containers", KAKAO_BUNDLE, "Data", "Library")]);
		if (ls.code !== 0 && /no such file/i.test(ls.stderr)) ls = await this.exec(["/bin/ls", join(this.d.paths.home, "Library", "Safari")]);
		if (ls.code !== 0 && /operation not permitted/i.test(ls.stderr)) out.push("fda");
		if (!(await this.d.ports.accessibilityGranted())) out.push("ax");
		return out;
	}

	private async ensureAsk(purpose: string) {
		if (this.st.authId) {
			const r = await this.hubGet(`/api/auth/${this.st.authId}`);
			if (r.json?.status === "pending") {
				this.todo.set("creds", CRED_TODO);
				return;
			}
		}
		const r = await this.d.hub.post("/api/auth", { kind: "secret", site: "kakao", fields: ["username", "password"], purpose, target: this.target, timeout_minutes: 30 });
		if (r.status >= 300 || typeof r.json?.id !== "string") throw new Stop("ask", "입력 요청을 보내지 못했어요", `게이트웨이가 켜져 있는지 확인한 뒤 ${AGAIN}`);
		this.st.authId = r.json.id;
		this.save();
		this.todo.set("creds", CRED_TODO);
	}

	// The batching point: credentials and every missing permission are asked in one message.
	private async batchAsk() {
		if (this.asked) return;
		this.asked = true;
		for (const p of await this.missingPerms()) this.todo.set(p, this.permTodo(p));
		if (!(await this.d.ports.hasCredentials())) await this.ensureAsk(CRED_PURPOSE);
		this.st.steps.ask = "done";
		this.view.set("ask", "끝");
		this.save();
	}

	private async waitAuth(id: string): Promise<"entered" | "approved" | "cancelled" | "timeout" | "lost"> {
		const until = this.d.now() + AUTH_WAIT_MS;
		for (;;) {
			const r = await this.hubGet(`/api/auth/${id}?wait=55`);
			if (r.status === 404) return "lost";
			const s = r.json?.status;
			if (s === "entered" || s === "approved" || s === "cancelled" || s === "timeout") return s;
			if (this.d.now() > until) return "timeout";
			if (r.status !== 200) await this.d.sleep(POLL_MS);
		}
	}

	private async importCreds() {
		await this.d.ports.importAuthFile();
		if (!(await this.d.ports.hasCredentials())) throw new Stop("credentials", "계정 정보를 저장하지 못했어요", `입력을 한 번 더 받으려면 ${AGAIN}`);
	}

	private async deps() {
		await this.begin("deps");
		const env = { HOMEBREW_NO_AUTO_UPDATE: "1" };
		const brew = this.d.brew;
		if ((await this.exec([brew, "--version"], { env })).code !== 0)
			throw new Stop("deps", "Homebrew가 없어요", `Homebrew를 깔려면 맥 비밀번호가 필요해서 직접 해야 해요. 터미널에서 이 명령을 한 번 실행한 뒤 ${AGAIN}: ${BREW_INSTALL}`);
		const listed = await this.exec([brew, "list", "--versions", "sqlcipher"], { env });
		if (listed.code !== 0 || !listed.stdout.trim()) {
			if ((await this.exec([brew, "install", "sqlcipher"], { env, timeoutMs: INSTALL_MS })).code !== 0) throw new Stop("deps", "sqlcipher를 설치하지 못했어요", `잠시 뒤 ${AGAIN}`);
		}
		if (!this.d.ports.hasKmsg()) {
			if ((await this.exec([brew, "install", "channprj/tap/kmsg"], { env, timeoutMs: INSTALL_MS })).code !== 0) throw new Stop("deps", "kmsg를 설치하지 못했어요", `잠시 뒤 ${AGAIN}`);
		}
		this.finish("deps");
	}

	private async app() {
		if (await this.d.ports.appInstalled()) return this.finish("app");
		await this.begin("app");
		await this.exec(["open", "-g", STORE_URL]);
		this.todo.set("app", "App Store에서 카카오톡을 설치해 주세요");
		await this.batchAsk();
		await this.wait("app", "설치");
		const until = this.d.now() + APP_WAIT_MS;
		while (!(await this.d.ports.appInstalled())) {
			if (this.d.now() > until) throw new Stop("app", "카카오톡이 설치되지 않았어요", `App Store에서 카카오톡을 설치한 뒤 ${AGAIN}`);
			await this.d.sleep(POLL_MS);
		}
		this.todo.delete("app");
		this.finish("app");
	}

	private async ask() {
		if (this.asked) return;
		await this.batchAsk();
		await this.post();
	}

	private async permissions() {
		let missing = await this.missingPerms();
		if (!missing.length) return this.finish("permissions");
		this.st.current = "permissions";
		const opened = new Set<Perm>();
		const start = this.d.now();
		let hinted = false;
		while (missing.length) {
			const first = missing[0]!;
			if (!opened.has(first)) {
				opened.add(first);
				await this.exec(["open", "-g", PERM_PANE[first]]);
			}
			for (const p of ["fda", "ax"] as const) {
				if (missing.includes(p)) this.todo.set(p, this.permTodo(p));
				else this.todo.delete(p);
			}
			if (!hinted && missing.includes("fda") && this.d.now() - start >= FDA_HINT_MS) {
				hinted = true;
				this.todo.set("restart", "전체 디스크 접근을 이미 켰는데도 이 안내가 계속되면 게이트웨이를 한 번 다시 시작해 주세요");
			}
			await this.wait("permissions", PERM_NAME[first]);
			if (this.d.now() - start >= PERM_WAIT_MS) throw new Stop("permissions", `${PERM_NAME[first]} 권한이 켜지지 않았어요`, `${this.permTodo(first)}. 그런 다음 ${AGAIN}`);
			await this.d.sleep(POLL_MS);
			missing = await this.missingPerms();
		}
		for (const k of ["fda", "ax", "restart"]) this.todo.delete(k);
		this.finish("permissions");
	}

	private async credentials() {
		// An answer left by an earlier run that stopped before storing it goes to the Keychain (or is deleted) first.
		await this.d.ports.importAuthFile();
		if (await this.d.ports.hasCredentials()) {
			if (this.st.authId) await this.d.hub.del(`/api/auth/${this.st.authId}`).catch(() => undefined);
			this.st.authId = undefined;
			this.todo.delete("creds");
			return this.finish("credentials");
		}
		await this.begin("credentials");
		await this.takeAnswer(CRED_PURPOSE, "credentials", "입력");
		this.finish("credentials");
	}

	// Waits for the secret ask (asking again once when the gateway forgot it), then stores the answer.
	private async takeAnswer(purpose: string, step: StepId, what: string) {
		for (let again = 0; ; again++) {
			if (!this.st.authId) await this.ensureAsk(purpose);
			await this.wait(step, what);
			const outcome = await this.waitAuth(this.st.authId!);
			if (outcome === "lost" && again === 0) {
				this.st.authId = undefined;
				continue;
			}
			this.st.authId = undefined;
			this.todo.delete("creds");
			this.save();
			if (outcome !== "entered") throw new Stop(step, outcome === "cancelled" ? "입력을 취소했어요" : "입력 시간이 지났어요", `다시 입력하려면 ${AGAIN}`);
			return this.importCreds();
		}
	}

	private async confirm() {
		const r = await this.d.hub.post("/api/auth", { kind: "approve", site: "kakao", purpose: PHONE_TODO, target: this.target, timeout_minutes: 10 });
		this.todo.set("approve", PHONE_TODO);
		await this.wait("login", "휴대폰 확인");
		const res = await this.d.ports.resumeAfterConfirm();
		this.todo.delete("approve");
		if (typeof r.json?.id === "string") await this.d.hub.del(`/api/auth/${r.json.id}`).catch(() => undefined);
		if (res.status !== "ok") throw new Stop("login", "휴대폰 확인이 끝나지 않았어요", `휴대폰 카카오톡에서 확인한 뒤 ${AGAIN}`);
	}

	private async login() {
		await this.begin("login");
		for (let round = 1; ; round++) {
			if (round > MAX_LOGIN_ROUNDS) throw new Stop("login", "로그인이 끝나지 않았어요", `카카오톡 앱 상태를 확인한 뒤 ${AGAIN}`);
			const { status } = await this.d.ports.login();
			if (status === "ok") break;
			if (status === "confirm") {
				await this.confirm();
				break;
			}
			if (status === "bad_credentials") {
				await this.d.ports.clearCredentials();
				this.st.badLogins = (this.st.badLogins ?? 0) + 1;
				this.save();
				if (this.st.badLogins >= 2)
					throw new Stop("login", "아이디나 비밀번호가 두 번 맞지 않았어요", `계정이 잠기지 않게 여기서 멈췄어요. 카카오톡이나 휴대폰에서 직접 로그인되는지 확인한 뒤 ${AGAIN}`);
				await this.takeAnswer("카카오톡이 아이디나 비밀번호를 받아 주지 않았어요. 다시 한 번 입력해 주세요", "login", "다시 입력");
			} else if (status === "no_credentials") {
				await this.takeAnswer(CRED_PURPOSE, "login", "입력");
			} else if (status === "no_accessibility") {
				await this.permissions();
				await this.begin("login");
			} else if (status === "not_installed") {
				await this.app();
				await this.begin("login");
			} else throw new Stop("login", "로그인하지 못했어요", `카카오톡 앱이 열려 있는지 확인한 뒤 ${AGAIN}`);
		}
		this.st.badLogins = 0;
		this.finish("login");
	}

	private async derive() {
		await this.begin("derive");
		let info: { dbPath: string; userId: number };
		try {
			info = await this.d.ports.derive();
		} catch (e) {
			this.d.log?.(`derive failed: ${(e as Error).message}`);
			throw new Stop("derive", "카톡 데이터 위치를 찾지 못했어요", `카카오톡이 로그인된 채로 켜져 있는지 확인한 뒤 ${AGAIN}`);
		}
		const old = readJson<KakaoConfig>(this.d.paths.config) ?? ({} as KakaoConfig);
		const config: KakaoConfig = { enabled: true, dbPath: info.dbPath, userId: info.userId, settle_seconds: old.settle_seconds ?? 20, max_per_run: old.max_per_run ?? 10, exclude_chats: old.exclude_chats ?? [], watch_chats: old.watch_chats ?? [] };
		atomicWrite(this.d.paths.config, `${JSON.stringify(config, null, 1)}\n`);
		this.finish("derive");
	}

	private async read() {
		await this.begin("read");
		let counts: { rooms: number; draftable: number; maxLogId: string };
		try {
			counts = await this.d.ports.readCounts(readJson<KakaoConfig>(this.d.paths.config)!);
		} catch (e) {
			this.d.log?.(`test read failed: ${(e as Error).message}`);
			throw new Stop("read", "카톡 데이터를 읽지 못했어요", `전체 디스크 접근이 켜져 있는지 확인하고, 켜져 있다면 게이트웨이를 한 번 다시 시작한 뒤 ${AGAIN}`);
		}
		if (counts.rooms === 0) throw new Stop("read", "읽을 수 있는 대화방이 없어요", `카카오톡에 대화가 보이는지 확인한 뒤 ${AGAIN}`);
		this.st.counts = { rooms: counts.rooms, draftable: counts.draftable };
		this.finish("read", `대화방 ${counts.rooms}개, 초안 대상 ${counts.draftable}개`);
	}

	private async watch() {
		await this.begin("watch");
		const { paths, execPath, repo } = this.d;
		const script = watchScriptPath(paths);
		atomicWrite(
			script,
			[
				"#!/bin/sh",
				'pgrep -xq KakaoTalk || { echo "DOTZ_FAIL app"; echo "카카오톡이 꺼져 있어요"; exit 1; }',
				`DOTZ_DIR=${shq(paths.dataDir)}`,
				"export DOTZ_DIR",
				`exec ${shq(execPath)} ${shq(join(repo, "hub", "kakao", "watch.ts"))}`,
				"",
			].join("\n"),
			0o755,
		);
		const channel = /^ch:(\d+)$/.exec(this.target)?.[1];
		const channels = channel ? [channel] : [];
		const listed = await this.d.hub.get("/api/watches");
		const list: any[] = Array.isArray(listed.json) ? listed.json : (listed.json?.watches ?? []);
		const found = list.find(w => w.name === WATCH_NAME);
		if (found?.script === script && JSON.stringify(found.channels ?? []) === JSON.stringify(channels)) {
			if (found.paused) await this.d.hub.patch(`/api/watches/${found.id}`, { paused: false });
		} else {
			const r = await this.d.hub.post("/api/watches", {
				name: WATCH_NAME,
				script,
				every_minutes: 1,
				on: "match",
				pattern: ".",
				to: "orchestrator",
				...(channels.length ? { channels } : {}),
				timeout_seconds: 60,
				retry: { app: [5, 15, 30], fda: [], db: [10, 30] },
			});
			if (r.status >= 300) throw new Stop("watch", "새 메시지 모니터링을 등록하지 못했어요", `잠시 뒤 ${AGAIN}`);
		}
		this.finish("watch");
	}

	private async card() {
		await this.begin("card");
		const d = this.d;
		const card = {
			title: "카톡",
			view: "kv",
			command: cliLine(d, "status --json"),
			every_minutes: 5,
			timeout_seconds: 30,
			actions: [
				{ label: "다시 로그인", prompt: "카톡 다시 로그인해 줘" },
				{ label: "설정 이어서", command: cliLine(d, "setup") },
				{ label: "끄기", prompt: "카톡 연동 꺼 줘", confirm: true },
			],
		};
		atomicWrite(cardFile(d.paths), `${JSON.stringify(card, null, 1)}\n`);
		this.finish("card");
	}

	// The personal copy follows the shipped one on every setup run, so updates reach it.
	private async enable() {
		await this.begin("enable");
		const shipped = readFileSync(join(this.d.repo, "features", "kakao", "feature.md"), "utf8");
		atomicWrite(featureFile(this.d.paths), shipped.replace(/^enabled: false$/m, "enabled: true"));
		this.finish("enable");
	}

	private async runStep(id: StepId) {
		const recheck = id === "app" || id === "permissions";
		if (this.st.steps[id] === "done" && !recheck) {
			this.view.set(id, "끝");
			return;
		}
		await this[id]();
	}

	async run(only?: StepId[]): Promise<void> {
		try {
			this.st.status = "running";
			delete this.st.stoppedAt;
			this.st.pid = this.d.pid;
			this.asked = this.st.steps.ask === "done";
			if (this.st.authId) this.todo.set("creds", CRED_TODO);
			this.save();
			await this.post();
			for (const s of STEPS) if (!only || only.includes(s.id)) await this.runStep(s.id);
			this.mode = "done";
			this.st.status = "done";
			this.st.finished = new Date(this.d.now()).toISOString();
			delete this.st.current;
			this.todo.clear();
			this.save();
		} catch (e) {
			const stop = e instanceof Stop ? e : new Stop(this.st.current ?? "deps", "예상하지 못한 문제가 생겼어요", `잠시 뒤 ${AGAIN}`);
			if (!(e instanceof Stop)) this.d.log?.(`unexpected: ${(e as Error).stack ?? e}`);
			this.mode = "fail";
			this.todo.clear();
			this.todo.set("stop", stop.action);
			this.view.set(stop.step, `멈춤(${stop.reason})`);
			this.st.status = "stopped";
			this.st.stoppedAt = { step: stop.step, reason: stop.reason, action: stop.action };
			this.save();
		}
		await this.post();
	}
}

const CRED_TODO = "알림으로 온 입력창에 카카오톡 아이디와 비밀번호를 입력해 주세요";
const CRED_PURPOSE = "카카오톡 로그인에 쓸 아이디와 비밀번호를 입력해 주세요. 키체인에만 저장하고 메시지에는 남기지 않아요";
const PHONE_TODO = "휴대폰 카카오톡에서 이 맥 로그인을 확인해 주세요";

export type RunOutcome = { outcome: "done" | "stopped" | "running"; state: OnboardState | undefined; text: string };

export async function runOnboarding(d: Deps): Promise<RunOutcome> {
	const prev = readState(d.paths);
	if (prev?.status === "running" && prev.pid && prev.pid !== d.pid && d.isAlive(prev.pid)) return { outcome: "running", state: prev, text: RUNNING_LINE };
	const resuming = prev !== undefined && prev.status !== "done";
	const st: OnboardState = resuming ? prev : { status: "running", steps: {}, started: new Date(d.now()).toISOString() };
	st.target = d.target;
	const m = new Machine(d, st);
	if (resuming) {
		m.resumeAt = prev.stoppedAt?.step ?? prev.current;
		if (prev.stoppedAt?.step === "login") st.badLogins = 0;
	}
	await m.run();
	return { outcome: st.status === "done" ? "done" : "stopped", state: st, text: m.lastText };
}

// `cli login`: just step 6 (with its permission / credential detours), no progress message and no saved state.
export async function runLoginOnly(d: Deps): Promise<{ ok: boolean; text: string }> {
	const m = new Machine({ ...d, solo: true }, { status: "running", steps: { deps: "done", ask: "done" }, started: new Date(d.now()).toISOString() });
	await m.run(["login"]);
	return m.st.status === "done" ? { ok: true, text: "[done] 카톡 로그인이 됐어요" } : { ok: false, text: `[fail] ${m.st.stoppedAt!.reason}. ${m.st.stoppedAt!.action}` };
}

// `setup --dry-run`: the same machine in a simulated world (every check passes, nothing real runs, files go to a temp dir that
// is removed afterwards). `emit` gets one line per progress message and per command.
export async function runDry(emit: (line: string) => void, repo: string, execPath: string): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "kakao-dry-"));
	const paths = kakaoPaths(join(dir, "data"), join(dir, "home"));
	let t = 0;
	let creds = false;
	const flat = (s: string) => s.replaceAll("\n", " / ");
	const d: Deps = {
		paths,
		repo,
		execPath,
		brew: "brew",
		target: "chat",
		pid: process.pid,
		isAlive: () => false,
		sleep: async ms => {
			t += ms;
		},
		now: () => t,
		runner: async argv => {
			emit(`run: ${argv.join(" ")}`);
			return { code: 0, stdout: "ok 1.0", stderr: "" };
		},
		hub: {
			post: async (path, body: any) => {
				if (path === "/api/send") emit(`post: ${flat(body.text)}`);
				else if (path === "/api/auth") emit(`ask: ${body.kind} (${flat(body.purpose)})`);
				return { status: 200, json: { id: "dry", ok: true } };
			},
			get: async path => ({ status: 200, json: path.startsWith("/api/auth/") ? { status: "entered" } : [] }),
			patch: async () => ({ status: 200, json: {} }),
			del: async () => ({ status: 200, json: {} }),
		},
		ports: {
			hasKmsg: () => true,
			appInstalled: async () => true,
			accessibilityGranted: async () => true,
			hasCredentials: async () => creds,
			importAuthFile: async () => {
				creds = true;
				return true;
			},
			clearCredentials: async () => {},
			login: async () => ({ status: "ok" }),
			resumeAfterConfirm: async () => ({ status: "ok" }),
			derive: async () => ({ dbPath: join(dir, "db"), userId: 1 }),
			readCounts: async () => ({ rooms: 3, draftable: 2, maxLogId: "1" }),
		},
	};
	try {
		await runOnboarding(d);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
