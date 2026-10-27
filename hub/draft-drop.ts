// 보내지 않기 on a mail reply draft's card (hub/routes.ts, POST /api/notices/<id>/answer) drops the draft in the reply-drafts store at once, not only
// when the bot gets to it, so every count and list, here and on the other computer, sees it gone. Reply-drafts ids are R + 6 letters.
import { draftActionOf } from "./draft-approval.ts";
import type { Notice } from "./notices.ts";

export async function dropAnsweredMailDraft(item: Notice | undefined, n: number, log: (line: string) => void = () => undefined): Promise<void> {
	const ref = item?.decision?.draft?.ref, opt = item?.decision?.options.find(o => o.n === n);
	if (!ref || !/^R[A-Z2-7]{6}$/.test(ref) || !opt || draftActionOf(opt.label) !== "drop") return;
	try {
		const { dropDraft } = await import("../features/reply-drafts/lib/flow.ts");
		const r = dropDraft(ref);
		if (!r.ok) log(`draft ${ref}: 보내지 않기 not applied to the store: ${r.text}`);
	} catch (e) {
		log(`draft ${ref}: 보내지 않기 not applied to the store: ${(e as Error).message}`);
	}
}
