// Per-channel automation. The owner hands out work by Discord channel; when a channel's work needs a login kept alive
// or something watched, the orchestrator sets that up for the channel. Logins are session watches shared across
// channels on the same site and kept for as long as some channel needs them; a deleted channel drops its setup.
import { existsSync, readFileSync } from "node:fs";
import { now, paths, writeAtomic } from "./config.ts";
import { projectInfoContext } from "./projectinfo.ts";
import { addWatch, allWatches, relabelWatches, removeWatch, setWatchChannels, type Watch } from "./watch.ts";
import { deriveLabel, humanLabel, isKeyLabel, plainLabel } from "./watchtext.ts";

export type Login = { session_url: string; expect?: string; login_url?: string; secret?: string; host?: string; profile?: string };
export type Monitor = { command: string; every_minutes?: number; on?: "change" | "match" | "fail"; pattern?: string; label?: string };
// A standing is the owner's leave to act on a wake without asking. `scope` and `expires` bound it; a record without them was made before scopes existed
// and stays valid with no limit (shown as 기한 없음). `lapsed` marks that the owner was told it ended; `spent` keeps the last `basis` after a setup dropped the standing.
export type StandingScope = "once" | "task" | "hours";
export type Setup = { channel: string; name: string; purpose: string; standing?: string; basis?: string; scope?: StandingScope; expires?: string; lapsed?: string; spent?: string; logins: string[]; monitors: string[]; updated: string };
// The longest grant, so a large number cannot stand in for a permanent one. `once` and `task` have this day as their limit if their end never comes.
export const STANDING_HOURS_MAX = 720;
const STANDING_BOUND_HOURS = 24;

const setups: Setup[] = existsSync(paths.setups) ? JSON.parse(readFileSync(paths.setups, "utf8")) : [];
const save = () => writeAtomic(paths.setups, `${JSON.stringify(setups, null, 2)}\n`);
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
		// a later setup may name how to sign in (the login form, the dotz_auth secret) for a login already kept
		if (existing.session && (l.login_url || l.secret)) Object.assign(existing.session, { ...(l.login_url ? { login_url: l.login_url } : {}), ...(l.secret ? { secret: l.secret } : {}) });
		return existing;
	}
	const where = slug([l.host, l.profile].filter(Boolean).join("-")).slice(0, 8);
	const host = new URL(l.session_url).hostname.replace(/^www\./, "");
	return addWatch({ name: `login-${slug(host)}${l.host || l.profile ? `-${where}` : ""}`, session_url: l.session_url, expect: l.expect, login_url: l.login_url, secret: l.secret, host: l.host, profile: l.profile, to: "orchestrator", channels: [channel], project: `ch:${channel}` }, rulesText);
}

// A repeated setup (a monitor changed) names the same standing with the same words: that is the same grant, so it neither needs a scope nor renews or
// revives anything. Only new words from the owner make a new grant: old words under another standing, or after the standing was dropped, are refused.
function grantOf(input: Record<string, any>, prev?: Setup): Pick<Setup, "standing" | "basis" | "scope" | "expires" | "lapsed" | "spent"> {
	const used = prev?.basis ?? prev?.spent;
	if (!input.standing) return used ? { spent: used } : {};
	const standing = String(input.standing);
	const basis = String(input.basis);
	if (prev?.standing === standing && prev.basis === basis) return { standing, basis, ...(prev.scope ? { scope: prev.scope, expires: prev.expires } : {}), ...(prev.lapsed ? { lapsed: prev.lapsed } : {}) };
	if (basis === used) throw new Error("a new standing needs the owner's new words as basis: these words already gave one");
	const scope = input.scope as StandingScope;
	if (scope !== "once" && scope !== "task" && scope !== "hours") throw new Error('a new standing needs scope: "once", "task" or "hours" (with hours); there is no permanent grant');
	const hours = scope === "hours" ? Number(input.hours) : STANDING_BOUND_HOURS;
	if (!(hours > 0 && hours <= STANDING_HOURS_MAX)) throw new Error(`scope "hours" needs hours: more than 0, at most ${STANDING_HOURS_MAX}`);
	return { standing, basis, scope, expires: new Date(Date.now() + hours * 3_600_000).toISOString() };
}

