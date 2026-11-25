import { readFileSync } from "node:fs";
import { join } from "node:path";
import { harnessDir } from "./agent-home.ts";

/** A language the harness writes its user-facing notices in. */
export type NoticeLanguage = "en" | "ko";

/** One user-facing notice in every language the harness writes notices in. */
export interface NoticeText {
	en: string;
	ko: string;
}

function ruleOf(name: "noticeLanguage" | "replyLanguage"): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(harnessDir(), "machine-rules.json"), "utf8"));
	} catch {
		return undefined;
	}
	return typeof parsed === "object" && parsed !== null && name in parsed ? Reflect.get(parsed, name) : undefined;
}

/** The language of the notices the user sees: `noticeLanguage` in `<harnessDir()>/machine-rules.json` ("en" or "ko"), read on every call; English when the file or the field is missing or holds anything else. Messages for the agent (refusal reasons, additionalContext) stay English. */
export function noticeLanguage(): NoticeLanguage {
	return ruleOf("noticeLanguage") === "ko" ? "ko" : "en";
}

/** The language every reply of this machine must be in: `replyLanguage` in `<harnessDir()>/machine-rules.json` ("en" or "ko"), read on every call; undefined (the prompts decide) when the file or the field is missing or holds anything else. */
export function replyLanguage(): NoticeLanguage | undefined {
	const value = ruleOf("replyLanguage");
	return value === "ko" || value === "en" ? value : undefined;
}

/** The text of `notice` in the machine's notice language. */
export const say = (notice: NoticeText): string => notice[noticeLanguage()];
