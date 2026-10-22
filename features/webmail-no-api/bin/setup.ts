// Setup pieces for one webmail site, used by onboard.ts (and runnable alone): the per-install config, a home card, a sidebar
// project, this install's switch that turns the shipped feature on, and the two watch specs (new mail; session keeping).
// Everything is written under the data dir's custom layer and features dir, never into the repo.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, defaultConfig, loadSpec, paths, REPO_FEATURE, siteDir, validateConfig, writeJson, type SiteConfig } from "../lib/config.ts";
import { endpointUrl, type SiteSpec } from "../lib/spec.ts";

export type ApplyOpts = { site: string; channel?: string; poll_minutes?: number; refresh_hours?: number; keepalive?: boolean };

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const cardFile = (site: string) => join(dataDir(), "custom", "cards", `webmail-${site}.json`);
const pinsFile = () => join(dataDir(), "custom", "pins.json");
const FEATURE_ID = "webmail-no-api";
export const personalFeatureFile = () => join(dataDir(), "features", FEATURE_ID, "feature.md");

export function buildConfig(opts: ApplyOpts): SiteConfig {
	const c = defaultConfig(opts.site);
	if (opts.channel) c.channel = opts.channel;
	if (opts.poll_minutes) c.poll_minutes = opts.poll_minutes;
	if (opts.refresh_hours) c.refresh_hours = opts.refresh_hours;
	if (opts.keepalive !== undefined) c.keepalive = opts.keepalive;
	return c;
}

// New mail must wake the orchestrator (to "orchestrator", delivered in the mail channel) so it can open one thread per mail;
// a channel `to` would only paste the raw lines there.
export function watchSpec(site: string, config: SiteConfig): Record<string, unknown> {
	return {
		name: `webmail-${site}`,
		command: `WEBMAIL_SITE=${shq(site)} bun ${shq(join(REPO_FEATURE, "bin", "watch.ts"))}`,
		every_minutes: config.poll_minutes,
		on: "match",
		pattern: ".",
		timeout_seconds: 90,
		to: "orchestrator",
		...(config.channel ? { channels: [config.channel.replace(/^ch:/, "")] } : {}),
	};
}

// Session keeping by the gateway with no model calls: a cookie-bearing check every 30 min and a real background tab load
// every refresh_hours to renew rotating cookies. `expect` is the list JSON key, which only a logged-in answer contains. The
// gateway accepts https only, so a non-https site (a local test server) gets no session watch.
export function sessionWatchSpec(spec: SiteSpec, config: SiteConfig): Record<string, unknown> | undefined {
	const url = endpointUrl(spec.origin, spec.list, { mailbox: spec.list.mailbox });
	if (!url.startsWith("https://")) return undefined;
	const key = spec.list.listPath.split(".").pop()!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return { name: `webmail-${spec.site}-login`.slice(0, 40), session_url: url, expect: `"${key}"\\s*:`, refresh_hours: config.refresh_hours, every_minutes: 30 };
}

function mergePins(site: string, channel?: string): void {
	const pins = existsSync(pinsFile()) ? JSON.parse(readFileSync(pinsFile(), "utf8")) : {};
	const projects: any[] = Array.isArray(pins.projects) ? pins.projects : [];
	const path = siteDir(site);
	const project = { name: `${site} 메일`, path, ...(channel ? { channel } : {}), note: "zele로 안 되는 메일을 읽고, 새 메일을 알리고, 초안을 써요" };
	const at = projects.findIndex((p) => p?.path === path);
	if (at >= 0) projects[at] = project;
	else projects.push(project);
	writeJson(pinsFile(), { ...pins, projects }, 0o644);
}

// This install's switch: a personal copy of the shipped feature.md with enabled: true (a personal folder with the same id
// replaces the shipped one). Rewritten from the shipped file on every onboarding run so repo updates reach it.
export function enableFeature(): string {
	const shipped = readFileSync(join(REPO_FEATURE, "feature.md"), "utf8");
	const on = shipped.replace(/^enabled:\s*false\s*$/m, "enabled: true");
	const file = personalFeatureFile();
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, on);
	return file;
}

export function apply(opts: ApplyOpts): { config: SiteConfig; watch: Record<string, unknown>; session?: Record<string, unknown> } {
	const spec = loadSpec(opts.site);
	if (!spec) throw new Error(`"${opts.site}" 설정(spec.json)이 아직 없어요. 온보딩의 호출 기록 단계부터 해 주세요`);
	const config = buildConfig(opts);
	const problem = validateConfig(config);
	if (problem) throw new Error(problem);
	mkdirSync(siteDir(opts.site), { recursive: true });
	writeJson(paths.config(opts.site), config);
	writeJson(cardFile(opts.site), {
		title: `${opts.site} 메일`,
		note: "zele로 안 되는 메일",
		view: "kv",
		command: `WEBMAIL_SITE=${shq(opts.site)} bun ${shq(join(REPO_FEATURE, "bin", "card.ts"))}`,
		every_minutes: 10,
		timeout_seconds: 15,
		actions: [{ label: "새 메일 확인", prompt: `${opts.site} 메일 새로 온 거 확인해 줘` }],
	}, 0o644);
	mergePins(opts.site, opts.channel);
	enableFeature();
	return { config, watch: watchSpec(opts.site, config), session: sessionWatchSpec(spec, config) };
}

async function main(argv: string[]): Promise<number> {
	const site = argv[0] ?? "";
	const get = (flag: string) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined);
	try {
		const { watch, session } = apply({
			site,
			channel: get("--channel"),
			poll_minutes: get("--poll") ? Number(get("--poll")) : undefined,
			refresh_hours: get("--refresh") ? Number(get("--refresh")) : undefined,
			keepalive: argv.includes("--no-keepalive") ? false : undefined,
		});
		console.log(`설정 완료: ${site}`);
		console.log(`새 메일 감시: ${JSON.stringify(watch)}`);
		if (session) console.log(`로그인 유지 감시: ${JSON.stringify(session)}`);
		return 0;
	} catch (e) {
		console.log(String(e instanceof Error ? e.message : e));
		return 1;
	}
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code));
