import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import type { CallRecord } from "./llm.ts";

/**
 * Benchmarks: every model call, agent run and demo outcome is appended as JSONL; `renderBenchReport`
 * turns one run into Markdown tables (per demo, per model/device, per pipeline stage, per agent).
 * Devices are named from HARNESS_DEVICE_<PROVIDER> labels — never from IPs — so reports are safe to publish.
 */
export type BenchRecord =
	| { kind: "env"; runId: string; at: string; client: Record<string, string | number> }
	| ({ kind: "call"; runId: string; demo: string; device: string } & CallRecord)
	| { kind: "agent"; runId: string; demo: string; agent: string; model: string; device: string; totalMs: number; turns: number; input: number; output: number; costUSD: number; peakContextTokens: number; error?: string }
	| { kind: "demo"; runId: string; demo: string; totalMs: number; ok: boolean; metrics: Record<string, string | number>; error?: string };

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i;

export function deviceOf(provider: string, baseUrl: string, local: boolean, env: NodeJS.ProcessEnv = process.env): string {
	const label = env[`HARNESS_DEVICE_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
	if (label) return label;
	if (!local) return "cloud API";
	return LOOPBACK.test(baseUrl) ? "this machine" : "LAN server";
}

export function clientInfo(): Record<string, string | number> {
	const cpu = cpus();
	return {
		os: `${platform()} ${release()}`,
		cpu: cpu[0]?.model.trim() ?? "?",
		cores: cpu.length,
		memoryGB: Math.round(totalmem() / 1e9),
		freeMemoryGB: Math.round(freemem() / 1e9),
		node: process.version,
	};
}

export class BenchRecorder {
	readonly file: string;
	/** Toggle at runtime (/bench on|off); when off nothing is written. */
	enabled = true;
	private demo = "session";

	constructor(
		readonly dir: string,
		readonly runId: string = new Date().toISOString().replace(/[:.]/g, "-"),
	) {
		mkdirSync(dir, { recursive: true });
		this.file = join(dir, `${runId}.jsonl`);
		if (!existsSync(this.file)) this.write({ kind: "env", runId, at: new Date().toISOString(), client: clientInfo() });
	}

	/** Group following records under a name (a demo, or the current mode in interactive sessions). */
	setScope(name: string): void {
		this.demo = name;
	}

	private write(record: BenchRecord): void {
		// HARNESS_BENCH=0 (set by `/bench off`) pauses every recorder in the process.
		if ((!this.enabled || process.env.HARNESS_BENCH === "0") && record.kind !== "env") return;
		appendFileSync(this.file, `${JSON.stringify(record)}\n`);
	}

	/** Pass to registryLlm(registry, observe) so every model call is recorded under the current demo. */
	readonly observe = (call: CallRecord): void => {
		this.write({ kind: "call", runId: this.runId, demo: this.demo, device: deviceOf(call.provider, call.baseUrl, call.local), ...call });
	};

	agent(entry: Omit<Extract<BenchRecord, { kind: "agent" }>, "kind" | "runId" | "demo" | "device"> & { provider: string; baseUrl: string; local: boolean }): void {
		const { provider, baseUrl, local, ...rest } = entry;
		this.write({ kind: "agent", runId: this.runId, demo: this.demo, device: deviceOf(provider, baseUrl, local), ...rest });
	}

	/** Time a demo; `metrics` collects quality numbers (accuracy, κ, tokens saved, …). */
	async run<T>(demo: string, body: (metrics: Record<string, string | number>) => Promise<T>): Promise<T> {
		this.demo = demo;
		const metrics: Record<string, string | number> = {};
		const start = Date.now();
		try {
			const result = await body(metrics);
			this.write({ kind: "demo", runId: this.runId, demo, totalMs: Date.now() - start, ok: true, metrics });
			return result;
		} catch (error) {
			// A skipped demo (e.g. no model available) is not a failure; just don't record it.
			if (!/skip/i.test(`${(error as Error).name} ${(error as Error).message}`)) {
				this.write({ kind: "demo", runId: this.runId, demo, totalMs: Date.now() - start, ok: false, metrics, error: (error as Error).message });
			}
			throw error;
		}
	}
}

export function readBench(file: string): BenchRecord[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as BenchRecord);
}

const pct = (values: number[], p: number) => {
	if (!values.length) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const secs = (ms?: number) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`);
const num = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) => (n ? `$${n.toFixed(4)}` : "$0");
const rate = (tokens: number, ms: number) => (ms > 0 && tokens > 0 ? (tokens / (ms / 1000)).toFixed(1) : "—");