export function setupChannel(input: Record<string, any>, channelName: string, rulesText: string): Setup {
	const channel = String(input.channel ?? "").replace(/^ch:/, "");
	if (!channel) throw new Error("channel required (the ch:<id> from the inbox header)");
	if (!String(input.purpose ?? "").trim()) throw new Error("purpose required");
	if (input.standing && !String(input.basis ?? "").trim()) throw new Error("standing actions need basis: the owner's words that asked for them, verbatim");
	const grant = grantOf(input, setups.find(x => x.channel === channel));
	const claimed = new Set<string>();
	const logins = ((input.logins ?? []) as Login[]).map(l => {
		const w = claimLogin(channel, l, rulesText);
		claimed.add(w.id);
		return w.name;
	});
	// The name is only a key ([a-z0-9-]); the channel id keeps it unique where a Korean channel name slugs to nothing.
	const monitors = ((input.monitors ?? []) as Monitor[]).map((m, i) => {
		const name = `ch-${channel}-${i + 1}`;
		const w = addWatch({ ...m, name, label: m.label?.trim() || deriveLabel({ name, project: channelName, index: i + 1 }), to: "orchestrator", channels: [channel], project: `ch:${channel}` }, rulesText);
		claimed.add(w.id);
		return w.name;
	});
	release(channel, claimed);
	const s: Setup = { channel, name: channelName, purpose: String(input.purpose), ...grant, logins, monitors, updated: now() };
	const i = setups.findIndex(x => x.channel === channel);
	if (i >= 0) setups[i] = s;
	else setups.push(s);
	save();
	return s;
}

// A deleted channel is not a deleted monitor: its watches (and kept logins) stay as standalone monitors of their own, only the link to the channel
// goes, so their reports reach the default target (hub/main.ts) and 모니터링 lists them as before.
function unlink(channel: string): void {
	for (const w of allWatches().filter(w => w.channels?.includes(channel))) setWatchChannels(w.id, w.channels!.filter(c => c !== channel));
}

export function clearChannel(channel: string): boolean {
	channel = channel.replace(/^ch:/, "");
	unlink(channel);
	const i = setups.findIndex(s => s.channel === channel);
	if (i < 0) return false;
	setups.splice(i, 1);
	save();
	return true;
}

export const getSetup = (channel: string) => setups.find(s => s.channel === channel);

export const standingLive = (s: Setup, at = Date.now()): boolean => !!s.standing && (!s.expires || at < Date.parse(s.expires));
export const standingTerm = (s: Setup, at = Date.now()): StandingScope | "none" | "lapsed" | undefined => (!s.standing ? undefined : !standingLive(s, at) ? "lapsed" : (s.scope ?? "none"));
const untilKo = (iso: string) => new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
export function standingLabelKo(s: Setup): string {
	const term = standingTerm(s);
	return term === "hours" ? `${untilKo(s.expires!)}까지` : term ? { none: "기한 없음", once: "한 번", task: "이 작업 동안", lapsed: "끝남" }[term] : "";
}

// The wake that carried a `once` standing used it; a `task` standing ends with its task. The owner hears about it from the next lapseStandings.
export function endStanding(channel: string, scope: "once" | "task", at = Date.now()): void {
	const s = getSetup(channel.replace(/^ch:/, ""));
	if (s?.scope !== scope || !standingLive(s, at)) return;
	s.expires = new Date(at).toISOString();
	save();
}

// Every minute (hub/main.ts): each standing that ended since the last look is marked and told to the owner once. Nothing here touches a monitor or a login.
export function lapseStandings(tell: (s: Setup) => void, at = Date.now()): void {
	const ended = setups.filter(s => s.standing && s.expires && !s.lapsed && !standingLive(s, at));
	if (!ended.length) return;
	for (const s of ended) s.lapsed = new Date(at).toISOString();
	save();
	ended.forEach(tell);
}
// A session's home channel id: the gateway's live channel map, else the lane's own record (bare id, or "ch:<id>" on a lane row).
export const homeChannel = (name: string, home: unknown, homes?: Record<string, string>): string | undefined => homes?.[name] ?? (typeof home === "string" && home ? home.replace(/^ch:/, "") : undefined);

