import { askDirections, frame } from "../brainstorm/frame.ts";
import type { UserChannel } from "../brainstorm/resolve/index.ts";
import type { BrainstormEvent } from "../brainstorm/types.ts";
import { Budget, BudgetExceededError } from "../core/budget.ts";
import type { HarnessConfig } from "../core/config.ts";
import { firstAvailable, type Llm } from "../core/llm.ts";
import { mapPool } from "../core/pool.ts";
import type { RunState } from "../core/runstate.ts";
import { callStructured } from "../core/structured.ts";
import { type Paper, type PaperSourceName, SOURCES, searchAll } from "./papers.ts";
import {
	type Extraction,
	ExtractionSchema,
	type Protocol,
	ProtocolSchema,
	type ScienceReport,
	type ScreenResult,
	ScreenSchema,
	type SentenceCheck,
	type Synthesis,
	SynthesisSchema,
	VerifySchema,
} from "./types.ts";

export type ScienceConfig = HarnessConfig["science"];

export interface ScienceDeps {
	llm: Llm;
	user?: UserChannel;
	state?: RunState;
	budget?: Budget;
	signal?: AbortSignal;
	onEvent?: (event: BrainstormEvent) => void;
	/** Injected in tests. */
	sources?: typeof SOURCES;
}

const SCIENTIST = `You are a careful research methodologist. You follow systematic-review practice (PICO, explicit criteria, PRISMA, GRADE), you never invent studies or numbers, and you say clearly when evidence is weak.`;

