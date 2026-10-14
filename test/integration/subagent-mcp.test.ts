// Integration: a real in-process pi subagent session (scripted faux model) that loads the user's
// packages, filters out the harness extensions, connects only its MCP servers, and drives the
// Playwright MCP container. Needs `harness init` into HARNESS_AGENT_DIR and the compose stack up.
//   HARNESS_AGENT_DIR=... npx vitest --run test/integration
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { readFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "../../src/core/artifacts.ts";
import { describe, expect, it } from "vitest";
import { createSessionRunner } from "../../src/core/subagent.ts";

const agentDir = process.env.HARNESS_AGENT_DIR ?? "";
const playwrightUp = await fetch("http://localhost:8931/mcp", { signal: AbortSignal.timeout(1000) }).then(
	() => true,
	() => false,
);
const ready = !!agentDir && existsSync(join(agentDir, "settings.json")) && playwrightUp;

describe.skipIf(!ready)("subagent runtime (live Playwright MCP)", () => {
	it("navigates with mcp__playwright__ tools and returns the page title", async () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
		const seenContexts: string[] = [];
		faux.setResponses([
			(context) => {
				seenContexts.push(JSON.stringify(context));
				return fauxAssistantMessage(fauxToolCall("mcp__playwright__browser_navigate", { url: "https://example.com" }), { stopReason: "toolUse" });
			},
			(context) => {
				const last = context.messages.at(-1);
				const text = last?.role === "toolResult" ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
				const title = text.match(/Page Title: (.*)/)?.[1] ?? "unknown";
				return fauxAssistantMessage(fauxText(`# Findings
Long detail that must stay out of the caller's context.

## Summary
TITLE=${title}`));
			},
		]);

		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
		runtime.registerProvider("faux", {
			name: "Faux",
			baseUrl: "http://faux.invalid",
			apiKey: "x",
			api: faux.api as any,
			streamSimple: (model: any, context: any, options: any) => faux.provider.streamSimple(model, context as any, options),
			models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
		} as any);

		const runner = createSessionRunner({
			cwd: process.cwd(),
			agentDir,
			llm: { available: async () => true, complete: async () => Promise.reject(new Error("unused")) },
			fallbackModels: () => [],
			artifacts: new ArtifactStore(process.cwd(), ".harness/artifacts", "integration"),
			mcpCatalogue: JSON.parse(readFileSync(new URL("../../config/harness.json", import.meta.url), "utf8")).mcpServers,
			contextTokens: 50_000,
			summaryTokens: 200,
			timeoutMs: 90_000,
			modelRuntime: Promise.resolve(runtime),
		});

		const progress: string[] = [];
		const result = await runner.run({
			agent: { name: "browser", description: "", tools: ["read"], mcp: ["playwright"], models: ["faux/scripted"], systemPrompt: "Be brief.", filePath: "" },
			task: "What is the title of example.com?",
			onProgress: (line) => progress.push(line),
		});

		expect(result.error).toBeUndefined();
		// Caller gets only the summary; the full report + tool trace is in the artifact.
		expect(result.text).toBe("TITLE=Example Domain");
		const full = readFileSync(join(process.cwd(), result.artifact!), "utf8");
		expect(full).toMatch(/Long detail that must stay out/);
		expect(full).toMatch(/- mcp__playwright__browser_navigate \{"url":"https:\/\/example.com"\}/);
		expect(progress).toContain("browser: mcp__playwright__browser_navigate");
		// Harness extensions are filtered out of subagents (no recursion); MCP tools are declared directly.
		expect(seenContexts[0]).not.toContain('"delegate"');
		expect(seenContexts[0]).not.toContain('"brainstorm"');
		expect(seenContexts[0]).toContain('"mcp__playwright__browser_navigate"');
		// The reporting contract is in the subagent's system prompt.
		expect(seenContexts[0]).toMatch(/Reporting contract/);
	}, 120_000);
});
