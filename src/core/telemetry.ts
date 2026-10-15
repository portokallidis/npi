import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One trace record. Flat and JSON-serialisable so it can be shipped to OTel/Langfuse later if wanted. */
export type TraceEvent =
	| { type: "route"; route: string; reason: string; confidence?: number; tier?: string; tierReason?: string }
	| { type: "llm"; route?: string; tier?: string; model: string; input: number; output: number; cacheRead: number; costUSD: number; stop: string }
	| { type: "tool"; route?: string; tool: string; ms: number; error: boolean }
	| { type: "subagent"; agent: string; model: string; turns: number; costUSD: number; peakContextTokens: number; error?: string }
	| { type: "checks"; runs: number; failed: number }
	| { type: "experiment"; name: string; seeds: number; verdict: string }
	| { type: "science"; costUSD: number; screened: number; included: number; supported: number; sentences: number; stoppedEarly?: string }
	| { type: "brainstorm"; costUSD: number; pathways: number; disputes: number; resolved: number; recommended: boolean };

export type TraceRecord = TraceEvent & { ts: string; session: string };

export const TELEMETRY_CHANNEL = "npi:telemetry";

export function traceFile(dir: string, date = new Date()): string {
	return join(dir, `${date.toISOString().slice(0, 10)}.jsonl`);
}

export function writeTrace(dir: string, session: string, event: TraceEvent): void {
	mkdirSync(dir, { recursive: true });
	appendFileSync(traceFile(dir), `${JSON.stringify({ ts: new Date().toISOString(), session, ...event })}\n`);
}

export function readTraces(dir: string, days: number): TraceRecord[] {
	if (!existsSync(dir)) return [];
	const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl") && f.slice(0, 10) >= since)
		.flatMap((f) =>
			readFileSync(join(dir, f), "utf8")
				.split("\n")
				.filter(Boolean)
				.flatMap((line) => {
					try {
						return [JSON.parse(line) as TraceRecord];
					} catch {
						return [];
					}
				}),
		);
}

const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
const top = (m: Map<string, number>, fmt: (v: number) => string, n = 8) =>
	[...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${fmt(v)}`).join(" · ") || "—";

/** Human summary for /stats: where the money, tokens, time and errors went. */
export function summarize(records: readonly TraceRecord[]): string {
	const costByModel = new Map<string, number>();
	const costByRoute = new Map<string, number>();
	const routes = new Map<string, number>();
	const reasons = new Map<string, number>();
	const tierTurns = new Map<string, number>();
	const tierCost = new Map<string, number>();
	const tierCalls = new Map<string, number>();
	const tools = new Map<string, number>();
	const toolErrors = new Map<string, number>();
	const toolMs = new Map<string, number>();
	let input = 0;
	let cached = 0;
	let subCost = 0;
	let subRuns = 0;
	let subErrors = 0;
	let checkRuns = 0;
	let checkFails = 0;
	for (const r of records) {
		if (r.type === "route") {
			add(routes, r.route, 1);
			add(reasons, r.reason, 1);
			if (r.tier) add(tierTurns, `${r.tier}${r.tierReason === "escalated" ? "↑" : ""}`, 1);
		} else if (r.type === "llm") {
			add(costByModel, r.model, r.costUSD);
			add(costByRoute, r.route ?? "?", r.costUSD);
			add(tierCost, r.tier ?? "standard", r.costUSD);
			add(tierCalls, r.tier ?? "standard", 1);
			input += r.input + r.cacheRead;
			cached += r.cacheRead;
		} else if (r.type === "tool") {
			add(tools, r.tool, 1);
			add(toolMs, r.tool, r.ms);
			if (r.error) add(toolErrors, r.tool, 1);
		} else if (r.type === "checks") {
			checkRuns++;
			if (r.failed) checkFails++;
		} else if (r.type === "subagent") {
			subRuns++;
			subCost += r.costUSD;
			if (r.error) subErrors++;
		}
	}
	const total = [...costByModel.values()].reduce((a, b) => a + b, 0) + subCost;
	const usd = (v: number) => `$${v.toFixed(3)}`;
	return [
		`Total cost ${usd(total)} (main ${usd(total - subCost)}, subagents ${usd(subCost)} over ${subRuns} runs, ${subErrors} failed)`,
		`Cost by model: ${top(costByModel, usd)}`,
		`Cost by mode: ${top(costByRoute, usd)}`,
		`Modes chosen: ${top(routes, String)}  (by ${top(reasons, String)})`,
		`Tiers chosen: ${top(tierTurns, String)}  (↑ = escalated after a struggling turn)`,
		`Cost per model call by tier: ${[...tierCalls].map(([k, n]) => `${k} ${usd((tierCost.get(k) ?? 0) / n)} × ${n}`).join(" · ") || "—"}`,
		`Prompt cache hit: ${input ? Math.round((cached / input) * 100) : 0}% of ${input.toLocaleString()} input tokens`,
		`Tools: ${top(tools, String)}`,
		`Tool errors: ${top(toolErrors, String)}`,
		`Post-edit check rounds: ${checkRuns} (${checkFails} failing)`,
		`Slowest tools (total s): ${top(toolMs, (v) => (v / 1000).toFixed(1))}`,
	].join("\n");
}
