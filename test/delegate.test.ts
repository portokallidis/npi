import { describe, expect, it } from "vitest";
import type { AgentDef } from "../src/core/agents.ts";
import { parseAgentDef } from "../src/core/agents.ts";
import { delegateMode, runDelegate } from "../src/core/delegate.ts";
import type { SubagentRequest, SubagentRunner } from "../src/core/subagent.ts";

const def = (name: string): AgentDef => ({ name, description: name, systemPrompt: "", filePath: `${name}.md` });
const agents = new Map([
	["a", def("a")],
	["b", def("b")],
]);

function fakeRunner(fail?: string) {
	const seen: SubagentRequest[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const runner: SubagentRunner = {
		async run(req) {
			seen.push(req);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			const usage = { input: 1, output: 1, costUSD: 0, turns: 1, peakContextTokens: 1 };
			if (req.agent.name === fail) return { agent: req.agent.name, model: "m", text: "", usage, error: "boom" };
			return { agent: req.agent.name, model: "m", text: `${req.agent.name}:${req.task}`, usage };
		},
	};
	return { runner, seen, maxInFlight: () => maxInFlight };
}

describe("delegate", () => {
	it("rejects ambiguous params", () => {
		expect(() => delegateMode({ agent: "a", task: "x", tasks: [{ agent: "b", task: "y" }] })).toThrow(/exactly one/);
		expect(() => delegateMode({})).toThrow();
	});

	it("runs parallel tasks with bounded concurrency, keeping order", async () => {
		const f = fakeRunner();
		const tasks = Array.from({ length: 5 }, (_, i) => ({ agent: i % 2 ? "a" : "b", task: `t${i}` }));
		const results = await runDelegate({ tasks }, { agents, runner: f.runner, maxConcurrency: 2, maxParallelTasks: 8 });
		expect(results.map((r) => r.text)).toEqual(["b:t0", "a:t1", "b:t2", "a:t3", "b:t4"]);
		expect(f.maxInFlight()).toBeLessThanOrEqual(2);
	});

	it("chains outputs through {previous} and stops on failure", async () => {
		const f = fakeRunner("b");
		const results = await runDelegate(
			{ chain: [{ agent: "a", task: "start" }, { agent: "b", task: "got {previous}" }, { agent: "a", task: "never" }] },
			{ agents, runner: f.runner, maxConcurrency: 1, maxParallelTasks: 8 },
		);
		expect(f.seen[1].task).toBe("got a:start");
		expect(results).toHaveLength(2);
		expect(results[1].error).toBe("boom");
	});

	it("fails fast on unknown agents", async () => {
		const f = fakeRunner();
		await expect(
			runDelegate({ tasks: [{ agent: "nope", task: "x" }] }, { agents, runner: f.runner, maxConcurrency: 2, maxParallelTasks: 8 }),
		).rejects.toThrow(/Unknown agent "nope"/);
		expect(f.seen).toHaveLength(0);
	});

	it("parses agent frontmatter with model lists and mcp servers", () => {
		const parsed = parseAgentDef(
			"---\nname: r\ndescription: d\nmodel: anthropic/x, ollama/y\ntools: [read, web_search]\nmcp: playwright\n---\nBody",
			"r.md",
		);
		expect(parsed).toMatchObject({ models: ["anthropic/x", "ollama/y"], tools: ["read", "web_search"], mcp: ["playwright"], systemPrompt: "Body" });
	});
});
