import type { AgentDef } from "./agents.ts";
import { mapPool } from "./pool.ts";
import type { SubagentResult, SubagentRunner } from "./subagent.ts";

export interface DelegateTask {
	agent: string;
	task: string;
	model?: string;
}

export interface DelegateParams {
	agent?: string;
	task?: string;
	model?: string;
	tasks?: DelegateTask[];
	chain?: DelegateTask[];
}

export interface DelegateOptions {
	agents: Map<string, AgentDef>;
	runner: SubagentRunner;
	maxConcurrency: number;
	maxParallelTasks: number;
	signal?: AbortSignal;
	onProgress?: (line: string) => void;
}

export type DelegateMode = "single" | "parallel" | "chain";

export function delegateMode(params: DelegateParams): DelegateMode {
	const modes = [params.agent || params.task ? "single" : "", params.tasks?.length ? "parallel" : "", params.chain?.length ? "chain" : ""].filter(
		Boolean,
	) as DelegateMode[];
	if (modes.length !== 1) throw new Error("Provide exactly one of {agent, task}, {tasks: [...]}, or {chain: [...]}");
	return modes[0];
}

function lookup(agents: Map<string, AgentDef>, name: string): AgentDef {
	const def = agents.get(name);
	if (!def) throw new Error(`Unknown agent "${name}". Available: ${[...agents.keys()].join(", ") || "none"}`);
	return def;
}

/**
 * Run subagents in one of three modes:
 * - single:   { agent, task }
 * - parallel: { tasks: [...] } (bounded concurrency)
 * - chain:    { chain: [...] } where "{previous}" in a task is replaced by the prior step's output;
 *             the chain stops at the first failing step.
 */
export async function runDelegate(params: DelegateParams, options: DelegateOptions): Promise<SubagentResult[]> {
	const mode = delegateMode(params);
	const run = (t: DelegateTask) =>
		options.runner.run({
			agent: lookup(options.agents, t.agent),
			task: t.task,
			model: t.model,
			signal: options.signal,
			onProgress: options.onProgress,
		});

	if (mode === "single") {
		if (!params.agent || !params.task) throw new Error("Single mode needs both agent and task");
		return [await run({ agent: params.agent, task: params.task, model: params.model })];
	}
	if (mode === "parallel") {
		const tasks = params.tasks!;
		if (tasks.length > options.maxParallelTasks) throw new Error(`At most ${options.maxParallelTasks} parallel tasks`);
		tasks.forEach((t) => lookup(options.agents, t.agent));
		return mapPool(tasks, options.maxConcurrency, run);
	}
	const results: SubagentResult[] = [];
	let previous = "";
	for (const step of params.chain!) {
		const result = await run({ ...step, task: step.task.replaceAll("{previous}", previous) });
		results.push(result);
		if (result.error) break;
		previous = result.text;
	}
	return results;
}

export function formatResults(results: readonly SubagentResult[]): string {
	return results
		.map((r) => {
			const head = `### ${r.agent} (${r.model}, ${r.usage.turns} turns, $${r.usage.costUSD.toFixed(4)})`;
			const full = r.artifact ? `\n_Full report: ${r.artifact} (read it only if the summary is not enough)_` : "";
			const body = r.error ? `FAILED: ${r.error}${r.text ? `\n${r.text}` : ""}` : r.text || "(no output)";
			return `${head}\n${body}${full}`;
		})
		.join("\n\n");
}
