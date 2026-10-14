import type { Dispute, Resolution } from "../types.ts";
import type { ResolveContext } from "./context.ts";
import { judge } from "./judge.ts";

export const EXPLAIN_OPTION = "Neither / it depends — let me explain";
export const SKIP_OPTION = "Skip — let the judge decide";

const clip = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Context-dependent disputes hinge on the asker's situation, so ask them: pick a side, explain,
 * or skip to the judge. Without a UI the judge decides.
 */
export async function resolveWithUser(dispute: Dispute, ctx: ResolveContext): Promise<Resolution> {
	if (!ctx.user) return judge(dispute, ctx, ["(User not reachable in this mode.)"]);
	const options = dispute.positions.map((p, i) => `${i + 1}. ${clip(p.stance)}`);
	const choice = await ctx.user.select(`Panel needs your input — ${dispute.topic}: ${dispute.crux}`, [...options, EXPLAIN_OPTION, SKIP_OPTION]);

	if (!choice || choice === SKIP_OPTION) return judge(dispute, ctx, ["(User skipped the question.)"]);
	if (choice === EXPLAIN_OPTION) {
		const text = await ctx.user.input(dispute.crux, "Describe your situation or preference");
		if (!text?.trim()) return judge(dispute, ctx, ["(User gave no explanation.)"]);
		return judge(dispute, ctx, [`The user (the person asking) says: ${text.trim()}`], "user");
	}
	const index = options.indexOf(choice);
	return {
		disputeId: dispute.id,
		method: "user",
		verdict: dispute.positions[index].stance,
		confidence: 1,
		winningPosition: index,
		rationale: "Chosen by the user, whose situation this depends on.",
		sources: [],
		trail: [`User chose: ${choice}`],
	};
}
