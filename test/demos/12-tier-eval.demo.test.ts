// Demo 12 — Decision-model eval (quick). Rates the effort tier (light / standard / heavy) of the labelled
// prompts in test/evals/tier-cases.json with each candidate decision model, and reports tier accuracy,
// light↔heavy confusions (the costly mistakes) and latency. Use it to pick `router.classifierModels` or a
// `router.classifierEndpoint` on your own hardware:
//   NPI_EVAL_CLASSIFIER_MODEL=lmstudio/qwen/qwen3.5-9b,ollama/qwen3:1.7b  (comma list; default local/small, local/large)
//   NPI_EVAL_CLASSIFIER_ENDPOINT=http://localhost:8090/route             (encoder router behind HTTP)
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { type Classifier, httpClassifier, llmClassifier } from "../../src/core/router.ts";
import { banner, bench, config, demo } from "./common.ts";

const cases: { prompt: string; tier: "light" | "standard" | "heavy" }[] = JSON.parse(readFileSync(new URL("../evals/tier-cases.json", import.meta.url), "utf8"));
const ORDER = ["light", "standard", "heavy"];

const candidates: { name: string; make: () => Promise<Classifier | undefined> }[] = [
	...(process.env.NPI_EVAL_CLASSIFIER_MODEL?.split(",") ?? ["local/small", "local/large"]).map((model) => ({
		name: model,
		make: async () => {
			const { llm } = await demo();
			if (!(await llm.available(model))) return undefined;
			return llmClassifier(llm, { ...config, router: { ...config.router, classifierModels: [model], classifierTimeoutMs: 120_000 } });
		},
	})),
	...(process.env.NPI_EVAL_CLASSIFIER_ENDPOINT
		? [{ name: process.env.NPI_EVAL_CLASSIFIER_ENDPOINT, make: async () => httpClassifier(process.env.NPI_EVAL_CLASSIFIER_ENDPOINT as string, config) }]
		: []),
];

for (const candidate of candidates) {
	it(`quick: tier eval with ${candidate.name}`, (t) =>
		bench.run(`tier eval: ${candidate.name}`, async (metrics) => {
			const classify = await candidate.make();
			if (!classify) return t.skip();
			await classify("warm up the model please");
			let correct = 0;
			let severe = 0;
			let none = 0;
			const times: number[] = [];
			const confusion = new Map<string, number>();
			const misses: string[] = [];
			for (const c of cases) {
				const start = Date.now();
				const r = await classify(c.prompt);
				times.push(Date.now() - start);
				const got = r?.tier;
				if (!got) none++;
				confusion.set(`${c.tier}→${got ?? "none"}`, (confusion.get(`${c.tier}→${got ?? "none"}`) ?? 0) + 1);
				if (got === c.tier) correct++;
				else misses.push(`${c.tier} → ${got ?? "none"}: ${c.prompt}`);
				if (got && Math.abs(ORDER.indexOf(got) - ORDER.indexOf(c.tier)) === 2) severe++;
			}
			times.sort((a, b) => a - b);
			const p50 = (times[times.length >> 1] ?? 0) / 1000;
			const p90 = (times[Math.floor(times.length * 0.9)] ?? 0) / 1000;
			Object.assign(metrics, {
				"tier accuracy": `${correct}/${cases.length}`,
				"light↔heavy": severe,
				"no answer": none,
				"p50 s": p50.toFixed(2),
				"p90 s": p90.toFixed(2),
			});
			banner(`Tier eval with ${candidate.name}: ${correct}/${cases.length} correct, ${severe} light↔heavy, ${none} no answer, p50 ${p50.toFixed(2)}s p90 ${p90.toFixed(2)}s`, [
				`Confusion: ${[...confusion].sort().map(([k, v]) => `${k} ${v}`).join(" · ")}`,
				...(misses.length ? ["Misses:", ...misses] : ["No misses."]),
			]);
		}));
}
