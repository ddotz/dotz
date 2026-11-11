// Messenger onboarding engine (설정 → 메신저 → 연결): a small injectable state machine. Flows are lists of steps; every
// automatic step runs without a model call, and a step stops at exactly one owner action (login, 2FA, consent, captcha).
// The view persists in <DATA_DIR>/onboarding/<key>.json (0600, atomic) with the step index, never a secret value.
// Browser work runs in the owner's background Aside session (no window forward, no Chrome.app, no OS keys).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AsideRepl, resetToken } from "../onboard/discord.ts";
import { ensureAside, oneShotInbox } from "./aside.ts";
import { DATA_DIR, log, writeAtomic } from "./config.ts";
import { createDiscordStore, type DiscordStore } from "./discord-connection.ts";
import { msg } from "./i18n.ts";
import { inboxPost, loginCaptureScript, loginCloseScript } from "./messenger-login.ts";
import { discordFlow } from "./onboarding-discord.ts";
import { createJandiStore, jandiFlow, type JandiStore } from "./onboarding-jandi.ts";
import { slackFlow } from "./onboarding-slack.ts";
import { telegramFlow } from "./onboarding-telegram.ts";
import { webAccessFlow } from "./onboarding-web-access.ts";
import { json } from "./routes-util.ts";
import { runLimited } from "./run-limited.ts";
import { writeSecretFile } from "./secretbox.ts";

export const ONBOARD_KEYS = ["discord", "jandi", "slack", "telegram", "web-access"] as const;
export type OnboardKey = (typeof ONBOARD_KEYS)[number];
export type OnboardState = "idle" | "running" | "waiting" | "done" | "failed";
export type OnboardOwnerStep = { label: string; hint: string };
export type OnboardStep = { id: string; title: string; detail: string };
export type OnboardChoice = { id: string; label: string };
export type OnboardView = {
	key: OnboardKey;
	state: OnboardState;
	step: OnboardStep | null;
	owner: OnboardOwnerStep | null; // exactly one action when state is waiting or failed
	error: string | null; // scrubbed, capped; owner.hint carries the one next step
	url: string | null;
	/** Set while waiting for the owner to pick one of them (continue with { choice }). */
	choices?: OnboardChoice[];
	/** Only the owner can answer this step: the web panel must not continue by itself. */
	manual?: true;
	updated_at: string;
};

/** Runs one scripted step in the owner's background Aside browser. Returns plain data; never logs a secret. */
export type BrowserLike = {
	run(action: string, arg?: Record<string, unknown>): Promise<{ ok: boolean; value?: string; waiting?: string; data?: Record<string, unknown> }>;
};

export type OnboardDeps = {
	dir: string;
	fetch: typeof fetch;
	browser: BrowserLike;
	exec: (argv: string[]) => Promise<{ code: number; out: string }>;
	/** A command that may stay alive (cloudflared tunnel login): each output line reaches `onLine` as it arrives. */
	execLines?: (argv: string[], onLine: (line: string) => void) => Promise<{ code: number; out: string }>;
	restart: () => Promise<void>;
	/** Makes the web access mode live (hub/web-access.ts change); the web-access flow needs it. */
	applyWebAccess?: (input: { mode: string; hostname?: string; token?: string }) => Promise<void>;
	/** Overrides ~ for ~/.cloudflared (tests). */
	home?: string;
	now?: () => number;
	/** Runs `fn` after `ms` (setTimeout by default): the recheck of a waiting step. Tests hold it and call it themselves. */
	after?: (ms: number, fn: () => void) => void;
	/** One plain line to the chat that asked for the connection (hub/outbound.ts send by default). */
	say?: (target: string, text: string) => Promise<unknown>;
	// Injectable stores for tests; the defaults read the real data dir (the DISCORD one is the live config).
	discord?: DiscordStore;
	jandi?: JandiStore;
};

export type OnboardInventory = { secrets: string[]; config: boolean; messengers: string[]; accounts: boolean };
/** `waiting` with `recheckMs` is run again by the engine after that long (a login the owner is doing); with `choices` it waits for { choice }. */
export type OnboardStepOutcome = { done: true; url?: string } | { waiting: OnboardOwnerStep; recheckMs?: number; choices?: OnboardChoice[]; manual?: true };

