// Integration: a real in-process subagent that keeps working past its context budget is first steered
// to wrap up, then stopped at 1.5x — and its summary still reaches the caller.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/core/artifacts.ts";
import { createSessionRunner } from "../../src/core/subagent.ts";

const agentDir = process.env.HARNESS_AGENT_DIR ?? "";

describe.skipIf(!agentDir || !existsSync(join(agentDir, "settings.json")))("subagent context budget", () => {
	it("steers at the budget and the agent wraps up with a summary", async () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
		const contexts: string[] = [];
		const step = (context: any) => {
			const json = JSON.stringify(context);
			contexts.push(json);
			if (json.includes("Context budget reached")) return fauxAssistantMessage(fauxText("## Summary\npartial answer"));
			return fauxAssistantMessage(fauxToolCall("read", { path: "node_modules/@earendil-works/pi-coding-agent/docs/extensions.md" }), { stopReason: "toolUse" });
		};
		faux.setResponses(Array.from({ length: 30 }, () => step));

		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
		runtime.registerProvider("faux", {
			name: "Faux",
			baseUrl: "http://faux.invalid",
			apiKey: "x",
			api: faux.api as any,
			streamSimple: (model: any, context: any, options: any) => faux.provider.streamSimple(model, context, options),
			models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
		} as any);

		const runner = createSessionRunner({
			cwd: process.cwd(),
			agentDir,
			llm: { available: async () => true, complete: async () => Promise.reject(new Error("unused")) },
			fallbackModels: () => [],
			artifacts: new ArtifactStore(process.cwd(), ".harness/artifacts", "integration"),
			contextTokens: 10_000, // after one ~5k-token read the context (~13.5k) is between 1x and 1.5x
			summaryTokens: 100,
			timeoutMs: 60_000,
			modelRuntime: Promise.resolve(runtime),
		});

		const result = await runner.run({
			agent: { name: "reader", description: "", tools: ["read"], models: ["faux/scripted"], systemPrompt: "", filePath: "" },
			task: "Keep reading the docs",
		});

		expect(contexts.some((c) => c.includes("Context budget reached"))).toBe(true);
		expect(result.text).toBe("partial answer");
		expect(result.usage.turns).toBeLessThan(30);
		expect(result.usage.peakContextTokens).toBeGreaterThan(10_000);
	}, 90_000);
});
