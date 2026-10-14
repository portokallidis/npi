import { callStructured } from "../../core/structured.ts";
import { CROSS_EXAM_SYSTEM, crossExamPrompt } from "../prompts.ts";
import { CrossExamSchema, type Dispute, type Resolution } from "../types.ts";
import { type ResolveContext, representative } from "./context.ts";
import { judge } from "./judge.ts";

/**
 * Each side's representative answers the other side(s) for up to N rounds. If every side but one
 * concedes, that side wins. Otherwise the judge rules with the full debate as its trail.
 */
export async function crossExamine(dispute: Dispute, ctx: ResolveContext): Promise<Resolution> {
	let current: Dispute = { ...dispute, positions: dispute.positions.map((p) => ({ ...p })) };
	const history: string[] = [];
	const conceded = new Set<number>();

	for (let round = 1; round <= ctx.crossExamRounds; round++) {
		const standing = current.positions.map((_, i) => i).filter((i) => !conceded.has(i));
		const replies = await Promise.all(
			standing.map(async (i) => {
				const speaker = representative(current.positions[i], ctx.panel);
				if (!speaker) return undefined;
				const reply = await callStructured(ctx.llm, ctx.budget, {
					model: speaker.model,
					label: `cross-exam:${speaker.id}`,
					system: CROSS_EXAM_SYSTEM,
					prompt: crossExamPrompt(ctx.question, current, i, history),
					schema: CrossExamSchema,
					toolName: "submit_reply",
					toolDescription: "Submit your response to the opposing position.",
					thinking: speaker.thinking,
					signal: ctx.signal,
				});
				return { i, speaker, reply };
			}),
		);

		for (const entry of replies) {
			if (!entry) continue;
			const { i, speaker, reply } = entry;
			history.push(`[round ${round}] position ${i} (${speaker.id}) ${reply.action.toUpperCase()}: ${reply.statement} — because ${reply.reason}`);
			if (reply.action === "concede") conceded.add(i);
			else current.positions[i] = { ...current.positions[i], stance: reply.statement };
		}

		const remaining = current.positions.map((_, i) => i).filter((i) => !conceded.has(i));
		if (remaining.length === 1) {
			const winner = remaining[0];
			const last = replies.find((r) => r?.i === winner)?.reply;
			return {
				disputeId: dispute.id,
				method: "cross-exam",
				verdict: current.positions[winner].stance,
				confidence: last?.confidence ?? 0.7,
				winningPosition: winner,
				rationale: `The other side${current.positions.length > 2 ? "s" : ""} conceded after ${round} round${round > 1 ? "s" : ""}.`,
				sources: [],
				trail: history,
			};
		}
		if (remaining.length === 0) break;
	}
	return judge(current, ctx, history);
}
