import type { AgentDef } from "../../core/agents.ts";
import type { Budget } from "../../core/budget.ts";
import type { Llm } from "../../core/llm.ts";
import type { SubagentRunner } from "../../core/subagent.ts";
import type { Panelist, Position } from "../types.ts";

/** How the pipeline talks to the human; absent in non-interactive modes. */
export interface UserChannel {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

export interface ResolveContext {
	question: string;
	llm: Llm;
	budget: Budget;
	panel: readonly Panelist[];
	judgeModel: string;
	crossExamRounds: number;
	runner?: SubagentRunner;
	evidenceAgent?: AgentDef;
	user?: UserChannel;
	signal?: AbortSignal;
}

/** The panelist who argues for a position: first named holder, else the owner of its first claim ref. */
export function representative(position: Position, panel: readonly Panelist[]): Panelist | undefined {
	const ids = [...position.panelists, ...position.claimRefs.map((ref) => ref.split(":")[0])];
	return ids.map((id) => panel.find((p) => p.id === id)).find((p): p is Panelist => !!p);
}
