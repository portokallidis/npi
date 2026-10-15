import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** Root of the npi package (contains config/, agents/, skills/). */
export const NPI_ROOT = process.env.NPI_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
	/** Extra model lists per effort tier (tried before `models`, which is the standard tier). */
	tiers: Type.Optional(Type.Object({ light: Type.Optional(Type.Array(Type.String())), heavy: Type.Optional(Type.Array(Type.String())) })),
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

export const NpiConfigSchema = Type.Object({
	/** Active launch-time profile (set by the loader from config/profiles/<name>.json, not written by hand). */
	profile: Type.Optional(
		Type.Object({
			name: Type.String(),
			description: Type.Optional(Type.String()),
			/** Markdown appended to the system prompt in every route of this profile. */
			prompt: Type.Optional(Type.String()),
		}),
	),
	router: Type.Object({
		classifierModels: Type.Array(Type.String()),
		/** Optional HTTP decision model tried before classifierModels: POST {text, routes, tiers} -> {route, confidence, tier?}. */
		classifierEndpoint: Type.Optional(Type.String()),
		classifierTimeoutMs: Type.Number(),
		minConfidence: Type.Number(),
		defaultRoute: Type.String(),
		alwaysTools: Type.Array(Type.String()),
		/** Send a 1-token request to the first available classifier model at session start (loads local models). */
		prewarm: Type.Boolean(),
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
	/** Post-edit checks: after a run that changed matching files, run these and send failures back to the model. */
	checks: Type.Optional(
		Type.Array(Type.Object({ glob: Type.String(), command: Type.String(), timeoutMs: Type.Optional(Type.Number()) })),
	),
	/** Project ledger (invariants, decisions, failed approaches, open questions), injected into every prompt. */
	ledger: Type.Optional(Type.Object({ file: Type.String(), promptChars: Type.Number() })),
	/** Long-term memory: notes in <agentDir>/<dir>; #pin notes are always in the prompt (capped). */
	memory: Type.Object({ dir: Type.String(), pinnedChars: Type.Number() }),
	/** JSONL traces of routing, model calls, tools and subagents in <agentDir>/<dir> (see /stats). */
	telemetry: Type.Object({ enabled: Type.Boolean(), dir: Type.String() }),
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
		/** Small (ideally local) models that digest oversized tool output; [] = plain preview only. */
		digestModels: Type.Array(Type.String()),
		digestMaxInputChars: Type.Number(),
		digestTimeoutMs: Type.Number(),
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
		/** Personas for extra panelists when fewer distinct models than minPanelists are available. */
		fallbackPersonas: Type.Array(Type.String()),
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
	/** Literature-review pipeline (see src/science). */
	science: Type.Object({
		orchestrator: Type.Array(Type.String()),
		/** Two available screeners are used, preferably from different providers. */
		screeners: Type.Array(Type.String()),
		extractor: Type.Array(Type.String()),
		verifier: Type.Array(Type.String()),
		sources: Type.Array(Type.Union([Type.Literal("openalex"), Type.Literal("semanticscholar"), Type.Literal("pubmed"), Type.Literal("arxiv")])),
		maxDirectionQuestions: Type.Number(),
		maxQueries: Type.Number(),
		perQuery: Type.Number(),
		maxCandidates: Type.Number(),
		maxIncluded: Type.Number(),
		askUser: Type.Boolean(),
		maxCostUSD: Type.Number(),
		reportDir: Type.String(),
	}),
});

export type NpiConfig = Static<typeof NpiConfigSchema>;
export type RouteConfig = Static<typeof RouteSchema>;
export type PanelistConfig = Static<typeof PanelistSchema>;
export type ThinkingLevel = Static<typeof Thinking>;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Overlay `patch` onto `base`: objects merge recursively, arrays and scalars replace, `null` deletes the key. */
export function deepMerge(base: Json, patch: Json): Json {
	const out: Json = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (key === "$comment") continue;
		if (value === null) delete out[key];
		else if (isObject(value) && isObject(out[key])) out[key] = deepMerge(out[key] as Json, value);
		else out[key] = value;
	}
	return out;
}

const readJson = (path: string): Json => JSON.parse(readFileSync(path, "utf8"));

/** Packaged then user profile files (both optional, at least one required); `prompt` names a .md next to the file. */
function loadProfile(agentDir: string, name: string): { overlay: Json; profile: NonNullable<NpiConfig["profile"]> } {
	if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid profile name "${name}"`);
	const files = [join(NPI_ROOT, "config", "profiles", `${name}.json`), join(agentDir, "profiles", `${name}.json`)].filter((f) => existsSync(f));
	if (!files.length) throw new Error(`Unknown profile "${name}" (looked in config/profiles and ${join(agentDir, "profiles")})`);
	let overlay: Json = {};
	const profile: NonNullable<NpiConfig["profile"]> = { name };
	for (const file of files) {
		const { description, prompt, ...rest } = readJson(file) as Json & { description?: string; prompt?: string };
		overlay = deepMerge(overlay, rest);
		if (description) profile.description = description;
		if (prompt) profile.prompt = readFileSync(join(dirname(file), prompt), "utf8").trim();
	}
	return { overlay, profile };
}

export interface LoadOptions {
	/** Profile name; default NPI_PROFILE, then the trusted project's `.pi/npi.json` "profile". None = every route. */
	profile?: string;
	/** Trusted project directory whose `.pi/npi.json` is overlaid last. Omit for untrusted projects. */
	projectDir?: string;
}

/**
 * Load npi.json: `<agentDir>/npi.json` if present, else the packaged default; then the profile overlay;
 * then the trusted project's `.pi/npi.json`. Throws with readable schema errors when the result is invalid.
 */
export function loadNpiConfig(agentDir: string, options: LoadOptions = {}): NpiConfig {
	const userPath = join(agentDir, "npi.json");
	const path = existsSync(userPath) ? userPath : join(NPI_ROOT, "config", "npi.json");
	let raw = readJson(path);
	delete raw.$comment;

	const projectPath = options.projectDir ? join(options.projectDir, ".pi", "npi.json") : undefined;
	const project = projectPath && existsSync(projectPath) ? readJson(projectPath) : undefined;
	const profileName = options.profile ?? (process.env.NPI_PROFILE || undefined) ?? (project?.profile as string | undefined);
	if (profileName) {
		const { overlay, profile } = loadProfile(agentDir, profileName);
		raw = { ...deepMerge(raw, overlay), profile };
	}
	if (project) {
		const { profile: _name, ...rest } = project;
		raw = deepMerge(raw, rest);
	}
	const routes = raw.routes as Json | undefined;
	const router = raw.router as Json | undefined;
	if (routes && router && !routes[router.defaultRoute as string]) {
		throw new Error(`Invalid config (${path}${profileName ? ` + profile ${profileName}` : ""}): defaultRoute "${router.defaultRoute}" is not a route`);
	}
	if (!Value.Check(NpiConfigSchema, raw)) {
		const errors = [...Value.Errors(NpiConfigSchema, raw)]
			.slice(0, 5)
			.map((e) => `${e.instancePath || "/"} ${e.message}`);
		throw new Error(`Invalid ${path}${profileName ? ` + profile ${profileName}` : ""}:\n  ${errors.join("\n  ")}`);
	}
	return raw as NpiConfig;
}
