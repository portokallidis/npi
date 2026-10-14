import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

	pi.on("message_end", (event) => {
		const m = event.message;
		if (m.role !== "assistant") return;
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
}
