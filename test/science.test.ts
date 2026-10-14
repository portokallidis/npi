import { describe, expect, it } from "vitest";
import { citedSentences, cohensKappa, quoteInAbstract, runScience, type ScienceConfig } from "../src/science/pipeline.ts";
import { renderScience } from "../src/science/report.ts";
import { FakeLlm, type RecordedCall, toolCallMessage } from "./fakes.ts";

const config: ScienceConfig = {
	orchestrator: ["p/orch"],
	screeners: ["a/screen", "b/screen"],
	extractor: ["p/extract"],
	verifier: ["c/verify"],
	sources: ["openalex", "pubmed"],
	maxDirectionQuestions: 2,
	maxQueries: 2,
	perQuery: 5,
	maxCandidates: 10,
	maxIncluded: 5,
	askUser: false,
	maxCostUSD: 10,
	reportDir: ".harness/science",
};

const abstract = (n: number) => `Background: we studied exercise. Methods: randomized trial with ${n} adults. Results: exercise reduced depressive symptoms by 30 percent versus control. Conclusion: exercise helps.`;
const raw = (title: string, doi: string, extra = {}) => ({ title, doi, abstract: abstract(100), authors: ["Ann Lee"], year: 2020, sources: ["openalex" as const], ...extra });
const sources = {
	openalex: async () => [raw("Trial A", "10.1/a"), raw("Trial B", "10.1/b"), raw("Retracted C", "10.1/c", { retracted: true }), raw("Short D", "10.1/d", { abstract: "too short" })],
	pubmed: async () => [raw("Trial A", "10.1/a", { sources: ["pubmed"] }), raw("Trial E", "10.1/e", { sources: ["pubmed"] })],
	semanticscholar: async () => [],
	arxiv: async () => [],
};

function respond(call: RecordedCall) {
	const tool = call.request.tools?.[0]?.name;
	switch (tool) {
		case "submit_framing":
			return toolCallMessage(tool, { goal: "Does exercise reduce depression?", goalClarity: 0.9, questions: [] });
		case "submit_protocol":
			return toolCallMessage(tool, {
				question: "Does exercise reduce depressive symptoms in adults?",
				population: "adults",
				intervention: "exercise",
				comparison: "usual care",
				outcomes: ["depressive symptoms"],
				studyTypes: ["RCT"],
				inclusion: ["RCT"],
				exclusion: ["children"],
				fromYear: 2010,
				queries: ["exercise depression trial", "physical activity depressive symptoms", "ignored third query"],
			});
		case "submit_screening": {
			const ids = [...call.prompt.matchAll(/\[(P\d+)\]/g)].map((m) => m[1]);
			// Screener B excludes Trial E (P5); the judge (verifier model) then includes it.
			return toolCallMessage(tool, { decisions: ids.map((id) => ({ id, include: !(call.ref === "b/screen" && id === "P5"), reason: "criteria" })) });
		}
		case "submit_extraction": {
			const id = call.prompt.match(/\[(P\d+)\]/)?.[1];
			return toolCallMessage(tool, {
				design: "rct",
				n: 100,
				population: "adults",
				intervention: "exercise",
				comparator: "control",
				outcomes: [{ name: "depressive symptoms", finding: "-30%", direction: "benefit", significant: "yes" }],
				limitations: [],
				quote: id === "P2" ? "Exercise cures everything forever in all humans." : "Results: exercise reduced depressive symptoms by 30 percent versus control.",
			});
		}
		case "submit_synthesis":
			return toolCallMessage(tool, {
				answer: "Exercise reduces depressive symptoms in adults by about 30 percent [P1, P5]. It also cures cancer [P2]. Effects were seen in a trial nobody included [P9].",
				outcomes: [{ outcome: "depressive symptoms", direction: "reduced", certainty: "moderate", rationale: "two RCTs, small", supporting: ["P1", "P5"], contradicting: [] }],
				openQuestions: ["Long-term effects?"],
				nextExperiments: ["Larger RCT"],
			});
		case "submit_checks":
			return toolCallMessage(tool, { checks: [{ index: 0, supported: "yes", note: "" }, { index: 1, supported: "no", note: "no cancer data" }] });
		default:
			throw new Error(`unexpected ${tool}`);
	}
}

describe("science helpers", () => {
	it("computes Cohen's kappa", () => {
		expect(cohensKappa([true, true, false, false], [true, true, false, false])).toBe(1);
		expect(cohensKappa([true, false, true, false], [true, true, false, false])).toBeCloseTo(0);
	});
	it("verifies quotes against the abstract and splits cited sentences", () => {
		expect(quoteInAbstract("Results: exercise reduced depressive symptoms by 30 percent.", abstract(10))).toBe(true);
		expect(quoteInAbstract("Exercise cures everything forever.", abstract(10))).toBe(false);
		expect(citedSentences("First claim here is long enough [P1]. Second claim cites two [P2, P3].")).toEqual([
			{ sentence: "First claim here is long enough [P1].", cites: ["P1"] },
			{ sentence: "Second claim cites two [P2, P3].", cites: ["P2", "P3"] },
		]);
	});
});

describe("runScience", () => {
	it("runs protocol → search → dual screening → extraction → GRADE → citation checks", async () => {
		const llm = new FakeLlm(respond);
		const r = await runScience("does exercise help depression?", config, { llm, sources });

		// PRISMA: 2 queries × 6 records = 12, 7 duplicates → 5 unique; 1 retracted, 1 without abstract → 3 screened.
		expect(r.prisma).toMatchObject({ identified: 12, duplicates: 7, retracted: 1, noAbstract: 1, screened: 3, included: 3, excluded: 0 });
		expect(r.searchLog).toHaveLength(4); // 2 queries (capped) × 2 sources
		expect(r.screen).toMatchObject({ disagreements: 1, screeners: ["a/screen", "b/screen"] });
		expect(r.screen.kappa).toBeLessThan(1);
		expect(llm.calls.some((c) => c.ref === "c/verify" && c.request.tools?.[0]?.name === "submit_screening")).toBe(true);

		expect(r.extractions.find((x) => x.id === "P1")?.quoteVerified).toBe(true);
		expect(r.extractions.find((x) => x.id === "P2")?.quoteVerified).toBe(false);

		expect(r.checks.map((c) => c.supported)).toEqual(["yes", "no", "no"]);
		expect(r.checks[2].note).toMatch(/not included/);
		const md = renderScience(r);
		expect(md).toMatch(/It also cures cancer \[P2\]\. ❌/);
		expect(md).toMatch(/Cohen's κ = /);
		expect(md).toMatch(/\| depressive symptoms \| reduced \| \*\*moderate\*\*/);
	});

	it("falls back to one screener model acting as two reviewers", async () => {
		const llm = new FakeLlm(respond);
		llm.unavailable.add("b/screen");
		const r = await runScience("q", config, { llm, sources });
		expect(r.screen.screeners).toEqual(["a/screen", "a/screen"]);
		expect(llm.calls.some((c) => c.prompt.includes("second, independent reviewer"))).toBe(true);
		llm.unavailable.add("a/screen");
		await expect(runScience("q", config, { llm, sources })).rejects.toThrow(/No screener model available/);
	});
});
