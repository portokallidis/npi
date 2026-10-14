import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTraces, summarize, writeTrace } from "../src/core/telemetry.ts";

describe("telemetry", () => {
	it("writes JSONL traces and summarizes cost, cache hits, routing and errors", () => {
		const dir = mkdtempSync(join(tmpdir(), "tel-"));
		writeTrace(dir, "s1", { type: "route", route: "code", reason: "keyword" });
		writeTrace(dir, "s1", { type: "llm", route: "code", model: "anthropic/opus", input: 100, output: 50, cacheRead: 900, costUSD: 0.02, stop: "stop" });
		writeTrace(dir, "s1", { type: "tool", route: "code", tool: "bash", ms: 1500, error: true });
		writeTrace(dir, "s1", { type: "subagent", agent: "scout", model: "ollama/q", turns: 3, costUSD: 0.01, peakContextTokens: 9000 });
		const records = readTraces(dir, 1);
		expect(records).toHaveLength(4);
		const text = summarize(records);
		expect(text).toMatch(/Total cost \$0\.030 \(main \$0\.020, subagents \$0\.010 over 1 runs/);
		expect(text).toMatch(/Prompt cache hit: 90%/);
		expect(text).toMatch(/Modes chosen: code 1 {2}\(by keyword 1\)/);
		expect(text).toMatch(/Tool errors: bash 1/);
	});
});
