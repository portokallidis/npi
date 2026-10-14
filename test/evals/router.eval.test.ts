// Router evals. Offline (always): keyword routing precision on a labelled set — a keyword hit must be the
// right mode, and prompts labelled null must fall through to the classifier/default.
// Live (HARNESS_LIVE_EVAL=1 + HARNESS_AGENT_DIR): the real LLM classifier on the fall-through prompts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/core/config.ts";
import { matchKeywords } from "../../src/core/router.ts";

const config: HarnessConfig = JSON.parse(readFileSync(new URL("../../config/harness.json", import.meta.url), "utf8"));
const cases: { prompt: string; route: string | null }[] = JSON.parse(readFileSync(new URL("./router-cases.json", import.meta.url), "utf8"));

describe("router eval (keywords)", () => {
	it("keyword hits are correct and coverage is reported", () => {
		const wrong: string[] = [];
		let hits = 0;
		for (const c of cases) {
			const got = matchKeywords(c.prompt, config.routes);
			if (got) hits++;
			if (got !== (c.route ?? undefined) && !(got === undefined && c.route)) wrong.push(`${c.prompt} → ${got} (expected ${c.route})`);
		}
		const labelled = cases.filter((c) => c.route).length;
		console.log(`keyword coverage ${hits}/${labelled} labelled prompts; misroutes: ${wrong.length}`);
		expect(wrong).toEqual([]);
		expect(hits / labelled).toBeGreaterThanOrEqual(0.7);
	});
});

describe.skipIf(!process.env.HARNESS_LIVE_EVAL)("router eval (live classifier)", () => {
	it("classifies the fall-through prompts", async () => {
		const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
		const { registryLlm } = await import("../../src/core/llm.ts");
		const { llmClassifier } = await import("../../src/core/router.ts");
		const runtime = await ModelRuntime.create();
		const classify = llmClassifier(registryLlm(new ModelRegistry(runtime)), { ...config, router: { ...config.router, classifierTimeoutMs: 60_000 } });
		let correct = 0;
		const misses = cases.filter((c) => c.route && !matchKeywords(c.prompt, config.routes));
		for (const c of misses) {
			const r = await classify(c.prompt);
			if (r?.route === c.route) correct++;
			console.log(`${r?.route ?? "none"} (${r?.confidence ?? "-"}) ← ${c.prompt} [expected ${c.route}]`);
		}
		console.log(`classifier accuracy on keyword misses: ${correct}/${misses.length}`);
	}, 600_000);
});
