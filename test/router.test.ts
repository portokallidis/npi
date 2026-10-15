import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NpiConfig } from "../src/core/config.ts";
import { decideRoute, matchKeywords, parsePrefix, routeTools } from "../src/core/router.ts";

const config: NpiConfig = JSON.parse(readFileSync(new URL("../config/npi.json", import.meta.url), "utf8"));

describe("router", () => {
	it("routes typical prompts by keyword", () => {
		expect(matchKeywords("fix this bug in parser.ts", config.routes)).toBe("code");
		expect(matchKeywords("what's new in the latest Node release? cite sources", config.routes)).toBe("research");
		expect(matchKeywords("open https://example.com and take a screenshot", config.routes)).toBe("browse");
		expect(matchKeywords("brainstorm names for my startup", config.routes)).toBe("brainstorm");
		expect(matchKeywords("tell me a joke", config.routes)).toBeUndefined();
		expect(matchKeywords("make a plan for the migration", config.routes)).toBe("plan");
		expect(matchKeywords("is there evidence that creatine helps memory? RCTs only", config.routes)).toBe("science");
	});

	it("has keyword regexes that compile and contain no control characters (JSON '\\b' is a backspace)", () => {
		for (const [name, route] of Object.entries(config.routes)) {
			for (const pattern of route.keywords ?? []) {
				expect(() => new RegExp(pattern), `${name}: ${pattern}`).not.toThrow();
				expect(/[\u0000-\u001f]/.test(pattern), `${name}: ${JSON.stringify(pattern)}`).toBe(false);
			}
		}
	});

	it("parses #route prefixes only for known routes", () => {
		expect(parsePrefix("#research rust async runtimes", config.routes)).toEqual({ route: "research", text: "rust async runtimes" });
		expect(parsePrefix("#nobody hi there", config.routes)).toBeUndefined();
	});

	it("applies precedence pinned > prefix > keyword > classifier > sticky > default", async () => {
		const classify = async () => ({ route: "research", confidence: 0.9 });
		expect(await decideRoute({ text: "fix the bug", config, pinned: "chat", prefixRoute: "browse", classify })).toMatchObject({ route: "chat", reason: "pinned" });
		expect(await decideRoute({ text: "fix the bug", config, prefixRoute: "browse", classify })).toMatchObject({ route: "browse", reason: "prefix" });
		expect(await decideRoute({ text: "fix the bug", config, classify })).toMatchObject({ route: "code", reason: "keyword" });
		expect(await decideRoute({ text: "how tall is the eiffel tower today", config, classify })).toMatchObject({ route: "research", reason: "classifier" });
	});

	it("ignores low-confidence classifications and keeps short follow-ups on the current route", async () => {
		const unsure = async () => ({ route: "research", confidence: 0.2 });
		expect(await decideRoute({ text: "how tall is the eiffel tower today", config, classify: unsure, previous: "code" })).toMatchObject({ route: "code", reason: "sticky" });
		let called = false;
		const spy = async () => ((called = true), { route: "research", confidence: 1 });
		expect(await decideRoute({ text: "yes do it", config, classify: spy, previous: "code" })).toMatchObject({ route: "code" });
		expect(called).toBe(false);
		expect(await decideRoute({ text: "yes do it", config })).toMatchObject({ route: "chat", reason: "default" });
	});

	it("picks a tier: pin > prefix > classifier > sticky follow-up > standard, then escalates", async () => {
		const heavy = async () => ({ route: "research", confidence: 0.9, tier: "heavy" as const });
		const long = "please rework the whole authentication flow across the api gateway and the web client so that sessions survive restarts and the token refresh logic stops racing with parallel requests from several tabs";
		expect(await decideRoute({ text: "how tall is the eiffel tower today", config, classify: heavy })).toMatchObject({ tier: "heavy", tierReason: "classifier" });
		expect(await decideRoute({ text: "fix the bug", config, classify: heavy })).toMatchObject({ route: "code", tier: "standard", tierReason: "default" });
		// Keyword picks the route; a long prompt still asks the classifier for the tier only.
		expect(await decideRoute({ text: `fix ${long}`, config, classify: heavy })).toMatchObject({ route: "code", reason: "keyword", tier: "heavy" });
		expect(await decideRoute({ text: long, config, classify: heavy, pinnedTier: "light" })).toMatchObject({ tier: "light", tierReason: "pinned" });
		expect(await decideRoute({ text: long, config, classify: heavy, prefixTier: "standard" })).toMatchObject({ tier: "standard", tierReason: "prefix" });
		expect(await decideRoute({ text: "yes do it", config, previous: "code", previousTier: "light" })).toMatchObject({ tier: "light", tierReason: "sticky" });
		expect(await decideRoute({ text: "yes do it", config, previous: "code", previousTier: "light", escalate: true })).toMatchObject({ tier: "standard", tierReason: "escalated" });
		expect(await decideRoute({ text: "yes do it", config, pinnedTier: "light", escalate: true })).toMatchObject({ tier: "light", tierReason: "pinned" });
		// Low confidence: no tier from the classifier either.
		const unsure = async () => ({ route: "research", confidence: 0.1, tier: "heavy" as const });
		expect(await decideRoute({ text: "how tall is the eiffel tower today", config, classify: unsure })).toMatchObject({ tier: "standard" });
	});

	it("maps tiers to model lists and parses tier prefixes", async () => {
		const { tierModels, parseTierPrefix, escalateTier } = await import("../src/core/router.ts");
		const route = { ...config.routes.code, models: ["a", "b"], tiers: { light: ["l", "a"], heavy: ["h"] } };
		expect(tierModels(route, "light")).toEqual(["l", "a", "b"]);
		expect(tierModels(route, "heavy")).toEqual(["h", "a", "b"]);
		expect(tierModels(route, "standard")).toEqual(["a", "b"]);
		expect(tierModels(config.routes.code, "light")).toEqual(config.routes.code.models);
		expect(parseTierPrefix("#heavy do it")).toEqual({ tier: "heavy", text: "do it" });
		expect(parseTierPrefix("#code do it")).toBeUndefined();
		expect(escalateTier("heavy")).toBe("heavy");
	});

	it("caches classifier answers and chains an HTTP decision model before the LLM", async () => {
		const { cachedClassifier, chainClassifiers, httpClassifier } = await import("../src/core/router.ts");
		let calls = 0;
		const cached = cachedClassifier(async () => (calls++, { route: "code", confidence: 1 }), 2);
		await cached("Fix  it now");
		await cached("fix it now");
		expect(calls).toBe(1);

		const fakeFetch = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			expect(body.routes.map((r: { name: string }) => r.name)).toContain("code");
			return new Response(JSON.stringify({ route: "code", confidence: 0.8, tier: "light" }));
		}) as typeof fetch;
		const down = (async () => {
			throw new Error("down");
		}) as typeof fetch;
		const fallback = async () => ({ route: "chat", confidence: 1 });
		expect(await httpClassifier("http://x", config, fakeFetch)("hi there friend")).toEqual({ route: "code", confidence: 0.8, tier: "light" });
		expect(await chainClassifiers(httpClassifier("http://x", config, down), fallback)("hi there friend")).toEqual({ route: "chat", confidence: 1 });
	});

	it("declares only registered tools for a route", () => {
		const registered = new Set(["read", "tool_search", "delegate", "web_search", "mcp__playwright__browser_navigate"]);
		expect(routeTools(config, "browse", registered)).toEqual(["read", "tool_search", "delegate", "web_search", "mcp__playwright__browser_navigate"]);
	});
});

