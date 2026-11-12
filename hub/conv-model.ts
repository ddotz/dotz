// The model a kind of conversation runs on apart from main: today the mail app's 이 메일에서 쓸 모델 (custom/apps.json {"<mail instance>":{"conv_model":"<model>:<thinking>"}}).
// Nothing set = the conversation follows main, as every install did before.
import { readAppsFile, appEntries } from "./integrations.ts";
import { DEFAULT_WORKER_MODEL, selectorOf, kindModelOf } from "./config.ts";
import { instanceOf } from "./reply-model.ts";
import { QUICK } from "./session-key.ts";

export const isMailTarget = (t: string): boolean => /^mail:[a-z0-9._-]+$/.test(t);

/**
 * The selector the mail instance that owns conversation `key` (`mail:<key>`) set for its conversations, or undefined. The quick chat runs on
 * the worker default (Sonnet 5.5 high) and never follows main. Other kinds have none.
 */
export function convKindModel(dataDir: string, key: string): string | undefined {
	if (key === QUICK) return DEFAULT_WORKER_MODEL;
	if (!isMailTarget(key)) return undefined;
	const own = kindModelOf(readAppsFile(dataDir)[instanceOf(appEntries(dataDir), "mail", key)]?.conv_model);
	return own && selectorOf(own);
}
