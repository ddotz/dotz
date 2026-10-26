// The model of a reply draft (owner 2026-10-23: the 답장 모델 setting of every app that drafts replies). Order: the app instance's own setting
// (custom/reply-drafts/config.json models.<app or instance id>), then the global reply-drafts `model`, then the subagent model (config models.workers,
// Sonnet high unless the owner changed it), read live on every call so changing the subagent model changes this default too.
// Light on purpose: the CLI draft path imports it, so nothing here pulls in the web, the orchestrator or the model list (reply-model-choices.ts does).
import { dataDir as installDir, loadSettings, type Settings } from "../features/reply-drafts/lib/settings.ts";
import { appEntries, inConv, type IntegrationEntry } from "./integrations.ts";
import { pickDraftModel } from "./kakao/draft.ts";

export type ReplyCall = (system: string, user: string, opts: { model?: string; timeoutMs?: number }) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

/** The app instance a draft belongs to: the created instance whose filter claims `conv` (e.g. `kakao:<chat>`, `mail:<source>-<id>`), else the app itself. */
export function instanceOf(entries: readonly IntegrationEntry[], app: string, conv?: string): string {
	if (!conv) return app;
	const mine = entries.filter(e => e.app === app && inConv(e, conv));
	return (mine.find(e => e.created) ?? mine[0])?.key ?? app;
}

/** Pure choice: instance setting, else the global model, else the fallback; never a role, mini or Haiku model (pickDraftModel). */
export const pickReplyModel = (s: Settings, instance: string, fallback: string): string => pickDraftModel(s.models?.[instance] ?? s.model ?? fallback);

export async function replyModel(app: string, conv?: string, o: { dataDir?: string; worker?: string } = {}): Promise<string> {
	return pickReplyModel(loadSettings(), instanceOf(appEntries(o.dataDir ?? installDir()), app, conv), o.worker ?? (await import("./config.ts")).workerModel());
}

// A draft on a warm process answers in a few seconds; 45 s leaves room for a long room prompt and a slow model, and an
// unusable provider is refused before the call (hub/model-runner.ts), so nobody waits 120 s for a draft that cannot come.
export const DRAFT_TIMEOUT_MS = 45_000;

/** The one model call of a reply draft for `app` (subscription only, hub/outlang.ts); `call` is injected by tests. */
export async function callReplyModel(app: string, conv: string | undefined, system: string, user: string, call?: ReplyCall, o: { dataDir?: string; worker?: string } = {}) {
	const model = await replyModel(app, conv, o);
	return (call ?? (await import("./outlang.ts")).callModel)(system, user, { model, timeoutMs: DRAFT_TIMEOUT_MS });
}
