import type { ListedChoice } from "./notices.ts";
import type { OwnerSaid } from "./notices-types.ts";

type Asked = { key: string; refs: string[]; listed: ListedChoice[]; said?: OwnerSaid };
type Following = Asked & { prompt: string };
type Deps = {
	untouched: (listed: readonly ListedChoice[]) => ListedChoice[];
	waiting: (key: string, target: string) => string[];
	followUp: (key: string, target: string, titles: string[]) => string;
	judging: (listed: readonly ListedChoice[], said: OwnerSaid) => void;
	keptOpen: (listed: readonly ListedChoice[], at: string) => void;
	log: (message: string) => void;
};

/**
 * The owner's message that went in with its conversation's open choice questions (hub/intake.ts openQuestionLines), once its turn ended with every
 * one of them untouched, gets one follow-up turn asking whether it answered them; only that turn's <resolves> lines close anything. The cards show
 * the message as being judged until then; what the turn (or its follow-up) left open is marked kept open.
 */
export function createAskFollowup(deps: Deps) {
	const pending = new Map<string, Asked>();
	const following = new Map<string, Following>();
	const settle = (a: Asked): void => {
		if (a.said) deps.keptOpen(deps.untouched(a.listed), a.said.ts);
	};
	return {
		asked(target: string, a: Asked): void {
			const waiting = deps.waiting(a.key, target);
			if (!a.listed.length || !a.refs.some(r => waiting.includes(r))) return;
			pending.set(target, a);
			if (a.said) deps.judging(a.listed, a.said);
		},
		forget(target: string): void {
			const a = pending.get(target) ?? following.get(target);
			pending.delete(target);
			following.delete(target);
			if (a) settle(a);
		},
		turnEnded(key: string, prompt?: string): void {
			for (const [target, a] of following) {
				if (a.key !== key || !prompt?.includes(a.prompt)) continue;
				following.delete(target);
				settle(a);
			}
			for (const [target, a] of pending) {
				if (a.key !== key) continue;
				const waiting = deps.waiting(key, target);
				if (a.refs.some(r => waiting.includes(r))) continue;
				pending.delete(target);
				const open = deps.untouched(a.listed);
				if (open.length < a.listed.length) {
					settle(a);
					continue;
				}
				deps.log(`turn of ${key} closed none of the ${open.length} open question(s) its message in ${target} went in with; asking once`);
				following.set(target, { ...a, prompt: deps.followUp(key, target, open.map(q => q.title)) });
			}
		},
	};
}
