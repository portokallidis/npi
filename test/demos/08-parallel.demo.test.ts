// Demo 8 — Parallel subagents across two machines (quick-ish). `delegate` in parallel mode runs one scout
// on each local device at the same time; the wall time is compared with the sum of both runs.
import { expect, it } from "vitest";
import { runDelegate } from "../../src/core/delegate.ts";
import { agents, banner, bench, demo, makeRunner, ms, recordAgent } from "./common.ts";

it("quick: two scouts in parallel on two devices", (t) =>
	bench.run("parallel subagents", async (metrics) => {
		const { llm } = await demo();
		const models = ["local/small", "local/large"];
		for (const m of models) if (!(await llm.available(m))) return t.skip();
		const runner = await makeRunner();
		const timed = {
			async run(req: Parameters<typeof runner.run>[0]) {
				const start = Date.now();
				const r = await runner.run(req);
				await recordAgent(`scout (${req.model})`, r, Date.now() - start);
				return { ...r, elapsed: Date.now() - start };
			},
		};
		const start = Date.now();
		const results = (await runDelegate(
			{
				tasks: [
					{ agent: "scout", model: models[0], task: "In this repository, which file decides the routing precedence (pinned, prefix, keyword, classifier, sticky, default)? Answer with the file path and function name." },
					{ agent: "scout", model: models[1], task: "In this repository, which file implements de-duplication of scientific papers, and what keys does it de-duplicate by? Answer with the file path and function name." },
				],
			},
			{ agents: await agents(), runner: timed, maxConcurrency: 2, maxParallelTasks: 8, policy: { level: "readonly", sandboxed: false } },
		)) as Awaited<ReturnType<typeof timed.run>>[];
		const wall = Date.now() - start;
		const sum = results.reduce((s, r) => s + r.elapsed, 0);
		Object.assign(metrics, {
			"wall s": (wall / 1000).toFixed(1),
			"sum of runs s": (sum / 1000).toFixed(1),
			speedup: `${(sum / wall).toFixed(2)}x`,
			"found router.ts": /router\.ts/.test(results[0].text) ? "yes" : "no",
			"found papers.ts": /papers\.ts/.test(results[1].text) ? "yes" : "no",
		});
		banner(`Parallel scouts in ${ms(start)} (sum of runs ${(sum / 1000).toFixed(1)}s → ${(sum / wall).toFixed(2)}x)`, results.flatMap((r) => [`— ${r.model} (${(r.elapsed / 1000).toFixed(1)}s, ${r.usage.turns} turns)`, r.text, ""]));
		expect(results.every((r) => !r.error)).toBe(true);
		expect(sum / wall).toBeGreaterThan(1.2);
	}));
