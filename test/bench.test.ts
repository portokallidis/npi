import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BenchRecorder, deviceOf, readBench, renderBenchReport } from "../src/core/bench.ts";

const call = (over: Record<string, unknown> = {}) => ({
	ref: "local/small",
	label: "router",
	provider: "lmstudio",
	modelId: "qwen/qwen3.5-9b",
	baseUrl: "http://10.0.0.2:1234/v1",
	local: true,
	thinking: false,
	startedAt: 0,
	ttftMs: 1000,
	totalMs: 3000,
	input: 2000,
	output: 100,
	cacheRead: 0,
	costUSD: 0,
	stop: "stop",
	...over,
});

describe("bench", () => {
	it("names devices from labels, never from IPs", () => {
		expect(deviceOf("lmstudio", "http://10.0.0.2:1234/v1", true, { NPI_DEVICE_LMSTUDIO: "Mac mini M4" })).toBe("Mac mini M4");
		expect(deviceOf("llamacpp", "http://10.0.0.7:8080/v1", true, {})).toBe("LAN server");
		expect(deviceOf("ollama", "http://127.0.0.1:11434/v1", true, {})).toBe("this machine");
		expect(deviceOf("anthropic", "https://api.anthropic.com", false, {})).toBe("cloud API");
	});

	it("records demos and calls and renders per-demo, per-model and per-stage tables", async () => {
		const rec = new BenchRecorder(mkdtempSync(join(tmpdir(), "bench-")), "run1");
		await rec.run("router", async (m) => {
			rec.observe(call());
			rec.observe(call({ totalMs: 5000, ttftMs: 1000 }));
			m.accuracy = "7/8";
		});
		await expect(rec.run("broken", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		process.env.NPI_BENCH = "0";
		rec.observe(call({ label: "ignored" }));
		delete process.env.NPI_BENCH;

		const md = renderBenchReport(readBench(rec.file));
		expect(md).not.toMatch(/192\.168/);
		expect(md).toMatch(/\| ✅ router \| .* \| 2 \| 4,000 \/ 200 \| \$0 \| accuracy: 7\/8 \|/);
		expect(md).toMatch(/\| ❌ broken \|.*error: boom/);
		// 200 output tokens over (2s + 4s) decode = 33.3 tok/s; 4000 input over 2s TTFT = 2000 tok/s.
		expect(md).toMatch(/\| lmstudio\/qwen\/qwen3\.5-9b \| LAN server \| 2 \| 0 \| .* \| 33\.3 \| 2000\.0 \|/);
		expect(md).not.toMatch(/ignored/);
	});
});
