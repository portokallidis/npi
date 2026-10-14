import { callStructured } from "../../core/structured.ts";
import { JUDGE_SYSTEM, judgePrompt } from "../prompts.ts";
import { type Dispute, JudgeSchema, type Resolution, type ResolutionMethod } from "../types.ts";
import type { ResolveContext } from "./context.ts";

/** Have the (non-panel) judge rule on a dispute, given any evidence or debate gathered so far. */
export async function judge(
	dispute: Dispute,
	ctx: ResolveContext,
	trail: readonly string[] = [],
	method: ResolutionMethod = "judge",
	sources: readonly string[] = [],
): Promise<Resolution> {
	const ruling = await callStructured(ctx.llm, ctx.budget, {
		model: ctx.judgeModel,
		label: "judge",
		system: JUDGE_SYSTEM,
		prompt: judgePrompt(ctx.question, dispute, trail),
		schema: JudgeSchema,
		toolName: "submit_ruling",
		toolDescription: "Submit your ruling on the dispute.",
		thinking: "medium",
		signal: ctx.signal,
	});
	const winningPosition = ruling.winningPosition < dispute.positions.length ? ruling.winningPosition : -1;
	return {
		disputeId: dispute.id,
		method,
		verdict: ruling.verdict,
		confidence: ruling.confidence,
		winningPosition,
		rationale: ruling.rationale,
		sources: [...sources],
		trail: [...trail],
	};
}
