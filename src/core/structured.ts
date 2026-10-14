import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Budget } from "./budget.ts";
import type { ThinkingLevel } from "./config.ts";
import { assistantText, type Llm, userMessage } from "./llm.ts";

export interface StructuredCall<T extends TSchema> {
	model: string;
	/** For budget accounting and error messages. */
	label: string;
	system: string;
	prompt: string;
	schema: T;
	toolName: string;
	toolDescription: string;
	thinking?: ThinkingLevel;
	maxTokens?: number;
	signal?: AbortSignal;
}

/** Pull candidate arguments from a tool call, or from JSON in the text for models without tool calling. */
function extractArgs(message: AssistantMessage, toolName: string): unknown {
	const call = message.content.find((block) => block.type === "toolCall" && block.name === toolName);
	if (call?.type === "toolCall") return call.arguments;
	const text = assistantText(message);
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
	try {
		return JSON.parse(candidate);
	} catch {
		return undefined;
	}
}

function validate<T extends TSchema>(schema: T, value: unknown): { ok: true; value: Static<T> } | { ok: false; errors: string } {
	if (value === undefined || value === null) return { ok: false, errors: "no tool call and no JSON object found" };
	const converted = Value.Convert(schema, Value.Clone(value));
	if (Value.Check(schema, converted)) return { ok: true, value: converted as Static<T> };
	const errors = [...Value.Errors(schema, converted)].slice(0, 8).map((e) => `${e.instancePath || "/"}: ${e.message}`);
	return { ok: false, errors: errors.join("; ") };
}

/**
 * One model call whose answer must match `schema`. The model is asked to call a single "submit"
 * tool; JSON in plain text is accepted as a fallback. One repair attempt quotes the validation errors.
 */
export async function callStructured<T extends TSchema>(llm: Llm, budget: Budget, call: StructuredCall<T>): Promise<Static<T>> {
	const tool = { name: call.toolName, description: call.toolDescription, parameters: call.schema };
	const instruction = `\n\nRespond ONLY by calling the \`${call.toolName}\` tool exactly once. If you cannot call tools, reply with a single JSON object matching its parameters.`;
	let prompt = call.prompt + instruction;
	let lastError = "";
	let thinking = call.thinking;

	for (let attempt = 0; attempt < 2; attempt++) {
		budget.assertAvailable();
		const message = await llm.complete(call.model, {
			system: call.system,
			messages: [userMessage(prompt)],
			tools: [tool],
			thinking,
			label: call.label,
			maxTokens: call.maxTokens,
			signal: call.signal,
		});
		budget.add(call.label, call.model, message.usage);
		const result = validate(call.schema, extractArgs(message, call.toolName));
		if (result.ok) return result.value;
		lastError = result.errors;
		// Reasoning can eat the whole output budget before the answer is written (stopReason "length",
		// or no tool call at all): retry without thinking so the budget goes to the answer.
		if (message.stopReason === "length" || extractArgs(message, call.toolName) === undefined) thinking = "off";
		const previous = JSON.stringify(extractArgs(message, call.toolName) ?? assistantText(message)).slice(0, 4000);
		prompt = `${call.prompt}\n\nYour previous answer was invalid (${lastError}). Previous answer:\n${previous}\n\nFix it.${instruction}`;
	}
	throw new Error(`${call.label}: ${call.model} did not return valid ${call.toolName} arguments (${lastError})`);
}
