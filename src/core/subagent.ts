import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	createAgentSession,
	createMcpExtension,
	DefaultResourceLoader,
	type InlineExtension,
	type LoadedMcpConfig,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "./agents.ts";
import { type ArtifactStore, extractSummary } from "./artifacts.ts";
import { commitAll, diffStat, gitRoot, worktreeAdd } from "./gitsnap.ts";
import { NPI_ROOT } from "./config.ts";
import { firstAvailable, type Llm, parseModelRef } from "./llm.ts";
import { decide, type GuardConfig, type PolicyLevel, sandboxCommand } from "./policy.ts";
import { withTimeout } from "./pool.ts";

export interface SubagentUsage {
	input: number;
	output: number;
	costUSD: number;
	turns: number;
	/** Largest single-request context the subagent used, in tokens. */
	peakContextTokens: number;
}

export interface SubagentRequest {
	agent: AgentDef;
	task: string;
	/** Overrides the agent's model preferences. */
	model?: string;
	signal?: AbortSignal;
	onProgress?: (line: string) => void;
	/** Policy inherited from the calling mode. Subagents have no UI, so "ask" means block. Default: readonly. */
	policy?: { level: PolicyLevel; sandboxed: boolean };
	/** Run in this directory instead of the session cwd (e.g. a git worktree). */
	cwd?: string;
}

export interface SubagentResult {
	agent: string;
	model: string;
	/** Caller-facing summary only (the agent's "## Summary" section, capped). */
	text: string;
	/** Path of the full report + tool trace, relative to cwd. */
	artifact?: string;
	usage: SubagentUsage;
	error?: string;
}

/** Runs one subagent to completion. Fakeable for tests. */
export interface SubagentRunner {
	run(request: SubagentRequest): Promise<SubagentResult>;
}

export interface SessionRunnerOptions {
	cwd: string;
	agentDir: string;
	llm: Llm;
	/** Used when the agent definition names no available model. */
	fallbackModels: () => readonly string[];
	artifacts: ArtifactStore;
	/** Defaults; agent frontmatter can override per agent. */
	contextTokens: number;
	summaryTokens: number;
	timeoutMs: number;
	guard: GuardConfig;
	/** npi MCP catalogue (npi.json `mcpServers`); agents' `mcp` names resolve here, then in mcp.json. */
	mcpCatalogue?: Record<string, unknown>;
	/** Defaults to a runtime reading the agent dir's models.json and auth (tests inject one). */
	modelRuntime?: Promise<ModelRuntime>;
}

const NPI_EXTENSIONS_DIR = resolve(NPI_ROOT, "src", "extensions").toLowerCase();

export function reportingContract(summaryTokens: number, contextTokens: number): string {
	return `## Reporting contract
Your caller sees ONLY the "## Summary" section of your final message (at most ~${summaryTokens} tokens). Everything else you write is saved to a file the caller can open if it needs detail, so put long material (full findings, tables, logs) above the summary, never in it.
End your final message with:
## Summary
<the result itself: answer, key facts, decisions, file paths and source URLs. No narration of your process.>
Your working budget is ~${contextTokens} tokens of context. Be economical: fetch only what you need, prefer targeted reads/searches, and stop as soon as the task is answered.`;
}

const WRAP_UP =
	"Context budget reached. Stop gathering information now and write your final message with the ## Summary section, using what you already have. Note anything left unverified.";

