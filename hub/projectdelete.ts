// Deleting a project (owner 2026-10-23): one path for the web, a peer's /api/peer/act and the orchestrator's dotz_channel delete.
// A project is a work channel; it goes with its setup (standing), its notices, its record and the Discord channel. Its monitors and kept logins are
// not part of it: they stay as standalone monitors (hub/workchannels.ts clearChannel only drops their link to the channel).
// The conversation log stays as a small archive file under the data dir unless the caller asks for none.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as discord from "./discord.ts";
import { DATA_DIR, now, writeAtomic } from "./config.ts";
import { historyEvents } from "./events.ts";
import { lanes, laneLive } from "./lanestate.ts";
import { countChannelNotices, dropChannelNotices } from "./notices.ts";
import { loadProjects, removeProject } from "./projects.ts";
import { allWatches } from "./watch.ts";
import { clearChannel, getSetup, watchLabel } from "./workchannels.ts";

export class ProjectDeleteError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

export type DeleteDeps = {
	work: () => Record<string, string>;
	// ids and names of the channels that are not projects (chat, worklog, alert, dm, brief)
	builtin: () => Record<string, string>;
	// names of the live sessions working in the channel
	running: (id: string) => string[];
	removeChannel: (id: string) => Promise<void>;
};

export const defaultDeps: DeleteDeps = {
	work: () => discord.channels.work,
	builtin: () => {
		const c = discord.channels;
		return Object.fromEntries(([["chat", c.chat], ["worklog", c.worklog], ["alert", c.alert], ["dm", c.dm], ["brief", c.brief]] as const).filter(([, id]) => id).map(([name, id]) => [id!, name]));
	},
	running: id => [...lanes.values()].filter(l => laneLive(l) && (discord.channels.homes[l.name] ?? l.home) === id).map(l => l.name),
	removeChannel: discord.deleteWorkChannel,
};

const BUILTIN_NAMES = ["chat", "worklog", "alert", "dm", "brief"];

export type DeletePlan = {
	key: string;
	channel: string;
	name: string;
	monitors: string[];
	logins: { name: string; shared: boolean }[];
	standing?: string;
	notices: number;
	messages: number;
	running: string[];
	archive: string;
};

// Resolves `ch:<id>` (or the bare id) to a deletable work channel, or throws why not.
function target(key: string, deps: DeleteDeps): { id: string; name: string } {
	const raw = key.trim();
	const id = raw.replace(/^ch:/, "");
	const builtin = deps.builtin();
	if (BUILTIN_NAMES.includes(raw) || builtin[id]) throw new ProjectDeleteError(409, `${BUILTIN_NAMES.includes(raw) ? raw : builtin[id]}는 기본 채널이라 지울 수 없어요`);
	const name = deps.work()[id];
	if (!/^\d+$/.test(id) || !name) throw new ProjectDeleteError(raw.startsWith("dir:") ? 409 : 404, raw.startsWith("dir:") ? "작업 채널이 없는 프로젝트는 지울 수 없어요" : `프로젝트 ${raw}를 찾지 못했어요`);
	return { id, name };
}

const archivePath = (id: string, name: string) => join(DATA_DIR, "archive", "projects", `${name.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 40) || "project"}-${id}.jsonl`);

export function planDelete(key: string, deps: DeleteDeps = defaultDeps): DeletePlan {
	const { id, name } = target(key, deps);
	const setup = getSetup(id);
	const watches = allWatches();
	const logins = (setup?.logins ?? []).map(n => ({ name: n, shared: (watches.find(w => w.name === n)?.channels ?? []).some(c => c !== id) }));
	const monitors = watches.filter(w => w.channels?.includes(id) && !(setup?.logins ?? []).includes(w.name)).map(w => watchLabel(w.name));
	return {
		key: `ch:${id}`, channel: `ch:${id}`, name, monitors, logins,
		...(setup?.standing ? { standing: setup.standing } : {}),
		notices: countChannelNotices(`ch:${id}`),
		messages: historyEvents(`ch:${id}`, 100_000).length,
		running: deps.running(id),
		archive: archivePath(id, name),
	};
}

export type DeleteResult = { ok: true; channel: string; name: string; removed: { notices: number }; kept: { monitors: number; logins: number }; archive: string | null; discord: { ok: boolean; error?: string } };

// Refuses a built-in channel and a channel with a running session (naming it); then removes everything. A Discord failure does not stop it:
// the project is gone here, and the result says the channel is still there.
export async function deleteProject(key: string, opts: { archive?: boolean } = {}, deps: DeleteDeps = defaultDeps): Promise<DeleteResult> {
	const plan = planDelete(key, deps);
	if (plan.running.length) throw new ProjectDeleteError(409, `실행 중인 세션이 있어서 지울 수 없어요: ${plan.running.join(", ")}. 먼저 세션을 끝내 주세요`);
	const id = plan.channel.slice(3);
	let archive: string | null = null;
	if (opts.archive !== false) {
		const events = historyEvents(plan.channel, 100_000);
		mkdirSync(join(DATA_DIR, "archive", "projects"), { recursive: true });
		writeAtomic(plan.archive, [{ archived: now(), project: { channel: plan.channel, name: plan.name, setup: getSetup(id) ?? null, record: loadProjects()[plan.channel] ?? null } }, ...events].map(e => JSON.stringify(e)).join("\n") + "\n");
		archive = plan.archive;
	}
	clearChannel(id);
	const notices = dropChannelNotices(plan.channel);
	removeProject(plan.channel);
	let result: DeleteResult["discord"] = { ok: true };
	await deps.removeChannel(id).catch(e => {
		result = { ok: false, error: (e as Error).message };
	});
	return { ok: true, channel: plan.channel, name: plan.name, removed: { notices }, kept: { monitors: plan.monitors.length, logins: plan.logins.length }, archive, discord: result };
}
