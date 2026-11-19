import type { ListedChoice } from "./notices.ts";

type Asked = { key: string; refs: string[]; listed: ListedChoice[] };
type Deps = {
	untouched: (listed: readonly ListedChoice[]) => ListedChoice[];
	waiting: (key: string, target: string) => string[];
	followUp: (key: string, target: string, titles: string[]) => void;
	log: (message: string) => void;
};

/**
 * The owner's message that went in with its conversation's open choice questions (hub/intake.ts openQuestionLines), once its turn ended with every
 * one of them untouched, gets one follow-up turn asking whether it answered them; only that turn's <resolves> lines close anything.
 */
export function createAskFollowup(deps: Deps) {
	const pending = new Map<string, Asked>();
	return {
		asked(target: string, a: Asked): void {
			const waiting = deps.waiting(a.key, target);
			if (a.listed.length && a.refs.some(r => waiting.includes(r))) pending.set(target, a);
		},
		forget(target: string): void {
			pending.delete(target);
		},
		turnEnded(key: string): void {
			for (const [target, a] of pending) {
				if (a.key !== key) continue;
				const waiting = deps.waiting(key, target);
				if (a.refs.some(r => waiting.includes(r))) continue;
				pending.delete(target);
				const open = deps.untouched(a.listed);
				if (open.length < a.listed.length) continue;
				deps.log(`turn of ${key} closed none of the ${open.length} open question(s) its message in ${target} went in with; asking once`);
				deps.followUp(key, target, open.map(q => q.title));
			}
		},
	};
}