export type OnboardFlowContext = {
	deps: OnboardDeps;
	dir: string;
	inventory: OnboardInventory;
	/** How many times continue ran this flow since the last start (0 on start): a browser step that waits for the owner skips its first pass. */
	attempt: number;
	/** The choice the owner made with the last continue that carried one. */
	choice: string | undefined;
	/** Per-run scratch for a value one step computes for a later one (never persisted, never a secret). */
	memo: Map<string, string>;
	/** Remembers a secret so any later error text is scrubbed, and returns it unchanged. */
	seen(value: string): string;
	scrub(text: string): string;
	/** Marks that config or a secret changed, so the adapters restart once at the end. */
	changed(): void;
	hasChanged(): boolean;
	secret(name: string): string;
	saveSecret(name: string, value: string): void;
	/** Like saveSecret, but encrypted (hub/secretbox.ts); for values only the gateway reads back. */
	saveSealed(name: string, value: string): void;
	readJson(rel: string): Record<string, unknown> | undefined;
	writeJson(rel: string, value: unknown, mode?: number): void;
	discord: DiscordStore;
	jandi: JandiStore;
};

export type OnboardFlowStep = {
	id: string;
	title: string;
	detail: string;
	/** The one action the owner can take when this step fails, or when the browser reports a login wall. */
	owner: OnboardOwnerStep;
	run(ctx: OnboardFlowContext): Promise<OnboardStepOutcome>;
};
export type OnboardFlow = { key: OnboardKey; steps: OnboardFlowStep[]; /** Runs on cancel and when the flow fails or gives up (closes a login tab). */ cleanup?(ctx: OnboardFlowContext): Promise<unknown>; /** After a failure the next run begins at the first step: its later steps need what the run held in memory. */ restartOnFail?: true };

type Saved = { version: 1; index: number; attempt: number; view: OnboardView; notify?: string; choice?: string };
const noChoices = ({ choices: _choices, manual: _manual, ...rest }: OnboardView): OnboardView => rest;
const DEFAULT_OWNER: OnboardOwnerStep = { label: "연결 다시 시작", hint: "연결을 다시 시작하고 화면에 남은 안내를 따라 주세요." };
const TOKEN_LIKE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{25,}/g;

export function scrubText(text: unknown, secrets: Iterable<string> = []): string {
	let s = typeof text === "string" ? text : text instanceof Error ? text.message : "알 수 없는 오류";
	for (const secret of [...secrets].filter(v => v && v.length >= 4).sort((a, b) => b.length - a.length)) s = s.split(secret).join("***");
	return s.replace(TOKEN_LIKE, "***").replace(/\s+/g, " ").trim().slice(0, 200);
}

function namesIn(dir: string): string[] {
	try {
		return readdirSync(dir).filter(n => !n.startsWith(".")).sort();
	} catch {
		return [];
	}
}

export function inventoryOf(dir: string): OnboardInventory {
	return {
		secrets: namesIn(join(dir, "secrets")),
		config: existsSync(join(dir, "config.json")),
		messengers: namesIn(join(dir, "messengers")).filter(n => n.endsWith(".json")),
		accounts: existsSync(join(dir, "accounts.json")),
	};
}

const statePath = (dir: string, key: OnboardKey) => join(dir, "onboarding", `${key}.json`);
const stepOf = (s: OnboardFlowStep): OnboardStep => ({ id: s.id, title: s.title, detail: s.detail });

const flows = new Map<OnboardKey, OnboardFlow>();
export function registerFlow(flow: OnboardFlow): void {
	flows.set(flow.key, flow);
}
registerFlow(discordFlow);
registerFlow(jandiFlow);
registerFlow(slackFlow);
registerFlow(telegramFlow);
registerFlow(webAccessFlow);

export type OnboardingService = {
	view(key: OnboardKey): OnboardView;
	/** `notify`: the chat that asked; it gets one plain line at each new owner step, failure and the end. */
	start(key: OnboardKey, opts?: { notify?: string }): OnboardView;
	continue(key: OnboardKey, opts?: { choice?: string }): OnboardView;
	cancel(key: OnboardKey): OnboardView;
	/** Done without running the steps (a mode that needs none); the web-access local choice uses it. */
	markDone(key: OnboardKey): OnboardView;
	inventory(): OnboardInventory;
	idle(key: OnboardKey): Promise<void>;
};