export function renderBenchReport(records: readonly BenchRecord[]): string {
	const env = records.find((r): r is Extract<BenchRecord, { kind: "env" }> => r.kind === "env");
	const calls = records.filter((r): r is Extract<BenchRecord, { kind: "call" }> => r.kind === "call");
	const agents = records.filter((r): r is Extract<BenchRecord, { kind: "agent" }> => r.kind === "agent");
	const demos = records.filter((r): r is Extract<BenchRecord, { kind: "demo" }> => r.kind === "demo");

	const demoRows = demos.map((d) => {
		const c = calls.filter((x) => x.demo === d.demo);
		const a = agents.filter((x) => x.demo === d.demo);
		const tin = c.reduce((s, x) => s + x.input + x.cacheRead, 0) + a.reduce((s, x) => s + x.input, 0);
		const tout = c.reduce((s, x) => s + x.output, 0) + a.reduce((s, x) => s + x.output, 0);
		const cost = c.reduce((s, x) => s + x.costUSD, 0) + a.reduce((s, x) => s + x.costUSD, 0);
		const metrics = Object.entries(d.metrics).map(([k, v]) => `${k}: ${v}`).join("; ");
		return `| ${d.ok ? "✅" : "❌"} ${d.demo} | ${secs(d.totalMs)} | ${c.length + a.reduce((s, x) => s + x.turns, 0)} | ${num(tin)} / ${num(tout)} | ${usd(cost)} | ${metrics || (d.error ? `error: ${d.error.slice(0, 80)}` : "—")} |`;
	});

	const byModel = new Map<string, typeof calls>();
	for (const c of calls) byModel.set(`${c.provider}/${c.modelId}|${c.device}`, [...(byModel.get(`${c.provider}/${c.modelId}|${c.device}`) ?? []), c]);
	const modelRows = [...byModel].map(([key, cs]) => {
		const [model, device] = key.split("|");
		const ok = cs.filter((c) => !c.error);
		const decodeMs = ok.reduce((s, c) => s + Math.max(0, c.totalMs - (c.ttftMs ?? 0)), 0);
		// Prompt speed only from calls that reported a first-token time.
		const timed = ok.filter((c) => c.ttftMs !== undefined);
		const prefillMs = timed.reduce((s, c) => s + (c.ttftMs ?? 0), 0);
		const out = ok.reduce((s, c) => s + c.output, 0);
		const inp = timed.reduce((s, c) => s + c.input, 0);
		return `| ${model} | ${device} | ${cs.length} | ${cs.length - ok.length} | ${secs(pct(ok.map((c) => c.totalMs), 50))} | ${secs(pct(ok.map((c) => c.totalMs), 95))} | ${secs(pct(ok.flatMap((c) => (c.ttftMs === undefined ? [] : [c.ttftMs])), 50))} | ${rate(out, decodeMs)} | ${rate(inp, prefillMs)} | ${cs.filter((c) => c.thinking).length} | ${usd(cs.reduce((s, c) => s + c.costUSD, 0))} |`;
	});

	const byStage = new Map<string, typeof calls>();
	for (const c of calls) {
		const key = `${c.demo} · ${c.label ?? "—"}`;
		byStage.set(key, [...(byStage.get(key) ?? []), c]);
	}
	const stageRows = [...byStage].map(([key, cs]) => {
		const avg = (f: (c: (typeof cs)[number]) => number) => Math.round(cs.reduce((s, c) => s + f(c), 0) / cs.length);
		return `| ${key} | ${cs.length} | ${secs(pct(cs.map((c) => c.totalMs), 50))} | ${secs(cs.reduce((s, c) => s + c.totalMs, 0))} | ${num(avg((c) => c.input + c.cacheRead))} | ${num(avg((c) => c.output))} |`;
	});

	const agentRows = agents.map(
		(a) => `| ${a.demo} | ${a.agent} | ${a.model} | ${a.device} | ${secs(a.totalMs)} | ${a.turns} | ${num(a.peakContextTokens)} | ${num(a.input)} / ${num(a.output)} | ${a.error ? `❌ ${a.error.slice(0, 60)}` : "✅"} |`,
	);

	const client = env ? Object.entries(env.client).map(([k, v]) => `${k}: ${v}`).join(" · ") : "unknown";
	return `# Benchmark report

Run \`${env?.runId ?? "?"}\` · ${env?.at ?? ""}
Client: ${client}

## Demos
| Demo | Wall time | Model calls (incl. agent turns) | Tokens in / out | Cost | Results |
|---|---|---|---|---|---|
${demoRows.join("\n") || "| — | | | | | |"}

## Models and devices
| Model | Device | Calls | Errors | Median time | p95 time | Median TTFT | Output tok/s | Prompt tok/s | Thinking calls | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
${modelRows.join("\n") || "| — | | | | | | | | | | |"}

## Pipeline stages
| Demo · stage | Calls | Median time | Total time | Avg tokens in | Avg tokens out |
|---|---|---|---|---|---|
${stageRows.join("\n") || "| — | | | | | |"}

## Agent runs
| Demo | Agent | Model | Device | Time | Turns | Peak context | Tokens in / out | Status |
|---|---|---|---|---|---|---|---|---|
${agentRows.join("\n") || "| — | | | | | | | | |"}

<sub>Time is wall-clock per call, including queueing and model load on local servers. TTFT is the time to the first streamed token. Output tok/s = output tokens ÷ (time − TTFT); prompt tok/s = input tokens ÷ TTFT (rough prefill speed). Tokens in include cache reads. Devices come from HARNESS_DEVICE_* labels in .env.</sub>
`;
}
