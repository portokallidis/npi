import { type Static, Type } from "typebox";
import type { HarnessConfig } from "../core/config.ts";

export type BrainstormConfig = HarnessConfig["brainstorm"];

const Effort = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);

export const ClaimSchema = Type.Object({
	id: Type.String({ description: "Short id unique within your answer, e.g. c1" }),
	text: Type.String({ description: "One atomic, checkable statement a pathway's trade-offs depend on" }),
	type: Type.Union([Type.Literal("factual"), Type.Literal("reasoning"), Type.Literal("recommendation")]),
	confidence: Type.Number({ minimum: 0, maximum: 1, description: "Calibrated probability the claim is correct" }),
});

/** Orchestrator step 1: understand the abstract prompt and decide what to ask the user. */
export const FramingSchema = Type.Object({
	goal: Type.String({ description: "Your best statement of what the user is trying to achieve" }),
	goalClarity: Type.Number({ minimum: 0, maximum: 1, description: "How clear the goal and success criteria are from the prompt alone" }),
	questions: Type.Array(
		Type.Object({
			question: Type.String(),
			why: Type.String({ description: "How the answer changes which pathways make sense" }),
			options: Type.Array(Type.String(), { description: "2-5 likely answers, short" }),
		}),
		{ description: "Only questions whose answers would change the exploration. Empty if none." },
	),
});

/** Panelist step: diverge — propose distinct pathways with honest trade-offs. */
export const PathwaysSchema = Type.Object({
	pathways: Type.Array(
		Type.Object({
			name: Type.String(),
			summary: Type.String({ description: "What this pathway is, in 1-3 sentences" }),
			howItWorks: Type.Array(Type.String(), { description: "3-6 concrete steps" }),
			pros: Type.Array(Type.String()),
			cons: Type.Array(Type.String()),
			risks: Type.Array(Type.String()),
			effort: Effort,
			bestWhen: Type.String({ description: "The situation in which this is the best choice" }),
			claims: Type.Array(ClaimSchema, { description: "The checkable claims its trade-offs rest on" }),
		}),
	),
	assumptions: Type.Array(Type.String()),
});

const DisputeSchema = Type.Object({
	topic: Type.String({ description: "Short label" }),
	crux: Type.String({ description: "The single question whose answer settles it" }),
	kind: Type.Union([Type.Literal("factual"), Type.Literal("reasoning"), Type.Literal("context")]),
	importance: Type.Number({ minimum: 0, maximum: 1, description: "How much choosing between pathways depends on it" }),
	positions: Type.Array(
		Type.Object({
			stance: Type.String(),
			panelists: Type.Array(Type.String()),
			claimRefs: Type.Array(Type.String(), { description: "panelist:claimId references" }),
		}),
	),
});

/** Orchestrator step 2: merge everything the panel proposed into one catalogue and find disputes. */
export const MapSchema = Type.Object({
	pathways: Type.Array(
		Type.Object({
			name: Type.String(),
			summary: Type.String(),
			proposedBy: Type.Array(Type.String(), { description: 'Panelist names; "orchestrator" for a pathway you add because nobody covered it' }),
			pros: Type.Array(Type.String()),
			cons: Type.Array(Type.String()),
			risks: Type.Array(Type.String()),
			effort: Effort,
			bestWhen: Type.String(),
		}),
	),
	consensus: Type.Array(Type.Object({ statement: Type.String(), panelists: Type.Array(Type.String()) })),
	disputes: Type.Array(DisputeSchema),
});

