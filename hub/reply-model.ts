// The model of a reply draft (owner 2026-10-23: the 답장 모델 setting of every app that drafts replies). Order: the app instance's own setting
// (custom/reply-drafts/config.json models.<app or instance id>), then the global reply-drafts `model` (the 답장 기본값 setting, 모델·폴백),
// then REPLY_DEFAULT, Sonnet 5.5 medium (owner 2026-10-27: its own default, no longer the subagent model).
// Light on purpose: the CLI draft path imports it, so nothing here pulls in the web, the orchestrator or the model list (reply-model-choices.ts does).
import { dataDir as installDir, loadSettings, type Settings } from "../features/reply-drafts/lib/settings.ts";
import { appEntries, inConv, type IntegrationEntry } from "./integrations.ts";
import { DRAFT_MODEL } from "./kakao/draft.ts";

export type ReplyCall = (system: string, user: string, opts: { model?: string; timeoutMs?: number }) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

/** The reply default when the owner set none: Sonnet 5.5 medium on the subscription. */
export const REPLY_DEFAULT = DRAFT_MODEL;

/** The app instance a draft belongs to: the created instance whose filter claims `conv` (e.g. `kakao:<chat>`, `mail:<source>-<id>`), else the app itself. */
export function instanceOf(entries: readonly IntegrationEntry[], app: string, conv?: string): string {
	if (!conv) return app;
	const mine = entries.filter(e => e.app === app && inConv(e, conv));
	return (mine.find(e => e.created) ?? mine[0])?.key ?? app;
}

const real = (m?: string): m is string => Boolean(m) && !m!.startsWith("@");
/** The global reply default as the call uses it: the owner's 답장 기본값, else REPLY_DEFAULT. A role (@tiny) is never a reply model. */
export const replyDefault = (s: Pick<Settings, "model">): string => (real(s.model) ? s.model : REPLY_DEFAULT);
/** Pure choice: the instance setting as the owner picked it (any listed model, owner 2026-10-27), else the reply default. */
export const pickReplyModel = (s: Settings, instance: string): string => {
	const own = s.models?.[instance];
	return real(own) ? own : replyDefault(s);
};

export async function replyModel(app: string, conv?: string, o: { dataDir?: string } = {}): Promise<string> {
	return pickReplyModel(loadSettings(), instanceOf(appEntries(o.dataDir ?? installDir()), app, conv));
}

// A draft on a warm process answers in a few seconds; 45 s leaves room for a long room prompt and a slow model, and an
// unusable provider is refused before the call (hub/model-runner.ts), so nobody waits 120 s for a draft that cannot come.
export const DRAFT_TIMEOUT_MS = 45_000;

/** The one model call of a reply draft for `app` (subscription only, hub/outlang.ts); `call` is injected by tests. */
export async function callReplyModel(app: string, conv: string | undefined, system: string, user: string, call?: ReplyCall, o: { dataDir?: string } = {}) {
	const model = await replyModel(app, conv, o);
	return (call ?? (await import("./outlang.ts")).callModel)(system, user, { model, timeoutMs: DRAFT_TIMEOUT_MS });
}
