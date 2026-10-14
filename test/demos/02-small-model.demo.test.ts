// Demo 2 — Jobs for the small local model (quick). Besides routing, the small model handles cheap,
// high-volume, private work the big models should not be paid for:
//   a) digesting oversized tool output before it enters the main context
//   b) first-pass paper screening (triage) in science mode
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { approxTokens } from "../../src/core/artifacts.ts";
import { Budget } from "../../src/core/budget.ts";
import { digestToolOutput } from "../../src/core/digest.ts";
import { callStructured } from "../../src/core/structured.ts";
import { ScreenSchema } from "../../src/science/types.ts";
import { banner, bench, config, demo, ms, pick } from "./harness.ts";

it("quick: small model digests a huge tool output into what the agent needs", (t) =>
	bench.run("small-model: digest", async (metrics) => {
	const small = await pick(config.context.digestModels);
	if (!small) return t.skip();
	const { llm } = await demo();
	// A realistic oversized result: a long log with one real failure buried in the middle.
	const noise = readFileSync(new URL("../../node_modules/@earendil-works/pi-coding-agent/docs/extensions.md", import.meta.url), "utf8");
	const failure = "\nFAIL src/billing/invoice.test.ts > rounds totals\n  AssertionError: expected 10.005 to equal 10.01\n    at src/billing/invoice.ts:42:17\n";
	const output = noise.slice(0, 9000) + failure + noise.slice(9000);

	const start = Date.now();
	const result = await digestToolOutput(output, { llm, models: [small], tool: "bash", path: ".harness/artifacts/demo/001-tool-bash.txt", previewChars: 2500, maxInputChars: 60_000, timeoutMs: 120_000 });
	banner(`Tool-output digest by ${result.by ?? "fallback preview"} in ${ms(start)}`, [
		`input ~${approxTokens(output)} tokens → context ~${approxTokens(result.text)} tokens`,
		"",
		result.text.split("--- raw head ---")[0].trim(),
	]);
	Object.assign(metrics, { model: result.by ?? "fallback", "tokens in": approxTokens(output), "tokens to context": approxTokens(result.text), "kept the failure": /invoice/i.test(result.text) ? "yes" : "no" });
	expect(result.by).toBe(small);
	expect(result.text).toMatch(/invoice/i);
	expect(approxTokens(result.text)).toBeLessThan(approxTokens(output) / 5);
	}));

const records = [
	["P1", "Aerobic exercise for major depression: a randomized controlled trial", "Adults with major depressive disorder (n=120) were randomized to 12 weeks of supervised aerobic exercise or usual care. Depressive symptoms fell more with exercise (HAM-D −6.1 vs −2.3, p<0.01).", true],
	["P2", "Exercise and depressive symptoms in adolescents: a cluster trial", "School-based exercise for 14–16 year olds (n=800) modestly reduced depressive symptoms.", false],
	["P3", "Mouse models of exercise-induced neurogenesis", "Mice given running wheels showed increased hippocampal neurogenesis; behavioural despair decreased.", false],
	["P4", "Walking versus sertraline in adults with depression: a randomized trial", "Adults with moderate depression (n=200) walked 30 min daily or took sertraline for 16 weeks; remission rates were similar (41% vs 44%).", true],
	["P5", "Yoga for chronic low back pain", "Adults with chronic back pain (n=300) improved function with weekly yoga compared with education.", false],
	["P6", "High-intensity interval training in adults with major depression: a pilot RCT", "Adults with MDD (n=40) randomized to HIIT or stretching; HIIT reduced BDI-II scores by 7 points more.", true],
] as const;

it("quick: small model screens papers against a protocol (science triage)", (t) =>
	bench.run("small-model: screening", async (metrics) => {
	const small = await pick(config.science.screeners.filter((m) => m.startsWith("local/")));
	if (!small) return t.skip();
	const { llm } = await demo();
	const start = Date.now();
	const out = await callStructured(llm, new Budget(Number.POSITIVE_INFINITY), {
		model: small,
		label: "demo:screen",
		system: "You are a careful research methodologist screening records for a systematic review.",
		prompt: `Protocol: adults (18+) with depression; intervention = an exercise program; designs = randomized trials. Exclude animals, children/adolescents, and other conditions.\n\nRecords:\n${records.map(([id, title, abs]) => `[${id}] ${title}\n${abs}`).join("\n\n")}`,
		schema: ScreenSchema,
		toolName: "submit_screening",
		toolDescription: "Submit an include/exclude decision for every record.",
		maxTokens: 1500,
	});
	const rows = records.map(([id, title, , expected]) => {
		const d = out.decisions.find((x) => x.id === id);
		return { ok: d?.include === expected, line: `${d?.include === expected ? "✓" : "✗"} ${id} ${d?.include ? "include" : "exclude"}  ${title} — ${d?.reason ?? "no decision"}` };
	});
	const correct = rows.filter((r) => r.ok).length;
	banner(`Paper screening by ${small} in ${ms(start)} — ${correct}/${records.length} correct`, rows.map((r) => r.line));
	Object.assign(metrics, { model: small, accuracy: `${correct}/${records.length}` });
	expect(correct).toBeGreaterThanOrEqual(5);
	}));