/** Only the MCP servers the agent asked for, with their tools declared directly. */
function mcpConfigFor(agentDir: string, servers: readonly string[], catalogue: Record<string, unknown> = {}): LoadedMcpConfig {
	const path = join(agentDir, "mcp.json");
	const all = { ...catalogue, ...(existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")).mcpServers ?? {}) : {}) };
	const missing = servers.filter((name) => !all[name]);
	return {
		servers: servers
			.filter((name) => all[name])
			.map((name) => ({ name, config: { ...all[name], exposure: "direct" }, source: path, scope: "global" as const })),
		errors: missing.map((name) => `MCP server "${name}" is not defined in ${path}`),
	};
}

/**
 * Runs each subagent as an in-memory pi AgentSession in this process: its own model, context window,
 * tool selection and MCP servers, with the user's packages (e.g. pi-web-access) but without the npi
 * extensions themselves, so subagents cannot recurse into delegate/brainstorm.
 *
 * Context discipline: the subagent is told its budgets; at its context budget it is steered to wrap up and
 * at 1.5x it is stopped. The caller gets only the summary; the full report and tool trace go to an artifact.
 */
export function createSessionRunner(options: SessionRunnerOptions): SubagentRunner {
	let runtime = options.modelRuntime;

	async function pickModel(request: SubagentRequest): Promise<string> {
		const prefs = [request.model, ...(request.agent.models ?? []), ...options.fallbackModels()].filter(
			(ref): ref is string => !!ref,
		);
		const ref = await firstAvailable(options.llm, prefs);
		if (!ref) throw new Error(`No available model for agent "${request.agent.name}" (tried ${prefs.join(", ")})`);
		return ref;
	}

	return {
		async run(request) {
			const { agent } = request;
			const contextTokens = agent.contextTokens ?? options.contextTokens;
			const summaryTokens = agent.summaryTokens ?? options.summaryTokens;
			const usage: SubagentUsage = { input: 0, output: 0, costUSD: 0, turns: 0, peakContextTokens: 0 };
			const trace: string[] = [];
			let modelRef = request.model ?? agent.models?.[0] ?? "?";
			let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
			let overBudget = false;

			const saveArtifact = (body: string) =>
				options.artifacts.write(
					`${agent.name}`,
					`# ${agent.name} (${modelRef})\n\n## Task\n${request.task}\n\n## Report\n${body || "(no output)"}\n\n## Tool trace\n${trace.join("\n") || "(none)"}\n\n## Usage\n${JSON.stringify(usage)}\n`,
				);

			try {
				modelRef = await pickModel(request);
				runtime ??= ModelRuntime.create();
				const modelRuntime = await runtime;
				const { provider, id } = parseModelRef(modelRef);
				const model = modelRuntime.getModel(provider, id);
				if (!model) throw new Error(`Model ${modelRef} not found`);

				// Worktree isolation: a fresh branch per run, so parallel coders never collide.
				let cwd = request.cwd ?? options.cwd;
				let worktree: { path: string; branch: string } | undefined;
				if (agent.isolation === "worktree" && !request.cwd) {
					const root = await gitRoot(options.cwd);
					if (!root) throw new Error(`Agent "${agent.name}" needs a git repository for worktree isolation`);
					const id = `${agent.name}-${Date.now().toString(36)}`;
					worktree = { path: join(root, ".npi", "worktrees", id), branch: `npi/${id}` };
					await worktreeAdd(root, worktree.path, worktree.branch);
					cwd = worktree.path;
				}
				const policy = request.policy ?? { level: "readonly" as PolicyLevel, sandboxed: false };
				const extensionFactories: InlineExtension[] = [
					(pi) => {
						pi.on("tool_call", (event) => {
							const hints = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations;
							const input = event.input as Record<string, unknown>;
							const d = decide(policy.level, { tool: event.toolName, input, hints }, options.guard, { cwd, home: homedir(), sandboxed: policy.sandboxed });
							if (d.action !== "allow") return { block: true, reason: `Blocked (${policy.level} policy, no approver in a subagent): ${d.reason}` };
							if (policy.sandboxed && event.toolName === "bash" && typeof input.command === "string") {
								input.command = sandboxCommand(input.command, cwd, options.guard);
							}
							return undefined;
						});
					},
				];
				if (agent.mcp?.length) {
					const servers = agent.mcp;
					extensionFactories.push(createMcpExtension({ loadConfig: () => mcpConfigFor(options.agentDir, servers, options.mcpCatalogue) }));
				}
				const resourceLoader = new DefaultResourceLoader({
					cwd,
					agentDir: options.agentDir,
					extensionFactories,
					disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
					extensionsOverride: (base) => ({
						...base,
						extensions: base.extensions.filter(
							(ext) => !resolve(ext.resolvedPath || ext.path).toLowerCase().startsWith(NPI_EXTENSIONS_DIR),
						),
					}),
					appendSystemPrompt: [agent.systemPrompt, reportingContract(summaryTokens, contextTokens)].filter(Boolean),
				});
				await resourceLoader.reload();

				({ session } = await createAgentSession({
					cwd,
					agentDir: options.agentDir,
					modelRuntime,
					model,
					thinkingLevel: agent.thinking ?? "medium",
					resourceLoader,
					sessionManager: SessionManager.inMemory(cwd),
				}));
				const live = session;
				await live.bindExtensions({});
				// MCP tools with direct exposure activate themselves when their server connects.
				if (agent.tools) live.setActiveToolsByName(agent.tools);

				let steered = false;
				live.subscribe((event) => {
					if (event.type === "message_end" && event.message.role === "assistant") {
						const u = event.message.usage;
						usage.turns++;
						usage.input += u.input;
						usage.output += u.output;
						usage.costUSD += u.cost.total;
						const context = u.input + u.cacheRead + u.cacheWrite;
						usage.peakContextTokens = Math.max(usage.peakContextTokens, context);
						if (context > contextTokens * 1.5) {
							overBudget = true;
							void live.abort();
						} else if (context > contextTokens && !steered) {
							steered = true;
							void live.steer(WRAP_UP);
						}
					} else if (event.type === "tool_execution_start") {
						trace.push(`- ${event.toolName} ${JSON.stringify(event.args).slice(0, 300)}`);
						request.onProgress?.(`${agent.name}: ${event.toolName}`);
					}
				});
				const onAbort = () => void live.abort();
				request.signal?.addEventListener("abort", onAbort, { once: true });
				try {
					await withTimeout(live.prompt(request.task), options.timeoutMs, `agent ${agent.name}`, onAbort);
				} finally {
					request.signal?.removeEventListener("abort", onAbort);
				}
				const full = live.getLastAssistantText() ?? "";
				const artifact = saveArtifact(full);
				let note = "";
				if (worktree) {
					const stat = await diffStat(worktree.path).catch(() => "");
					const subject = `${agent.name}: ${request.task.split("\n")[0].slice(0, 72)}`;
					const sha = await commitAll(worktree.path, subject).catch(() => undefined);
					note = sha
						? `\n\nChanges committed on branch ${worktree.branch} (${sha}) in ${worktree.path}:\n${stat}\nReview: git diff HEAD...${worktree.branch} · merge: git merge ${worktree.branch}`
						: `\n\nNo file changes (worktree ${worktree.path}).`;
				}
				return {
					agent: agent.name,
					model: modelRef,
					text: extractSummary(full, summaryTokens) + note,
					artifact,
					usage,
					error: overBudget ? `stopped at 1.5x its ${contextTokens}-token context budget (partial result)` : undefined,
				};
			} catch (error) {
				const message = (error as Error).message;
				return { agent: agent.name, model: modelRef, text: "", artifact: saveArtifact(`FAILED: ${message}`), usage, error: message };
			} finally {
				session?.dispose();
			}
		},
	};
}
