/** Map over items with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return results;
}

/** Reject with a timeout error if `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			onTimeout?.();
			reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
		}, ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
