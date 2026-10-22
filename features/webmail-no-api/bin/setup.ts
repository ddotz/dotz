// First-run setup for one webmail site: write the per-install config, a home card and a sidebar project into the custom
// layer (hot-reloaded, no restart), and print the watch spec for the orchestrator to register. The site spec itself is
// produced by capture.ts; this only wires the pieces once the spec exists. All data stays under the custom layer.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, loadSpec, paths, dataDir, siteDir, validateConfig, writeJson, REPO_FEATURE, type SiteConfig } from "../lib/config.ts";

export type ApplyOpts = { site: string; channel?: string; poll_minutes?: number; refresh_hours?: number; keepalive?: boolean };

const cardId = (site: string) => `webmail-${site}`;
const cardFile = (site: string) => join(dataDir(), "custom", "cards", `${cardId(site)}.json`);
const pinsFile = () => join(dataDir(), "custom", "pins.json");

export function buildConfig(opts: ApplyOpts): SiteConfig {
	const c = defaultConfig(opts.site);
	if (opts.channel) c.channel = opts.channel;
	if (opts.poll_minutes) c.poll_minutes = opts.poll_minutes;
	if (opts.refresh_hours) c.refresh_hours = opts.refresh_hours;
	if (opts.keepalive !== undefined) c.keepalive = opts.keepalive;
	return c;
}

export function watchSpec(site: string, config: SiteConfig): Record<string, unknown> {
	return {
		name: `webmail-${site}`,
		command: `WEBMAIL_SITE=${site} bun ${join(REPO_FEATURE, "bin", "watch.ts")}`,
		every_minutes: config.poll_minutes,
		on: "match",
		pattern: ".",
		timeout_seconds: 90,
		to: config.channel ? config.channel : "orchestrator",
		...(config.channel ? { channels: [config.channel.replace(/^ch:/, "")] } : {}),
	};
}

function mergePins(site: string, channel?: string): void {
	const pins = existsSync(pinsFile()) ? JSON.parse(readFileSync(pinsFile(), "utf8")) : {};
	const projects: any[] = Array.isArray(pins.projects) ? pins.projects : [];
	const path = siteDir(site);
	const existing = projects.findIndex((p) => p?.path === path);
	const project = { name: `${site} 메일`, path, ...(channel ? { channel } : {}), note: "API 없는 회사 메일을 읽고, 새 메일을 알리고, 초안을 써요" };
	if (existing >= 0) projects[existing] = project;
	else projects.push(project);
	writeJson(pinsFile(), { ...pins, projects }, 0o644);
}

export function apply(opts: ApplyOpts): { config: SiteConfig; watch: Record<string, unknown> } {
	const spec = loadSpec(opts.site);
	if (!spec) throw new Error(`먼저 capture.ts로 "${opts.site}" 스펙을 만들어야 해요`);
	const config = buildConfig(opts);
	const problem = validateConfig(config);
	if (problem) throw new Error(problem);
	mkdirSync(siteDir(opts.site), { recursive: true });
	writeJson(paths.config(opts.site), config);
	writeJson(cardFile(opts.site), {
		title: `${opts.site} 메일`,
		note: "API 없는 회사 메일",
		view: "kv",
		command: `WEBMAIL_SITE=${opts.site} bun ${join(REPO_FEATURE, "bin", "card.ts")}`,
		every_minutes: 10,
		timeout_seconds: 15,
	}, 0o644);
	mergePins(opts.site, opts.channel);
	return { config, watch: watchSpec(opts.site, config) };
}

async function main(argv: string[]): Promise<number> {
	const site = argv[0] ?? "";
	const get = (flag: string) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined);
	try {
		const { watch } = apply({
			site,
			channel: get("--channel"),
			poll_minutes: get("--poll") ? Number(get("--poll")) : undefined,
			refresh_hours: get("--refresh") ? Number(get("--refresh")) : undefined,
			keepalive: argv.includes("--no-keepalive") ? false : undefined,
		});
		console.log(`설정 완료: ${site}`);
		console.log(`감시 등록 스펙(dotz_watch add로 등록): ${JSON.stringify(watch)}`);
		return 0;
	} catch (e) {
		console.log(String(e instanceof Error ? e.message : e));
		return 1;
	}
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code));
