import type { Usage } from "@earendil-works/pi-ai";

export class BudgetExceededError extends Error {
	constructor(
		readonly spentUSD: number,
		readonly limitUSD: number,
	) {
		super(`Budget exceeded: $${spentUSD.toFixed(3)} of $${limitUSD.toFixed(2)}`);
	}
}

export interface BudgetEntry {
	label: string;
	model: string;
	costUSD: number;
	input: number;
	output: number;
}

/** Tracks spend across many model calls and refuses new calls once the cap is reached. */
export class Budget {
	readonly entries: BudgetEntry[] = [];
	private listeners = new Set<() => void>();

	constructor(readonly limitUSD: number) {}

	get spentUSD(): number {
		return this.entries.reduce((sum, e) => sum + e.costUSD, 0);
	}

	get exceeded(): boolean {
		return this.spentUSD >= this.limitUSD;
	}

	/** Throw before starting a call if the cap has already been reached. */
	assertAvailable(): void {
		if (this.exceeded) throw new BudgetExceededError(this.spentUSD, this.limitUSD);
	}

	add(label: string, model: string, usage: (Pick<Usage, "input" | "output"> & { cost?: { total: number } }) | undefined): void {
		if (!usage) return;
		this.entries.push({ label, model, costUSD: usage.cost?.total ?? 0, input: usage.input, output: usage.output });
		for (const listener of this.listeners) listener();
	}

	/** A view that never refuses calls but still records spend here (for must-finish steps). */
	uncapped(): Budget {
		const view = new Budget(Number.POSITIVE_INFINITY);
		view.add = (label, model, usage) => this.add(label, model, usage);
		return view;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
