import type { Direction, Dispute, PanelProposal, Pathway, PathwayMap, Resolution } from "./types.ts";

// ---- Orchestrator: frame -------------------------------------------------------------------------

export const ORCHESTRATOR_SYSTEM = `You orchestrate a brainstorming panel of different AI models. You turn an abstract prompt into a clear exploration, merge what the panel proposes into one map of options, and decide whether the goal is clear enough to recommend one. You are rigorous, neutral between panelists, and economical with the user's attention.`;

export function framingPrompt(prompt: string, maxQuestions: number): string {
	return `The user's prompt (it may be abstract or underspecified):
"""
${prompt}
"""

1. State the goal as you understand it and rate how clear it is (goalClarity).
2. Choose at most ${maxQuestions} direction questions for the user — only questions whose answers would change which pathways are worth exploring or how they rank (constraints, priorities, scale, budget, timeline, risk appetite, what success looks like). Offer 2-5 short likely answers for each. Ask nothing you could reasonably infer, and ask nothing if the goal is already clear.`;
}

export function brief(prompt: string, goal: string, directions: readonly Direction[]): string {
	const answered = directions.length ? `\n\nDirections from the user:\n${directions.map((d) => `- ${d.question} → ${d.answer}`).join("\n")}` : "";
	return `${prompt}\n\nGoal (as understood): ${goal}${answered}`;
}

// ---- Panel: diverge ------------------------------------------------------------------------------

export const PANELIST_SYSTEM = `You are one member of a brainstorming panel of different AI models. Others work on the same brief independently; afterwards an orchestrator merges all proposals and checks disputed claims against evidence and cross-examination.

- Explore broadly: include the obvious approaches AND credible unconventional ones. Distinct pathways, not variations of one idea.
- Give honest trade-offs. Every pathway has cons and risks.
- Make your claims atomic and checkable, with calibrated confidences (0.9 = wrong 1 time in 10).
- Be concise: lists of short phrases, no essays.`;

export function pathwaysPrompt(briefText: string, maxPathways: number): string {
	return `Brief:\n${briefText}\n\nPropose up to ${maxPathways} distinct pathways to achieve the goal.`;
}

// ---- Orchestrator: map ---------------------------------------------------------------------------

/** Compact rendering of a proposal for the orchestrator: structure only, no prose padding. */
export function compactProposal(p: PanelProposal): string {
	const items = p.pathways.map((w, i) => {
		const claims = w.claims.map((c) => `      [${p.panelist}:${c.id}] (${c.type}, ${c.confidence}) ${c.text}`).join("\n");
		return `  ${i + 1}. ${w.name} [effort ${w.effort}] — ${w.summary}
     + ${w.pros.join("; ")}
     − ${w.cons.join("; ")}
     ! ${w.risks.join("; ") || "none listed"}
     best when: ${w.bestWhen}
${claims}`;
	});
	return `## ${p.panelist}\nassumptions: ${p.assumptions.join("; ") || "none"}\n${items.join("\n")}`;
}

export function mapPrompt(briefText: string, proposals: readonly PanelProposal[]): string {
	return `Brief:\n${briefText}\n\nIndependent proposals from the panel:\n\n${proposals.map(compactProposal).join("\n\n")}

Produce one map of the option space:
1. pathways: merge duplicates across panelists (union their pros/cons/risks, list everyone in proposedBy). Keep genuinely different options separate. If an important pathway is missing, add it with proposedBy ["orchestrator"].
2. consensus: trade-off statements all panelists who addressed them agree on.
3. disputes: genuine disagreements that matter for choosing between pathways — contradicting claims, confidence gaps > 0.4 on the same claim, or one panelist's important claim the others would reject. Ignore wording differences.
   - "factual": settleable by external sources (costs, limits, versions, documented behaviour, data).
   - "reasoning": inference, trade-off weighting or prediction that argument can settle.
   - "context": depends on the user's own situation or preferences.
   Give at least two positions per dispute with exact panelist names and claim refs like "gpt:c3".`;
}

