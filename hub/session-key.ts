// Which agent session answers a conversation (config `conversations.sessions`, hub/convsessions.ts). Pure: the registry passes
// the flag, the enabled kinds and the thread-to-mail lookup. Everything that is not a conversation of its own is `main`, the
// session that also takes every prompt the gateway starts itself (schedules, watches, mail wakes, lane reports).
export const CONV_KINDS = ["mail", "ch", "th", "settings", "alert", "worklog"] as const;
export type ConvKind = (typeof CONV_KINDS)[number];
export type KeyRules = { on: boolean; kinds?: readonly string[]; mailOf?: (thread: string) => string | undefined; quick?: boolean };

export const MAIN = "main";
/** The quick chat's session key (config `conversations.quick_chat`, off by default, so it is no CONV_KINDS entry). */
export const QUICK = "quick";

function keyOf(target: string, mailOf?: (thread: string) => string | undefined): { kind: ConvKind; key: string } | undefined {
	if (target === "web:alert" || target === "alert") return { kind: "alert", key: "alert" };
	if (target === "web:worklog" || target === "worklog") return { kind: "worklog", key: "worklog" };
	const i = target.indexOf(":");
	if (i < 1 || i === target.length - 1) return undefined;
	const kind = target.slice(0, i);
	const id = target.slice(i + 1);
	if (kind === "mail") return { kind: "mail", key: target };
	if (kind === "th") {
		// A mail's Discord thread and its web conversation are one conversation (hub/runstate.ts mailConversation).
		const mail = mailOf?.(id);
		return mail ? { kind: "mail", key: `mail:${mail}` } : { kind: "th", key: target };
	}
	if (kind === "ch" || kind === "settings") return { kind, key: target };
	return undefined;
}

/** The session key of `target`: `main`, or the conversation's own key when the feature is on and its kind is enabled. */
export function sessionKeyOf(target: string | undefined, rules: KeyRules): string {
	if (!rules.on || !target) return MAIN;
	if (target === "web:quick" || target === QUICK) return rules.quick ? QUICK : MAIN;
	const k = keyOf(target, rules.mailOf);
	if (!k) return MAIN;
	return (rules.kinds ?? CONV_KINDS).includes(k.kind) ? k.key : MAIN;
}

export const safeDir = (key: string): string => key.replace(/[^a-z0-9._-]/gi, "_");

/** The target a session's answers and history belong to (the web conversation of that key). */
export function primaryTarget(key: string): string {
	if (key === MAIN) return "web";
	if (key === "alert") return "web:alert";
	if (key === "worklog") return "web:worklog";
	if (key === QUICK) return "web:quick";
	return key;
}

const CONV_TARGET = /^(?:(?:ch|th|mail|settings):\S+|web:alert|web:worklog)$/;

/**
 * The conversation a schedule or watch belongs to: the conversation target given as `conv` (or `project`), else the primary target of
 * the session that created it. Made in main, or by a session key that is no conversation, it belongs to none (main runs it, as before).
 * A given target of an unknown kind is an error.
 */
export function convTargetOf(input: { conv?: unknown; project?: unknown; session?: unknown }): string | undefined {
	for (const [name, v] of [["conv", input.conv], ["project", input.project]] as const) {
		if (v === undefined || v === null || v === "") continue;
		if (typeof v !== "string" || !CONV_TARGET.test(v)) throw new Error(`${name} must be a conversation target (ch:<id>, th:<id>, mail:<key> or settings:<key>)`);
		return v;
	}
	if (typeof input.session !== "string" || input.session === MAIN) return undefined;
	const target = primaryTarget(input.session);
	return CONV_TARGET.test(target) ? target : undefined;
}