describe("per-route loading", () => {
	it("scopes skills and agents to the route", async () => {
		const { routeSkills, routeAgents } = await import("../src/core/router.ts");
		const skills = [{ name: "lit-review" }, { name: "commit" }];
		const scoped = { ...config, routes: { ...config.routes, research: { ...config.routes.research, skills: ["lit-review"] } } };
		expect(routeSkills(scoped, "research", skills).map((s) => s.name)).toEqual(["lit-review"]);
		expect(routeSkills(scoped, "code", skills)).toHaveLength(2);
		expect(routeSkills(config, "chat", skills)).toEqual([]);
		const agents = new Map([["scout", 1], ["coder", 2], ["researcher", 3]]);
		expect([...routeAgents(config, "code", agents).keys()]).toEqual(["scout", "coder"]);
		expect(routeAgents(config, undefined, agents).size).toBe(3);
	});
});

describe("handoff targets", () => {
	it("parses modes, models and external agents", async () => {
		const { parseHandoff } = await import("../src/core/handoff.ts");
		const routes = Object.keys(config.routes);
		expect(parseHandoff("continue with tests", routes)).toEqual({ target: { kind: "same" }, goal: "continue with tests" });
		expect(parseHandoff("--to code implement step 1", routes)).toEqual({ target: { kind: "route", route: "code" }, goal: "implement step 1" });
		expect(parseHandoff("--to lmstudio/qwen/qwen3.5-9b go", routes)).toEqual({ target: { kind: "model", model: "lmstudio/qwen/qwen3.5-9b" }, goal: "go" });
		expect(parseHandoff("--to claude finish it", routes)).toEqual({ target: { kind: "external", agent: "claude" }, goal: "finish it" });
		expect(() => parseHandoff("--to nowhere x", routes)).toThrow(/Unknown handoff target/);
	});
});
