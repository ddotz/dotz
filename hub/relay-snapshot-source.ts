import { cfg } from "./config.ts";
import { ownProjects } from "./custom.ts";
import * as discord from "./discord.ts";
import { machineHost } from "./hostname.ts";
import { lanes, laneSummary } from "./lanes.ts";
import { withHomes } from "./laneviews.ts";
import { resolveName } from "./machine-name.ts";
import { listMonitors } from "./monitors.ts";
import { listNotices } from "./notices.ts";
import { orch } from "./orchestrator.ts";
import type { Snapshot } from "./relay-snapshot.ts";
import { buildSnapshot } from "./relay-snapshot-send.ts";
import { readTodo } from "./todo.ts";

// What the running gateway posts about itself when its JANDI status sharing is on (hub/relay-snapshot-send.ts): its own projects (as a peer reads them),
// its sessions with their last report, its monitors, the open to-dos of the main session and the live ones, and its last five notices. Loaded by
// hub/messenger-jandi.ts only when a snapshot is due, so the adapter does not import the gateway's state.
export function currentSnapshot(now: number): Snapshot {
	const sessions = laneSummary().map(s => ({ ...s, lastReportAt: lanes.get(String(s.name))?.lastReportAt }));
	const files = [orch.sessionFile, ...sessions.filter(s => s.live).map(s => s.sessionFile as string | undefined)];
	const open = files.flatMap(f => readTodo(f).phases.flatMap(p => p.tasks)).filter(t => t.status === "pending" || t.status === "in_progress");
	const projects = ownProjects({ lanes: () => withHomes(laneSummary(), discord.channels), channels: () => discord.channels, machine: () => resolveName(cfg.web?.machine_name, machineHost()) }).projects;
	return buildSnapshot({ projects, sessions, monitors: listMonitors(), todos: { open: open.length, items: open.slice(0, 5).map(t => t.content) }, notices: listNotices(5).items }, now);
}
