// Who may change a model. A request that carries the hub token is an agent process, not the owner: it may change a model or thinking level (or ask for
// an expensive-model grant) only on the strength of an owner message it names (`owner_message`), which this module finds in the inbox and checks.
// The web picker (no token), a peer, /model typed in a chat and the limit fallback stay owner paths. The gateway also keeps two small state files:
// model-picks.json (who set each target's model) and expensive-grants.json (conversations the owner allowed an expensive model in).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadGuardConfig } from "./lanegates.ts";
import { DATA_DIR, log, parseSelector, paths, splitThinking, writeAtomic } from "./config.ts";
import { AGENT_AUTHOR, tokenOk } from "./entry-check.ts";
import { eventTarget, isPeerMessage, tailEvents } from "./events.ts";
import { PEER_HEADER } from "./peer-auth.ts";

const DAY_MS = 24 * 3_600_000;
const STATE_DIR = join(DATA_DIR, "state");
const PICKS_FILE = join(STATE_DIR, "model-picks.json");
const GRANTS_FILE = join(STATE_DIR, "expensive-grants.json");

export type Pick = { model: string; thinking: string; by: string; at: string; evidence?: string };
export type Grant = { until: string; by: string; evidence?: string };
export type Ask = { conv?: string; model?: string; thinking?: string; expensive?: boolean };
export type Gate = { by: string } | { denied: string };

export const isAgentRequest = (req: Request): boolean => tokenOk(req) && !req.headers.has(PEER_HEADER);

// The conversation a change is confined to: a project or a session names its own, any other target (main, lanes, workers) has none.
export function convOfTarget(target: string | undefined): string | undefined {
	if (!target) return undefined;
	if (/^(?:ch:\d+|lane:.+)$/.test(target)) return target;
	return ["main", "orchestrator", "lanes", "workers"].includes(target) ? undefined : `lane:${target}`;
}

// Family of a model id or the owner's short name for it: "anthropic/claude-opus-5-5:high" and "opus" are both "opus".
const familyOf = (input: string): string | undefined => {
	const id = splitThinking(input.trim().toLowerCase()).model.split("/").pop() ?? "";
	return id.split(/[^a-z]+/).find(w => w.length > 1 && w !== "claude");
};
const ALIASES: Record<string, string[]> = {
	opus: ["오퍼스", "오푸스"],
	sonnet: ["소넷", "소네트"],
	haiku: ["하이쿠"],
	fable: ["페이블"],
	mythos: ["미토스"],
	gpt: ["지피티"],
	gemini: ["제미나이", "제미니"],
};
const namesFamily = (text: string, family: string): boolean => text.includes(family) || (ALIASES[family] ?? []).some(a => text.includes(a));
const namesLevel = (text: string, level: string): boolean => new RegExp(`(?:^|[^a-z])${level}(?:[^a-z]|$)`).test(text);

function expensiveFamilies(): string[] {
	const listed = loadGuardConfig(DATA_DIR).expensive_models.filter(e => !e.startsWith(":")).flatMap(e => familyOf(e) ?? []);
	return [...new Set(["fable", ...listed])];
}
const expensiveLevels = (): string[] => loadGuardConfig(DATA_DIR).expensive_models.filter(e => e.startsWith(":")).map(e => e.slice(1).toLowerCase());

// What the message must say for this ask, as the reasons it fails to.
function missing(text: string, ask: Ask): string[] {
	const t = text.toLowerCase(), out: string[] = [];
	if (ask.model) {
		const family = familyOf(ask.model);
		if (!family) out.push(`cannot tell which model "${ask.model}" is, so no message can name it`);
		else if (!namesFamily(t, family)) out.push(`the message does not name the model (${family})`);
	}
	if (ask.thinking && !namesLevel(t, ask.thinking.toLowerCase())) out.push(`the message does not name the thinking level (${ask.thinking})`);
	if (ask.expensive && !expensiveFamilies().some(f => namesFamily(t, f)) && !expensiveLevels().some(l => namesLevel(t, l))) out.push("the message does not name an expensive model");
	return out;
}