class StepError {
	constructor(
		readonly step: OnboardFlowStep,
		readonly cause: unknown,
	) {}
}
const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : "알 수 없는 오류");

export function createOnboarding(deps: OnboardDeps): OnboardingService {
	const now = () => deps.now?.() ?? Date.now();
	const stamp = () => new Date(now()).toISOString();
	const discord = deps.discord ?? createDiscordStore(deps.dir === DATA_DIR ? undefined : deps.dir);
	const jandi = deps.jandi ?? createJandiStore(deps.dir);
	const saved = new Map<OnboardKey, Saved>();
	const running = new Set<OnboardKey>();
	const runs = new Map<OnboardKey, Promise<void>>();
	const generations = new Map<OnboardKey, number>();

	const blank = (key: OnboardKey): Saved => ({ version: 1, index: 0, attempt: 0, view: { key, state: "idle", step: null, owner: null, error: null, url: null, updated_at: stamp() } });

	const load = (key: OnboardKey): Saved => {
		const hit = saved.get(key);
		if (hit) return hit;
		let value = blank(key);
		try {
			const raw = JSON.parse(readFileSync(statePath(deps.dir, key), "utf8")) as Partial<Saved>;
			const view = raw.view;
			if (view && view.key === key && (ONBOARD_KEYS as readonly string[]).includes(view.key)) {
				value = { version: 1, index: Math.max(0, Number(raw.index) || 0), attempt: Math.max(0, Number(raw.attempt) || 0), view: { ...value.view, ...view, key }, ...(typeof raw.notify === "string" ? { notify: raw.notify } : {}), ...(typeof raw.choice === "string" ? { choice: raw.choice } : {}) };
			}
		} catch {}
		saved.set(key, value);
		return value;
	};

	const persist = (key: OnboardKey, value: Saved): void => {
		const dir = join(deps.dir, "onboarding");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		const file = statePath(deps.dir, key);
		// The view carries no secret: errors are scrubbed and steps never hold a token.
		writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, 0o600);
		chmodSync(file, 0o600);
	};
	const store = (key: OnboardKey, value: Saved): void => {
		saved.set(key, value);
		persist(key, value);
	};

	const secretsOf = (): Set<string> => {
		const out = new Set<string>();
		const add = (v: unknown) => {
			if (typeof v === "string" && v.trim().length >= 4) out.add(v.trim());
		};
		for (const name of namesIn(join(deps.dir, "secrets"))) {
			try {
				add(readFileSync(join(deps.dir, "secrets", name), "utf8").slice(0, 8192));
			} catch {}
		}
		add(discord.token());
		const j = jandi.load();
		add(j.incoming_url);
		for (const room of j.rooms) {
			add(room.outgoing_token);
			add(room.incoming_url);
		}
		return out;
	};

	const context = (attempt: number, choice?: string): OnboardFlowContext => {
		const secrets = secretsOf();
		let changed = false;
		const seen = (value: string): string => {
			if (typeof value === "string" && value.trim().length >= 4) secrets.add(value.trim());
			return value;
		};
		return {
			deps,
			dir: deps.dir,
			inventory: inventoryOf(deps.dir),
			attempt,
			choice,
			memo: new Map<string, string>(),
			seen,
			scrub: text => scrubText(text, secrets),
			changed: () => {
				changed = true;
			},
			hasChanged: () => changed,
			secret: name => {
				try {
					return seen(readFileSync(join(deps.dir, "secrets", name), "utf8").trim());
				} catch {
					return "";
				}
			},
			saveSecret: (name, value) => {
				seen(value);
				const secretsDir = join(deps.dir, "secrets");
				mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
				chmodSync(secretsDir, 0o700);
				const file = join(secretsDir, name);
				writeAtomic(file, `${value}\n`, 0o600);
				chmodSync(file, 0o600);
			},
			saveSealed: (name, value) => {
				seen(value);
				const secretsDir = join(deps.dir, "secrets");
				mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
				chmodSync(secretsDir, 0o700);
				writeSecretFile(join(secretsDir, name), value);
			},
			readJson: rel => {
				try {
					const v = JSON.parse(readFileSync(join(deps.dir, rel), "utf8"));
					return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
				} catch {
					return undefined;
				}
			},
			writeJson: (rel, value, mode = 0o600) => {
				const file = join(deps.dir, rel);
				mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
				writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
				chmodSync(file, mode);
			},
			discord,
			jandi,
		};
	};

	const lastWaiting = new Map<OnboardKey, string>();
	const tell = (key: OnboardKey, text: string): void => {
		const target = load(key).notify;
		if (!target) return;
		const say = deps.say ?? (async (to: string, line: string) => (await import("./outbound.ts")).send(to, line));
		void say(target, text).catch(e => log(`onboarding ${key}: could not tell ${target}: ${errorText(e)}`));
	};
	const closeUp = (key: OnboardKey): void => {
		const flow = flows.get(key);
		if (flow?.cleanup) void flow.cleanup(context(0)).catch(e => log(`onboarding ${key}: cleanup failed: ${errorText(e)}`));
	};

	/** Returns how long to wait before the engine runs the step again, when the step asked for a recheck. */
	const run = async (key: OnboardKey, value: Saved, from: number, generation: number): Promise<number | undefined> => {
		const flow = flows.get(key);
		if (!flow) return undefined;
		const ctx = context(value.attempt, value.choice);
		let current: OnboardFlowStep | undefined = flow.steps[from];
		try {
			for (let i = from; i < flow.steps.length; i++) {
				if (generations.get(key) !== generation) return undefined;
				const step = flow.steps[i]!;
				current = step;
				value.index = i;
				value.view = { ...noChoices(value.view), state: "running", step: stepOf(step), owner: null, error: null, updated_at: stamp() };
				store(key, value);
				let outcome: OnboardStepOutcome;
				try {
					outcome = await step.run(ctx);
				} catch (e) {
					throw new StepError(step, e);
				}
				if (generations.get(key) !== generation) return undefined;
				if ("waiting" in outcome) {
					value.view = { ...noChoices(value.view), state: "waiting", step: stepOf(step), owner: outcome.waiting, error: null, ...(outcome.choices ? { choices: outcome.choices } : {}), ...(outcome.manual ? { manual: true as const } : {}), updated_at: stamp() };
					store(key, value);
					if (lastWaiting.get(key) !== step.id) tell(key, msg().connect.say.waiting(outcome.waiting.label, outcome.waiting.hint));
					lastWaiting.set(key, step.id);
					return outcome.recheckMs;
				}
				if (outcome.url !== undefined) value.view = { ...noChoices(value.view), url: outcome.url };
			}
			if (generations.get(key) !== generation) return undefined;
			if (ctx.hasChanged()) await deps.restart();
			if (generations.get(key) !== generation) return undefined;
			const last = flow.steps[flow.steps.length - 1];
			value.index = flow.steps.length;
			value.view = { ...noChoices(value.view), state: "done", step: last ? stepOf(last) : null, owner: null, error: null, updated_at: stamp() };
			store(key, value);
			lastWaiting.delete(key);
			tell(key, msg().connect.say.done);
			log(`onboarding ${key} done`);
			return undefined;
		} catch (e) {
			if (generations.get(key) !== generation) return undefined;
			const step = e instanceof StepError ? e.step : current;
			const text = ctx.scrub(errorText(e instanceof StepError ? e.cause : e));
			if (flow.restartOnFail) {
				value.index = 0;
				value.attempt = 0;
			}
			value.view = { ...noChoices(value.view), state: "failed", step: step ? stepOf(step) : null, owner: step?.owner ?? DEFAULT_OWNER, error: text, updated_at: stamp() };
			store(key, value);
			log(`onboarding ${key} failed at ${step?.id ?? "?"}: ${text}`);
			lastWaiting.delete(key);
			tell(key, msg().connect.say.failed(text, step?.owner.hint ?? DEFAULT_OWNER.hint));
			closeUp(key);
			return undefined;
		}
	};

	const begin = (key: OnboardKey, from: number, attempt: number): OnboardView => {
		const value = load(key);
		const generation = (generations.get(key) ?? 0) + 1;
		generations.set(key, generation);
		running.add(key);
		const flow = flows.get(key);
		value.index = from;
		value.attempt = Math.max(0, attempt);
		value.view = { ...noChoices(value.view), state: "running", step: flow?.steps[from] ? stepOf(flow.steps[from]!) : null, owner: null, error: null, ...(from === 0 ? { url: null } : {}), updated_at: stamp() };
		store(key, value);
		const view = { ...value.view };
		let recheck: number | undefined;
		const promise = run(key, value, from, generation)
			.then(ms => void (recheck = ms))
			.finally(() => {
				if (generations.get(key) !== generation) return;
				running.delete(key);
				if (runs.get(key) === promise) runs.delete(key);
				if (recheck !== undefined) (deps.after ?? ((ms, fn) => void setTimeout(fn, ms)))(recheck, () => generations.get(key) === generation && load(key).view.state === "waiting" && void cont(key));
			});
		runs.set(key, promise);
		void promise;
		return view;
	};

	const start = (key: OnboardKey, opts: { notify?: string } = {}): OnboardView => {
		if (running.has(key)) return load(key).view;
		const flow = flows.get(key);
		if (!flow || !flow.steps.length) return load(key).view;
		const value = load(key);
		const resume = value.view.state === "waiting" || value.view.state === "failed";
		const from = resume ? Math.min(Math.max(0, value.index), flow.steps.length - 1) : 0;
		if (from === 0) {
			delete value.choice;
			lastWaiting.delete(key);
		}
		if (opts.notify) value.notify = opts.notify;
		else if (from === 0) delete value.notify;
		return begin(key, from, 0);
	};

	const cont = (key: OnboardKey, opts: { choice?: string } = {}): OnboardView => {
		if (running.has(key)) return load(key).view;
		const flow = flows.get(key);
		if (!flow || !flow.steps.length) return load(key).view;
		const value = load(key);
		if (value.view.state !== "waiting" && value.view.state !== "failed") return value.view;
		if (opts.choice) value.choice = opts.choice;
		const from = Math.min(Math.max(0, value.index), flow.steps.length - 1);
		return begin(key, from, (value.attempt ?? 0) + 1);
	};

	const cancel = (key: OnboardKey): OnboardView => {
		generations.set(key, (generations.get(key) ?? 0) + 1);
		running.delete(key);
		runs.delete(key);
		lastWaiting.delete(key);
		closeUp(key);
		const value = load(key);
		delete value.choice;
		value.index = 0;
		value.attempt = 0;
		value.view = { ...noChoices(value.view), state: "idle", step: null, owner: null, error: null, url: null, updated_at: stamp() };
		store(key, value);
		return { ...value.view };
	};

	/** Records a flow that finished outside its steps (web access local mode needs no tunnel): done at once, no secret. */
	const markDone = (key: OnboardKey): OnboardView => {
		generations.set(key, (generations.get(key) ?? 0) + 1);
		running.delete(key);
		runs.delete(key);
		const value = load(key);
		const flow = flows.get(key);
		const last = flow && flow.steps.length ? flow.steps[flow.steps.length - 1] : undefined;
		value.index = flow?.steps.length ?? 0;
		value.view = { ...noChoices(value.view), state: "done", step: last ? stepOf(last) : null, owner: null, error: null, url: null, updated_at: stamp() };
		store(key, value);
		return { ...value.view };
	};

	return {
		view: key => ({ ...load(key).view }),
		start,
		continue: cont,
		cancel,
		markDone,
		inventory: () => inventoryOf(deps.dir),
		idle: key => runs.get(key) ?? Promise.resolve(),
	};
}

