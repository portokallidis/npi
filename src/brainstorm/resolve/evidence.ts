import { evidenceTask } from "../prompts.ts";
import type { Dispute, Resolution } from "../types.ts";
import type { ResolveContext } from "./context.ts";
import { judge } from "./judge.ts";

export function extractUrls(text: string): string[] {
	return [...new Set(text.match(/https?:\/\/[^\s)\]>"'`]+/g) ?? [])].map((u) => u.replace(/[.,;:]+$/, ""));
}

/**
 * Send a research subagent (web search + fetch + browser) to check the facts, then let the judge
 * map its sourced report onto the competing positions.
 */
export async function resolveWithEvidence(dispute: Dispute, ctx: ResolveContext): Promise<Resolution> {
	if (!ctx.runner || !ctx.evidenceAgent) {
		return judge(dispute, ctx, ["(No research agent available; ruling without external evidence.)"]);
	}
	ctx.budget.assertAvailable();
	const result = await ctx.runner.run({
		agent: ctx.evidenceAgent,
		task: evidenceTask(ctx.question, dispute),
		signal: ctx.signal,
		policy: { level: "readonly", sandboxed: false },
	});
	ctx.budget.add(`evidence:${ctx.evidenceAgent.name}`, result.model, {
		input: result.usage.input,
		output: result.usage.output,
		cost: { total: result.usage.costUSD },
	});
	// Only the research summary enters the judge's context; the full report stays in the artifact.
	if (!result.text.trim()) {
		return judge(dispute, ctx, [`(Research failed: ${result.error ?? "empty report"}; ruling without external evidence.)`]);
	}
	const caveat = result.error ? ` (partial: ${result.error})` : "";
	const report = `Research summary from ${result.agent} (${result.model})${caveat}:\n${result.text}`;
	const resolution = await judge(dispute, ctx, [report], "evidence", extractUrls(result.text));
	return { ...resolution, artifact: result.artifact };
}
