// Shared contract of the KakaoTalk integration (hub/kakao/*). Off by default: nothing here runs until the owner asks for
// setup (features/kakao/feature.md ships with `enabled: false`). Every side effect goes through an injected Runner so the
// tests run with fake runners and fixture databases, never the real KakaoTalk app.
//
// Hard rules carried by every module:
// - Sending happens only by UI automation of the KakaoTalk app (kmsg, macOS Accessibility). No Kakao message API, no
//   private protocol, no HTTP to Kakao hosts.
// - KakaoTalk's database is opened read-only. Watch output carries chat ids, log ids and times only; bodies are read on demand.
// - The KakaoTalk id and password live only in the macOS Keychain; no plaintext copy is kept. They never
//   appear in argv, logs, prompts or messages.
import { join } from "node:path";

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOpts = { stdin?: string; timeoutMs?: number; env?: Record<string, string> };
// argv[0] is the program; no shell. Secrets go through `stdin`, never argv.
export type Runner = (argv: string[], opts?: RunOpts) => Promise<RunResult>;

export const defaultRunner: Runner = async (argv, opts = {}) => {
	const proc = Bun.spawn(argv, {
		stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
		stdout: "pipe",
		stderr: "pipe",
		...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
	});
	const kill = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	clearTimeout(kill);
	return { code, stdout, stderr };
};

// Where things live. `dataDir` is the dotz data folder (~/.dotz); `home` is the macOS home (KakaoTalk container, prefs).
export type KakaoPaths = {
	dataDir: string;
	home: string;
	// Per-install, non-secret settings (custom layer): db path, poll settings, excluded rooms. <dataDir>/custom/kakao/config.json
	config: string;
	// Draft store (approval flow). <dataDir>/kakao/drafts.json
	drafts: string;
	// The gateway's secret flow (POST /api/auth, site "kakao") writes {username,password} here (0600). Setup moves it into the
	// Keychain and deletes it at once, also when the Keychain refuses it. <dataDir>/secrets/kakao
	secretFile: string;
	// Onboarding progress (resumable): <dataDir>/kakao/onboard.json
	onboard: string;
	// The dotz inbox log the approval check reads (owner answers). <dataDir>/inbox.jsonl
	inbox: string;
	outbox: string;
};

export const kakaoPaths = (dataDir: string, home = process.env.HOME ?? ""): KakaoPaths => ({
	dataDir,
	home,
	config: join(dataDir, "custom", "kakao", "config.json"),
	drafts: join(dataDir, "kakao", "drafts.json"),
	secretFile: join(dataDir, "secrets", "kakao"),
	onboard: join(dataDir, "kakao", "onboard.json"),
	inbox: join(dataDir, "inbox.jsonl"),
	outbox: join(dataDir, "outbox.jsonl"),
});

// Per-install settings written by setup to the custom layer. Absent file = the integration is off.
export type KakaoConfig = {
	enabled: boolean;
	dbPath?: string; // the encrypted KakaoTalk database (derived at setup, ported from kakaocli)
	userId?: number; // the logged-in account's numeric id, used to drop the owner's own messages
	exclude_chats?: string[]; // chat ids the owner never wants drafts for
	settle_seconds?: number; // a room whose newest message is younger than this waits one more run (batching)
	max_per_run?: number; // cap on rooms reported in one watch run
};

// Keychain service name for this integration. Accounts: "id", "password", "dbkey".
export const KEYCHAIN_SERVICE = "dotz.kakao";
export const KAKAO_BUNDLE = "com.kakao.KakaoTalkMac";
export const KAKAO_APP = "/Applications/KakaoTalk.app";

// The gateway's HTTP API as seen by the CLI (127.0.0.1, x-dotz-token). Injected so tests never reach a real hub.
export type Hub = {
	post: (path: string, body: unknown) => Promise<{ status: number; json: any }>;
	get: (path: string) => Promise<{ status: number; json: any }>;
};

// Hub plus the two verbs setup and off need (watch pause / removal, closing an ask). Added by hub/kakao/hub.ts; `Hub` itself is unchanged.
export type HubFull = Hub & {
	patch: (path: string, body: unknown) => Promise<{ status: number; json: any }>;
	del: (path: string) => Promise<{ status: number; json: any }>;
};

// A room as the reader returns it. `kind` is the classification the draft filter uses.
export type Room = { chatId: string; name: string; type: number; kind: "direct" | "group" | "self" | "channel" | "open" | "other"; unread: number; lastAt: number };
export type Msg = { logId: string; chatId: string; authorId: string; sender: string; text: string; type: number; sentAt: number; fromMe: boolean };

// Result of one login attempt by UI automation. `confirm` = KakaoTalk waits for a device confirmation or a code on the phone.
export type LoginStatus = "ok" | "confirm" | "bad_credentials" | "no_credentials" | "no_accessibility" | "not_installed" | "failed";
