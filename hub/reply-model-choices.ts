// The options of the 답장 모델 setting, read from the runtime's own model list (the data behind /model): the Claude subscription models, each with
// the efforts a reasoning model offers, under friendly names ("Sonnet 5.5 · high"). The first option, "", is the default and names the model it means now.
import { setReplyModelChoices, type ReplyModelChoices } from "./app-settings.ts";
import { splitThinking, workerModel } from "./config.ts";
import { modelChoices } from "./control.ts";
import { availableModels, type ModelInfo } from "./providers.ts";
import { loadSettings } from "../features/reply-drafts/lib/settings.ts";

const EFFORTS = ["low", "medium", "high"] as const;
// The pickers elsewhere hide Haiku (control.ts HIDDEN_MODEL); a reply draft may use the newest one (owner 2026-10-26).
const vnum = (sel: string): number[] => (sel.match(/haiku-([\d-]+)$/)?.[1] ?? "0").split("-").map(Number);
const newestHaiku = (models: readonly ModelInfo[]): ModelInfo | undefined =>
	models.filter(m => m.provider === "anthropic" && /claude-haiku-\d+(?:-\d)?$/.test(m.selector)).sort((a, b) => {
		const [x, y] = [vnum(a.selector), vnum(b.selector)];
		return (y[0]! - x[0]!) || ((y[1] ?? 0) - (x[1] ?? 0));
	})[0];

const friendly = (selector: string): string => {
	const [one] = modelChoices([{ selector, name: selector, provider: selector.split("/")[0]!, reasoning: false }]);
	return one?.name ?? selector.split("/").pop()!;
};
const friendlyHaiku = (sel: string): string => `Haiku ${vnum(sel).join(".")}`;
const effortWord = (thinking?: string): string => (thinking && thinking !== "off" ? ` ${thinking}` : "");

/** Pure: the options and their labels (name and effort only, owner 2026-10-26: no description) from the model list, the global reply model (if any) and the subagent model. */
export function replyModelChoices(models: readonly ModelInfo[], worker: string, global?: string): ReplyModelChoices {
	const options = [""];
	const own = global ? splitThinking(global) : undefined;
	const base = own ?? splitThinking(worker);
	const labels: Record<string, string> = { "": `${own ? "답장 기본값" : "서브에이전트와 같음"} · ${friendly(base.model)}${effortWord(base.thinking)}` };
	const haiku = newestHaiku(models);
	const listed = [...modelChoices(models.filter(x => x.provider === "anthropic")).filter(m => !m.older), ...(haiku ? [{ ...haiku, name: friendlyHaiku(haiku.selector) }] : [])];
	for (const m of listed) {
		const levels = m.reasoning ? EFFORTS : [undefined];
		for (const level of levels) {
			const value = level ? `${m.selector}:${level}` : m.selector;
			options.push(value);
			labels[value] = `${m.name}${level ? ` · ${level}` : ""}`;
		}
	}
	return { options, labels };
}

/** Reads the live model list and installs the options the app settings offer; called before a settings read or write. */
export async function refreshReplyModelChoices(): Promise<void> {
	setReplyModelChoices(replyModelChoices(await availableModels(), workerModel(), loadSettings().model));
}
