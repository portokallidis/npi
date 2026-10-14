import { type Static, Type } from "typebox";
import type { Direction, Framing } from "../brainstorm/types.ts";
import type { Paper, SearchLogEntry } from "./papers.ts";

export const ProtocolSchema = Type.Object({
	question: Type.String({ description: "The research question, precise and answerable from literature" }),
	population: Type.String(),
	intervention: Type.String({ description: "Intervention or exposure" }),
	comparison: Type.String({ description: 'Comparator, or "none"' }),
	outcomes: Type.Array(Type.String(), { description: "1-5 outcomes that matter" }),
	studyTypes: Type.Array(Type.String(), { description: "Acceptable designs, e.g. RCT, cohort, meta-analysis" }),
	inclusion: Type.Array(Type.String()),
	exclusion: Type.Array(Type.String()),
	fromYear: Type.Integer({ description: "Earliest publication year, or 0 for no limit" }),
	queries: Type.Array(Type.String(), { description: "3-6 plain-language search queries with different phrasings/synonyms" }),
});

export const ScreenSchema = Type.Object({
	decisions: Type.Array(Type.Object({ id: Type.String(), include: Type.Boolean(), reason: Type.String({ description: "Which criterion decided it, a few words" }) })),
});

export const ExtractionSchema = Type.Object({
	design: Type.String({ description: "rct | cohort | case-control | cross-sectional | meta-analysis | systematic-review | qualitative | modeling | other" }),
	n: Type.Integer({ description: "Sample size, 0 if not reported" }),
	population: Type.String(),
	intervention: Type.String(),
	comparator: Type.String(),
	outcomes: Type.Array(
		Type.Object({
			name: Type.String(),
			finding: Type.String({ description: "Effect with numbers if reported" }),
			direction: Type.Union([Type.Literal("benefit"), Type.Literal("harm"), Type.Literal("none"), Type.Literal("mixed")]),
			significant: Type.Union([Type.Literal("yes"), Type.Literal("no"), Type.Literal("unclear")]),
		}),
	),
	limitations: Type.Array(Type.String()),
	quote: Type.String({ description: "The single sentence from the abstract that states the main result, copied verbatim" }),
});

const Certainty = Type.Union([Type.Literal("high"), Type.Literal("moderate"), Type.Literal("low"), Type.Literal("very_low")]);

export const SynthesisSchema = Type.Object({
	answer: Type.String({ description: "Markdown answer; EVERY factual sentence ends with citations like [P3] or [P3, P7]" }),
	outcomes: Type.Array(
		Type.Object({
			outcome: Type.String(),
			direction: Type.String({ description: "What the evidence shows, briefly" }),
			certainty: Certainty,
			rationale: Type.String({ description: "GRADE reasoning: risk of bias, inconsistency, indirectness, imprecision, publication bias" }),
			supporting: Type.Array(Type.String()),
			contradicting: Type.Array(Type.String()),
		}),
	),
	openQuestions: Type.Array(Type.String()),
	nextExperiments: Type.Array(Type.String()),
});

export const VerifySchema = Type.Object({
	checks: Type.Array(
		Type.Object({
			index: Type.Integer(),
			supported: Type.Union([Type.Literal("yes"), Type.Literal("partial"), Type.Literal("no")]),
			note: Type.String(),
		}),
	),
});

export type Protocol = Static<typeof ProtocolSchema>;
export type Extraction = Static<typeof ExtractionSchema> & { id: string; quoteVerified: boolean };
export type Synthesis = Static<typeof SynthesisSchema>;

export interface ScreenResult {
	included: string[];
	excluded: { id: string; reason: string }[];
	kappa: number;
	disagreements: number;
	screeners: string[];
}

export interface SentenceCheck {
	sentence: string;
	cites: string[];
	supported: "yes" | "partial" | "no" | "uncited";
	note: string;
}

export interface ScienceReport {
	prompt: string;
	startedAt: string;
	models: { orchestrator: string; screeners: string[]; extractor: string; verifier: string };
	framing: Framing;
	directions: Direction[];
	protocol: Protocol;
	searchLog: SearchLogEntry[];
	prisma: { identified: number; duplicates: number; retracted: number; noAbstract: number; screened: number; excluded: number; included: number };
	papers: Paper[];
	screen: ScreenResult;
	extractions: Extraction[];
	synthesis: Synthesis;
	checks: SentenceCheck[];
	costUSD: number;
	stoppedEarly?: string;
}
