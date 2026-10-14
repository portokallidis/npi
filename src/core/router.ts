import { Type } from "typebox";
import { Budget } from "./budget.ts";
import type { HarnessConfig, RouteConfig } from "./config.ts";
import { firstAvailable, type Llm } from "./llm.ts";
import { withTimeout } from "./pool.ts";
import { callStructured } from "./structured.ts";

export type RouteReason = "pinned" | "prefix" | "keyword" | "classifier" | "sticky" | "default";

export interface RouteDecision {
	route: string;
	reason: RouteReason;
	confidence?: number;
}

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

export type Classifier = (text: string) => Promise<{ route: string; confidence: number } | undefined>;

/** LLM classifier over the route descriptions, on the first available small model. */
export function llmClassifier(llm: Llm, config: HarnessConfig): Classifier {
	const names = Object.keys(config.routes);
	const schema = Type.Object({
		route: Type.Union(names.map((n) => Type.Literal(n))),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
	});
	const menu = names.map((n) => `- ${n}: ${config.routes[n].description}`).join("\n");
	return async (text) => {
		const model = await firstAvailable(llm, config.router.classifierModels);
		if (!model) return undefined;
		const call = callStructured(llm, new Budget(Number.POSITIVE_INFINITY), {
			model,
			label: "router",
			system: "You route user requests to the best handler. Pick exactly one route.",
			prompt: `Routes:\n${menu}\n\nRequest:\n${text.slice(0, 4000)}`,
			schema,
			toolName: "choose_route",
			toolDescription: "Choose the route for this request.",
			thinking: "off",
		});
		return withTimeout(call, config.router.classifierTimeoutMs, "router classifier").catch(() => undefined);
	};
}

export interface DecideInput {
	text: string;
	config: HarnessConfig;
	pinned?: string;
	prefixRoute?: string;
	previous?: string;
	classify?: Classifier;
}

/**
 * Precedence: /route pin > #route prefix > keyword match > classifier (if confident) >
 * previous route (conversation continuity) > configured default.
 */
export async function decideRoute(input: DecideInput): Promise<RouteDecision> {
	const { routes, router } = input.config;
	if (input.pinned && routes[input.pinned]) return { route: input.pinned, reason: "pinned" };
	if (input.prefixRoute && routes[input.prefixRoute]) return { route: input.prefixRoute, reason: "prefix" };
	const keyword = matchKeywords(input.text, routes);
	if (keyword) return { route: keyword, reason: "keyword" };

	// Very short follow-ups ("yes", "do it") continue the current route without a classifier call.
	const short = input.text.trim().split(/\s+/).length < 4;
	if (!short && input.classify) {
		const result = await input.classify(input.text);
		if (result && routes[result.route] && result.confidence >= router.minConfidence) {
			return { route: result.route, reason: "classifier", confidence: result.confidence };
		}
	}
	if (input.previous && routes[input.previous]) return { route: input.previous, reason: "sticky" };
	return { route: router.defaultRoute, reason: "default" };
}

/** Tools to declare for a route: always-on + route tools + promoted MCP tools, limited to registered ones. */
export function routeTools(config: HarnessConfig, route: string, registered: ReadonlySet<string>): string[] {
	const r = config.routes[route];
	const wanted = [...config.router.alwaysTools, ...(r?.tools ?? []), ...(r?.promote ?? [])];
	return [...new Set(wanted)].filter((name) => registered.has(name));
}

/** Skills to list in the system prompt for a route; undefined `skills` keeps them all. */
export function routeSkills<T extends { name: string }>(config: HarnessConfig, route: string, skills: readonly T[]): T[] {
	const allow = config.routes[route]?.skills;
	return allow ? skills.filter((s) => allow.includes(s.name)) : [...skills];
}

/** Agents usable on a route; undefined `agents` allows all. */
export function routeAgents<T>(config: HarnessConfig, route: string | undefined, agents: ReadonlyMap<string, T>): Map<string, T> {
	const allow = route ? config.routes[route]?.agents : undefined;
	return allow ? new Map([...agents].filter(([name]) => allow.includes(name))) : new Map(agents);
}
