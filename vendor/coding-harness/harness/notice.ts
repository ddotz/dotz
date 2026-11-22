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

/** The language of the notices the user sees: `noticeLanguage` in `<harnessDir()>/machine-rules.json` ("en" or "ko"), read on every call; English when the file or the field is missing or holds anything else. Messages for the agent (refusal reasons, additionalContext) stay English. */
export function noticeLanguage(): NoticeLanguage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(harnessDir(), "machine-rules.json"), "utf8"));
	} catch {
		return "en";
	}
	return typeof parsed === "object" && parsed !== null && "noticeLanguage" in parsed && parsed.noticeLanguage === "ko" ? "ko" : "en";
}

/** The text of `notice` in the machine's notice language. */
export const say = (notice: NoticeText): string => notice[noticeLanguage()];