// The browser is the owner's Aside session, opened in the background. Scripts print one RESULT line; the token is
// parsed from it and returned as a value, never printed, and every tab a step opens is closed.
const RESULT_LINE = /RESULT (\{[^\n]*\})/g;
const tick = (ms: number) => `await new Promise(r => setTimeout(r, ${ms}));`;

function discordAppScript(name: string): string {
	return [
		`await openTab('https://discord.com/developers/applications');`,
		tick(3500),
		`const id = await page.evaluate(async n => { const links = [...document.querySelectorAll('a[href*="/applications/"]')]; const hit = links.find(a => (((a.parentElement && a.parentElement.innerText) || a.innerText || '').toLowerCase().includes(n.toLowerCase()))); if (hit) return ((hit.getAttribute('href') || '').match(/\\/applications\\/(\\d+)/) || [])[1] || ''; const btn = [...document.querySelectorAll('button')].find(b => /New Application|새 애플리케이션/i.test(b.innerText)); if (!btn) return ''; btn.click(); await new Promise(r => setTimeout(r, 2500)); const input = document.querySelector('input[name="name"], input[type="text"]'); if (!input) return ''; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, n); input.dispatchEvent(new Event('input', { bubbles: true })); const box = document.querySelector('input[type="checkbox"]'); if (box && !box.checked) box.click(); await new Promise(r => setTimeout(r, 300)); const create = [...document.querySelectorAll('button')].find(b => /Create|만들기/i.test(b.innerText) && !b.disabled); if (create) create.click(); await new Promise(r => setTimeout(r, 5000)); return (location.pathname.match(/\\/applications\\/(\\d+)/) || [])[1] || ''; }, ${JSON.stringify(name)});`,
		`console.log('RESULT ' + JSON.stringify(id ? { ok: true, value: id } : { ok: false, waiting: 'app' }));`,
		`await page.close();`,
	].join(" ");
}

