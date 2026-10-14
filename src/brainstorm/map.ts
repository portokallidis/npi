import type { Budget } from "../core/budget.ts";
import type { Llm } from "../core/llm.ts";
import { callStructured } from "../core/structured.ts";
import { mapPrompt, ORCHESTRATOR_SYSTEM } from "./prompts.ts";
import { type Dispute, type MapOutput, MapSchema, type PanelProposal, type PathwayMap } from "./types.ts";

/**
 * Clean up the orchestrator's map: give pathways ids, keep only real panelist names, drop one-sided
 * disputes, rank disputes by importance, cap their number and give them ids.
 */
export function normalizeMap(raw: MapOutput, panelists: readonly string[], maxDisputes: number): PathwayMap {
	const known = new Set(panelists);
	const keep = (names: readonly string[]) => [...new Set(names.filter((n) => known.has(n)))];

	const disputes: Dispute[] = raw.disputes
		.map((d) => ({
			...d,
			positions: d.positions
				.map((p) => ({ ...p, panelists: keep(p.panelists) }))
				.filter((p) => p.panelists.length > 0 || p.claimRefs.length > 0),
		}))
		.filter((d) => d.positions.length >= 2)
		.sort((a, b) => b.importance - a.importance)
		.slice(0, maxDisputes)
		.map((d, i) => ({ id: `d${i + 1}`, ...d }));

	return {
		pathways: raw.pathways.map((p, i) => ({
			...p,
			id: `p${i + 1}`,
			proposedBy: [...new Set(p.proposedBy.filter((n) => known.has(n) || n === "orchestrator"))],
		})),
		consensus: raw.consensus.map((c) => ({ statement: c.statement, panelists: keep(c.panelists) })),
		disputes,
	};
}

export async function mapPathways(
	briefText: string,
	proposals: readonly PanelProposal[],
	options: { llm: Llm; budget: Budget; model: string; maxDisputes: number; maxTokens: number; signal?: AbortSignal },
): Promise<PathwayMap> {
	const raw = await callStructured(options.llm, options.budget, {
		model: options.model,
		label: "orchestrator:map",
		system: ORCHESTRATOR_SYSTEM,
		prompt: mapPrompt(briefText, proposals),
		schema: MapSchema,
		toolName: "submit_map",
		toolDescription: "Submit the merged pathway catalogue, consensus and disputes.",
		thinking: "high",
		maxTokens: options.maxTokens,
		signal: options.signal,
	});
	return normalizeMap(
		raw,
		proposals.map((p) => p.panelist),
		options.maxDisputes,
	);
}