// ---- Orchestrator: converge ----------------------------------------------------------------------

function pathwayLine(p: Pathway): string {
	return `${p.id}. ${p.name} [effort ${p.effort}; from ${p.proposedBy.join(", ")}] — ${p.summary}\n    + ${p.pros.join("; ")}\n    − ${p.cons.join("; ")}\n    ! ${p.risks.join("; ") || "none"}\n    best when: ${p.bestWhen}`;
}

export function convergePrompt(briefText: string, map: PathwayMap, resolutions: readonly Resolution[], threshold: number): string {
	const settled = resolutions
		.map((r) => `- ${map.disputes.find((d) => d.id === r.disputeId)?.topic ?? r.disputeId}: ${r.verdict} (${r.method}, conf ${r.confidence.toFixed(2)})`)
		.join("\n");
	const open = map.disputes
		.filter((d) => !resolutions.some((r) => r.disputeId === d.id))
		.map((d) => `- ${d.topic}: ${d.crux}`)
		.join("\n");
	return `Brief:\n${briefText}

Pathways:
${map.pathways.map(pathwayLine).join("\n")}

Settled disputes (treat as ground truth):
${settled || "- none"}

Still open:
${open || "- none"}

1. Re-rate goalClarity now that you have the user's directions.
2. Rank every pathway by fit with the goal, using the settled facts.
3. Only if goalClarity ≥ ${threshold}: recommend one pathway with rationale, the conditions under which you'd change your mind, and the first concrete steps. Otherwise omit the recommendation and give the decisionCriteria that would settle the choice.
4. summary: a short Markdown overview for the user.`;
}

// ---- Dispute resolution --------------------------------------------------------------------------

export const CROSS_EXAM_SYSTEM = `You are a panelist being cross-examined. Update honestly: concede when the other side is right, refine when both are partly right, rebut only with a concrete argument or evidence. Changing your mind when warranted is a success, not a failure.`;

export function crossExamPrompt(question: string, dispute: Dispute, mine: number, history: readonly string[]): string {
	const own = dispute.positions[mine];
	const others = dispute.positions
		.map((p, i) => (i === mine ? "" : `- Position ${i} (held by ${p.panelists.join(", ")}): ${p.stance}`))
		.filter(Boolean)
		.join("\n");
	const transcript = history.length ? `\n\nDebate so far:\n${history.join("\n")}` : "";
	return `Context:\n${question}

Disputed point: ${dispute.topic}
Crux: ${dispute.crux}

Your position: ${own.stance}
Opposing position(s):
${others}${transcript}

Respond to the opposing position(s): concede, refine, or rebut.`;
}

export const JUDGE_SYSTEM = `You are an impartial judge resolving a disagreement between AI panelists. You are not one of them. Weigh arguments and evidence, not the number of panelists on each side. If no side is clearly right, say what is most likely true and set winningPosition to -1.`;

export function judgePrompt(question: string, dispute: Dispute, trail: readonly string[]): string {
	const positions = dispute.positions.map((p, i) => `${i}. (${p.panelists.join(", ")}) ${p.stance}`).join("\n");
	const extra = trail.length ? `\n\nEvidence and debate:\n${trail.join("\n").slice(0, 12000)}` : "";
	return `Context:\n${question}\n\nDispute: ${dispute.topic}\nCrux: ${dispute.crux}\n\nPositions:\n${positions}${extra}`;
}

export function evidenceTask(question: string, dispute: Dispute): string {
	const positions = dispute.positions.map((p, i) => `${i}. ${p.stance}`).join("\n");
	return `Settle this factual disagreement with sources.

Context (what is being decided):
${question}

Crux: ${dispute.crux}

Competing positions:
${positions}

Find authoritative, current sources. In your VERDICT line, say which position number is correct (or that neither is and what is true).`;
}