function discordGuildScript(): string {
	return [
		`await openTab('https://discord.com/channels/@me');`,
		tick(4000),
		`const id = await page.evaluate(() => [...document.querySelectorAll('a[href^="/channels/"]')].map(a => ((a.getAttribute('href') || '').match(/^\\/channels\\/(\\d+)/) || [])[1]).find(Boolean) || '');`,
		`console.log('RESULT ' + JSON.stringify(id ? { ok: true, value: id } : { ok: false, waiting: 'login' }));`,
		`await page.close();`,
	].join(" ");
}

function inviteScript(url: string): string {
	return [
		`await openTab(${JSON.stringify(url)});`,
		tick(3000),
		`await page.evaluate(async () => { const find = labels => [...document.querySelectorAll('button')].find(b => labels.includes(b.innerText.trim()) && !b.disabled); for (const labels of [['계속하기', '계속', 'Continue'], ['승인', 'Authorize']]) { const b = find(labels); if (b) { b.click(); await new Promise(r => setTimeout(r, 1500)); } } });`,
		`console.log('RESULT ' + JSON.stringify({ ok: true }));`,
		`await page.close();`,
	].join(" ");
}

function cloudflareLoginScript(url: string): string {
	// The tab stays open: the owner approves the login in it, and cloudflared writes ~/.cloudflared/cert.pem when they do.
	return [`await openTab(${JSON.stringify(url)});`, tick(2000), `console.log('RESULT ' + JSON.stringify({ ok: true }));`].join(" ");
}

