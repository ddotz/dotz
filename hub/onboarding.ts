// Messenger onboarding engine (설정 → 메신저 → 연결): a small injectable state machine. Flows are lists of steps; every
// automatic step runs without a model call, and a step stops at exactly one owner action (login, 2FA, consent, captcha).
// The view persists in <DATA_DIR>/onboarding/<key>.json (0600, atomic) with the step index, never a secret value.
// Browser work runs in the owner's background Aside session (no window forward, no Chrome.app, no OS keys).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { asideState } from "../onboard/aside.ts";
import { AsideRepl, resetToken } from "../onboard/discord.ts";
import { DATA_DIR, log, writeAtomic } from "./config.ts";
import { createDiscordStore, type DiscordStore } from "./discord-connection.ts";
import { discordFlow } from "./onboarding-discord.ts";
import { createJandiStore, jandiFlow, type JandiStore } from "./onboarding-jandi.ts";
import { webAccessFlow } from "./onboarding-web-access.ts";
import { json } from "./routes-util.ts";

export const ONBOARD_KEYS = ["discord", "jandi", "slack", "telegram", "web-access"] as const;
export type OnboardKey = (typeof ONBOARD_KEYS)[number];
export type OnboardState = "idle" | "running" | "waiting" | "done" | "failed";
export type OnboardOwnerStep = { label: string; hint: string };
export type OnboardStep = { id: string; title: string; detail: string };
export type OnboardView = {
	key: OnboardKey;
	state: OnboardState;
	step: OnboardStep | null;
	owner: OnboardOwnerStep | null; // exactly one action when state is waiting or failed
	error: string | null; // scrubbed, capped; owner.hint carries the one next step
	url: string | null;
	updated_at: string;
};

/** Runs one scripted step in the owner's background Aside browser. Returns plain data; never logs a secret. */
export type BrowserLike = {
	run(action: string, arg?: Record<string, unknown>): Promise<{ ok: boolean; value?: string; waiting?: string }>;
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
	// Injectable stores for tests; the defaults read the real data dir (the DISCORD one is the live config).
	discord?: DiscordStore;
	jandi?: JandiStore;
};

export type OnboardInventory = { secrets: string[]; config: boolean; messengers: string[]; accounts: boolean };
export type OnboardStepOutcome = { done: true; url?: string } | { waiting: OnboardOwnerStep };

