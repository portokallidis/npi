import { exec } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Experiment log: seed-locked runs with metrics, provenance (git HEAD + exact working-tree snapshot + session
 * entry) and a verdict, appended to `.npi/experiments.jsonl`. Statistics are dependency-free and use a seeded
 * RNG, so the same data always yields the same intervals and p-values.
 */
export type Verdict = "pending" | "accepted" | "rejected" | "inconclusive";

export interface SeedRun {
	seed: number;
	metrics: Record<string, number>;
	error?: string;
}

export interface ExperimentRecord {
	name: string;
	ts: string;
	hypothesis?: string;
	command?: string;
	runs: SeedRun[];
	verdict: Verdict;
	reason?: string;
	git?: { head?: string; tree?: string };
	sessionEntry?: string;
	model?: string;
}

// ---- statistics ----------------------------------------------------------------------------------

/** mulberry32: tiny deterministic PRNG for reproducible resampling. */
export function rng(seed = 42): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Sample standard deviation (n-1); 0 for fewer than two values. */
export function std(xs: readonly number[]): number {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function quantile(sorted: readonly number[], q: number): number {
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Percentile bootstrap CI of the mean. */
export function bootstrapCI(xs: readonly number[], { iters = 4000, level = 0.95, seed = 42 } = {}): [number, number] {
	if (xs.length < 2) return [xs[0] ?? Number.NaN, xs[0] ?? Number.NaN];
	const r = rng(seed);
	const means: number[] = [];
	for (let i = 0; i < iters; i++) {
		let s = 0;
		for (let j = 0; j < xs.length; j++) s += xs[Math.floor(r() * xs.length)];
		means.push(s / xs.length);
	}
	means.sort((a, b) => a - b);
	const alpha = (1 - level) / 2;
	return [quantile(means, alpha), quantile(means, 1 - alpha)];
}

/** Two-sided sign-flip permutation test on paired differences (exact up to 2^16 flips). */
export function pairedPermutationP(diffs: readonly number[], { iters = 20000, seed = 42 } = {}): number {
	const n = diffs.length;
	if (!n) return 1;
	const observed = Math.abs(mean(diffs));
	const eps = 1e-12;
	if (n <= 16) {
		let extreme = 0;
		const total = 2 ** n;
		for (let mask = 0; mask < total; mask++) {
			let s = 0;
			for (let i = 0; i < n; i++) s += mask & (1 << i) ? -diffs[i] : diffs[i];
			if (Math.abs(s / n) >= observed - eps) extreme++;
		}
		return extreme / total;
	}
	const r = rng(seed);
	let extreme = 0;
	for (let k = 0; k < iters; k++) {
		let s = 0;
		for (const d of diffs) s += r() < 0.5 ? -d : d;
		if (Math.abs(s / n) >= observed - eps) extreme++;
	}
	return (extreme + 1) / (iters + 1);
}

/** Two-sided permutation test on the difference of means of two independent samples. */
export function unpairedPermutationP(a: readonly number[], b: readonly number[], { iters = 20000, seed = 42 } = {}): number {
	if (!a.length || !b.length) return 1;
	const all = [...a, ...b];
	const observed = Math.abs(mean(a) - mean(b));
	const r = rng(seed);
	let extreme = 0;
	for (let k = 0; k < iters; k++) {
		for (let i = all.length - 1; i > 0; i--) {
			const j = Math.floor(r() * (i + 1));
			[all[i], all[j]] = [all[j], all[i]];
		}
		const diff = Math.abs(mean(all.slice(0, a.length)) - mean(all.slice(a.length)));
		if (diff >= observed - 1e-12) extreme++;
	}
	return (extreme + 1) / (iters + 1);
}

export interface Comparison {
	metric: string;
	paired: boolean;
	n: [number, number];
	meanA: number;
	meanB: number;
	/** mean(B) - mean(A) (paired: mean of per-seed differences). */
	diff: number;
	ci: [number, number];
	p: number;
	/** Cohen's d (paired: d_z on the differences). */
	effect: number;
}

/** Compare metric `metric` of B against A; paired on shared seeds when every seed of A has a match in B. */
export function compare(a: ExperimentRecord, b: ExperimentRecord, metric: string): Comparison {
	const values = (rec: ExperimentRecord) => rec.runs.filter((r) => Number.isFinite(r.metrics[metric]));
	const ra = values(a);
	const rb = values(b);
	if (!ra.length || !rb.length) throw new Error(`Metric "${metric}" missing in ${!ra.length ? a.name : b.name}`);
	const bySeed = new Map(rb.map((r) => [r.seed, r.metrics[metric]]));
	const paired = ra.length >= 2 && ra.every((r) => bySeed.has(r.seed));
	const xa = ra.map((r) => r.metrics[metric]);
	const xb = rb.map((r) => r.metrics[metric]);
	if (paired) {
		const diffs = ra.map((r) => (bySeed.get(r.seed) as number) - r.metrics[metric]);
		const sd = std(diffs);
		return {
			metric,
			paired,
			n: [xa.length, diffs.length],
			meanA: mean(xa),
			meanB: mean(diffs.map((d, i) => d + xa[i])),
			diff: mean(diffs),
			ci: bootstrapCI(diffs),
			p: pairedPermutationP(diffs),
			effect: sd ? mean(diffs) / sd : 0,
		};
	}
	const pooled = Math.sqrt(((xa.length - 1) * std(xa) ** 2 + (xb.length - 1) * std(xb) ** 2) / Math.max(1, xa.length + xb.length - 2));
	const r = rng(7);
	const diffs: number[] = [];
	for (let i = 0; i < 4000; i++) {
		const sa = xa.map(() => xa[Math.floor(r() * xa.length)]);
		const sb = xb.map(() => xb[Math.floor(r() * xb.length)]);
		diffs.push(mean(sb) - mean(sa));
	}
	diffs.sort((x, y) => x - y);
	return {
		metric,
		paired,
		n: [xa.length, xb.length],
		meanA: mean(xa),
		meanB: mean(xb),
		diff: mean(xb) - mean(xa),
		ci: [quantile(diffs, 0.025), quantile(diffs, 0.975)],
		p: unpairedPermutationP(xa, xb),
		effect: pooled ? (mean(xb) - mean(xa)) / pooled : 0,
	};
}

// ---- running and parsing -------------------------------------------------------------------------

/** Metrics from a run's stdout: the last line that is a JSON object with at least one numeric value. */
export function parseMetrics(stdout: string): Record<string, number> | undefined {
	const lines = stdout.trim().split(/\r?\n/).reverse();
	for (const line of lines) {
		const t = line.trim();
		if (!t.startsWith("{")) continue;
		try {
			const obj = JSON.parse(t) as Record<string, unknown>;
			const nums = Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
			if (Object.keys(nums).length) return nums;
		} catch {
			// not JSON; keep looking
		}
	}
	return undefined;
}

/** Run `command` once per seed (`{seed}` placeholder and SEED env var), sequentially for fair timing. */
export async function runSeeds(command: string, seeds: readonly number[], cwd: string, timeoutMs: number): Promise<SeedRun[]> {
	const runs: SeedRun[] = [];
	for (const seed of seeds) {
		const cmd = command.replaceAll("{seed}", String(seed));
		const result = await new Promise<SeedRun>((resolve) => {
			exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, SEED: String(seed) } }, (error, stdout, stderr) => {
				const metrics = parseMetrics(stdout);
				if (metrics && !error) return resolve({ seed, metrics });
				const why = error ? `${error.message.split("\n")[0]}${stderr ? `: ${stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}` : "no JSON metrics line on stdout";
				resolve({ seed, metrics: metrics ?? {}, error: why.slice(0, 400) });
			});
		});
		runs.push(result);
	}
	return runs;
}

// ---- storage and reporting -----------------------------------------------------------------------

export function appendExperiment(path: string, record: ExperimentRecord): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/** Latest record per name (later lines update earlier ones, e.g. a verdict). */
export function loadExperiments(path: string): Map<string, ExperimentRecord> {
	const out = new Map<string, ExperimentRecord>();
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as ExperimentRecord;
			out.delete(rec.name);
			out.set(rec.name, rec);
		} catch {
			// skip corrupt line
		}
	}
	return out;
}

const fmt = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 1000 || (Math.abs(x) < 0.001 && x !== 0) ? x.toExponential(2) : x.toFixed(4).replace(/\.?0+$/, "")) : "—");

/** One line per metric: mean ± sd [95% CI] (n). */
export function summarizeRuns(runs: readonly SeedRun[]): string[] {
	const ok = runs.filter((r) => !r.error);
	const metrics = [...new Set(ok.flatMap((r) => Object.keys(r.metrics)))];
	return metrics.map((m) => {
		const xs = ok.map((r) => r.metrics[m]).filter(Number.isFinite);
		const [lo, hi] = bootstrapCI(xs);
		return `${m}: ${fmt(mean(xs))} ± ${fmt(std(xs))} [95% CI ${fmt(lo)}, ${fmt(hi)}] (n=${xs.length})`;
	});
}

export function formatComparison(c: Comparison, a: string, b: string): string {
	return [
		`${c.metric}: ${b} vs ${a} (${c.paired ? `paired on ${c.n[1]} seeds` : `unpaired, n=${c.n[0]}/${c.n[1]}`})`,
		`  mean ${fmt(c.meanA)} → ${fmt(c.meanB)}, Δ ${fmt(c.diff)} [95% CI ${fmt(c.ci[0])}, ${fmt(c.ci[1])}]`,
		`  permutation p = ${fmt(c.p)}, effect size d = ${fmt(c.effect)}${c.n[0] < 5 ? "  (few seeds: treat as exploratory)" : ""}`,
	].join("\n");
}

/** Leaderboard sorted by `metric` (default: first metric of the newest record). */
export function leaderboard(records: readonly ExperimentRecord[], metric?: string, higherIsBetter = true): string {
	if (!records.length) return "No experiments yet.";
	const m = metric ?? Object.keys(records.at(-1)?.runs.find((r) => !r.error)?.metrics ?? {})[0];
	const rows = records.map((rec) => {
		const xs = rec.runs.filter((r) => !r.error && m && Number.isFinite(r.metrics[m])).map((r) => r.metrics[m as string]);
		return { rec, xs, mean: xs.length ? mean(xs) : Number.NaN };
	});
	rows.sort((x, y) => (Number.isNaN(x.mean) ? 1 : Number.isNaN(y.mean) ? -1 : higherIsBetter ? y.mean - x.mean : x.mean - y.mean));
	const lines = [`metric: ${m ?? "—"} (${higherIsBetter ? "higher" : "lower"} is better)`, "name | n | mean ± sd | 95% CI | verdict | git"];
	for (const { rec, xs, mean: mu } of rows) {
		const [lo, hi] = xs.length ? bootstrapCI(xs) : [Number.NaN, Number.NaN];
		lines.push(`${rec.name} | ${xs.length} | ${fmt(mu)} ± ${fmt(std(xs))} | ${fmt(lo)}..${fmt(hi)} | ${rec.verdict} | ${rec.git?.head?.slice(0, 7) ?? "—"}`);
	}
	return lines.join("\n");
}
