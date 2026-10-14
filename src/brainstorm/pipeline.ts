import type { AgentDef } from "../core/agents.ts";
import type { ArtifactStore } from "../core/artifacts.ts";
import { Budget, BudgetExceededError } from "../core/budget.ts";
import { firstAvailable, type Llm } from "../core/llm.ts";
import { mapPool } from "../core/pool.ts";
import { callStructured } from "../core/structured.ts";
import type { SubagentRunner } from "../core/subagent.ts";
import { askDirections, frame } from "./frame.ts";
import { mapPathways } from "./map.ts";
import { collectProposals, selectPanel } from "./panel.ts";
import { brief, convergePrompt, ORCHESTRATOR_SYSTEM } from "./prompts.ts";
import { type ResolveContext, resolveDispute, type UserChannel } from "./resolve/index.ts";
import {
	type BrainstormConfig,
	type BrainstormEvent,
	type BrainstormReport,
	ConvergeSchema,
	type Convergence,
	type Dispute,
	type PathwayMap,
	type Resolution,
} from "./types.ts";

export interface BrainstormDeps {
	llm: Llm;
	runner?: SubagentRunner;
	evidenceAgent?: AgentDef;
	/** Present only when a human can answer questions (TUI/RPC). */
	user?: UserChannel;
	artifacts?: ArtifactStore;
	signal?: AbortSignal;
	onEvent?: (event: BrainstormEvent) => void;
	/** Shared so callers can display live spend. */
	budget?: Budget;
}

/** Prefer a judge from a different model than any panelist, to avoid self-preference. */
async function pickJudge(config: BrainstormConfig, llm: Llm, panelModels: ReadonlySet<string>): Promise<string> {
	const independent = config.judge.filter((m) => !panelModels.has(m));
	const judge = (await firstAvailable(llm, independent)) ?? (await firstAvailable(llm, config.judge));
	if (!judge) throw new Error(`No judge model available (tried ${config.judge.join(", ")})`);
	return judge;
}

const EMPTY_CONVERGENCE: Convergence = { goalClarity: 0, ranking: [], decisionCriteria: [], openQuestions: [], summary: "" };

/**
 * Explore-and-decide brainstorm:
 *  1. frame     — the orchestrator (top frontier model) states the goal and asks the user direction questions
 *  2. diverge   — every panelist (different models) proposes distinct pathways with trade-offs + claims
 *  3. map       — the orchestrator merges them into one pathway catalogue and finds disputed claims
 *  4. resolve   — disputes go to web evidence / cross-examination / the user / an independent judge
 *  5. converge  — the orchestrator ranks pathways and recommends one only if the goal is clear enough
 * Only compact, structured data moves between stages; full proposals and research go to artifacts.
 */
