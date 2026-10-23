// The options of the 답장 모델 setting, read from the runtime's own model list (the data behind /model): the Claude subscription models, each with
// the efforts a reasoning model offers, under friendly names ("Sonnet 5.5 · high"). The first option, "", is the default and names the model it means now.
import { setReplyModelChoices, type ReplyModelChoices } from "./app-settings.ts";
import { splitThinking, workerModel } from "./config.ts";
import { modelChoices } from "./control.ts";
import { availableModels, type ModelInfo } from "./providers.ts";
import { loadSettings } from "../features/reply-drafts/lib/settings.ts";

const EFFORTS = ["low", "medium", "high"] as const;
const HINT: Record<string, string> = { low: "빠르고 가벼워요", medium: "속도와 품질이 균형이에요", high: "꼼꼼하지만 한도를 더 써요" };
const MOST = "가장 꼼꼼하지만 한도를 많이 써요";

const friendly = (selector: string): string => {
	const [one] = modelChoices([{ selector, name: selector, provider: selector.split("/")[0]!, reasoning: false }]);
	return one?.name ?? selector.split("/").pop()!;
};
const effortWord = (thinking?: string): string => (thinking && thinking !== "off" ? ` ${thinking}` : "");

/** Pure: the options and their one-line Korean labels from the model list, the global reply model (if any) and the subagent model. */
export function replyModelChoices(models: readonly ModelInfo[], worker: string, global?: string): ReplyModelChoices {
	const options = [""];
	const own = global ? splitThinking(global) : undefined;
	const base = own ?? splitThinking(worker);
	const labels: Record<string, string> = { "": `${own ? "답장 기본값" : "서브에이전트와 같음"} · ${friendly(base.model)}${effortWord(base.thinking)}` };
	for (const m of modelChoices(models.filter(x => x.provider === "anthropic"))) {
		if (m.older) continue;
		const levels = m.reasoning ? EFFORTS : [undefined];
		for (const level of levels) {
			const value = level ? `${m.selector}:${level}` : m.selector;
			options.push(value);
			const hint = level ? (m.family === "Opus" && level === "high" ? MOST : HINT[level]) : "생각 단계 없이 답해요";
			labels[value] = `${m.name}${level ? ` · ${level}` : ""} — ${hint}`;
		}
	}
	return { options, labels };
}

/** Reads the live model list and installs the options the app settings offer; called before a settings read or write. */
export async function refreshReplyModelChoices(): Promise<void> {
	setReplyModelChoices(replyModelChoices(await availableModels(), workerModel(), loadSettings().model));
}
