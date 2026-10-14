import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatResults, runDelegate } from "../../core/delegate.ts";
import type { SubagentResult } from "../../core/subagent.ts";
import { routeAgents } from "../../core/router.ts";
import { runtimeHolder } from "../runtime.ts";

const ROUTE_CHANNEL = "harness:route";

const Task = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Self-contained task. In a chain, {previous} is replaced by the prior step's output." }),
	model: Type.Optional(Type.String({ description: "Override model as provider/model-id" })),
});

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single mode: agent name" })),
	task: Type.Optional(Type.String({ description: "Single mode: the task" })),
	model: Type.Optional(Type.String({ description: "Single mode: override model as provider/model-id" })),
	tasks: Type.Optional(Type.Array(Task, { description: "Parallel mode: independent tasks run concurrently" })),
	chain: Type.Optional(Type.Array(Task, { description: "Chain mode: sequential steps" })),
});

export default function subagents(pi: ExtensionAPI) {
	const runtime = runtimeHolder();
	let route: string | undefined;
	pi.on("session_start", () => runtime.reset());
	pi.events.on(ROUTE_CHANNEL, (name) => {
		route = typeof name === "string" ? name : undefined;
	});

	pi.registerTool<typeof Params, { results: SubagentResult[] }>({
		name: "delegate",
		label: "Delegate",
		description:
			"Delegate work to specialized subagents, each with its own context window, model and tools. " +
			"Modes: single {agent, task}; parallel {tasks: [...]}; chain {chain: [...]} using {previous}. " +
			"Tasks must be self-contained: subagents do not see this conversation. Use /agents to list agents.",
		promptSnippet: "Delegate self-contained tasks to subagents (researcher, browser, scout, coder, ...)",
		promptGuidelines: [
			"Use delegate for independent research or exploration that would flood this context; give each subagent a complete, self-contained task.",
			"Run independent delegate tasks in parallel mode rather than one by one.",
		],
		parameters: Params,
		async execute(_id, params, signal, onUpdate, ctx) {
			const rt = runtime.get(ctx);
			// Only the agents the active route allows.
			const agents = routeAgents(rt.config, route, rt.agents());
			const progress: string[] = [];
			const results = await runDelegate(params, {
				agents,
				runner: rt.runner,
				maxConcurrency: rt.config.subagents.maxConcurrency,
				maxParallelTasks: rt.config.subagents.maxParallelTasks,
				signal,
				onProgress(line) {
					progress.push(line);
					onUpdate?.({ content: [{ type: "text", text: progress.slice(-6).join("\n") }], details: { results: [] } });
				},
			});
			const cost = results.reduce((sum, r) => sum + r.usage.costUSD, 0);
			const input = results.reduce((sum, r) => sum + r.usage.input, 0);
			const output = results.reduce((sum, r) => sum + r.usage.output, 0);
			return {
				content: [{ type: "text", text: formatResults(results) }],
				details: { results },
				isError: results.every((r) => r.error),
				usage: {
					input,
					output,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: input + output,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
				},
			};
		},
	});

	pi.registerCommand("agents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			const agents = [...runtime.get(ctx).agents().values()];
			const lines = agents.map((a) => `${a.name} — ${a.description}\n    model: ${a.models?.join(" > ") ?? "default"}  tools: ${a.tools?.join(", ") ?? "default"}${a.mcp ? `  mcp: ${a.mcp.join(", ")}` : ""}`);
			ctx.ui.notify(lines.join("\n") || "No agents found", "info");
		},
	});
}