export async function runBrainstorm(prompt: string, config: BrainstormConfig, deps: BrainstormDeps): Promise<BrainstormReport> {
	const { llm, onEvent, signal } = deps;
	const budget = deps.budget ?? new Budget(config.maxCostUSD);
	const phase = (text: string) => onEvent?.({ type: "phase", text });
	const orchestratorTokens = config.maxOutputTokens.orchestrator;

	const orchestrator = await firstAvailable(llm, config.orchestrator);
	if (!orchestrator) throw new Error(`No orchestrator model available (tried ${config.orchestrator.join(", ")})`);
	const { panel, skipped } = await selectPanel(config, llm);
	for (const s of skipped) onEvent?.({ type: "panelist", id: s.id, status: "skipped", detail: s.reason });
	const judgeModel = await pickJudge(config, llm, new Set(panel.map((p) => p.model)));
	const user = config.askUser ? deps.user : undefined;

	phase("Understanding the goal");
	const framing = await frame(prompt, { llm, budget, model: orchestrator, maxQuestions: config.maxDirectionQuestions, maxTokens: orchestratorTokens, signal });
	if (framing.questions.length) phase(user ? "Asking you for direction" : "No UI: proceeding on the orchestrator's interpretation");
	const directions = await askDirections(framing, user);
	const briefText = brief(prompt, framing.goal, directions);

	const report: BrainstormReport = {
		prompt,
		startedAt: new Date().toISOString(),
		orchestrator,
		judge: judgeModel,
		framing,
		directions,
		panel,
		skipped: [...skipped],
		proposals: [],
		map: { pathways: [], consensus: [], disputes: [] },
		resolutions: [],
		convergence: EMPTY_CONVERGENCE,
		costUSD: 0,
		costByLabel: {},
	};

	const resolveCtx: ResolveContext = {
		question: briefText,
		llm,
		budget,
		panel,
		judgeModel,
		crossExamRounds: config.crossExamRounds,
		runner: deps.runner,
		evidenceAgent: deps.evidenceAgent,
		user,
		signal,
	};

	async function resolveOne(dispute: Dispute): Promise<Resolution | undefined> {
		onEvent?.({ type: "dispute", dispute, status: "resolving" });
		try {
			const resolution = await resolveDispute(dispute, resolveCtx);
			report.resolutions.push(resolution);
			onEvent?.({ type: "dispute", dispute, status: "resolved", resolution });
			return resolution;
		} catch (error) {
			if (error instanceof BudgetExceededError) throw error;
			phase(`Could not resolve "${dispute.topic}": ${(error as Error).message}`);
			return undefined;
		}
	}

	try {
		phase(`Exploring pathways with ${panel.length} panelists`);
		const { proposals, failed } = await collectProposals(briefText, panel, {
			llm,
			budget,
			timeoutMs: config.callTimeoutMs,
			maxPathways: config.maxPathwaysPerPanelist,
			maxTokens: config.maxOutputTokens.panelist,
			artifacts: deps.artifacts,
			signal,
			onEvent,
		});
		report.skipped.push(...failed);
		report.proposals = proposals;
		if (proposals.length < 2) throw new Error(`Only ${proposals.length} panelist(s) answered: ${failed.map((f) => `${f.id}: ${f.reason}`).join("; ")}`);

		phase("Mapping the option space");
		const map: PathwayMap = await mapPathways(briefText, proposals, { llm, budget, model: orchestrator, maxDisputes: config.maxDisputes, maxTokens: orchestratorTokens, signal });
		report.map = map;
		for (const dispute of map.disputes) onEvent?.({ type: "dispute", dispute, status: "open" });

		if (map.disputes.length) {
			phase(`Settling ${map.disputes.length} disputed trade-off(s)`);
			const byKind = (kind: Dispute["kind"]) => map.disputes.filter((d) => d.kind === kind);
			// Machine-only resolvers run concurrently; questions to the user go one at a time.
			await Promise.all([mapPool(byKind("factual"), 3, resolveOne), mapPool(byKind("reasoning"), 3, resolveOne)]);
			await mapPool(byKind("context"), 1, resolveOne);
		}
	} catch (error) {
		if (!(error instanceof BudgetExceededError)) throw error;
		report.stoppedEarly = error.message;
		phase(`${error.message} — concluding with what is settled so far`);
	}

	if (report.map.pathways.length) {
		phase("Ranking pathways");
		// Convergence is the payoff of everything spent so far, so it may run past the cap once.
		const convergence = await callStructured(llm, budget.uncapped(), {
			model: orchestrator,
			label: "orchestrator:converge",
			system: ORCHESTRATOR_SYSTEM,
			prompt: convergePrompt(briefText, report.map, report.resolutions, config.recommendThreshold),
			schema: ConvergeSchema,
			toolName: "submit_convergence",
			toolDescription: "Submit the ranking, recommendation (if warranted) and decision criteria.",
			thinking: "high",
			maxTokens: orchestratorTokens,
			signal,
		}).catch((error) => {
			phase(`Ranking failed: ${(error as Error).message}`);
			return EMPTY_CONVERGENCE;
		});
		report.convergence = convergence;
		const known = convergence.recommendation && report.map.pathways.some((p) => p.id === convergence.recommendation?.pathway);
		if (known && convergence.goalClarity >= config.recommendThreshold) report.recommended = convergence.recommendation;
	}

	report.costUSD = budget.spentUSD;
	for (const entry of budget.entries) {
		const key = entry.label.split(":")[0];
		report.costByLabel[key] = (report.costByLabel[key] ?? 0) + entry.costUSD;
	}
	return report;
}
