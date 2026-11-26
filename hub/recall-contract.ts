// The contract the orchestrator re-reads after a compaction (extension/index.ts recall()), built from a data dir and a package dir
// instead of module constants, so a check can measure it for any data dir. Pure: it reads files and writes nothing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { featurePrompt } from "./featuredirs.ts";
import { baseLanguage, detectLanguage, languageName } from "./language.ts";
import { boundaryEntries, dropSection, newestLines, renderSetups, renderState } from "./recall-parts.ts";

export type RecallParts = { identity: string; mode: string; rules: string; features: string; lessons: string; owner: string; boundaries: string; setups: string; state: string };

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

/** The owner's voice and address file as every session re-reads it (the main session's contract and a lane's). */
export const identityText = (data: string): string => {
	const p = join(data, "identity", "IDENTITY.md");
	return existsSync(p) ? readFileSync(p, "utf8").slice(0, 3000) : "";
};

/** What a lane re-reads after a compaction (extension/index.ts laneSession): the lane footer the gateway wrote at spawn (hub/lanefooter.ts),
 * which already holds the owner's identity text. Not the orchestrator's contract or state. */
export function laneContract(contractFile: string | undefined): string {
	const footer = contractFile && existsSync(contractFile) ? readFileSync(contractFile, "utf8").trim() : "";
	return `[dotz] Lane contract re-read after compaction:\n\n${footer}`;
}

/**
 * `modeInSystem`: the runtime keeps identity and MODE in its system prompt (caps.modeInSystem; the hub tells the process with DOTZ_MODE_IN_SYSTEM), and a
 * compaction leaves that alone, so the re-read leaves both out and says where they are. `parts` holds them either way: what hub/prompt-health.ts measures is the
 * whole contract, wherever a runtime keeps it, so it calls this without the option.
 */
export function recallContract(data: string, pkg: string, opts: { modeInSystem?: boolean } = {}): { text: string; parts: RecallParts; modeFile: string } {
	const file = (p: string, max: number) => (existsSync(p) ? readFileSync(p, "utf8").slice(0, max) : "");
	const code = language(data);
	const base = baseLanguage(code);
	const chain = [...(base === "en" ? [] : [join(data, `MODE.${base}.md`), join(pkg, `MODE.${base}.md`)]), join(data, "MODE.md"), join(pkg, "MODE.md")];
	// Same as the start prompt (hub/orchestrator-parts.ts modeContract and recallText): no mail section while zele is off, state at STATE_CAP, setups one line each.
	let zeleOn = true;
	try {
		zeleOn = JSON.parse(readFileSync(join(data, "config.json"), "utf8")).zele?.enabled !== false;
	} catch {
		// no readable config: zele's default (on)
	}
	const modeFile = chain.find(existsSync) ?? join(pkg, "MODE.md");
	const modeText = file(modeFile, 30000);
	const mode = zeleOn ? modeText : dropSection(modeText, "## Mail and calendar");
	const features = featurePrompt(data, "orchestrator");
	const stateFile = join(data, "state.json");
	const setupsFile = join(data, "channel-setups.json");
	const rules = file(join(data, "RULES.md"), 12000);
	const ownerFile = join(data, "memory", "owner.md");
	const owner = newestLines(file(ownerFile, Number.POSITIVE_INFINITY), ownerFile);
	const boundaries = boundaryEntries(file(join(data, "memory", "boundaries.md"), Number.POSITIVE_INFINITY));
	const memory = [owner, boundaries].filter(Boolean).join("\n");
	const parts = { identity: identityText(data), rules: rules + (features ? `\n\n${features}` : ""), lessons: file(join(data, "LESSONS.md"), 3000), setups: existsSync(setupsFile) ? renderSetups(readFileSync(setupsFile, "utf8")) : "", state: (existsSync(stateFile) && renderState(readFileSync(stateFile, "utf8"), stateFile)) || "{}" };
	const split: RecallParts = { identity: parts.identity, mode, rules, features, lessons: parts.lessons, owner, boundaries, setups: parts.setups, state: parts.state };
	const sys = opts.modeInSystem === true;
	if (base === "ko") return { text: `[dotz] 컨텍스트 압축 뒤 계약을 다시 읽어요${sys ? " (정체성과 계약은 시스템 프롬프트에 있어요)" : ""}:\n\n${sys ? "" : `정체성:\n${parts.identity}\n\n${mode}\n\n`}오너 규칙:\n${parts.rules}\n\n교훈:\n${parts.lessons}\n\n오너 메모리:\n${memory || "(없음)"}\n\n작업 채널 설정 (자세한 건 dotz_channel list):\n${parts.setups || "(없음)"}\n\n현재 state.json:\n${parts.state}`, parts: split, modeFile };
	const reply = base === "en" ? "" : `\n\nReply to the owner in ${languageName(code)} (${code}).`;
	return { text: `[dotz] Contract re-read after compaction${sys ? " (your identity and the contract are in your system prompt)" : ""}:\n\n${sys ? "" : `Identity:\n${parts.identity}\n\n${mode}\n\n`}Owner rules:\n${parts.rules}\n\nLessons:\n${parts.lessons}\n\nOwner memory:\n${memory || "(none)"}\n\nWork channel setups (dotz_channel list for details):\n${parts.setups || "(none)"}\n\nCurrent state.json:\n${parts.state}${reply}`, parts: split, modeFile };
}
