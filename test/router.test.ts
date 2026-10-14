import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../src/core/config.ts";
import { decideRoute, matchKeywords, parsePrefix, routeTools } from "../src/core/router.ts";

const config: HarnessConfig = JSON.parse(readFileSync(new URL("../config/harness.json", import.meta.url), "utf8"));

describe("router", () => {
	it("routes typical prompts by keyword", () => {
		expect(matchKeywords("fix this bug in parser.ts", config.routes)).toBe("code");
		expect(matchKeywords("what's new in the latest Node release? cite sources", config.routes)).toBe("research");
		expect(matchKeywords("open https://example.com and take a screenshot", config.routes)).toBe("browse");
		expect(matchKeywords("brainstorm names for my startup", config.routes)).toBe("brainstorm");
		expect(matchKeywords("tell me a joke", config.routes)).toBeUndefined();
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
