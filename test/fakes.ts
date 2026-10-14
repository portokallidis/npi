import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { Llm, LlmRequest } from "../src/core/llm.ts";

export function usage(cost = 0.01): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

export function toolCallMessage(name: string, args: Record<string, unknown>, model = "fake"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args as any }],
		api: "openai-completions",
		provider: "fake",
		model,
		usage: usage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as AssistantMessage;
}

export function textMessage(text: string, model = "fake"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fake",
		model,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

export interface RecordedCall {
	ref: string;
	request: LlmRequest;
	prompt: string;
}

export type Responder = (call: RecordedCall) => AssistantMessage | Promise<AssistantMessage>;

/** Scriptable Llm: `respond` decides the reply from model ref + prompt text. */
export class FakeLlm implements Llm {
	readonly calls: RecordedCall[] = [];
	readonly unavailable = new Set<string>();

	constructor(private respond: Responder) {}

	async available(ref: string) {
		return !this.unavailable.has(ref);
	}

	async complete(ref: string, request: LlmRequest) {
		const last = request.messages.at(-1);
		const prompt = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
		const call = { ref, request, prompt };
		this.calls.push(call);
		return this.respond(call);
	}
}
