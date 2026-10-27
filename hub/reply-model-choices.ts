// The options of the 답장 모델 setting, read from the runtime's own model list (the data behind /model), which holds only the providers the owner
// connected an account or key for (providers.ts availableModels). The Claude subscription models come first, each with the efforts a reasoning model
// offers, under friendly names ("Sonnet 5.5 · high"); then every other connected provider's models, one entry each, named with the provider
// ("OpenGateway · GPT 5.5 · medium", owner 2026-10-27). The first option, "", is the default and names the model it means now.
import { providerLabel } from "./accounts-providers.ts";
import { setReplyModelChoices, type ReplyModelChoices } from "./app-settings.ts";
import { splitThinking, workerModel } from "./config.ts";
import { modelChoices } from "./control.ts";
import { availableModels, type ModelInfo } from "./providers.ts";
import { loadSettings } from "../features/reply-drafts/lib/settings.ts";

const EFFORTS = ["low", "medium", "high"] as const;
const vnum = (sel: string): number[] => (sel.match(/haiku-([\d-]+)$/)?.[1] ?? "0").split("-").map(Number);
const friendly = (selector: string): string => {
	const [one] = modelChoices([{ selector, name: selector, provider: selector.split("/")[0]!, reasoning: false }]);
	return one?.name ?? selector.split("/").pop()!;
};
const friendlyHaiku = (sel: string): string => `Haiku ${vnum(sel).filter(n => n < 1000).join(".")}`;
const effortWord = (thinking?: string): string => (thinking && thinking !== "off" ? ` ${thinking}` : "");

/** Pure: the options and their labels (name and effort only, owner 2026-10-26: no description) from the model list, the global reply model (if any) and the subagent model. */
export function replyModelChoices(models: readonly ModelInfo[], worker: string, global?: string): ReplyModelChoices {
	const options = [""];
	const own = global ? splitThinking(global) : undefined;
	const base = own ?? splitThinking(worker);
	const labels: Record<string, string> = { "": `${own ? "답장 기본값" : "서브에이전트와 같음"} · ${friendly(base.model)}${effortWord(base.thinking)}` };
	// Every connected model is offered (owner 2026-10-27: "리스트를 다 보여줘야지"): older generations, every Haiku, mini/flash/lite, and every
	// effort of a reasoning model, the subscription's first. What the owner picks is used as picked (reply-model.ts pickReplyModel).
	const all = (list: readonly ModelInfo[]) => {
		const named = modelChoices(list);
		const seen = new Set(named.map(x => x.selector));
		return [...named, ...list.filter(x => !seen.has(x.selector)).map(x => ({ ...x, name: /claude-haiku-/.test(x.selector) ? friendlyHaiku(x.selector) : friendly(x.selector) }))];
	};
	const add = (m: { selector: string; name: string; reasoning: boolean }, prefix: string) => {
		for (const level of m.reasoning ? EFFORTS : [undefined]) {
			const value = level ? `${m.selector}:${level}` : m.selector;
			if (labels[value] !== undefined) continue;
			options.push(value);
			labels[value] = `${prefix}${m.name}${level ? ` · ${level}` : ""}`;
		}
	};
	for (const m of all(models.filter(x => x.provider === "anthropic"))) add(m, "");
	for (const m of all(models.filter(x => x.provider !== "anthropic"))) add(m, `${providerLabel(m.provider)} · `);
	return { options, labels };
}

/** Reads the live model list and installs the options the app settings offer; called before a settings read or write. */
export async function refreshReplyModelChoices(): Promise<void> {
	setReplyModelChoices(replyModelChoices(await availableModels(), workerModel(), loadSettings().model));
}
