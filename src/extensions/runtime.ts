import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AgentDef, loadAgentDefs } from "../core/agents.ts";
import { ArtifactStore } from "../core/artifacts.ts";
import { BenchRecorder } from "../core/bench.ts";
import { NPI_ROOT, type NpiConfig, loadNpiConfig } from "../core/config.ts";
import { type Llm, registryLlm } from "../core/llm.ts";
import { createSessionRunner, type SubagentRunner } from "../core/subagent.ts";

/** Everything the npi extensions share for one session. */
export interface NpiRuntime {
	agentDir: string;
	config: NpiConfig;
	llm: Llm;
	runner: SubagentRunner;
	/** One artifact folder per session run: full subagent reports, offloaded tool output, panel answers. */
	artifacts: ArtifactStore;
	/** Per-call benchmarks (time, TTFT, tokens/s per model and device); undefined when telemetry is off. */
	bench?: BenchRecorder;
	/** Packaged agents, then ~/.npi/agent/agents, then the trusted project's .pi/agents. */
	agents(): Map<string, AgentDef>;
}

export function createRuntime(ctx: ExtensionContext): NpiRuntime {
	const agentDir = getAgentDir();
	const config = loadNpiConfig(agentDir);
	// One benchmark file per day; every npi model call (classifier, digests, pipelines) is timed.
	const bench = config.telemetry.enabled ? new BenchRecorder(join(agentDir, config.telemetry.dir, "bench"), new Date().toISOString().slice(0, 10)) : undefined;
	const llm = registryLlm(ctx.modelRegistry, bench?.observe);
	const artifacts = new ArtifactStore(ctx.cwd, config.context.artifactDir);
	const runner = createSessionRunner({
		cwd: ctx.cwd,
		agentDir,
		llm,
		fallbackModels: () => config.routes[config.router.defaultRoute]?.models ?? [],
		artifacts,
		mcpCatalogue: config.mcpServers,
		guard: config.guard,
		contextTokens: config.context.subagentContextTokens,
		summaryTokens: config.context.subagentSummaryTokens,
		timeoutMs: config.subagents.timeoutMs,
	});
	return {
		agentDir,
		config,
		llm,
		runner,
		artifacts,
		bench,
		agents: () =>
			loadAgentDefs([
				join(NPI_ROOT, "agents"),
				join(agentDir, "agents"),
				...(ctx.isProjectTrusted() ? [join(ctx.cwd, CONFIG_DIR_NAME, "agents")] : []),
			]),
	};
}

/** Lazily (re)create the runtime per session; config errors surface as notifications, not crashes. */
export function runtimeHolder() {
	let runtime: NpiRuntime | undefined;
	return {
		get(ctx: ExtensionContext): NpiRuntime {
			runtime ??= createRuntime(ctx);
			return runtime;
		},
		reset() {
			runtime = undefined;
		},
	};
}
