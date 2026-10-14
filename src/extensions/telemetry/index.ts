import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { readBench, renderBenchReport } from "../../core/bench.ts";
import { isLocalUrl } from "../../core/llm.ts";
import { readTraces, summarize, TELEMETRY_CHANNEL, type TraceEvent, writeTrace } from "../../core/telemetry.ts";
import { runtimeHolder } from "../runtime.ts";

const ROUTE_CHANNEL = "harness:route";

/**
 * Local tracing: every routing decision, model call, tool call and subagent run is appended as one
 * JSONL line under <agentDir>/telemetry. `/stats [days]` summarises cost, cache hits, routing and errors —
 * the numbers you need to tune routes, budgets and model chains.
 */
export default function telemetry(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	let route: string | undefined;
	let session = "unknown";
	let dir: string | undefined;

	const emit = (event: TraceEvent) => {
		if (dir) writeTrace(dir, session, event);
	};

	pi.on("session_start", (_event, ctx) => {
		holder.reset();
		const rt = holder.get(ctx);
		dir = rt.config.telemetry.enabled ? join(rt.agentDir, rt.config.telemetry.dir) : undefined;
		session = ctx.sessionManager.getSessionId();
	});
	pi.events.on(ROUTE_CHANNEL, (name) => {
		route = typeof name === "string" ? name : undefined;
	});
	pi.events.on(TELEMETRY_CHANNEL, (event) => emit(event as TraceEvent));

	// Agent-loop model calls: time from message start, TTFT from the first streamed update.
	let callStart = 0;
	let ttft: number | undefined;
	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		callStart = Date.now();
		ttft = undefined;
	});
	pi.on("message_update", () => {
		if (ttft === undefined && callStart) ttft = Date.now() - callStart;
	});

	pi.on("message_end", (event, ctx) => {
		const m = event.message;
		if (m.role !== "assistant") return;
		const bench = holder.get(ctx).bench;
		if (bench && callStart) {
			const baseUrl = ctx.modelRegistry.find(m.provider, m.model)?.baseUrl ?? "";
			bench.setScope(`session:${route ?? "?"}`);
			bench.observe({
				ref: `${m.provider}/${m.model}`,
				label: `agent:${route ?? "?"}`,
				provider: m.provider,
				modelId: m.model,
				baseUrl,
				local: isLocalUrl(baseUrl),
				thinking: m.content.some((c) => c.type === "thinking"),
				startedAt: callStart,
				ttftMs: ttft,
				totalMs: Date.now() - callStart,
				input: m.usage.input,
				output: m.usage.output,
				cacheRead: m.usage.cacheRead,
				reasoning: m.usage.reasoning,
				costUSD: m.usage.cost.total,
				stop: m.stopReason,
				error: m.stopReason === "error" ? m.errorMessage : undefined,
			});
		}
		callStart = 0;
		emit({ type: "llm", route, model: `${m.provider}/${m.model}`, input: m.usage.input, output: m.usage.output, cacheRead: m.usage.cacheRead, costUSD: m.usage.cost.total, stop: m.stopReason });
	});
	pi.on("tool_execution_end", (event) => {
		emit({ type: "tool", route, tool: event.toolName, ms: event.durationMs ?? 0, error: event.isError });
	});

	pi.registerCommand("stats", {
		description: "Cost, cache hits, routing and tool errors from local traces: /stats [days=1]",
		handler: async (args, ctx) => {
			const rt = holder.get(ctx);
			const days = Math.max(1, Number.parseInt(args, 10) || 1);
			const records = readTraces(join(rt.agentDir, rt.config.telemetry.dir), days);
			ctx.ui.notify(records.length ? `Last ${days} day(s), ${records.length} events\n${summarize(records)}` : "No traces yet", "info");
		},
	});

	pi.registerCommand("bench", {
		description: "Model benchmarks (time, TTFT, tokens/s per model and device): /bench report | on | off",
		handler: async (args, ctx) => {
			const rt = holder.get(ctx);
			const arg = args.trim() || "report";
			if (arg === "off" || arg === "on") {
				process.env.HARNESS_BENCH = arg === "off" ? "0" : "1";
				return ctx.ui.notify(`Benchmark recording ${arg}`, "info");
			}
			if (!rt.bench) return ctx.ui.notify("Telemetry is disabled (telemetry.enabled in harness.json)", "warning");
			const report = renderBenchReport(readBench(rt.bench.file));
			const out = join(ctx.cwd, ".harness", "benchmarks");
			mkdirSync(out, { recursive: true });
			const file = join(out, `session-${rt.bench.runId}.md`);
			writeFileSync(file, report);
			ctx.ui.notify(`Benchmark report written to ${file}
${report.split("## Pipeline stages")[0].split("## Models and devices")[1] ?? ""}`, "info");
		},
	});
}
