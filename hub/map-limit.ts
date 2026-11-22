/** Runs `fn` over `items` with at most `limit` calls in flight; the results come back in the order of `items`. After a rejection no further item is started, and the first rejection is thrown once the calls already in flight have settled. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failed: { error: unknown } | undefined;
	const worker = async (): Promise<void> => {
		while (!failed && next < items.length) {
			const at = next++;
			try {
				results[at] = await fn(items[at]!, at);
			} catch (error) {
				failed ??= { error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	if (failed) throw failed.error;
	return results;
}