/** Orchestrator step 3: converge — rank, and recommend only if the goal is clear. */
export const ConvergeSchema = Type.Object({
	goalClarity: Type.Number({ minimum: 0, maximum: 1 }),
	ranking: Type.Array(
		Type.Object({
			pathway: Type.String({ description: "Pathway id, e.g. p2" }),
			fit: Type.Number({ minimum: 0, maximum: 1, description: "Fit with the user's goal and answers" }),
			why: Type.String(),
		}),
	),
	recommendation: Type.Optional(
		Type.Object({
			pathway: Type.String({ description: "Pathway id" }),
			rationale: Type.String(),
			conditions: Type.Array(Type.String(), { description: "When this recommendation would no longer hold" }),
			firstSteps: Type.Array(Type.String()),
		}),
	),
	decisionCriteria: Type.Array(Type.String(), { description: "What would decide between the top pathways" }),
	openQuestions: Type.Array(Type.String()),
	summary: Type.String({ description: "A short Markdown overview for the user" }),
});

export const CrossExamSchema = Type.Object({
	action: Type.Union([Type.Literal("concede"), Type.Literal("refine"), Type.Literal("rebut")]),
	statement: Type.String({ description: "Your position after considering the other side" }),
	reason: Type.String({ description: "The decisive argument or evidence" }),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

export const JudgeSchema = Type.Object({
	winningPosition: Type.Integer({ minimum: -1, description: "Index of the best-supported position, or -1 if none / a synthesis" }),
	verdict: Type.String({ description: "What is most likely true, in one or two sentences" }),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
	rationale: Type.String(),
});

export type Claim = Static<typeof ClaimSchema>;
export type Framing = Static<typeof FramingSchema>;
export type PathwaysOutput = Static<typeof PathwaysSchema>;
export type MapOutput = Static<typeof MapSchema>;
export type Convergence = Static<typeof ConvergeSchema>;
export type CrossExamReply = Static<typeof CrossExamSchema>;
export type JudgeOutput = Static<typeof JudgeSchema>;

export interface Panelist {
	id: string;
	model: string;
	thinking?: BrainstormConfig["panel"][number]["thinking"];
	persona?: string;
}

export interface PanelProposal extends PathwaysOutput {
	panelist: string;
	model: string;
	/** Full proposal on disk; only the compact form enters the orchestrator's context. */
	artifact?: string;
}

export type Pathway = MapOutput["pathways"][number] & { id: string };

export type DisputeKind = "factual" | "reasoning" | "context";

export interface Position {
	stance: string;
	panelists: string[];
	claimRefs: string[];
}

export interface Dispute {
	id: string;
	topic: string;
	crux: string;
	kind: DisputeKind;
	importance: number;
	positions: Position[];
}

export interface PathwayMap {
	pathways: Pathway[];
	consensus: { statement: string; panelists: string[] }[];
	disputes: Dispute[];
}

export type ResolutionMethod = "evidence" | "cross-exam" | "user" | "judge";

export interface Resolution {
	disputeId: string;
	method: ResolutionMethod;
	verdict: string;
	confidence: number;
	/** Index into dispute.positions, or -1 when the verdict is a synthesis / no side won. */
	winningPosition: number;
	rationale: string;
	sources: string[];
	/** Cross-exam turns, evidence summary, or the user's answer. */
	trail: string[];
	/** Full evidence report, when a research subagent ran. */
	artifact?: string;
}

export interface Direction {
	question: string;
	answer: string;
}

export type BrainstormEvent =
	| { type: "phase"; text: string }
	| { type: "panelist"; id: string; status: "thinking" | "done" | "failed" | "skipped"; detail?: string }
	| { type: "dispute"; dispute: Dispute; status: "open" | "resolving" | "resolved"; resolution?: Resolution };

export interface BrainstormReport {
	prompt: string;
	startedAt: string;
	orchestrator: string;
	judge: string;
	framing: Framing;
	directions: Direction[];
	panel: Panelist[];
	skipped: { id: string; reason: string }[];
	proposals: PanelProposal[];
	map: PathwayMap;
	resolutions: Resolution[];
	convergence: Convergence;
	/** Set only when goal clarity reached the threshold. */
	recommended?: Convergence["recommendation"];
	costUSD: number;
	costByLabel: Record<string, number>;
	stoppedEarly?: string;
}
