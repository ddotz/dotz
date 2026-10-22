// Shared contract of the "webmail without API" feature (DESIGN.md): where a site's files live, the owner's per-site config,
// and the injected context every script runs with. Pure fs; never imports hub/config.ts (that loads the gateway config at
// import time). Nothing here is site-specific: each install's own data lives under DATA_DIR/custom/webmail/<site>/.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SITE_ID, type SiteSpec } from "./spec.ts";

export const dataDir = () => process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
export const webmailDir = () => join(dataDir(), "custom", "webmail");
export const siteDir = (site: string) => join(webmailDir(), site);
export const REPO_FEATURE = join(import.meta.dir, "..");

export const paths = {
	spec: (site: string) => join(siteDir(site), "spec.json"),
	config: (site: string) => join(siteDir(site), "config.json"),
	drafts: (site: string) => join(siteDir(site), "drafts"),
	cache: (site: string) => join(siteDir(site), "cache"),
	approval: (site: string) => join(siteDir(site), "send-approved"),
};

export type SiteConfig = {
	version: 1;
	site: string;
	channel?: string; // "ch:<id>" mail work channel
	poll_minutes: number;
	refresh_hours: number; // how often a real browser tab load renews rotating cookies
	keepalive: boolean; // issue a conditional request each poll to extend the server-side session
};

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

export function defaultConfig(site: string): SiteConfig {
	return { version: 1, site, poll_minutes: 5, refresh_hours: 6, keepalive: true };
}

export function validateConfig(c: any): string | undefined {
	if (!c || typeof c !== "object") return "설정이 JSON 객체가 아니에요";
	if (c.version !== 1) return "version은 1이어야 해요";
	if (!SITE_ID.test(String(c.site ?? ""))) return "site는 [a-z0-9-] (최대 40자)여야 해요";
	if (c.channel !== undefined && !/^ch:\d+$/.test(String(c.channel))) return "channel은 ch:<숫자> 형식이어야 해요";
	if (!Number.isInteger(c.poll_minutes) || c.poll_minutes < 1 || c.poll_minutes > 1440) return "poll_minutes는 1에서 1440 사이 정수여야 해요";
	if (!Number.isInteger(c.refresh_hours) || c.refresh_hours < 1 || c.refresh_hours > 168) return "refresh_hours는 1에서 168 사이 정수여야 해요";
	if (typeof c.keepalive !== "boolean") return "keepalive는 true 또는 false여야 해요";
	return undefined;
}

function readJson<T>(file: string): T | undefined {
	if (!existsSync(file)) return undefined;
	return JSON.parse(readFileSync(file, "utf8")) as T;
}

// Atomic write (temp + rename) so a concurrent reader always sees a whole file, and 0600 for anything that may carry
// addresses or draft text.
export function writeJson(file: string, value: unknown, mode = 0o600): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
	renameSync(tmp, file);
}

export const loadSpec = (site: string): SiteSpec | undefined => readJson<SiteSpec>(paths.spec(site));
export const loadConfig = (site: string): SiteConfig | undefined => readJson<SiteConfig>(paths.config(site));

// The context a script runs with. Real scripts build it from the live browser session (lib/session.ts) and global fetch;
// tests pass a fake fetch and a canned cookie header, so no test ever touches a real browser, keychain or network.
export type Ctx = {
	fetch: typeof fetch;
	cookieHeader: (spec: SiteSpec) => Promise<string>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	log: (m: string) => void;
};

export const liveCtx = (cookieHeader: Ctx["cookieHeader"]): Ctx => ({
	fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
	cookieHeader,
	now: () => Date.now(),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	log: (m) => console.log(`${new Date().toISOString()} ${m}`),
});
