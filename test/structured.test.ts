import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Budget, BudgetExceededError } from "../src/core/budget.ts";
import { callStructured } from "../src/core/structured.ts";
import { FakeLlm, textMessage, toolCallMessage } from "./fakes.ts";

const schema = Type.Object({ verdict: Type.String(), confidence: Type.Number({ minimum: 0, maximum: 1 }) });
const call = { model: "fake/m", label: "t", system: "s", prompt: "decide", schema, toolName: "submit", toolDescription: "d" };

describe("callStructured", () => {
	it("returns validated tool-call arguments", async () => {
		const llm = new FakeLlm(() => toolCallMessage("submit", { verdict: "yes", confidence: 0.9 }));
		const budget = new Budget(1);
		await expect(callStructured(llm, budget, call)).resolves.toEqual({ verdict: "yes", confidence: 0.9 });
		expect(llm.calls[0].request.tools?.[0].name).toBe("submit");
		expect(budget.entries).toHaveLength(1);
	});

	it("accepts JSON in plain text (local models without tool calling)", async () => {
		const llm = new FakeLlm(() => textMessage('Sure:\n```json\n{"verdict":"no","confidence":"0.4"}\n```'));
		await expect(callStructured(llm, new Budget(1), call)).resolves.toEqual({ verdict: "no", confidence: 0.4 });
	});

	it("repairs once with the validation errors, then succeeds", async () => {
		let n = 0;
		const llm = new FakeLlm(() =>
			n++ === 0 ? toolCallMessage("submit", { verdict: "yes" }) : toolCallMessage("submit", { verdict: "yes", confidence: 1 }),
		);
		await expect(callStructured(llm, new Budget(1), call)).resolves.toEqual({ verdict: "yes", confidence: 1 });
		expect(llm.calls).toHaveLength(2);
		expect(llm.calls[1].prompt).toMatch(/confidence/);
	});

	it("throws after the repair attempt also fails", async () => {
		const llm = new FakeLlm(() => textMessage("I refuse to use tools"));
		await expect(callStructured(llm, new Budget(1), call)).rejects.toThrow(/did not return valid submit/);
		expect(llm.calls).toHaveLength(2);
	});

	it("refuses to call once the budget is spent", async () => {
		const llm = new FakeLlm(() => toolCallMessage("submit", { verdict: "x", confidence: 0 }));
		const budget = new Budget(0.005);
		budget.add("earlier", "m", { input: 1, output: 1, cost: { total: 0.01 } as any });
		await expect(callStructured(llm, budget, call)).rejects.toBeInstanceOf(BudgetExceededError);
		expect(llm.calls).toHaveLength(0);
	});

	it("retries without thinking when the first answer had no tool call", async () => {
		let n = 0;
		const llm = new FakeLlm(() => (n++ === 0 ? textMessage("…thinking ran out of tokens…") : toolCallMessage("submit", { verdict: "ok", confidence: 0.5 })));
		await expect(callStructured(llm, new Budget(1), { ...call, thinking: "high" })).resolves.toEqual({ verdict: "ok", confidence: 0.5 });
		expect(llm.calls.map((c) => c.request.thinking)).toEqual(["high", "off"]);
	});
});
