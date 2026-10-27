// 되돌리기 after 보내지 않기 on a mail reply draft's card (hub/routes.ts, POST /api/notices/reopen): hub/draft-drop.ts dropped the draft in the
// reply-drafts store at answer time, so reopening only the notice would bring back a card whose 보내기 fails. The ref is read off the notice
// before the reopen clears its answer, and each reopened one is put back to pending in the store. Reply-drafts ids are R + 6 letters.
import { draftActionOf } from "./draft-approval.ts";
import type { Notice } from "./notices.ts";

// notice id -> draft ref, for the asked ids whose last answer was the drop option. Call it before reopenNotices.
export function droppedDraftRefs(items: Notice[], ids: unknown): Map<string, string> {
	const want = new Set(Array.isArray(ids) ? ids.map(String) : []), out = new Map<string, string>();
	for (const n of items) {
		const d = n.decision, ref = d?.draft?.ref;
		if (!want.has(n.id) || !d || !ref || !/^R[A-Z2-7]{6}$/.test(ref)) continue;
		const m = /^\s*(\d+)\)/.exec(String(d.answer ?? "")), o = m && d.options.find(x => x.n === Number(m[1]));
		if (o && draftActionOf(o.label) === "drop") out.set(n.id, ref);
	}
	return out;
}

export async function restoreReopenedDrafts(refs: Map<string, string>, reopened: string[], log: (line: string) => void = () => undefined): Promise<void> {
	const todo = reopened.map(id => refs.get(id)).filter((r): r is string => !!r);
	if (!todo.length) return;
	try {
		const { restoreDraft } = await import("../features/reply-drafts/lib/flow.ts");
		for (const ref of todo) {
			const r = restoreDraft(ref);
			if (!r.ok) log(`draft ${ref}: 되돌리기 not applied to the store: ${r.text}`);
		}
	} catch (e) {
		log(`drafts ${todo.join(", ")}: 되돌리기 not applied to the store: ${(e as Error).message}`);
	}
}
