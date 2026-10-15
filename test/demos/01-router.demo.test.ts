// Demo 1 — Routing (quick). Shows how each prompt picks a mode: keywords first, then the small local
// model as classifier for everything else. The classifier is the small model's main job: it runs on every
// unmatched prompt, so it must be fast, free and private.
import { expect, it } from "vitest";
import { decideRoute, llmClassifier, matchKeywords } from "../../src/core/router.ts";
import { banner, bench, config, demo, ms, pick } from "./common.ts";

const prompts: [string, string][] = [
	["fix the failing test in parser.test.ts", "code"],
	["open https://example.com and take a screenshot", "browse"],
	["what do studies show about creatine and cognition", "science"],
	["brainstorm names for a home-automation startup", "brainstorm"],
	["how tall is Mount Olympus in metres", "chat|research"],
	["write a short poem about autumn rain", "chat"],
	["is the new USB4 v2 spec actually shipping in laptops yet", "research"],
	["help me think through how to structure the payments module before we write any code", "plan"],
];

it("quick: routes prompts by keyword, then with the small local classifier", () =>
	bench.run("router", async (metrics) => {
	const { llm } = await demo();
	const small = await pick(config.router.classifierModels);
	const classify = small ? llmClassifier(llm, { ...config, router: { ...config.router, classifierModels: [small], classifierTimeoutMs: 60_000 } }) : undefined;
	if (small) await classify!("warm up"); // local servers load models on first use

	const rows: string[] = [];
	const classifyMs: number[] = [];
	let correct = 0;
	let classified = 0;
	for (const [prompt, expected] of prompts) {
		const start = Date.now();
		const d = await decideRoute({ text: prompt, config, classify });
		if (d.reason === "classifier") {
			classified++;
			classifyMs.push(Date.now() - start);
		}
		if (expected.split("|").includes(d.route)) correct++;
		rows.push(`${expected.split("|").includes(d.route) ? "✓" : "✗"} ${d.route.padEnd(10)} ${d.reason.padEnd(10)} ${(d.confidence?.toFixed(2) ?? "").padEnd(5)} ${ms(start).padStart(6)}  ${prompt}`);
	}
	banner(`Routing — classifier: ${small ?? "none available (keywords + default only)"}`, [
		"  route      reason     conf    time  prompt",
		...rows,
		`\n${correct}/${prompts.length} routed as expected; ${classified} decided by the classifier`,
	]);
	classifyMs.sort((a, b) => a - b);
	Object.assign(metrics, { accuracy: `${correct}/${prompts.length}`, classified, classifier: small ?? "none", "median classify s": ((classifyMs[Math.floor(classifyMs.length / 2)] ?? 0) / 1000).toFixed(2) });
	for (const [prompt, expected] of prompts) if (matchKeywords(prompt, config.routes)) expect(expected.split("|")).toContain(matchKeywords(prompt, config.routes));
	if (small) expect(classified).toBeGreaterThan(0);
	}));
