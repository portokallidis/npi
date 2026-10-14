// Demo 6 — Literature review (slow). Real searches on OpenAlex/PubMed/arXiv, two-model screening,
// extraction with verified quotes, GRADE certainty and sentence-level citation checks.
import { expect, it } from "vitest";
import { runScience } from "../../src/science/pipeline.ts";
import { renderScienceDigest, saveScience } from "../../src/science/report.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { RunState } from "../../src/core/runstate.ts";
import { banner, bench, config, demo, ms } from "./harness.ts";

const stateFile = join(process.cwd(), ".harness", "demo-state", "science.json");

it("science: creatine supplementation and memory in healthy adults", () =>
	bench.run("science", async (metrics) => {
	const { llm } = await demo();
	const small = { ...config.science, sources: ["openalex", "pubmed"] as const, askUser: false, maxQueries: 2, perQuery: 8, maxCandidates: 12, maxIncluded: 4, maxCostUSD: 1 };
	const start = Date.now();
	const report = await runScience("Does creatine supplementation improve memory in healthy adults?", { ...small, sources: [...small.sources] }, {
		llm,
		state: new RunState(stateFile), // a rerun after a failure resumes from the last finished stage
		onEvent: (e) => e.type === "phase" && console.log(`  [${ms(start)}] ${e.text}`),
	});
	const path = saveScience(report, process.cwd(), ".harness/science");
	rmSync(stateFile, { force: true });
	const supported = report.checks.filter((c) => c.supported === "yes").length;
	const cited = report.checks.filter((c) => c.supported !== "uncited").length;
	banner(`Science review in ${ms(start)} (${report.models.screeners.join(" + ")} screening, ${report.models.orchestrator} synthesis)`, [
		renderScienceDigest(report, path),
		`search log: ${report.searchLog.map((l) => `${l.source}:${l.error ? "err" : l.found}`).join(" ")}`,
		`κ=${report.screen.kappa.toFixed(2)} · quotes verified ${report.extractions.filter((x) => x.quoteVerified).length}/${report.extractions.length} · citations supported ${supported}/${cited}`,
	]);
	Object.assign(metrics, { found: report.prisma.identified, screened: report.prisma.screened, included: report.prisma.included, kappa: report.screen.kappa.toFixed(2), "quotes verified": `${report.extractions.filter((x) => x.quoteVerified).length}/${report.extractions.length}`, "citations supported": `${supported}/${cited}` });
	expect(report.prisma.identified).toBeGreaterThan(0);
	expect(report.synthesis.answer.length).toBeGreaterThan(0);
	}));