function slackAppScript(name: string, inbox: string): string {
	const manifest = { display_information: { name }, features: { bot_user: { display_name: name, always_online: true } }, oauth_config: { scopes: { bot: ["chat:write", "channels:read", "channels:join", "channels:manage", "users:read"] } }, settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false } };
	return [
		`await openTab('https://api.slack.com/apps?new_app=1');`,
		tick(3500),
		`await page.evaluate(async m => { const byText = t => [...document.querySelectorAll('button,a,[role="button"]')].find(b => (b.innerText || '').trim() === t); const from = byText('From a manifest') || byText('매니페스트에서'); if (from) { from.click(); await new Promise(r => setTimeout(r, 1200)); } const next = byText('Next') || byText('다음'); if (next) { next.click(); await new Promise(r => setTimeout(r, 1200)); } const area = document.querySelector('textarea'); if (area) { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(area, JSON.stringify(m, null, 2)); area.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 800)); } const create = byText('Create') || byText('만들기'); if (create) { create.click(); await new Promise(r => setTimeout(r, 2500)); } const install = [...document.querySelectorAll('button,a,[role="button"]')].find(b => /Install to Workspace|워크스페이스에 설치/i.test(b.innerText || '')); if (install) { install.click(); await new Promise(r => setTimeout(r, 2000)); } const allow = [...document.querySelectorAll('button,a,[role="button"]')].find(b => /^(Allow|허용)$/.test((b.innerText || '').trim())); if (allow) { allow.click(); await new Promise(r => setTimeout(r, 4000)); } }, ${JSON.stringify(manifest)});`,
		`const token = await page.evaluate(() => ((document.body.innerText || '') + ' ' + [...document.querySelectorAll('input,textarea')].map(x => x.value || '').join(' ')).match(/xox[baprs]-[A-Za-z0-9-]{10,}/));`,
		`if (token) { ${inboxPost(inbox, "{ token: token[0] }")} }`,
		`console.log('RESULT ' + JSON.stringify(token ? { ok: true } : { ok: false, waiting: 'login' }));`,
		`await page.close();`,
	].join(" ");
}

