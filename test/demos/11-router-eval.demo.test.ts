// Demo 11 — Router evaluation (quick). The full labelled set in test/evals/router-cases.json, routed end to
// end (keywords, then each local model as the classifier). Shows which model makes the better router and
// what it costs in latency.
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { decideRoute, llmClassifier } from "../../src/core/router.ts";
import { banner, bench, config, demo } from "./common.ts";

const cases: { prompt: string; route: string | null }[] = JSON.parse(readFileSync(new URL("../evals/router-cases.json", import.meta.url), "utf8"));

for (const model of ["local/small", "local/large"]) {
	it(`quick: router eval with ${model}`, (t) =>
		bench.run(`router eval: ${model}`, async (metrics) => {
			const { llm } = await demo();
			if (!(await llm.available(model))) return t.skip();
			const classify = llmClassifier(llm, { ...config, router: { ...config.router, classifierModels: [model], classifierTimeoutMs: 120_000 } });
			await classify("warm up");
			let correct = 0;
			let byClassifier = 0;
			let classifierCorrect = 0;
			const times: number[] = [];
			const misses: string[] = [];
			for (const c of cases) {
				const start = Date.now();
				const d = await decideRoute({ text: c.prompt, config, classify });
				const expected = c.route ?? "chat";
				const ok = d.route === expected || (c.route === null && ["chat", "research"].includes(d.route));
				if (ok) correct++;
				else misses.push(`${c.prompt} → ${d.route} (${d.reason}), expected ${expected}`);
				if (d.reason === "classifier") {
					byClassifier++;
					times.push(Date.now() - start);
					if (ok) classifierCorrect++;
				}
			}
			times.sort((a, b) => a - b);
			const median = (times[Math.floor(times.length / 2)] ?? 0) / 1000;
			Object.assign(metrics, {
				accuracy: `${correct}/${cases.length}`,
				"classifier accuracy": `${classifierCorrect}/${byClassifier}`,
				"median classify s": median.toFixed(2),
			});
			banner(`Router eval with ${model}: ${correct}/${cases.length} overall, classifier ${classifierCorrect}/${byClassifier}, median ${median.toFixed(2)}s`, misses.length ? ["Misses:", ...misses] : ["No misses."]);
		}));
}
