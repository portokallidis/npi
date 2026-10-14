import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AgentDef, loadAgentDefs } from "../core/agents.ts";
import { ArtifactStore } from "../core/artifacts.ts";
import { HARNESS_ROOT, type HarnessConfig, loadHarnessConfig } from "../core/config.ts";
import { type Llm, registryLlm } from "../core/llm.ts";
import { createSessionRunner, type SubagentRunner } from "../core/subagent.ts";

/** Everything the harness extensions share for one session. */
export interface HarnessRuntime {
	agentDir: string;
	config: HarnessConfig;
	llm: Llm;
	runner: SubagentRunner;
	/** One artifact folder per session run: full subagent reports, offloaded tool output, panel answers. */
	artifacts: ArtifactStore;
	/** Packaged agents, then ~/.harness/agent/agents, then the trusted project's .pi/agents. */
	agents(): Map<string, AgentDef>;
}

export function createRuntime(ctx: ExtensionContext): HarnessRuntime {
	const agentDir = getAgentDir();
	const config = loadHarnessConfig(agentDir);
	const llm = registryLlm(ctx.modelRegistry);
	const artifacts = new ArtifactStore(ctx.cwd, config.context.artifactDir);
	const runner = createSessionRunner({
		cwd: ctx.cwd,
		agentDir,
		llm,
		fallbackModels: () => config.routes[config.router.defaultRoute]?.models ?? [],
		artifacts,
		mcpCatalogue: config.mcpServers,
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
		agents: () =>
			loadAgentDefs([
				join(HARNESS_ROOT, "agents"),
				join(agentDir, "agents"),
				...(ctx.isProjectTrusted() ? [join(ctx.cwd, CONFIG_DIR_NAME, "agents")] : []),
			]),
	};
}

/** Lazily (re)create the runtime per session; config errors surface as notifications, not crashes. */
export function runtimeHolder() {
	let runtime: HarnessRuntime | undefined;
	return {
		get(ctx: ExtensionContext): HarnessRuntime {
			runtime ??= createRuntime(ctx);
			return runtime;
		},
		reset() {
			runtime = undefined;
		},
	};
}
