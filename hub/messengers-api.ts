// HTTP routes of the messenger settings (설정 → 메신저): GET /api/messengers, GET|PUT /api/messengers/<id>, POST /api/messengers/<id>/test.
// Mounted in routes-settings.ts, behind the same owner check as every other /api route. The adapters describe themselves (hub/messenger.ts Settings).
import { channels } from "./discord.ts";
import { type Adapter, adapters, get, restart, type Settings, SettingsError } from "./messenger.ts";
import { syncAdapter } from "./messenger-rooms.ts";
import { messengerClasses, saveMessengerClasses } from "./notify-route.ts";
import { body, json } from "./routes-util.ts";

const projects = (): { target: string; name: string }[] => Object.entries(channels.work).map(([id, name]) => ({ target: `ch:${id}`, name }));

/** The adapter's settings with the project list and each room's project name filled in. */
function view(a: Adapter): Settings {
	const s = a.settings!();
	const list = projects();
	const nameOf = (target: string) => list.find(p => p.target === target)?.name ?? target;
	return {
		...s,
		projects: list,
		...(a.native ? {} : { notify: messengerClasses(a.id) }),
		...(s.rooms ? { rooms: { ...s.rooms, items: s.rooms.items.map(r => (r.project ? { ...r, project: { target: r.project.target, name: nameOf(r.project.target) } } : r)) } } : {}),
	};
}

// What a change of these needs a restart for: enabled and every plain (non-secret, non-readonly) top-level value, e.g. the listen address.
const restartKey = (s: Settings): string => JSON.stringify([s.enabled, s.fields.filter(f => f.type === "text" || f.type === "number").map(f => [f.key, f.value])]);

export async function messengersRoute(req: Request, url: URL, parts: string[]): Promise<Response | undefined> {
	if (parts[0] !== "api" || parts[1] !== "messengers") return undefined;
	if (parts.length === 2) {
		if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
		return json({ items: adapters().filter(a => !a.hidden?.()).map(a => ({ id: a.id, label: a.label, enabled: a.enabled(), state: a.status.state, configured: a.configured ? a.configured() : a.enabled(), ...(a.status.error ? { error: a.status.error } : {}) })) });
	}
	const a = get(decodeURIComponent(parts[2]!));
	if (!a || a.hidden?.()) return json({ error: `unknown messenger ${parts[2]}` }, 404);
	if (parts.length === 3) {
		if (req.method === "GET") return a.settings ? json(view(a)) : json({ error: "no settings" }, 400);
		if (req.method !== "PUT") return json({ error: "method not allowed" }, 405);
		if (!a.settings || !a.saveSettings) return json({ error: `${a.label} settings are read-only here` }, 400);
		const { notify, ...b } = (await body(req)) as Record<string, unknown>;
		const before = restartKey(a.settings());
		// The 알림 switches are the router's, not the adapter's: they need no restart and no room sync.
		if (notify !== undefined) {
			if (a.native) return json({ error: `${a.label} notifications are set in its own screen` }, 400);
			try {
				saveMessengerClasses(a.id, notify);
			} catch (e) {
				return json({ error: (e as Error).message }, 400);
			}
			if (!Object.keys(b).length) return json(view(a));
		}
		try {
			a.saveSettings(b);
		} catch (e) {
			if (e instanceof SettingsError) return json({ error: e.message }, 400);
			throw e;
		}
		await syncAdapter(a, projects());
		if (restartKey(a.settings()) !== before) await restart(a);
		return json(view(a));
	}
	if (parts.length === 4 && parts[3] === "test") {
		if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
		if (!a.test) return json({ error: `${a.label} has no connection test` }, 400);
		return json(await a.test());
	}
	return undefined;
}