function telegramBotScript(inbox: string): string {
	return [
		`await openTab('https://web.telegram.org/k/#@BotFather');`,
		tick(4000),
		`await page.evaluate(async () => { const box = document.querySelector('.input-message-input[contenteditable="true"], .input-message-input'); if (!box) return; box.focus(); document.execCommand('insertText', false, '/newbot'); await new Promise(r => setTimeout(r, 500)); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); await new Promise(r => setTimeout(r, 2500)); });`,
		`const token = await page.evaluate(() => ((document.body.innerText || '') + ' ' + [...document.querySelectorAll('input,textarea')].map(x => x.value || '').join(' ')).match(/(?:^|[^0-9])(\d{5,}:[A-Za-z0-9_-]{10,})/));`,
		`if (token) { ${inboxPost(inbox, "{ token: token[1] }")} }`,
		`console.log('RESULT ' + JSON.stringify(token ? { ok: true } : { ok: false, waiting: 'login' }));`,
		`await page.close();`,
	].join(" ");
}

function cloudflareZoneScript(): string {
	return [
		`await openTab('https://dash.cloudflare.com/');`,
		tick(5000),
		`const zone = await page.evaluate(() => { const near = [...document.querySelectorAll('a,button,[role="button"],h3,h4,span')].map(e => (e.innerText || '').trim()).filter(t => /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(t) && !/cloudflare\.com$/i.test(t)); if (near.length) return near[0]; const m = (document.body.innerText || '').match(/\b([a-z0-9][a-z0-9-]*\.(?:com|net|org|io|dev|co|kr|xyz|app|me))\b/i); return m ? m[1] : ''; });`,
		`console.log('RESULT ' + JSON.stringify(zone ? { ok: true, value: zone } : { ok: false, waiting: 'login' }));`,
		`await page.close();`,
	].join(" ");
}

function createAsideBrowser(): BrowserLike {
	let repl: AsideRepl | undefined;
	const ensure = async (): Promise<AsideRepl> => {
		if (repl) return repl;
		await ensureAside().catch((e: unknown) => {
			log(`onboarding: Aside not available: ${errorText(e)}`);
			throw new Error(msg().connect.login.unavailable);
		});
		repl = new AsideRepl();
		return repl;
	};
	const script = async (code: string): Promise<{ ok: boolean; value?: string; waiting?: string; data?: Record<string, unknown> }> => {
		// The repl keeps one top-level scope for its whole life: a block lets the same script run twice.
		const out = await (await ensure()).run(`{ ${code} }`);
		const hits = [...out.matchAll(RESULT_LINE)];
		const raw = hits[hits.length - 1]?.[1];
		if (!raw) return { ok: false };
		try {
			return JSON.parse(raw) as { ok: boolean; value?: string; waiting?: string };
		} catch {
			return { ok: false };
		}
	};
	/** Runs a script that posts what it read to a one-shot localhost inbox; the value comes back as `data`, never through the script's output. */
	const captured = async (build: (inbox: string) => string): Promise<{ ok: boolean; value?: string; waiting?: string; data?: Record<string, unknown> }> => {
		const inbox = oneShotInbox();
		try {
			const r = await script(build(inbox.url));
			const data = inbox.got();
			return r.ok && data ? { ok: true, data } : r;
		} finally {
			inbox.stop();
		}
	};
	/** A finished login needs no repl: it holds no tab any more, so the process does not stay around. */
	const released = async <T extends { data?: unknown }>(r: T, always = false): Promise<T> => {
		if (repl && (always || r.data)) await repl.close();
		if (always || r.data) repl = undefined;
		return r;
	};
	return {
		async run(action, arg = {}) {
			switch (action) {
				case "discord-app":
					return script(discordAppScript(String(arg.name ?? "dotz")));
				case "discord-guild":
					return script(discordGuildScript());
				case "discord-invite":
					return script(inviteScript(String(arg.url ?? "")));
				case "login-capture":
					return released(await captured(inbox => loginCaptureScript({ key: String(arg.key ?? ""), url: String(arg.url ?? ""), read: String(arg.read ?? ""), inbox })));
				case "login-close":
					return released(await script(loginCloseScript(String(arg.key ?? ""))), true);
				case "cloudflare-login":
					return script(cloudflareLoginScript(String(arg.url ?? "")));
				case "cloudflare-zone":
					return script(cloudflareZoneScript());
				case "slack-app":
					return captured(inbox => slackAppScript(String(arg.name ?? "dotz"), inbox));
				case "telegram-bot":
					return captured(inbox => telegramBotScript(inbox));
				case "discord-token": {
					const r = await ensure();
					try {
						return { ok: true, value: await resetToken(r, String(arg.appId ?? ""), () => {}) };
					} finally {
						await r.run(`await page.close(); console.log('RESULT {"ok":true}');`).catch(() => "");
					}
				}
				case "close":
					if (repl) await repl.close();
					repl = undefined;
					return { ok: true };
				default:
					return { ok: false };
			}
		},
	};
}

