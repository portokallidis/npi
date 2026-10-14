import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable multi-stage runs: each named step's JSON result is saved as soon as it finishes, so a run
 * that crashed, was aborted or hit its budget resumes from the last finished step instead of re-paying
 * for everything. Steps must be deterministic in name (e.g. "resolve:d3").
 */
export class RunState {
	private data: { meta: Record<string, unknown>; steps: Record<string, unknown> };

	constructor(
		readonly file: string,
		meta: Record<string, unknown> = {},
	) {
		this.data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { meta, steps: {} };
		if (!existsSync(file)) this.save();
	}

	get meta(): Record<string, unknown> {
		return this.data.meta;
	}

	has(name: string): boolean {
		return name in this.data.steps;
	}

	async step<T>(name: string, run: () => Promise<T>): Promise<T> {
		if (this.has(name)) return this.data.steps[name] as T;
		const value = await run();
		this.data.steps[name] = value;
		this.save();
		return value;
	}

	private save(): void {
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(this.file, JSON.stringify(this.data, null, 2));
	}
}
