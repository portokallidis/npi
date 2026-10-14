import type { ArtifactStore } from "../core/artifacts.ts";
import type { Budget } from "../core/budget.ts";
import type { Llm } from "../core/llm.ts";
import { withTimeout } from "../core/pool.ts";
import { callStructured } from "../core/structured.ts";
import { PANELIST_SYSTEM, pathwaysPrompt } from "./prompts.ts";
import { type BrainstormConfig, type BrainstormEvent, type PanelProposal, type Panelist, PathwaysSchema } from "./types.ts";

export interface PanelSelection {
	panel: Panelist[];
	skipped: { id: string; reason: string }[];
}

/** Keep panelists whose model is reachable; at least `minPanelists` must remain. */
export async function selectPanel(config: BrainstormConfig, llm: Llm): Promise<PanelSelection> {
	const panel: Panelist[] = [];
	const skipped: PanelSelection["skipped"] = [];
	for (const p of config.panel) {
		if (await llm.available(p.model)) panel.push(p);
		else skipped.push({ id: p.id, reason: `${p.model} unavailable (no credentials or local server down)` });
	}
	// Persona fallback: too few distinct models (e.g. one local box, no keys) — reuse what is available
	// with contrasting personas. Weaker diversity than different models, so it is recorded in `skipped`.
	if (panel.length > 0 && panel.length < config.minPanelists) {
		const base = [...panel];
		for (let i = 0; panel.length < config.minPanelists && i < config.fallbackPersonas.length; i++) {
			const src = base[i % base.length];
			panel.push({ ...src, id: `${src.id}-alt${i + 1}`, persona: config.fallbackPersonas[i] });
		}
		skipped.push({ id: "diversity", reason: `only ${base.length} distinct model(s) available; extra panelists are the same model with different personas` });
	}
	if (panel.length < config.minPanelists) {
		const why = skipped.map((s) => `${s.id}: ${s.reason}`).join("; ");
		throw new Error(`Only ${panel.length} panelist(s) available, need ${config.minPanelists}. ${why}`);
	}
	return { panel, skipped };
}

export interface ProposeOptions {
	llm: Llm;
	budget: Budget;
	timeoutMs: number;
	maxPathways: number;
	maxTokens: number;
	artifacts?: ArtifactStore;
	signal?: AbortSignal;
	onEvent?: (event: BrainstormEvent) => void;
}

/** Every panelist explores the same brief in parallel. Failed panelists are reported, not fatal. */
export async function collectProposals(
	briefText: string,
	panel: readonly Panelist[],
	options: ProposeOptions,
): Promise<{ proposals: PanelProposal[]; failed: { id: string; reason: string }[] }> {
	const failed: { id: string; reason: string }[] = [];
	const settled = await Promise.all(
		panel.map(async (p) => {
			options.onEvent?.({ type: "panelist", id: p.id, status: "thinking" });
			try {
				const out = await withTimeout(
					callStructured(options.llm, options.budget, {
						model: p.model,
						label: `panel:${p.id}`,
						system: p.persona ? `${PANELIST_SYSTEM}\n\nYour perspective: ${p.persona}` : PANELIST_SYSTEM,
						prompt: pathwaysPrompt(briefText, options.maxPathways),
						schema: PathwaysSchema,
						toolName: "submit_pathways",
						toolDescription: "Submit your pathways with trade-offs and the claims they rest on.",
						thinking: p.thinking,
						maxTokens: options.maxTokens,
						signal: options.signal,
					}),
					options.timeoutMs,
					`panelist ${p.id}`,
				);
				const proposal: PanelProposal = { ...out, pathways: out.pathways.slice(0, options.maxPathways), panelist: p.id, model: p.model };
				proposal.artifact = options.artifacts?.write(`panel-${p.id}`, JSON.stringify(proposal, null, 2), "json");
				options.onEvent?.({ type: "panelist", id: p.id, status: "done", detail: `${proposal.pathways.length} pathways` });
				return proposal;
			} catch (error) {
				const reason = (error as Error).message;
				failed.push({ id: p.id, reason });
				options.onEvent?.({ type: "panelist", id: p.id, status: "failed", detail: reason });
				return undefined;
			}
		}),
	);
	return { proposals: settled.filter((a): a is PanelProposal => !!a), failed };
}
