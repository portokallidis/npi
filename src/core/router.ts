import { Type } from "typebox";
import { Budget } from "./budget.ts";
import type { NpiConfig, RouteConfig } from "./config.ts";
import { firstAvailable, type Llm } from "./llm.ts";
import { withTimeout } from "./pool.ts";
import { callStructured } from "./structured.ts";

export type RouteReason = "pinned" | "prefix" | "keyword" | "classifier" | "sticky" | "default";

/** Effort tier: picks the model list inside a route (light = cheap/fast, heavy = frontier reasoning). */
export type Tier = "light" | "standard" | "heavy";
export const TIERS: Tier[] = ["light", "standard", "heavy"];
export type TierReason = "pinned" | "prefix" | "classifier" | "sticky" | "default" | "escalated";

export interface RouteDecision {
	route: string;
	reason: RouteReason;
	confidence?: number;
	tier: Tier;
	tierReason: TierReason;
}

/** Prompts at least this long get a tier from the classifier even when a keyword/prefix/pin chose the route. */
const TIER_CLASSIFY_MIN_WORDS = 25;

/** "#heavy fix it" -> { tier: "heavy", text: "fix it" }. */
export function parseTierPrefix(text: string): { tier: Tier; text: string } | undefined {
	const match = text.match(/^#(light|standard|heavy)\s+([\s\S]*)$/);
	return match ? { tier: match[1] as Tier, text: match[2] } : undefined;
}

/** Model preferences for a tier: the tier's own list first, then the route's standard `models`. */
export function tierModels(route: RouteConfig, tier: Tier): string[] {
	const own = tier === "standard" ? [] : (route.tiers?.[tier] ?? []);
	return [...new Set([...own, ...route.models])];
}

/** One tier up (light -> standard -> heavy). */
export const escalateTier = (tier: Tier): Tier => TIERS[Math.min(TIERS.indexOf(tier) + 1, TIERS.length - 1)];

/** "#research what's new in X" -> { route: "research", text: "what's new in X" } (only for known routes). */
export function parsePrefix(text: string, routes: Record<string, RouteConfig>): { route: string; text: string } | undefined {
	// "#", not "@": pi uses "@path" for file references in the editor and CLI.
	const match = text.match(/^#([\w-]+)\s+([\s\S]*)$/);
	if (!match || !routes[match[1]]) return undefined;
	return { route: match[1], text: match[2] };
}

/** Route with the most keyword hits; undefined when nothing matches or the top score is tied. */
export function matchKeywords(text: string, routes: Record<string, RouteConfig>): string | undefined {
	const scores = Object.entries(routes)
		.map(([name, route]) => ({
			name,
			score: (route.keywords ?? []).filter((pattern) => {
				try {
					return new RegExp(pattern, "i").test(text);
				} catch {
					return false;
				}
			}).length,
		}))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score);
	if (!scores.length || (scores[1] && scores[1].score === scores[0].score)) return undefined;
	return scores[0].name;
}

export interface Classification {
	route: string;
	confidence: number;
	tier?: Tier;
}
export type Classifier = (text: string) => Promise<Classification | undefined>;

const TIER_RUBRIC = `Also rate the effort tier the request needs:
- light: lookups, explanations of small things, renames, formatting, one-line or single-function edits, chit-chat.
- standard: ordinary multi-step coding, research or writing tasks.
- heavy: multi-file design or refactors, security, data migrations, proofs, statistics, ambiguous or high-stakes specs, or retrying something that already failed.`;

/** Remember recent decisions so repeated prompts (retries, re-runs) cost no classifier call. */
export function cachedClassifier(inner: Classifier, size = 200): Classifier {
	const cache = new Map<string, Classification>();
	return async (text) => {
		const key = text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 4000);
		const hit = cache.get(key);
		if (hit) {
			cache.delete(key);
			cache.set(key, hit);
			return hit;
		}
		const result = await inner(text);
		if (result) {
			cache.set(key, result);
			if (cache.size > size) cache.delete(cache.keys().next().value as string);
		}
		return result;
	};
}

/** LLM classifier over the route descriptions, on the first available small model. Returns route + tier in one call. */
export function llmClassifier(llm: Llm, config: NpiConfig): Classifier {
	const names = Object.keys(config.routes);
	const schema = Type.Object({
		route: Type.Union(names.map((n) => Type.Literal(n))),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
		tier: Type.Union(TIERS.map((t) => Type.Literal(t))),
	});
	const menu = names.map((n) => `- ${n}: ${config.routes[n].description}`).join("\n");
	return async (text) => {
		const model = await firstAvailable(llm, config.router.classifierModels);
		if (!model) return undefined;
		const call = callStructured(llm, new Budget(Number.POSITIVE_INFINITY), {
			model,
			label: "router",
			system: `You route user requests to the best handler. Pick exactly one route.\n\n${TIER_RUBRIC}`,
			prompt: `Routes:\n${menu}\n\nRequest:\n${text.slice(0, 4000)}`,
			schema,
			toolName: "choose_route",
			toolDescription: "Choose the route and effort tier for this request.",
			thinking: "off",
		});
		return withTimeout(call, config.router.classifierTimeoutMs, "router classifier").catch(() => undefined);
	};
}

/**
 * Classifier behind a plain HTTP endpoint, for encoder models (ModernBERT/GLiNER-style) or any custom router
 * that does not speak chat completions. POST {text, routes:[{name,description}], tiers} -> {route, confidence, tier?}.
 */
