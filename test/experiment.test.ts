import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendExperiment,
	bootstrapCI,
	compare,
	type ExperimentRecord,
	leaderboard,
	loadExperiments,
	mean,
	pairedPermutationP,
	parseMetrics,
	runSeeds,
	std,
	unpairedPermutationP,
} from "../src/core/experiment.ts";
import { decide } from "../src/core/policy.ts";

const rec = (name: string, values: number[], seeds = values.map((_, i) => i)): ExperimentRecord => ({
	name,
	ts: "2026-10-15T00:00:00Z",
	runs: values.map((acc, i) => ({ seed: seeds[i], metrics: { acc } })),
	verdict: "pending",
});

describe("experiment statistics", () => {
	it("computes mean, sample sd and a bootstrap CI that brackets the mean", () => {
		const xs = [0.8, 0.82, 0.79, 0.81, 0.83];
		expect(mean(xs)).toBeCloseTo(0.81, 10);
		expect(std(xs)).toBeCloseTo(0.015811, 5);
		const [lo, hi] = bootstrapCI(xs);
		expect(lo).toBeLessThan(0.81);
		expect(hi).toBeGreaterThan(0.81);
		expect(bootstrapCI(xs)).toEqual([lo, hi]); // seeded: reproducible
	});

	it("exact paired sign-flip test matches hand-computed values", () => {
		// All 5 differences positive: only the all-plus and all-minus flips are as extreme -> 2/32.
		expect(pairedPermutationP([1, 2, 3, 4, 5])).toBeCloseTo(2 / 32, 10);
		expect(pairedPermutationP([1, -1, 1, -1])).toBe(1);
	});

	it("unpaired permutation test separates clearly different groups", () => {
		expect(unpairedPermutationP([1, 2, 3, 4, 5, 6], [11, 12, 13, 14, 15, 16])).toBeLessThan(0.01);
		expect(unpairedPermutationP([1, 2, 3], [1, 2, 3])).toBeGreaterThan(0.9);
	});

	it("pairs on shared seeds and reports effect direction", () => {
		const a = rec("base", [0.8, 0.81, 0.79, 0.8, 0.82]);
		const b = rec("cand", [0.83, 0.84, 0.82, 0.83, 0.85]);
		const c = compare(a, b, "acc");
		expect(c.paired).toBe(true);
		expect(c.diff).toBeCloseTo(0.03, 10);
		expect(c.p).toBeCloseTo(2 / 32, 10);
		expect(c.ci[0]).toBeGreaterThan(0);
		const unpaired = compare(a, rec("other", [0.9, 0.91, 0.92], [10, 11, 12]), "acc");
		expect(unpaired.paired).toBe(false);
		expect(() => compare(a, b, "f1")).toThrow(/missing/);
	});
});

describe("experiment runs and storage", () => {
	it("parses the last JSON metrics line", () => {
		expect(parseMetrics('epoch 1\n{"acc": 0.9, "name": "x"}\n{"loss": 0.1}\ndone')).toEqual({ loss: 0.1 });
		expect(parseMetrics("no metrics here")).toBeUndefined();
	});

	it("runs a command per seed and records failures", async () => {
		const cmd = `node -e "const s=Number(process.env.SEED); if (s===3) process.exit(1); console.log(JSON.stringify({acc: 0.5 + s/100, seed: {seed}}))"`;
		const runs = await runSeeds(cmd, [1, 2, 3], process.cwd(), 20_000);
		expect(runs[0]).toEqual({ seed: 1, metrics: { acc: 0.51, seed: 1 } });
		expect(runs[1].metrics.seed).toBe(2);
		expect(runs[2].error).toBeTruthy();
	});

	it("keeps the latest record per name and renders a sorted leaderboard", () => {
		const path = join(mkdtempSync(join(tmpdir(), "npi-exp-")), ".npi", "experiments.jsonl");
		appendExperiment(path, rec("base", [0.8, 0.81]));
		appendExperiment(path, rec("cand", [0.9, 0.91]));
		appendExperiment(path, { ...rec("base", [0.8, 0.81]), verdict: "rejected" });
		const all = loadExperiments(path);
		expect(all.get("base")?.verdict).toBe("rejected");
		const board = leaderboard([...all.values()], "acc").split("\n");
		expect(board[2]).toMatch(/^cand \| 2 /);
		expect(board[3]).toMatch(/^base .* rejected/);
	});

	it("guards `experiment run` like a shell command", () => {
		const guard = { protectedPaths: [".env"], askCommands: ["\\brm\\b"], readonlyCommands: ["^ls\\b"], readonlyTools: ["experiment"], askTools: [], sandboxImage: "x", sandboxNetwork: "none" };
		const env = { cwd: "/p", home: "/h", sandboxed: false };
		expect(decide("readonly", { tool: "experiment", input: { action: "run", command: "python train.py" } }, guard, env).action).toBe("deny");
		expect(decide("readonly", { tool: "experiment", input: { action: "list" } }, guard, env).action).toBe("allow");
		expect(decide("ask", { tool: "experiment", input: { action: "run", command: "rm -rf data" } }, guard, env).action).toBe("ask");
		expect(decide("auto", { tool: "experiment", input: { action: "run", command: "python t.py" } }, guard, { ...env, sandboxed: true }).action).toBe("ask");
	});
});
