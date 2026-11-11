import { msg } from "./i18n.ts";
import type { OnboardFlowContext, OnboardOwnerStep } from "./onboarding.ts";

// Shared browser login capture for the messenger connect flows: a background Aside tab per key reads one value from the page
// (a function the flow supplies as source text). The value goes to the gateway through a one-shot localhost inbox (hub/aside.ts
// oneShotInbox), never through stdout, argv, repl code, logs or the view.

export const LOGIN_RECHECK_MS = 5_000;
export const LOGIN_GIVE_UP_MS = 10 * 60_000;

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ");
// A tab the owner already closed makes closeTab fail: said in the repl output, which is only read for its RESULT line.
const CLOSE = "const dzClose = async tab => { try { await closeTab(tab); } catch (e) { console.log('closeTab failed: ' + String((e && e.message) || e).slice(0, 80)); } };";

/** The repl code that posts `body` (a JS expression) to the one-shot inbox. The repl has no AbortSignal, so the time limit is a race. */
export const inboxPost = (inbox: string, body: string): string =>
	`await Promise.race([fetch(${JSON.stringify(inbox)}, { method: 'POST', body: JSON.stringify(${body}) }), new Promise((_, no) => setTimeout(() => no(new Error('inbox post timed out')), 10000))]);`;

/** The repl code that opens (or reuses) the tab of `key`, runs `read` in it and posts a found object to `inbox`; it prints only a verdict. `read` has no // comments. */
export function loginCaptureScript(o: { key: string; url: string; read: string; inbox: string }): string {
	const key = JSON.stringify(o.key);
	return oneLine(`${CLOSE} globalThis.dzLogin = globalThis.dzLogin || {};
let tab = globalThis.dzLogin[${key}];
if (!tab) { tab = await openTab(${JSON.stringify(o.url)}); globalThis.dzLogin[${key}] = tab; await new Promise(r => setTimeout(r, 3000)); }
const found = await tab.evaluate(${o.read}).catch(() => { if (tab.isClosed()) delete globalThis.dzLogin[${key}]; return null; });
if (!found) { console.log('RESULT ' + JSON.stringify({ ok: true, waiting: 'login' })); }
else { ${inboxPost(o.inbox, "found")} await dzClose(tab); delete globalThis.dzLogin[${key}]; console.log('RESULT ' + JSON.stringify({ ok: true })); }`);
}

export function loginCloseScript(key: string): string {
	const k = JSON.stringify(key);
	return oneLine(`${CLOSE} const tab = globalThis.dzLogin && globalThis.dzLogin[${k}]; if (tab) { await dzClose(tab); delete globalThis.dzLogin[${k}]; } console.log('RESULT {"ok":true}');`);
}

export type LoginSpec = { key: string; url: string; read: string; owner: OnboardOwnerStep; giveUpAfter?: number };
export type LoginOutcome = { captured: Record<string, unknown> } | { waiting: OnboardOwnerStep; recheckMs: number };

/** One pass of a login step: the captured object, a waiting outcome to be rechecked by the engine, or a plain error (Aside unreachable, give-up limit). */
export async function loginStep(ctx: OnboardFlowContext, spec: LoginSpec): Promise<LoginOutcome> {
	const t = msg().connect.login;
	if (ctx.attempt * LOGIN_RECHECK_MS >= (spec.giveUpAfter ?? LOGIN_GIVE_UP_MS)) throw new Error(t.gaveUp);
	const got = await ctx.deps.browser.run("login-capture", { key: spec.key, url: spec.url, read: spec.read });
	if (got.waiting) return { waiting: spec.owner, recheckMs: LOGIN_RECHECK_MS };
	if (!got.ok || !got.data) throw new Error(t.unreadable);
	for (const v of Object.values(got.data)) if (typeof v === "string") ctx.seen(v);
	return { captured: got.data };
}

export const loginClose = (ctx: OnboardFlowContext, key: string): Promise<unknown> => ctx.deps.browser.run("login-close", { key });