// Owner requests pass. An agent request passes only with `owner_message`: the id (mid or message_id) of a message of the owner in the inbox that is
// fresh, in the right conversation and names what is asked for.
export function ownerGate(req: Request, ask: Ask, ownerMessage: unknown, now = Date.now()): Gate {
	if (!isAgentRequest(req)) return { by: "owner" };
	const id = typeof ownerMessage === "string" ? ownerMessage.trim() : "";
	const denied = (why: string): Gate => ({ denied: `an agent changes models only for what the owner just said: ${why}` });
	if (!id) return denied("send owner_message with the mid or message_id of the owner's message in the inbox");
	const e = tailEvents(paths.inbox).findLast(x => (x.kind === "message" || x.kind === "lane_message") && (x.mid === id || x.message_id === id));
	if (!e) return denied(`no owner message ${id} in the inbox`);
	if (e.source === "gateway" || e.author === AGENT_AUTHOR || isPeerMessage(e)) return denied(`${id} is not a message the owner wrote`);
	const age = now - Date.parse(e.ts);
	if (Number.isNaN(age) || age > DAY_MS) return denied(`${id} is older than 24 hours`);
	if (ask.conv && eventTarget(e) !== ask.conv) return denied(`${id} was written in another conversation than ${ask.conv}`);
	const why = missing(String(e.text ?? ""), ask);
	return why.length ? denied(`${id}: ${why.join("; ")}`) : { by: `owner-message:${id}` };
}

const readState = (file: string): Record<string, any> => {
	try {
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	} catch {
		return {};
	}
};
const writeJson = (file: string, value: unknown): void => {
	mkdirSync(dirname(file), { recursive: true });
	writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
};

export const readModelPicks = (): Record<string, Pick> => readState(PICKS_FILE);

// One hub.log line and one model-picks.json entry for every model or thinking change: `from` and `to` are "<model>:<thinking>" selectors,
// `by` is owner | owner-message:<mid> | fallback. Returns `to`.
export function noteModelChange(target: string, from: string, to: string, by: string): string {
	log(`model change: ${target} ${from} -> ${to} by ${by}`);
	const mid = by.startsWith("owner-message:") ? by.slice("owner-message:".length) : undefined;
	const said = mid ? tailEvents(paths.inbox).findLast(e => e.mid === mid || e.message_id === mid)?.text : undefined;
	const { model, thinking } = parseSelector(to);
	writeJson(PICKS_FILE, { ...readModelPicks(), [target]: { model, thinking, by, at: new Date(Date.now()).toISOString(), ...(typeof said === "string" ? { evidence: said.slice(0, 200) } : {}) } });
	return to;
}

export const isGrantKey = (conv: string): boolean => conv === "main" || /^(?:ch:\d+|lane:.+)$/.test(conv);

const liveGrants = (now: number): Record<string, Grant> => Object.fromEntries(Object.entries(readState(GRANTS_FILE)).filter(([, g]) => Date.parse(String(g?.until)) > now));

// The expensive-model grant of a conversation (main | ch:<id> | lane:<name>), unless it ran out.
export const activeGrant = (conv: string, now = Date.now()): Grant | undefined => liveGrants(now)[conv];

// Grants a conversation for guard.override_minutes; runs-out entries of other conversations are dropped in the same write.
export function grantExpensive(conv: string, by: string, now = Date.now()): Grant {
	const mid = by.startsWith("owner-message:") ? by.slice("owner-message:".length) : undefined;
	const said = mid ? tailEvents(paths.inbox).findLast(e => e.mid === mid || e.message_id === mid)?.text : undefined;
	const grant: Grant = { until: new Date(now + loadGuardConfig(DATA_DIR).override_minutes * 60_000).toISOString(), by, ...(typeof said === "string" ? { evidence: said.slice(0, 200) } : {}) };
	writeJson(GRANTS_FILE, { ...liveGrants(now), [conv]: grant });
	log(`expensive grant: ${conv} until ${grant.until} by ${by}`);
	return grant;
}
