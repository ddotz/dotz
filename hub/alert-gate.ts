// Which gateway alerts are worth the owner's attention (owner 2026-10-26: "불필요한 알림은 막고 꼭 필요한 알림만 사용자에게 보여줘야해").
// Two rules, shared by the bell (notices.ts), web push (push.ts) and the Discord alert post (outbound.ts):
// - quiet: a line that only says a problem is over or a routine check found nothing (a watch passing again, the provider back, the API key
//   no longer used, the model put back, a token audit with no warning). It stays readable in the 알림 conversation, born read, never pushed.
// - repeat: the same alert again (numbers aside) within REPEAT_MS while nothing recovered in between. The first one was delivered; the repeat
//   updates that bell item in place and is neither pushed nor posted to Discord again. A question ([ask]) is never a repeat. Kept on disk,
//   so a restart does not tell the owner again.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, writeAtomic } from "./config.ts";
import { parseTone } from "./tone.ts";

export const REPEAT_MS = 6 * 3600_000;
// An optional "<agent>: " or "[<watch>] " lead, then the words of an over / all-clear line.
const QUIET = /^(?:\[[^\]\n]{1,80}\]\s*|[^:\n]{1,60}:\s+)?(?:recovered\b|다시 정상이에요|모델 제공자가 다시 연결됐어요|API 키 사용 끝|원래 모델\(.*\)로 되돌렸어요|모델 복귀:|토큰 누수 점검 .*경고 0건)/;
export const quietAlert = (text: string): boolean => {
	const { tone, text: rest } = parseTone(text);
	return tone !== "ask" && tone !== "fail" && QUIET.test(rest.trim());
};
// The matter an alert is about, whatever times and counts it names.
export const alertMatter = (text: string): string => parseTone(text).text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 300);

export const alertRepeatsFile = () => join(DATA_DIR, "alert-repeats.json");
const load = (): Record<string, number> => {
	try {
		const v = JSON.parse(readFileSync(alertRepeatsFile(), "utf8"));
		return v && typeof v === "object" ? v : {};
	} catch {
		return {};
	}
};

// Records one gateway alert and says whether it repeats one already delivered. A quiet (all-clear) line ends every open matter: the next
// alert after it is news again.
export function repeatAlert(text: string, at = Date.now()): boolean {
	if (quietAlert(text)) {
		writeAtomic(alertRepeatsFile(), "{}\n");
		return false;
	}
	if (parseTone(text).tone === "ask") return false;
	const all = load();
	for (const [k, t] of Object.entries(all)) if (typeof t !== "number" || at - t >= REPEAT_MS) delete all[k];
	const key = alertMatter(text);
	const repeat = key in all;
	if (!repeat) all[key] = at;
	writeAtomic(alertRepeatsFile(), `${JSON.stringify(all)}\n`);
	return repeat;
}