export function httpClassifier(url: string, config: NpiConfig, fetchImpl: typeof fetch = fetch): Classifier {
	const routes = Object.entries(config.routes).map(([name, r]) => ({ name, description: r.description }));
	return async (text) => {
		try {
			const res = await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: text.slice(0, 4000), routes, tiers: TIERS }),
				signal: AbortSignal.timeout(config.router.classifierTimeoutMs),
			});
			if (!res.ok) return undefined;
			const body = (await res.json()) as Partial<Classification>;
			if (typeof body.route !== "string" || typeof body.confidence !== "number") return undefined;
			return { route: body.route, confidence: body.confidence, tier: TIERS.includes(body.tier as Tier) ? body.tier : undefined };
		} catch {
			return undefined;
		}
	};
}

/** First classifier that answers wins (e.g. a fast local endpoint, then a small LLM). */
export function chainClassifiers(...classifiers: Classifier[]): Classifier {
	return async (text) => {
		for (const classify of classifiers) {
			const result = await classify(text);
			if (result) return result;
		}
		return undefined;
	};
}

/** The configured decision model(s): optional HTTP endpoint, then the LLM classifier; cached. */
export function createClassifier(llm: Llm, config: NpiConfig): Classifier {
	const endpoint = config.router.classifierEndpoint;
	const llmBased = llmClassifier(llm, config);
	return cachedClassifier(endpoint ? chainClassifiers(httpClassifier(endpoint, config), llmBased) : llmBased);
}

export interface DecideInput {
	text: string;
	config: NpiConfig;
	pinned?: string;
	prefixRoute?: string;
	previous?: string;
	classify?: Classifier;
	/** /tier pin and #light/#heavy prefix. */
	pinnedTier?: Tier;
	prefixTier?: Tier;
	previousTier?: Tier;
	/** The previous turn struggled (tool errors, failing checks): go one tier up. */
	escalate?: boolean;
}

type RoutePart = Omit<RouteDecision, "tier" | "tierReason">;

/**
 * Route precedence: /route pin > #route prefix > keyword match > classifier (if confident) >
 * previous route (conversation continuity) > configured default.
 * Tier precedence: /tier pin > #tier prefix > classifier (same call, if confident) > previous tier on
 * follow-ups > standard; then one step up when the previous turn struggled (never past a pin).
 */
export async function decideRoute(input: DecideInput): Promise<RouteDecision> {
	const { routes, router } = input.config;
	const words = input.text.trim().split(/\s+/).filter(Boolean).length;
	// Very short follow-ups ("yes", "do it") continue the current route and tier without a classifier call.
	const short = words < 4;
	let classified: Classification | undefined;
	let called = false;
	const classify = async () => {
		if (!called && input.classify) {
			called = true;
			const result = await input.classify(input.text);
			classified = result && routes[result.route] && result.confidence >= router.minConfidence ? result : undefined;
		}
		return classified;
	};

	let part: RoutePart;
	const keyword = matchKeywords(input.text, routes);
	if (input.pinned && routes[input.pinned]) part = { route: input.pinned, reason: "pinned" };
	else if (input.prefixRoute && routes[input.prefixRoute]) part = { route: input.prefixRoute, reason: "prefix" };
	else if (keyword) part = { route: keyword, reason: "keyword" };
	else {
		const result = short ? undefined : await classify();
		if (result) part = { route: result.route, reason: "classifier", confidence: result.confidence };
		else if (input.previous && routes[input.previous]) part = { route: input.previous, reason: "sticky" };
		else part = { route: router.defaultRoute, reason: "default" };
	}

	let tier: Tier = "standard";
	let tierReason: TierReason = "default";
	if (input.pinnedTier) [tier, tierReason] = [input.pinnedTier, "pinned"];
	else if (input.prefixTier) [tier, tierReason] = [input.prefixTier, "prefix"];
	else {
		// Long prompts get a tier from the classifier even when the route came from a keyword or pin.
		const result = called ? classified : words >= TIER_CLASSIFY_MIN_WORDS ? await classify() : undefined;
		if (result?.tier) [tier, tierReason] = [result.tier, "classifier"];
		else if (input.previousTier && (short || part.reason === "sticky")) [tier, tierReason] = [input.previousTier, "sticky"];
	}
	if (input.escalate && tierReason !== "pinned" && tierReason !== "prefix" && tier !== "heavy") {
		[tier, tierReason] = [escalateTier(tier), "escalated"];
	}
	return { ...part, tier, tierReason };
}

/** Tools to declare for a route: always-on + route tools + promoted MCP tools, limited to registered ones. */
export function routeTools(config: NpiConfig, route: string, registered: ReadonlySet<string>): string[] {
	const r = config.routes[route];
	const wanted = [...config.router.alwaysTools, ...(r?.tools ?? []), ...(r?.promote ?? [])];
	return [...new Set(wanted)].filter((name) => registered.has(name));
}

/** Skills to list in the system prompt for a route; undefined `skills` keeps them all. */
export function routeSkills<T extends { name: string }>(config: NpiConfig, route: string, skills: readonly T[]): T[] {
	const allow = config.routes[route]?.skills;
	return allow ? skills.filter((s) => allow.includes(s.name)) : [...skills];
}

/** Agents usable on a route; undefined `agents` allows all. */
export function routeAgents<T>(config: NpiConfig, route: string | undefined, agents: ReadonlyMap<string, T>): Map<string, T> {
	const allow = route ? config.routes[route]?.agents : undefined;
	return allow ? new Map([...agents].filter(([name]) => allow.includes(name))) : new Map(agents);
}
