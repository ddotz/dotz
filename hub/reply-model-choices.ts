// The options of the 답장 모델 setting, read from the runtime's own model list (the data behind /model), which holds only the providers the owner
// connected an account or key for (providers.ts availableModels). The Claude subscription models come first, each with the efforts a reasoning model
// offers, under friendly names ("Sonnet 5.5 · high"); then every other connected provider's models, one entry each, named with the provider
// ("OpenGateway · GPT 5.5 · 보통", owner 2026-10-27). The first option, "", is the default and names the model it means now.
import { providerLabel } from "./accounts-providers.ts";
import { setReplyModelChoices, type ReplyModelChoices } from "./app-settings.ts";
import { splitThinking } from "./config.ts";
import { modelChoices } from "./control.ts";
import { availableModels, type ModelInfo } from "./providers.ts";
import { REPLY_DEFAULT, replyDefault } from "./reply-model.ts";
import { loadSettings, saveSettings } from "../features/reply-drafts/lib/settings.ts";

const EFFORTS = ["low", "medium", "high"] as const;
const vnum = (sel: string): number[] => (sel.match(/haiku-([\d-]+)$/)?.[1] ?? "0").split("-").map(Number);
const friendly = (selector: string): string => {
	const [one] = modelChoices([{ selector, name: selector, provider: selector.split("/")[0]!, reasoning: false }]);
	return one?.name ?? selector.split("/").pop()!;
};
const friendlyHaiku = (sel: string): string => `Haiku ${vnum(sel).filter(n => n < 1000).join(".")}`;
// Effort words in Korean, as the web says them (web/js/04-state.js THINK_KO); the stored value stays the API id.
export const EFFORT_KO: Record<string, string> = { off: "끔", minimal: "최소", low: "낮음", medium: "보통", high: "높음", xhigh: "최고", max: "최고", auto: "자동" };
const effortWord = (thinking?: string): string => (thinking && thinking !== "off" ? ` · ${EFFORT_KO[thinking] ?? thinking}` : "");
/** "Sonnet 5.5 · 보통" for a selector with its effort. */
export const replyModelLabel = (selector: string): string => {
	const { model, thinking } = splitThinking(selector);
	return `${friendly(model)}${effortWord(thinking)}`;
};

/** Pure: the options and their labels (name and effort only, owner 2026-10-26: no description) from the model list and the global reply
 *  model (if any). The default option names exactly the model a draft then uses (reply-model.ts replyDefault). */
export function replyModelChoices(models: readonly ModelInfo[], global?: string): ReplyModelChoices {
	const options = [""];
	const labels: Record<string, string> = { "": `답장 기본값 · ${replyModelLabel(replyDefault({ model: global }))}` };
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
			labels[value] = `${prefix}${m.name}${effortWord(level)}`;
		}
	};
	for (const m of all(models.filter(x => x.provider === "anthropic"))) add(m, "");
	for (const m of all(models.filter(x => x.provider !== "anthropic"))) add(m, `${providerLabel(m.provider)} · `);
	return { options, labels };
}

/** Reads the live model list and installs the options the app settings offer; called before a settings read or write. */
export async function refreshReplyModelChoices(): Promise<void> {
	setReplyModelChoices(replyModelChoices(await availableModels(), loadSettings().model));
}

// The 답장 기본값 setting (모델·폴백): the global reply-drafts `model`, "" = REPLY_DEFAULT. Its options are the app field's, "" naming the
// shipped default rather than the current one.
export async function replyDefaultView(models?: readonly ModelInfo[]) {
	const c = replyModelChoices(models ?? (await availableModels()));
	const value = loadSettings().model ?? "";
	return { value, model: replyDefault(loadSettings()), default: REPLY_DEFAULT, default_label: `기본값 · ${replyModelLabel(REPLY_DEFAULT)}`, options: c.options, labels: c.labels };
}
export async function setReplyDefault(value: string, models?: readonly ModelInfo[]) {
	const v = value.trim();
	const list = models ?? (await availableModels());
	if (v && !replyModelChoices(list).options.includes(v)) throw new Error(`연결된 모델이 아니에요: ${v}`);
	saveSettings({ model: v || undefined });
	setReplyModelChoices(replyModelChoices(list, v || undefined));
	return { ok: true, target: "replies", applied: "live", ...(await replyDefaultView(list)) };
}
