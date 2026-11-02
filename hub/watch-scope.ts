// Where a watch is listed (모니터링): every watch has an owner - an app (its instance key), a project, the gateway's own housekeeping, or none.
// 앱 and 프로젝트 watches show under their own section; 일반 모니터링 holds only the ones nobody owns.
// The order: the owner the watch names, the app it serves (hub/app-features.ts watchOwner: name, site, what it does), its project (a channel it
// is set up for, a project folder it works in), internal housekeeping by name, else plain. A login keeper with no app and no project stays plain.
import type { IntegrationEntry } from "./integrations.ts";
import { watchOwner } from "./app-features.ts";
import type { WatchOwner } from "./watch.ts";

export type WatchScope =
	| { scope: "app"; app: string }
	| { scope: "project"; project: string; title: string }
	| { scope: "internal" }
	| { scope: "plain" };
export type ScopeWatch = { name: string; label?: string; command?: string; script?: string; cwd?: string; channels?: string[]; owner?: WatchOwner; session?: { url: string } };
// What the scope needs from this install: the app entries, the data dir (<dir>/projects/<name>/), projects.json titles by "ch:<id>", the channel setup's name.
export type ScopeContext = { entries: readonly IntegrationEntry[]; dataDir: string; projects: Readonly<Record<string, { title?: string }>>; setupName: (channel: string) => string | undefined };

const INTERNAL = /keepalive|keep-alive|heartbeat|housekeeping|watchdog/i;
const FALLBACK_TITLE = "프로젝트";
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A project's name for the owner: ch:<id> reads projects.json's title, else the channel setup's name, else 프로젝트; a project folder is its own name. */
export function projectTitle(project: string, ctx: Pick<ScopeContext, "projects" | "setupName">): string {
	if (!project.startsWith("ch:")) return project;
	return ctx.projects[project]?.title?.trim() || ctx.setupName(project.slice(3)) || FALLBACK_TITLE;
}

// The project folder a watch works in: its cwd, script or a path in its command under <dataDir>/projects/<name>/.
function folderOf(w: ScopeWatch, dataDir: string): string | undefined {
	const re = new RegExp(`${escape(dataDir)}/projects/([^/\\s'"]+)/`);
	for (const s of [w.cwd, w.script, w.command]) {
		const hit = s ? re.exec(s.endsWith("/") ? s : `${s}/`) : null;
		if (hit) return hit[1];
	}
	return undefined;
}

export function watchScope(w: ScopeWatch, ctx: ScopeContext): WatchScope {
	const app = watchOwner(ctx.entries, w);
	if (app) return { scope: "app", app };
	const channel = w.channels?.[0], project = w.owner?.project ?? (channel ? `ch:${channel.replace(/^ch:/, "")}` : folderOf(w, ctx.dataDir));
	if (project) return { scope: "project", project, title: projectTitle(project, ctx) };
	if (w.owner?.internal || INTERNAL.test(`${w.name} ${w.label ?? ""}`)) return { scope: "internal" };
	return { scope: "plain" };
}
