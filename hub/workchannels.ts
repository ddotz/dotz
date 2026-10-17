// Per-channel automation. The owner hands out work by Discord channel; when a channel's work needs a login kept alive
// or something watched, the orchestrator sets that up for the channel. Logins are session watches shared across
// channels on the same site and kept for as long as some channel needs them; a deleted channel drops its setup.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { now, paths } from "./config.ts";
import { addWatch, allWatches, removeWatch, setWatchChannels, type Watch } from "./watch.ts";

export type Login = { session_url: string; expect?: string; host?: string; profile?: string };
export type Monitor = { command: string; every_minutes?: number; on?: "change" | "match" | "fail"; pattern?: string };
export type Setup = { channel: string; name: string; purpose: string; standing?: string; basis?: string; logins: string[]; monitors: string[]; updated: string };

const setups: Setup[] = existsSync(paths.setups) ? JSON.parse(readFileSync(paths.setups, "utf8")) : [];
const save = () => writeFileSync(paths.setups, `${JSON.stringify(setups, null, 2)}\n`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "ch";

function release(channel: string, keep: Set<string> = new Set()): void {
	for (const w of allWatches().filter(w => w.channels?.includes(channel) && !keep.has(w.id))) {
		const left = w.channels!.filter(c => c !== channel);
		if (left.length) setWatchChannels(w.id, left);
		else removeWatch(w.id);
	}
}

function claimLogin(channel: string, l: Login, rulesText: string): Watch {
	const same = (w: Watch) => w.session?.url === l.session_url && (w.session.host ?? "") === (l.host ?? "") && (w.session.profile ?? "") === (l.profile ?? "");
	const existing = allWatches().find(same);
	if (existing) {
		setWatchChannels(existing.id, [...new Set([...(existing.channels ?? []), channel])]);
		return existing;
	}
	const where = slug([l.host, l.profile].filter(Boolean).join("-")).slice(0, 8);
	const host = new URL(l.session_url).hostname.replace(/^www\./, "");
	return addWatch({ name: `login-${slug(host)}${l.host || l.profile ? `-${where}` : ""}`, session_url: l.session_url, expect: l.expect, host: l.host, profile: l.profile, to: "orchestrator", channels: [channel] }, rulesText);
}

export function setupChannel(input: Record<string, any>, channelName: string, rulesText: string): Setup {
	const channel = String(input.channel ?? "").replace(/^ch:/, "");
	if (!channel) throw new Error("channel required (the ch:<id> from the inbox header)");
	if (!String(input.purpose ?? "").trim()) throw new Error("purpose required");
	if (input.standing && !String(input.basis ?? "").trim()) throw new Error("standing actions need basis: the owner's words that asked for them, verbatim");
	const claimed = new Set<string>();
	const logins = ((input.logins ?? []) as Login[]).map(l => {
		const w = claimLogin(channel, l, rulesText);
		claimed.add(w.id);
		return w.name;
	});
	const prefix = `ch-${slug(channelName)}`;
	const monitors = ((input.monitors ?? []) as Monitor[]).map((m, i) => {
		const w = addWatch({ ...m, name: `${prefix}-${i + 1}`, to: "orchestrator", channels: [channel] }, rulesText);
		claimed.add(w.id);
		return w.name;
	});
	release(channel, claimed);
	const s: Setup = { channel, name: channelName, purpose: String(input.purpose), ...(input.standing ? { standing: String(input.standing), basis: String(input.basis) } : {}), logins, monitors, updated: now() };
	const i = setups.findIndex(x => x.channel === channel);
	if (i >= 0) setups[i] = s;
	else setups.push(s);
	save();
	return s;
}

export function clearChannel(channel: string): boolean {
	channel = channel.replace(/^ch:/, "");
	release(channel);
	const i = setups.findIndex(s => s.channel === channel);
	if (i < 0) return false;
	setups.splice(i, 1);
	save();
	return true;
}

export const getSetup = (channel: string) => setups.find(s => s.channel === channel);

function health(s: Setup) {
	const watches = allWatches();
	return s.logins.map(n => {
		const w = watches.find(x => x.name === n);
		return { login: n, ok: w ? w.state.fails === 0 && !!w.state.lastOk : false, last_ok: w?.state.lastOk };
	});
}

export const listSetups = () => setups.map(s => ({ ...s, login_health: health(s) }));

export function channelContext(channel?: string): string {
	const s = channel && getSetup(channel);
	if (!s) return "";
	const bad = health(s).filter(h => !h.ok).map(h => h.login);
	return [
		`channel #${s.name} setup: ${s.purpose}.`,
		s.standing ? `Standing actions the owner asked for ("${s.basis}"): ${s.standing}. Do them without asking; anything more needs the owner.` : "No standing actions: monitoring only; actions follow the normal confirmation rules.",
		s.logins.length ? `Kept logins: ${s.logins.join(", ")}.` : "",
		s.monitors.length ? `Monitors: ${s.monitors.join(", ")}.` : "",
		bad.length ? `Login not healthy: ${bad.join(", ")} - do not act on a broken login; follow the relogin rule first.` : "",
	].filter(Boolean).join(" ");
}

export function setupsSummary(): string {
	return setups.length ? setups.map(s => `- #${s.name} (ch:${s.channel}): ${s.purpose}${s.standing ? ` | standing: ${s.standing}` : ""} | logins: ${s.logins.join(", ") || "none"} | monitors: ${s.monitors.length}`).join("\n") : "(none)";
}