/** Cohen's kappa for two raters' include/exclude decisions. */
export function cohensKappa(a: readonly boolean[], b: readonly boolean[]): number {
	const n = a.length;
	if (!n) return 1;
	const agree = a.filter((x, i) => x === b[i]).length / n;
	const pa = a.filter(Boolean).length / n;
	const pb = b.filter(Boolean).length / n;
	const expected = pa * pb + (1 - pa) * (1 - pb);
	return expected === 1 ? 1 : (agree - expected) / (1 - expected);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The extractor's "verbatim" quote must actually appear in the abstract. */
export function quoteInAbstract(quote: string, abstract: string): boolean {
	const q = norm(quote);
	return q.length > 20 && norm(abstract).includes(q);
}

/** Split a Markdown answer into sentences and the [P#] ids each one cites. */
export function citedSentences(answer: string): { sentence: string; cites: string[] }[] {
	return answer
		.split(/(?<=[.!?])\s+(?=[A-Z0-9*_#-])|\n+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 25 && !/^#+\s/.test(s))
		.map((sentence) => ({ sentence, cites: [...new Set([...sentence.matchAll(/P\d+/g)].map((m) => m[0]))] }));
}

const paperLine = (p: Paper) => `[${p.id}] ${p.title} (${p.year ?? "n.d."}${p.venue ? `, ${p.venue}` : ""})\n${p.abstract.slice(0, 1800)}`;

function protocolText(p: Protocol): string {
	return `Question: ${p.question}
Population: ${p.population}
Intervention/exposure: ${p.intervention}
Comparison: ${p.comparison}
Outcomes: ${p.outcomes.join("; ")}
Study types: ${p.studyTypes.join("; ")}
Include if: ${p.inclusion.join("; ")}
Exclude if: ${p.exclusion.join("; ")}`;
}

/**
 * Systematic-review-style research:
 *  frame + directions (user) → protocol (PICO, criteria, queries) → multi-database search (logged, de-duplicated,
 *  retractions dropped) → dual-model screening (Cohen's kappa; disagreements to a judge) → structured extraction
 *  per paper (verbatim quote verified against the abstract) → GRADE synthesis citing [P#] → sentence-level
 *  citation verification. Every stage is checkpointed; only compact structured data moves between stages.
 */
export async function runScience(prompt: string, config: ScienceConfig, deps: ScienceDeps): Promise<ScienceReport> {
	const { llm, signal, onEvent } = deps;
	const budget = deps.budget ?? new Budget(config.maxCostUSD);
	const phase = (text: string) => onEvent?.({ type: "phase", text });
	const step = <T>(name: string, run: () => Promise<T>): Promise<T> => (deps.state ? deps.state.step(name, run) : run());
	const need = async (refs: string[], role: string) => {
		const m = await firstAvailable(llm, refs);
		if (!m) throw new Error(`No ${role} model available (tried ${refs.join(", ")})`);
		return m;
	};

	const orchestrator = await need(config.orchestrator, "orchestrator");
	const extractor = await need(config.extractor, "extractor");
	const verifier = await need(config.verifier, "verifier");
	// Two screeners, preferably from different providers, so their errors are less correlated.
	const available: string[] = [];
	for (const m of config.screeners) if (await llm.available(m)) available.push(m);
	const first = available[0];
	const second = available.find((m) => m.split("/")[0] !== first?.split("/")[0]) ?? available[1];
	if (!first || !second) throw new Error(`Need two available screener models (tried ${config.screeners.join(", ")})`);
	const orchestratorTokens = 8000;

	phase("Understanding the question");
	const framing = await step("frame", () => frame(prompt, { llm, budget, model: orchestrator, maxQuestions: config.maxDirectionQuestions, maxTokens: orchestratorTokens, signal }));
	const directions = await step("directions", () => askDirections(framing, config.askUser ? deps.user : undefined));
	const answers = directions.map((d) => `- ${d.question} → ${d.answer}`).join("\n");

	phase("Writing the review protocol");
	const protocol = await step("protocol", () =>
		callStructured(llm, budget, {
			model: orchestrator,
			label: "science:protocol",
			system: SCIENTIST,
			prompt: `Research request:\n${prompt}\n\nGoal: ${framing.goal}${answers ? `\nUser's directions:\n${answers}` : ""}\n\nWrite the review protocol (PICO, criteria, and ${config.maxQueries} or fewer search queries).`,
			schema: ProtocolSchema,
			toolName: "submit_protocol",
			toolDescription: "Submit the review protocol.",
			thinking: "high",
			maxTokens: orchestratorTokens,
			signal,
		}),
	);

	const report: ScienceReport = {
		prompt,
		startedAt: new Date().toISOString(),
		models: { orchestrator, screeners: [first, second], extractor, verifier },
		framing,
		directions,
		protocol,
		searchLog: [],
		prisma: { identified: 0, duplicates: 0, retracted: 0, noAbstract: 0, screened: 0, excluded: 0, included: 0 },
		papers: [],
		screen: { included: [], excluded: [], kappa: 1, disagreements: 0, screeners: [first, second] },
		extractions: [],
		synthesis: { answer: "", outcomes: [], openQuestions: [], nextExperiments: [] },
		checks: [],
		costUSD: 0,
	};

	try {
		phase(`Searching ${config.sources.join(", ")}`);
		const found = await step("search", () =>
			searchAll(protocol.queries.slice(0, config.maxQueries), config.sources as PaperSourceName[], {
				perQuery: config.perQuery,
				fromYear: protocol.fromYear || undefined,
				signal,
				impl: deps.sources,
			}),
		);
		report.searchLog = found.log;
		const retracted = found.papers.filter((p) => p.retracted);
		const noAbstract = found.papers.filter((p) => !p.retracted && p.abstract.length < 100);
		const candidates = found.papers
			.filter((p) => !p.retracted && p.abstract.length >= 100)
			.sort((a, b) => b.sources.length - a.sources.length || (b.citations ?? 0) - (a.citations ?? 0))
			.slice(0, config.maxCandidates);
		report.papers = candidates;
		report.prisma = { ...report.prisma, identified: found.identified, duplicates: found.duplicates, retracted: retracted.length, noAbstract: noAbstract.length, screened: candidates.length };

		phase(`Screening ${candidates.length} papers with two models`);
		const screenWith = async (model: string, papers: Paper[], label: string) => {
			const batches = Array.from({ length: Math.ceil(papers.length / 12) }, (_, i) => papers.slice(i * 12, i * 12 + 12));
			const out = await mapPool(batches, 3, (batch) =>
				callStructured(llm, budget, {
					model,
					label,
					system: SCIENTIST,
					prompt: `Screen these records against the protocol. Decide from title and abstract only. When unsure, include.\n\n${protocolText(protocol)}\n\nRecords:\n\n${batch.map(paperLine).join("\n\n")}`,
					schema: ScreenSchema,
					toolName: "submit_screening",
					toolDescription: "Submit an include/exclude decision for every record.",
					maxTokens: 3000,
					signal,
				}),
			);
			return new Map(out.flatMap((o) => o.decisions).map((d) => [d.id, d]));
		};
		const screen: ScreenResult = await step("screen", async () => {
			const [a, b] = await Promise.all([screenWith(first, candidates, "science:screen-a"), screenWith(second, candidates, "science:screen-b")]);
			const ids = candidates.map((p) => p.id);
			const va = ids.map((id) => a.get(id)?.include ?? true);
			const vb = ids.map((id) => b.get(id)?.include ?? true);
			const conflicts = ids.filter((_, i) => va[i] !== vb[i]);
			const resolved = conflicts.length ? await screenWith(verifier, candidates.filter((p) => conflicts.includes(p.id)), "science:screen-judge") : new Map();
			const decision = (id: string, i: number) => (va[i] === vb[i] ? va[i] : (resolved.get(id)?.include ?? true));
			const included = ids.filter((id, i) => decision(id, i));
			const excluded = ids
				.filter((id, i) => !decision(id, i))
				.map((id) => ({ id, reason: resolved.get(id)?.reason ?? a.get(id)?.reason ?? b.get(id)?.reason ?? "" }));
			return { included, excluded, kappa: cohensKappa(va, vb), disagreements: conflicts.length, screeners: [first, second] };
		});
		const included = candidates
			.filter((p) => screen.included.includes(p.id))
			.sort((x, y) => (y.citations ?? 0) - (x.citations ?? 0))
			.slice(0, config.maxIncluded);
		report.screen = { ...screen, included: included.map((p) => p.id) };
		report.prisma = { ...report.prisma, excluded: screen.excluded.length, included: included.length };

		phase(`Extracting data from ${included.length} papers`);
		report.extractions = (
			await mapPool(included, 4, (p) =>
				step(`extract:${p.id}`, async () => {
					const x = await callStructured(llm, budget, {
						model: extractor,
						label: "science:extract",
						system: SCIENTIST,
						prompt: `Extract the study data for this review. Use only what the abstract states; write "not reported" otherwise.\n\n${protocolText(protocol)}\n\n${paperLine(p)}`,
						schema: ExtractionSchema,
						toolName: "submit_extraction",
						toolDescription: "Submit the structured extraction.",
						maxTokens: 2000,
						signal,
					}).catch(() => undefined);
					return x ? { ...x, id: p.id, quoteVerified: quoteInAbstract(x.quote, p.abstract) } : undefined;
				}),
			)
		).filter((x): x is Extraction => !!x);

		phase("Grading the evidence");
		const evidence = report.extractions
			.map((x) => {
				const p = included.find((q) => q.id === x.id)!;
				const outcomes = x.outcomes.map((o) => `${o.name}: ${o.finding} (${o.direction}, significant: ${o.significant})`).join("; ");
				return `[${x.id}] ${p.title} (${p.year ?? "n.d."}) — ${x.design}, n=${x.n || "?"}; ${outcomes}; limitations: ${x.limitations.join("; ") || "none stated"}${x.quoteVerified ? "" : " [quote unverified]"}`;
			})
			.join("\n");
		report.synthesis = await step("synthesis", () =>
			callStructured(llm, budget.uncapped(), {
				model: orchestrator,
				label: "science:synthesis",
				system: SCIENTIST,
				prompt: `${protocolText(protocol)}\n\nExtracted evidence (one line per included study):\n${evidence || "(no studies)"}\n\nSynthesize. Cite every factual sentence with [P#]. Grade certainty per outcome (GRADE). Do not cite anything not listed.`,
				schema: SynthesisSchema,
				toolName: "submit_synthesis",
				toolDescription: "Submit the graded synthesis.",
				thinking: "high",
				maxTokens: orchestratorTokens,
				signal,
			}),
		);

		phase("Verifying citations sentence by sentence");
		const sentences = citedSentences(report.synthesis.answer);
		const known = new Set(report.extractions.map((x) => x.id));
		const cited = sentences.map((s, i) => ({ ...s, i })).filter((s) => s.cites.length);
		const verdicts = cited.length
			? await step("verify", () =>
					callStructured(llm, budget.uncapped(), {
						model: verifier,
						label: "science:verify",
						system: "You check whether each sentence is supported by the evidence of the studies it cites. Be strict: numbers and directions must match.",
						prompt: cited
							.map((s) => {
								const ev = s.cites
									.map((id) => report.extractions.find((x) => x.id === id))
									.map((x) => (x ? `  [${x.id}] "${x.quote}" — ${x.outcomes.map((o) => `${o.name}: ${o.finding}`).join("; ")}` : "  (cited id not among included studies)"))
									.join("\n");
								return `Sentence ${s.i}: ${s.sentence}\n${ev}`;
							})
							.join("\n\n"),
						schema: VerifySchema,
						toolName: "submit_checks",
						toolDescription: "Submit a support verdict for every sentence.",
						maxTokens: 3000,
						signal,
					}),
				)
			: { checks: [] };
		report.checks = sentences.map((s, i): SentenceCheck => {
			if (!s.cites.length) return { ...s, supported: "uncited", note: "" };
			if (s.cites.some((id) => !known.has(id))) return { ...s, supported: "no", note: "cites a study that was not included" };
			const v = verdicts.checks.find((c) => c.index === i);
			return { ...s, supported: v?.supported ?? "partial", note: v?.note ?? "not checked" };
		});
	} catch (error) {
		if (!(error instanceof BudgetExceededError)) throw error;
		report.stoppedEarly = error.message;
		phase(`${error.message} — stopping; resume to continue`);
	}

	report.costUSD = budget.spentUSD;
	return report;
}
