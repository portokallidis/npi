import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./config.ts";

/** A subagent definition: Markdown with frontmatter, body = system prompt addendum. */
export interface AgentDef {
	name: string;
	description: string;
	/** Active tool names; undefined keeps pi's defaults. */
	tools?: string[];
	/** Ordered model preferences ("provider/id"); first available wins. */
	models?: string[];
	thinking?: ThinkingLevel;
	/** MCP servers (names from mcp.json) whose tools this agent gets directly. */
	mcp?: string[];
	/** Context budget for this agent's own window (tokens); defaults to config.context.subagentContextTokens. */
	contextTokens?: number;
	/** Cap on the summary returned to the caller (tokens); defaults to config.context.subagentSummaryTokens. */
	summaryTokens?: number;
	systemPrompt: string;
	filePath: string;
}

function list(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const items = raw.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
	return items.length ? items : undefined;
}

export function parseAgentDef(content: string, filePath: string): AgentDef | undefined {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: list(frontmatter.tools),
		models: list(frontmatter.model ?? frontmatter.models),
		thinking: typeof frontmatter.thinking === "string" ? (frontmatter.thinking as ThinkingLevel) : undefined,
		mcp: list(frontmatter.mcp),
		contextTokens: typeof frontmatter.contextTokens === "number" ? frontmatter.contextTokens : undefined,
		summaryTokens: typeof frontmatter.summaryTokens === "number" ? frontmatter.summaryTokens : undefined,
		systemPrompt: body.trim(),
		filePath,
	};
}

/** Load agents from directories in order; later directories override earlier ones by name. */
export function loadAgentDefs(dirs: readonly string[]): Map<string, AgentDef> {
	const agents = new Map<string, AgentDef>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir)) {
			if (!entry.endsWith(".md")) continue;
			const filePath = join(dir, entry);
			try {
				const def = parseAgentDef(readFileSync(filePath, "utf8"), filePath);
				if (def) agents.set(def.name, def);
			} catch {
				// One malformed file must not hide the other agents.
			}
		}
	}
	return agents;
}
