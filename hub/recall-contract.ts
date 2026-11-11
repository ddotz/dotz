// The contract the orchestrator re-reads after a compaction (extension/index.ts recall()), built from a data dir and a package dir
// instead of module constants, so a check can measure it for any data dir. Pure: it reads files and writes nothing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { featurePrompt } from "./featuredirs.ts";
import { baseLanguage, detectLanguage, languageName } from "./language.ts";
import { dropSection, renderSetups, renderState } from "./recall-parts.ts";

/** The parts of the contract text as written into it (rules is RULES.md alone; the feature bodies that follow it are `features`). */
export type RecallParts = { identity: string; mode: string; rules: string; features: string; lessons: string; setups: string; state: string };

// Same language and MODE file chain as hub/i18n.ts (that module has gateway side effects, so only the pure helpers are shared).
function language(data: string): string {
	try {
		const id = JSON.parse(readFileSync(join(data, "config.json"), "utf8")).identity ?? {};
		if (typeof id.language === "string" && id.language.trim()) return id.language.trim();
		const text = [id.character, id.tone, id.notices, id.address].filter(s => typeof s === "string").join("\n");
		const identityFile = join(data, "identity", "IDENTITY.md");
		return detectLanguage(text.trim() || !existsSync(identityFile) ? text : readFileSync(identityFile, "utf8"));
	} catch {
		return "en";
	}
}

export function recallContract(data: string, pkg: string): { text: string; parts: RecallParts } {
	const file = (p: string, max: number) => (existsSync(p) ? readFileSync(p, "utf8").slice(0, max) : "");
	const code = language(data);
	const base = baseLanguage(code);
	const chain = [...(base === "en" ? [] : [join(data, `MODE.${base}.md`), join(pkg, `MODE.${base}.md`)]), join(data, "MODE.md"), join(pkg, "MODE.md")];
	// Same as the start prompt (hub/orchestrator-parts.ts recallText): no mail section while zele is off, state at STATE_CAP, setups one line each.
	let zeleOn = true;
	try {
		zeleOn = JSON.parse(readFileSync(join(data, "config.json"), "utf8")).zele?.enabled !== false;
	} catch {
		// no readable config: zele's default (on)
	}
	const modeText = file(chain.find(existsSync) ?? join(pkg, "MODE.md"), 30000);
	const mode = zeleOn ? modeText : dropSection(modeText, "## Mail and calendar");
	const features = featurePrompt(data, "orchestrator");
	const stateFile = join(data, "state.json");
	const setupsFile = join(data, "channel-setups.json");
	const rules = file(join(data, "RULES.md"), 12000);
	const parts = { identity: file(join(data, "identity", "IDENTITY.md"), 3000), rules: rules + (features ? `\n\n${features}` : ""), lessons: file(join(data, "LESSONS.md"), 3000), setups: existsSync(setupsFile) ? renderSetups(readFileSync(setupsFile, "utf8")) : "", state: (existsSync(stateFile) && renderState(readFileSync(stateFile, "utf8"), stateFile)) || "{}" };
	const split: RecallParts = { identity: parts.identity, mode, rules, features, lessons: parts.lessons, setups: parts.setups, state: parts.state };
	if (base === "ko") return { text: `[dotz] 컨텍스트 압축 뒤 계약을 다시 읽어요:\n\n정체성:\n${parts.identity}\n\n${mode}\n\n오너 규칙:\n${parts.rules}\n\n교훈:\n${parts.lessons}\n\n작업 채널 설정 (자세한 건 dotz_channel list):\n${parts.setups || "(없음)"}\n\n현재 state.json:\n${parts.state}`, parts: split };
	const reply = base === "en" ? "" : `\n\nReply to the owner in ${languageName(code)} (${code}).`;
	return { text: `[dotz] Contract re-read after compaction:\n\nIdentity:\n${parts.identity}\n\n${mode}\n\nOwner rules:\n${parts.rules}\n\nLessons:\n${parts.lessons}\n\nWork channel setups (dotz_channel list for details):\n${parts.setups || "(none)"}\n\nCurrent state.json:\n${parts.state}${reply}`, parts: split };
}