export type OnboardFlowContext = {
	deps: OnboardDeps;
	dir: string;
	inventory: OnboardInventory;
	/** How many times continue ran this flow since the last start (0 on start): a browser step that waits for the owner skips its first pass. */
	attempt: number;
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
export type OnboardFlow = { key: OnboardKey; steps: OnboardFlowStep[] };

type Saved = { version: 1; index: number; attempt: number; view: OnboardView };
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
registerFlow(webAccessFlow);

export type OnboardingService = {
	view(key: OnboardKey): OnboardView;
	start(key: OnboardKey): OnboardView;
	continue(key: OnboardKey): OnboardView;
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
				value = { version: 1, index: Math.max(0, Number(raw.index) || 0), attempt: Math.max(0, Number(raw.attempt) || 0), view: { ...value.view, ...view, key } };
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

	const context = (attempt: number): OnboardFlowContext => {
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

	const run = async (key: OnboardKey, value: Saved, from: number, generation: number): Promise<void> => {
		const flow = flows.get(key);
		if (!flow) return;
		const ctx = context(value.attempt);
		let current: OnboardFlowStep | undefined = flow.steps[from];
		try {
			for (let i = from; i < flow.steps.length; i++) {
				if (generations.get(key) !== generation) return;
				const step = flow.steps[i]!;
				current = step;
				value.index = i;
				value.view = { ...value.view, state: "running", step: stepOf(step), owner: null, error: null, updated_at: stamp() };
				store(key, value);
				let outcome: OnboardStepOutcome;
				try {
					outcome = await step.run(ctx);
				} catch (e) {
					throw new StepError(step, e);
				}
				if (generations.get(key) !== generation) return;
				if ("waiting" in outcome) {
					value.view = { ...value.view, state: "waiting", step: stepOf(step), owner: outcome.waiting, error: null, updated_at: stamp() };
					store(key, value);
					return;
				}
				if (outcome.url !== undefined) value.view = { ...value.view, url: outcome.url };
			}
			if (generations.get(key) !== generation) return;
			if (ctx.hasChanged()) await deps.restart();
			if (generations.get(key) !== generation) return;
			const last = flow.steps[flow.steps.length - 1];
			value.index = flow.steps.length;
			value.view = { ...value.view, state: "done", step: last ? stepOf(last) : null, owner: null, error: null, updated_at: stamp() };
			store(key, value);
			log(`onboarding ${key} done`);
		} catch (e) {
			if (generations.get(key) !== generation) return;
			const step = e instanceof StepError ? e.step : current;
			const text = ctx.scrub(errorText(e instanceof StepError ? e.cause : e));
			value.view = { ...value.view, state: "failed", step: step ? stepOf(step) : null, owner: step?.owner ?? DEFAULT_OWNER, error: text, updated_at: stamp() };
			store(key, value);
			log(`onboarding ${key} failed at ${step?.id ?? "?"}: ${text}`);
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
		value.view = { ...value.view, state: "running", step: flow?.steps[from] ? stepOf(flow.steps[from]!) : null, owner: null, error: null, ...(from === 0 ? { url: null } : {}), updated_at: stamp() };
		store(key, value);
		const view = { ...value.view };
		const promise = run(key, value, from, generation).finally(() => {
			if (generations.get(key) === generation) {
				running.delete(key);
				if (runs.get(key) === promise) runs.delete(key);
			}
		});
		runs.set(key, promise);
		void promise;
		return view;
	};

	const start = (key: OnboardKey): OnboardView => {
		if (running.has(key)) return load(key).view;
		const flow = flows.get(key);
		if (!flow || !flow.steps.length) return load(key).view;
		const value = load(key);
		const resume = value.view.state === "waiting" || value.view.state === "failed";
		const from = resume ? Math.min(Math.max(0, value.index), flow.steps.length - 1) : 0;
		return begin(key, from, 0);
	};

	const cont = (key: OnboardKey): OnboardView => {
		if (running.has(key)) return load(key).view;
		const flow = flows.get(key);
		if (!flow || !flow.steps.length) return load(key).view;
		const value = load(key);
		if (value.view.state !== "waiting" && value.view.state !== "failed") return value.view;
		const from = Math.min(Math.max(0, value.index), flow.steps.length - 1);
		return begin(key, from, (value.attempt ?? 0) + 1);
	};

	const cancel = (key: OnboardKey): OnboardView => {
		generations.set(key, (generations.get(key) ?? 0) + 1);
		running.delete(key);
		runs.delete(key);
		const value = load(key);
		value.index = 0;
		value.attempt = 0;
		value.view = { ...value.view, state: "idle", step: null, owner: null, error: null, url: null, updated_at: stamp() };
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
		value.view = { ...value.view, state: "done", step: last ? stepOf(last) : null, owner: null, error: null, url: null, updated_at: stamp() };
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

function jandiScript(url: string): string {
	return [
		`await openTab(${JSON.stringify(url)});`,
		tick(4000),
		`const where = page.url();`,
		`if (/login|signin|sign-in/i.test(where)) { console.log('RESULT ' + JSON.stringify({ ok: true, waiting: 'login' })); } else { const data = await page.evaluate(() => { const text = document.body.innerText; const urls = [...text.matchAll(/https?:\\/\\/[^\\s"'<>]+/g)].map(m => m[0]).filter(u => /webhook|hook|incoming/i.test(u)); const tokens = [...text.matchAll(/(?:token|토큰)[^A-Za-z0-9]{0,10}([A-Za-z0-9_-]{16,})/gi)].map(m => m[1]); return { urls: [...new Set(urls)], tokens: [...new Set(tokens)] }; }); const rooms = data.urls.slice(0, 1).map((u, i) => ({ id: 'room' + (i + 1), name: '메인', kind: 'main', incoming_url: u, outgoing_token: data.tokens[i] || '' })); console.log('RESULT ' + JSON.stringify(rooms.length ? { ok: true, value: JSON.stringify(rooms) } : { ok: false, waiting: 'webhook' })); }`,
		`await page.close();`,
	].join(" ");
}

function cloudflareLoginScript(url: string): string {
	// The tab stays open: the owner approves the login in it, and cloudflared writes ~/.cloudflared/cert.pem when they do.
	return [`await openTab(${JSON.stringify(url)});`, tick(2000), `console.log('RESULT ' + JSON.stringify({ ok: true }));`].join(" ");
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
		const state = await asideState();
		if (!state.cli) throw new Error("Aside CLI를 찾을 수 없어요");
		if (!state.app) {
			await Bun.spawn(["open", "-g", "-j", "-a", "Aside"]).exited;
			await Bun.sleep(4000);
		}
		repl = new AsideRepl();
		return repl;
	};
	const script = async (code: string): Promise<{ ok: boolean; value?: string; waiting?: string }> => {
		const out = await (await ensure()).run(code);
		const hits = [...out.matchAll(RESULT_LINE)];
		const raw = hits[hits.length - 1]?.[1];
		if (!raw) return { ok: false };
		try {
			return JSON.parse(raw) as { ok: boolean; value?: string; waiting?: string };
		} catch {
			return { ok: false };
		}
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
				case "jandi-webhooks":
					return script(jandiScript(String(arg.url ?? "https://www.jandi.com")));
				case "cloudflare-login":
					return script(cloudflareLoginScript(String(arg.url ?? "")));
				case "cloudflare-zone":
					return script(cloudflareZoneScript());
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

function defaultExec(argv: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([out, err, code]) => ({ code, out: out + err }));
}

function defaultExecLines(argv: string[], onLine: (line: string) => void): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
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
	return Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]).then(([, , code]) => ({ code, out }));
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
		return json(parts[3] === "start" ? service.start(key) : parts[3] === "continue" ? service.continue(key) : service.cancel(key));
	}
	return undefined;
}
