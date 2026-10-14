// Demo 5 — Brainstorm panel (slow: several minutes on local models). Different models propose pathways,
// disagreements are settled, and the orchestrator ranks them (and recommends one if the goal is clear).
import { expect, it } from "vitest";
import { runBrainstorm } from "../../src/brainstorm/pipeline.ts";
import { renderReport, saveReport } from "../../src/brainstorm/report.ts";
import { banner, bench, config, demo, ms } from "./harness.ts";

it("brainstorm: backup strategy for a small home lab", (t) =>
	bench.run("brainstorm", async (metrics) => {
	const { llm, artifacts } = await demo();
	const panel = [];
	for (const p of config.brainstorm.panel) if (await llm.available(p.model)) panel.push(p);
	if (panel.length < 2) return t.skip();
	const small = {
		...config.brainstorm,
		panel,
		maxDirectionQuestions: 0,
		maxPathwaysPerPanelist: 3,
		maxDisputes: 2,
		crossExamRounds: 1,
		callTimeoutMs: 15 * 60_000,
		maxCostUSD: 1,
	};
	const start = Date.now();
	const report = await runBrainstorm(
		"I run a small home lab (one NAS with 4 TB of family photos and documents, two Linux servers). Goal: never lose the photos, budget under $10/month, minimal maintenance. How should I back it up?",
		small,
		{ llm, artifacts, onEvent: (e) => e.type === "phase" && console.log(`  [${ms(start)}] ${e.text}`) },
	);
	const path = saveReport(report, process.cwd(), ".harness/brainstorms");
	banner(`Brainstorm with ${panel.map((p) => `${p.id}=${p.model}`).join(", ")} in ${ms(start)}`, [renderReport(report).split("## Where the panel agreed")[0], `Full report: ${path}`]);
	Object.assign(metrics, { panel: panel.map((p) => p.id).join("+"), orchestrator: report.orchestrator, pathways: report.map.pathways.length, disputes: report.map.disputes.length, resolved: report.resolutions.length, recommended: report.recommended ? "yes" : "no" });
	expect(report.map.pathways.length).toBeGreaterThanOrEqual(2);
	expect(report.convergence.ranking.length).toBeGreaterThan(0);
	}));
