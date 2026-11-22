import type { Store } from "./store.ts";

/** Failed draft attempts after which a queued comment is dropped and its reason reported. */
export const MAX_AUTO_TRIES = 3;

/** Takes `id` off the queue of source `key` and forgets its tries. */
export function leaveQueue(store: Store, key: string, id: string): void {
	const { queue, tries, ...rest } = store.cursors()[key] ?? {};
	const left = (queue ?? []).filter(x => x !== id);
	const { [id]: _gone, ...kept } = tries ?? {};
	store.setCursor(key, { ...rest, ...(left.length ? { queue: left } : {}), ...(Object.keys(kept).length ? { tries: kept } : {}) });
}

/** Counts a transient failure of `id`; at MAX_AUTO_TRIES the comment leaves the queue and the reason is added to `errors[key]`. */
export function failAuto(store: Store, key: string, id: string, reason: string, errors: Record<string, string>): void {
	const cur = store.cursors()[key] ?? {};
	const n = (cur.tries?.[id] ?? 0) + 1;
	if (n < MAX_AUTO_TRIES) {
		store.setCursor(key, { ...cur, tries: { ...cur.tries, [id]: n } });
		return;
	}
	leaveQueue(store, key, id);
	const line = `댓글 ${id}의 초안을 ${MAX_AUTO_TRIES}번 만들지 못해 건너뛰어요: ${reason}`;
	errors[key] = errors[key] ? `${errors[key]}; ${line}` : line;
}
