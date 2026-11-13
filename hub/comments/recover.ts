// A reply cut off by a restart (owner rule: a double post is worse than a question). Its POST may or may not have reached the platform, so the record that was left
// `sending` becomes `unsure`: no sender, no rule and no card sends it again (contract.ts dispatchReply), only the owner's 다시 보내기 does. On boot the platform is read
// back; the owner's own reply with the same words under that comment proves it went up and it ends `sent`. No proof changes nothing: the owner picks 다시 보내기 or 완료.
// A missing reply is no proof either way (a platform may list it late), and a source that cannot show the owner's replies (an RSS read) never proves anything.
import { type CommentAdapter, DM_THREAD, type RawComment, sameWords, type SourceKind } from "./contract.ts";
import type { Reply, Store } from "./store.ts";

export const POST_UNKNOWN = "게이트웨이가 멈출 때 답글을 올리던 중이라 올라갔는지 알 수 없어요. 확인한 뒤 다시 보내기나 완료를 골라 주세요";

type Deps = { store: Store; adapters: Partial<Record<SourceKind, CommentAdapter>>; onState: (r: Reply) => void };

export function createSendRecovery({ store, adapters, onState }: Deps) {
	const posted = ({ reason: _reason, code: _code, ...r }: Reply): void => {
		const final: Reply = { ...r, state: "sent" };
		store.putReply(final);
		store.setDraftStatus(r.draft, "sent");
		onState(final);
	};

	/** Whether the platform shows this reply. Throws when it cannot be read. */
	async function shown(r: Reply): Promise<boolean> {
		const src = store.config().sources[r.source], adapter = src && adapters[src.kind], c = store.comments().find(x => x.id === r.commentId);
		if (!src || !adapter || !c) return false;
		// A website has no re-check: its full read carries the owner's replies (adapters/website.ts).
		const rows: RawComment[] = (adapter.recheck ? await adapter.recheck(src, [c]) : await adapter.list(src, undefined)).comments;
		const under = c.thread.startsWith(DM_THREAD) ? (x: RawComment) => x.thread === c.thread && x.at >= c.at : (x: RawComment) => x.parent === (c.parent ?? c.native);
		return rows.some(x => x.mine === true && under(x) && sameWords(x.text, r.text));
	}

	return {
		/** On boot: the replies left sending have no sender in this process. */
		leaveUnsure(): number {
			const stuck = store.replies().filter(r => r.state === "sending");
			for (const r of stuck) {
				const left: Reply = { ...r, state: "unsure", reason: POST_UNKNOWN, code: "interrupted" };
				store.putReply(left);
				onState(left);
			}
			return stuck.length;
		},
		/** Reads every unsure reply back; only proof changes a record. */
		async proveSends(): Promise<{ proved: string[]; errors: string[] }> {
			const proved: string[] = [], errors: string[] = [];
			for (const r of store.replies().filter(x => x.state === "unsure")) {
				try {
					if (!(await shown(r))) continue;
					// The sender of the run before may have ended it during the read.
					if (store.replies().find(x => x.id === r.id)?.state !== "unsure") continue;
					posted(r);
					proved.push(r.id);
				} catch (e) {
					errors.push(`${r.id}: ${e instanceof Error ? e.message.slice(0, 160) : "읽지 못했어요"}`);
				}
			}
			return { proved, errors };
		},
		/** 완료: the owner saw it on the platform (or wants it closed); nothing is posted. */
		markPosted(id: string): { ok: boolean; reason?: string } {
			const r = store.replies().find(x => x.id === id);
			if (r?.state !== "unsure") return { ok: false, reason: "확인이 필요한 답글이 아니에요" };
			posted(r);
			return { ok: true };
		},
	};
}
