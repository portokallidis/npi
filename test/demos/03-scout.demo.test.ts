// Demo 3 — A real subagent (quick). The `scout` agent explores this repository in its own pi session
// (read-only tools, cheapest available model) and returns only a short summary; its full report and tool
// trace are saved as an artifact.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadAgentDefs } from "../../src/core/agents.ts";
import { createSessionRunner } from "../../src/core/subagent.ts";
import { isLocalUrl, parseModelRef } from "../../src/core/llm.ts";
import { banner, bench, config, demo, ms, pick } from "./harness.ts";

it("quick: scout subagent answers a codebase question with a short summary + artifact", (t) =>
	bench.run("scout subagent", async (metrics) => {
	const scout = loadAgentDefs([new URL("../../agents", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")]).get("scout")!;
	const model = await pick(scout.models ?? []);
	if (!model) return t.skip();
	const d = await demo();
	const runner = createSessionRunner({
		cwd: process.cwd(),
		agentDir: d.agentDir,
		llm: d.llm,
		fallbackModels: () => [],
		artifacts: d.artifacts,
		guard: config.guard,
		mcpCatalogue: config.mcpServers,
		contextTokens: 40_000,
		summaryTokens: 300,
		timeoutMs: 15 * 60_000,
		modelRuntime: Promise.resolve(d.runtime),
	});
	const progress: string[] = [];
	const start = Date.now();
	const result = await runner.run({
		agent: scout,
		model,
		task: "In this repository, where is the approval policy (readonly/ask/auto) implemented, and which file applies it to tool calls? Answer with file paths.",
		policy: { level: "readonly", sandboxed: false },
		onProgress: (line) => progress.push(line),
	});
	const resolved = parseModelRef(result.model);
	const m = d.runtime.getModel(resolved.provider, resolved.id);
	bench.agent({ agent: "scout", model: `${resolved.provider}/${resolved.id}`, provider: resolved.provider, baseUrl: m?.baseUrl ?? "", local: isLocalUrl(m?.baseUrl), totalMs: Date.now() - start, turns: result.usage.turns, input: result.usage.input, output: result.usage.output, costUSD: result.usage.costUSD, peakContextTokens: result.usage.peakContextTokens, error: result.error });
	Object.assign(metrics, { model: result.model, turns: result.usage.turns, "summary tokens": Math.ceil(result.text.length / 4), "found policy.ts": /policy.ts/.test(result.text) ? "yes" : "no" });
	banner(`scout on ${result.model} in ${ms(start)} — ${result.usage.turns} turns, peak context ${result.usage.peakContextTokens} tokens`, [
		`tools: ${progress.map((p) => p.split(": ")[1]).join(", ")}`,
		"",
		"Summary returned to the caller:",
		result.text,
		"",
		`Full report: ${result.artifact}${result.error ? `\nerror: ${result.error}` : ""}`,
	]);
	expect(result.text).toMatch(/policy\.ts|guard/);
	expect(readFileSync(join(process.cwd(), result.artifact!), "utf8")).toMatch(/## Tool trace/);
	}));
