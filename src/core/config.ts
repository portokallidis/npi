import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** Root of the harness package (contains config/, agents/, skills/). */
export const HARNESS_ROOT = process.env.HARNESS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const Thinking = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);

const RouteSchema = Type.Object({
	description: Type.String(),
	/** Ordered model preferences; the first available one is used. */
	models: Type.Array(Type.String()),
	thinking: Type.Optional(Thinking),
	tools: Type.Array(Type.String()),
	/** Deferred/MCP tools to declare up front for this route. */
	promote: Type.Optional(Type.Array(Type.String())),
	/** Case-insensitive regexes; a match routes here without calling the classifier. */
	keywords: Type.Optional(Type.Array(Type.String())),
	/** Extra guideline appended to the system prompt while this route is active. */
	prompt: Type.Optional(Type.String()),
	/** Skills listed in the system prompt for this route (others stay usable via /skill:name). Omit = all. */
	skills: Type.Optional(Type.Array(Type.String())),
	/** MCP servers from `mcpServers` to connect (lazily, first time this route is used). */
	mcp: Type.Optional(Type.Array(Type.String())),
	/** Subagents `delegate` may use on this route. Omit = all. */
	agents: Type.Optional(Type.Array(Type.String())),
	/** readonly | ask | auto (auto only takes effect with sandbox). Default: guard.defaultPolicy. */
	policy: Type.Optional(Type.Union([Type.Literal("readonly"), Type.Literal("ask"), Type.Literal("auto")])),
	/** Run shell commands in a throwaway Docker container with only the project mounted. */
	sandbox: Type.Optional(Type.Boolean()),
});

const PanelistSchema = Type.Object({
	id: Type.String(),
	model: Type.String(),
	thinking: Type.Optional(Thinking),
	/** Optional persona/system addendum for this panelist. */
	persona: Type.Optional(Type.String()),
});

export const HarnessConfigSchema = Type.Object({
	router: Type.Object({
		classifierModels: Type.Array(Type.String()),
		classifierTimeoutMs: Type.Number(),
		minConfidence: Type.Number(),
		defaultRoute: Type.String(),
		alwaysTools: Type.Array(Type.String()),
	}),
	routes: Type.Record(Type.String(), RouteSchema),
	/** MCP server catalogue (same shape as mcp.json entries). Servers connect only when a route or agent needs them. */
	mcpServers: Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())),
	guard: Type.Object({
		defaultPolicy: Type.Union([Type.Literal("readonly"), Type.Literal("ask"), Type.Literal("auto")]),
		protectedPaths: Type.Array(Type.String()),
		askCommands: Type.Array(Type.String()),
		readonlyCommands: Type.Array(Type.String()),
		readonlyTools: Type.Array(Type.String()),
		askTools: Type.Array(Type.String()),
		sandboxImage: Type.String(),
		sandboxNetwork: Type.String(),
	}),
	/** Context discipline: what may enter a context window, and where everything else goes. */
	context: Type.Object({
		/** Full outputs (subagent reports, big tool results, panel answers) are written here, relative to cwd. */
		artifactDir: Type.String(),
		/** Main-session tool results longer than this are offloaded to an artifact... */
		toolResultInlineChars: Type.Number(),
		/** ...and replaced by a preview of this many chars plus the artifact path. */
		toolResultPreviewChars: Type.Number(),
		/** Default per-subagent budgets; agent frontmatter `contextTokens` / `summaryTokens` override. */
		subagentContextTokens: Type.Number(),
		subagentSummaryTokens: Type.Number(),
	}),
	subagents: Type.Object({
		maxConcurrency: Type.Number(),
		maxParallelTasks: Type.Number(),
		timeoutMs: Type.Number(),
	}),
	brainstorm: Type.Object({
		/** Top frontier model(s) that frame the problem, map pathways and write the recommendation. */
		orchestrator: Type.Array(Type.String()),
		panel: Type.Array(PanelistSchema),
		minPanelists: Type.Number(),
		judge: Type.Array(Type.String()),
		evidenceAgent: Type.String(),
		maxDirectionQuestions: Type.Number(),
		maxPathwaysPerPanelist: Type.Number(),
		maxDisputes: Type.Number(),
		crossExamRounds: Type.Number(),
		/** Recommend a pathway only when the orchestrator rates goal clarity at least this high. */
		recommendThreshold: Type.Number(),
		askUser: Type.Boolean(),
		maxCostUSD: Type.Number(),
		callTimeoutMs: Type.Number(),
		maxOutputTokens: Type.Object({ panelist: Type.Number(), orchestrator: Type.Number() }),
		reportDir: Type.String(),
	}),
});

export type HarnessConfig = Static<typeof HarnessConfigSchema>;
export type RouteConfig = Static<typeof RouteSchema>;
export type PanelistConfig = Static<typeof PanelistSchema>;
export type ThinkingLevel = Static<typeof Thinking>;

/**
 * Load harness.json: `<agentDir>/harness.json` if present, else the packaged default.
 * Throws with readable schema errors when the file is invalid.
 */
export function loadHarnessConfig(agentDir: string): HarnessConfig {
	const userPath = join(agentDir, "harness.json");
	const path = existsSync(userPath) ? userPath : join(HARNESS_ROOT, "config", "harness.json");
	const raw = JSON.parse(readFileSync(path, "utf8"));
	delete raw.$comment;
	if (!Value.Check(HarnessConfigSchema, raw)) {
		const errors = [...Value.Errors(HarnessConfigSchema, raw)]
			.slice(0, 5)
			.map((e) => `${e.instancePath || "/"} ${e.message}`);
		throw new Error(`Invalid ${path}:\n  ${errors.join("\n  ")}`);
	}
	return raw;
}
