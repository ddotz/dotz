import { log } from "./config.ts";
import { type Adapter, adapters, type DesiredRoom } from "./messenger.ts";

// The rooms a messenger needs are not entered by hand: they mirror the web app's conversations (main chat, one per project, alert,
// worklog; hub/messenger.ts Kind), the same set Discord makes channels for. This is the one place that derives that set; each adapter
// creates or maps it in its own config (Adapter.syncRooms) when it is switched on, on gateway start and when a project is added or removed.

export type ProjectRef = { target: string; name: string };

const FIXED: DesiredRoom[] = [
	{ kind: "main", name: "메인 대화" },
	{ kind: "alert", name: "알림" },
	{ kind: "worklog", name: "작업내역" },
];

/** main, alert, worklog and one room per project (target `ch:<id>`), in that order. */
export function desiredRooms(projects: ProjectRef[]): DesiredRoom[] {
	return [...FIXED, ...projects.map(p => ({ kind: "project" as const, name: p.name, project: p.target }))];
}

/** The same room as a chat-service channel name the owner can read (no code names): "dotz", "dotz-알림", "dotz-작업내역", "dotz-<project>" (lowercase, no spaces). */
export function channelName(d: DesiredRoom): string {
	if (d.kind === "main") return "dotz";
	if (d.kind !== "project") return `dotz-${d.name}`;
	const slug = d.name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_-]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return `dotz-${slug || d.project?.replace(/^ch:/, "") || "project"}`;
}

/** Does `room` (kind + project of an existing room) already stand for `d`? */
export const sameRoom = (room: { kind: string; project?: string }, d: DesiredRoom): boolean => room.kind === d.kind && (d.kind !== "project" || room.project === d.project);

let source: () => ProjectRef[] = () => [];
/** Where the project list comes from (hub/main.ts wires the Discord work channels). */
export const setProjectSource = (fn: () => ProjectRef[]): void => {
	source = fn;
};

// One sync at a time per messenger: two projects added together must not both read the config before either wrote it.
const queue = new Map<string, Promise<void>>();

/** Syncs one adapter's rooms with the web structure; a no-op unless it can and is switched on. A failure is logged, never thrown. */
export function syncAdapter(a: Adapter, projects: ProjectRef[] = source()): Promise<void> {
	const run = async () => {
		if (!a.syncRooms || !a.settings?.().enabled) return;
		try {
			await a.syncRooms(desiredRooms(projects));
		} catch (e) {
			log(`messenger ${a.id} room sync failed: ${e}`);
		}
	};
	const next = (queue.get(a.id) ?? Promise.resolve()).then(run);
	queue.set(a.id, next);
	return next;
}

/** Every messenger, after a project was added or removed and on gateway start. */
export async function syncAllRooms(): Promise<void> {
	const projects = source();
	await Promise.all(adapters().map(a => syncAdapter(a, projects)));
}