// What the owner reads for a watch: its stored label (named once, see nameWatches), else "<채널 이름> 감시 <n>" for a monitor of a channel setup, else the
// words of its key. A notice can outlive its watch, so the key is still turned into words here ("ch-123-2" -> "<채널 이름> 감시 2"); a key never shows.
export function watchLabel(name: string): string {
	const own = allWatches().find(w => w.name === name)?.label;
	if (own && !isKeyLabel(own)) return plainLabel(own);
	if (!/^[a-z0-9][a-z0-9_ -]*$/.test(name)) return plainLabel(name);
	const s = setups.find(x => x.monitors.includes(name)) ?? setups.find(x => x.channel === /^ch-(\d+)-\d+$/.exec(name)?.[1]);
	if (s) return deriveLabel({ name, project: s.name, index: Number(/(\d+)$/.exec(name)?.[1]) || s.monitors.indexOf(name) + 1 });
	const words = humanLabel(deriveLabel({ name }), name);
	return words;
}

// Boot: every watch without a readable name gets one, stored (hub/watch.ts relabelWatches). Returns how many.
export const nameWatches = (): number => relabelWatches(w => setups.find(s => w.channels?.includes(s.channel))?.name);

// OmO's monitor hands an event to the agent alone and the agent tells the user: a one-shot watch for the orchestrator works the same. Its change or match
// only wakes the orchestrator, which reports in words; a failure, or no orchestrator to wake, still reaches the owner.
export const wakeOnly = (w: Watch, reason: string, orchestratorUp: boolean): boolean => orchestratorUp && w.to === "orchestrator" && !!w.once && /^(?:output changed|matched \/)/.test(reason);

// The inbox event a watch report becomes (hub/notices.ts and the web read label / to to word it).
export const watchWakeEvent = (w: Watch, reason: string, output: string, prev?: string) =>
	({ ts: now(), kind: "watch", source: `watch:${w.name}`, watch: w.name, label: watchLabel(w.name), to: w.to, channels: w.channels, reason, text: output, ...(prev ? { prev } : {}) });

// The owner edited the project's purpose on its page: the setup (and so the orchestrator prompt) follows. False without a setup.
export function setSetupPurpose(channel: string, purpose: string): boolean {
	const s = setups.find(x => x.channel === channel.replace(/^ch:/, ""));
	if (!s) return false;
	s.purpose = purpose;
	s.updated = now();
	save();
	return true;
}

function health(s: Setup) {
	const watches = allWatches();
	return s.logins.map(n => {
		const w = watches.find(x => x.name === n);
		return { login: n, ok: w ? w.state.fails === 0 && !!w.state.lastOk : false, last_ok: w?.state.lastOk };
	});
}

export const listSetups = () => setups.map(s => ({ ...s, login_health: health(s), ...(s.standing ? { standing_term: standingLabelKo(s) } : {}) }));

// What every wake reads, so a lapsed standing stops counting the moment it ends, before the minute sweep tells the owner.
function standingLine(s: Setup): string {
	if (!s.standing) return "No standing actions: monitoring only; on a wake, ask the owner before acting.";
	if (!standingLive(s)) return `The standing actions of this channel ended at ${s.expires}: monitors keep running; on a wake, ask the owner before acting.`;
	const term = s.scope === "once" ? "this one wake" : s.scope === "task" ? `this task, at most until ${s.expires}` : s.scope ? `until ${s.expires}` : "no limit set";
	return `Standing actions the owner asked for ("${s.basis}"), for ${term}: ${s.standing}. Do them without asking; anything more needs the owner. No standing covers sending mail or personal data (address, contact, id numbers): those always get the owner's confirmation.`;
}

export function channelContext(channel?: string): string {
	const s = channel && getSetup(channel);
	if (!s) return channel ? projectInfoContext(`ch:${channel}`) : "";
	const bad = health(s).filter(h => !h.ok).map(h => h.login);
	return [
		`channel #${s.name} setup: ${s.purpose}.`,
		standingLine(s),
		s.logins.length ? `Kept logins: ${s.logins.join(", ")}.` : "",
		s.monitors.length ? `Monitors: ${s.monitors.join(", ")}.` : "",
		bad.length ? `Login not healthy: ${bad.join(", ")} - do not act on a broken login; follow the relogin rule first.` : "",
		projectInfoContext(`ch:${s.channel}`),
	].filter(Boolean).join(" ");
}

export function setupsSummary(): string {
	return setups.length ? setups.map(s => `- #${s.name} (ch:${s.channel}): ${s.purpose}${s.standing ? ` | standing: ${standingLive(s) ? `${s.standing} (${s.scope ?? "no limit set"})` : "ended"}` : ""} | logins: ${s.logins.join(", ") || "none"} | monitors: ${s.monitors.length}`).join("\n") : "(none)";
}