const EXEC_MS = 60_000; // `which` and the cloudflared tunnel list, create, route and token calls answer in seconds
const BREW_MS = 30 * 60_000; // `brew install` downloads and may build from source (a slow machine can take over 15 min)
const LOGIN_MS = 15 * 60_000; // `cloudflared tunnel login` waits for the owner to sign in in a browser

function defaultExec(argv: string[]): Promise<{ code: number; out: string }> {
	return runLimited(argv, argv[0] === "brew" ? BREW_MS : EXEC_MS).then(r => ({ code: r.code, out: r.stdout + r.stderr + (r.timedOut ? "\n(timed out)" : "") }));
}

function defaultExecLines(argv: string[], onLine: (line: string) => void): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", timeout: LOGIN_MS, killSignal: "SIGKILL" });
	let out = "";
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		let rest = "";
		for await (const chunk of stream) {
			const text = decoder.decode(chunk, { stream: true });
			out += text;
			rest += text;
			for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
				onLine(rest.slice(0, i));
				rest = rest.slice(i + 1);
			}
		}
		if (rest) onLine(rest);
	};
	return Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]).then(([, , code]) => {
		if (proc.signalCode === "SIGKILL") log(`${argv[0]}: no answer in ${LOGIN_MS / 60_000} min, killed`);
		return { code, out };
	});
}

export function defaultOnboardDeps(dir: string = DATA_DIR, overrides: Partial<OnboardDeps> = {}): OnboardDeps {
	return {
		dir,
		fetch,
		browser: createAsideBrowser(),
		exec: defaultExec,
		execLines: defaultExecLines,
		restart: async () => {
			const { adapters, restart } = await import("./messenger.ts");
			for (const adapter of adapters()) if (adapter.enabled()) await restart(adapter);
		},
		discord: createDiscordStore(dir === DATA_DIR ? undefined : dir),
		jandi: createJandiStore(dir),
		...overrides,
		dir,
	};
}

let service: OnboardingService | undefined;
let override: OnboardDeps | undefined;
export function onboardingService(): OnboardingService {
	return (service ??= createOnboarding(override ?? defaultOnboardDeps()));
}
export function setOnboardDeps(deps?: OnboardDeps): void {
	override = deps;
	service = undefined;
}

/** GET /api/onboarding/<key>, POST /api/onboarding/<key>/{start,continue,cancel}; JSON only, never a secret. */
export async function onboardingRoute(req: Request, url: URL, svc?: OnboardingService): Promise<Response | undefined> {
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts[0] !== "api" || parts[1] !== "onboarding") return undefined;
	const key = parts[2] as OnboardKey | undefined;
	if (!key || !(ONBOARD_KEYS as readonly string[]).includes(key)) return json({ error: `unknown onboarding ${parts[2] ?? ""}` }, 404);
	const service = svc ?? onboardingService();
	if (parts.length === 3) {
		if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
		return json(service.view(key));
	}
	if (parts.length === 4 && (parts[3] === "start" || parts[3] === "continue" || parts[3] === "cancel")) {
		if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
		const body = (await req.json().catch(() => undefined)) as { notify?: unknown; choice?: unknown } | null | undefined;
		const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);
		const notify = text(body?.notify, 200);
		const choice = text(body?.choice, 100);
		return json(parts[3] === "start" ? service.start(key, notify ? { notify } : {}) : parts[3] === "continue" ? service.continue(key, choice ? { choice } : {}) : service.cancel(key));
	}
	return undefined;
}
