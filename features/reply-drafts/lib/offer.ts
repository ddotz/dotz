// The gateway's hook for a new mail: when this install turned the feature on (and auto), a mail that warrants a reply gets a draft in
// the user's tone, offered as a send-approval [ask] (hub/draft-approval.ts). Never throws; nothing is sent from here.
import { addressesOf, precheck, type ReplyItem } from "../../../hub/reply-draft.ts";
import type { ModelCall } from "../../../hub/reply-draft.ts";
import { askText, buildDraft } from "./flow.ts";
import { loadSettings } from "./settings.ts";
import { addDraft, isDrafted, markDrafted } from "./store.ts";

export type OfferMail = { key: string; target: string; thread?: string; source: string; id: string; subject: string; from?: string; to?: string; summary?: string; body?: string };
export type OfferDeps = { send: (target: string, text: string) => unknown; call?: ModelCall; readBody?: (source: string, id: string) => Promise<string | undefined> };

export async function offerMailDraft(m: OfferMail, deps: OfferDeps): Promise<"offered" | "skipped" | "off" | "failed"> {
	try {
		const settings = loadSettings();
		if (!settings.enabled || !settings.auto) return "off";
		if (isDrafted(m.key)) return "skipped";
		const item: ReplyItem = { kind: "mail", from: m.from ?? "", self: addressesOf(m.to), subject: m.subject, text: "" };
		if (precheck(item, settings.senders)) {
			markDrafted(m.key);
			return "skipped";
		}
		item.text = (m.body ?? (await deps.readBody?.(m.source, m.id).catch(() => undefined)) ?? m.summary ?? "").trim() || m.subject;
		const built = await buildDraft(item, { source: m.source, mailId: m.id, ref: m.key }, { call: deps.call });
		if (built.action === "skip") {
			markDrafted(m.key);
			return "skipped";
		}
		await deps.send(m.thread ? `th:${m.thread}` : m.target, askText(built.rec, built.warnings));
		addDraft(built.rec);
		return "offered";
	} catch {
		return "failed";
	}
}
