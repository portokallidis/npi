// Shared setup for live demos: loads .env, registers local servers, and gives each demo the same model
// layer the TUI uses (pi ModelRuntime + registry), with a throwaway agent dir so your real one is untouched.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "../../src/core/artifacts.ts";
import { BenchRecorder } from "../../src/core/bench.ts";
import type { HarnessConfig } from "../../src/core/config.ts";
import { type Llm, registryLlm } from "../../src/core/llm.ts";
import { localProviders } from "../../src/core/localmodels.ts";

const root = new URL("../../", import.meta.url);
for (const file of [join(root.pathname.replace(/^\/(\w:)/, "$1"), ".env"), join(homedir(), ".harness", "agent", ".env")]) {
	if (existsSync(file)) process.loadEnvFile(file);
}

export const config: HarnessConfig = JSON.parse(readFileSync(new URL("config/harness.json", root), "utf8"));

/** Shared by every demo file in one `npm run demo` (run id from global-setup). */
export const bench = new BenchRecorder(join(process.cwd(), ".harness", "benchmarks"), process.env.HARNESS_BENCH_RUN ?? new Date().toISOString().slice(0, 13));

export interface Demo {
	llm: Llm;
	runtime: ModelRuntime;
	agentDir: string;
	artifacts: ArtifactStore;
}

let cached: Promise<Demo> | undefined;

export function demo(): Promise<Demo> {
	cached ??= (async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "npi-demo-"));
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
		for (const { name, config: provider } of await localProviders()) runtime.registerProvider(name, provider as any);
		const llm = registryLlm(new ModelRegistry(runtime), bench.observe);
		return { llm, runtime, agentDir, artifacts: new ArtifactStore(process.cwd(), ".harness/artifacts", "demo") };
	})();
	return cached;
}

/** First available model from a list, or undefined (the demo then skips with a clear message). */
export async function pick(refs: readonly string[]): Promise<string | undefined> {
	const { llm } = await demo();
	for (const ref of refs) if (await llm.available(ref)) return ref;
	return undefined;
}

export function banner(title: string, lines: string[] = []): void {
	console.log(`\n━━━ ${title} ${"━".repeat(Math.max(0, 70 - title.length))}\n${lines.join("\n")}`);
}

export const ms = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)}s`;

/** A real subagent runner (in-process pi sessions) for demos, optionally rooted in another directory. */
export async function makeRunner(cwd = process.cwd(), overrides: { contextTokens?: number; summaryTokens?: number } = {}) {
	const { createSessionRunner } = await import("../../src/core/subagent.ts");
	const d = await demo();
	return createSessionRunner({
		cwd,
		agentDir: d.agentDir,
		llm: d.llm,
		fallbackModels: () => [],
		artifacts: d.artifacts,
		guard: config.guard,
		mcpCatalogue: config.mcpServers,
		contextTokens: overrides.contextTokens ?? 40_000,
		summaryTokens: overrides.summaryTokens ?? 300,
		timeoutMs: 30 * 60_000,
		modelRuntime: Promise.resolve(d.runtime),
	});
}

/** Record a finished subagent run in the benchmark (device resolved from the model's base URL). */
export async function recordAgent(agent: string, result: { model: string; usage: { turns: number; input: number; output: number; costUSD: number; peakContextTokens: number }; error?: string }, totalMs: number) {
	const { isLocalUrl, parseModelRef } = await import("../../src/core/llm.ts");
	const d = await demo();
	const ref = parseModelRef(result.model);
	const m = d.runtime.getModel(ref.provider, ref.id);
	bench.agent({ agent, model: `${ref.provider}/${ref.id}`, provider: ref.provider, baseUrl: m?.baseUrl ?? "", local: isLocalUrl(m?.baseUrl), totalMs, ...result.usage, error: result.error });
}

/** Load the packaged agent definitions. */
export async function agents() {
	const { loadAgentDefs } = await import("../../src/core/agents.ts");
	return loadAgentDefs([new URL("../../agents", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")]);
}
