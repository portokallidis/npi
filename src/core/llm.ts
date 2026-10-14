import type { AssistantMessage, Message, Model, Tool } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./config.ts";

export interface ModelRef {
	provider: string;
	id: string;
}

/** "openrouter/z-ai/glm-5.3" -> { provider: "openrouter", id: "z-ai/glm-5.3" } */
export function parseModelRef(ref: string): ModelRef {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) throw new Error(`Invalid model ref "${ref}" (expected provider/model-id)`);
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export interface LlmRequest {
	system?: string;
	messages: Message[];
	tools?: Tool[];
	thinking?: ThinkingLevel;
	/** Output cap for this call (keeps each role's contribution to downstream contexts bounded). */
	maxTokens?: number;
	signal?: AbortSignal;
}

/** The narrow model-calling surface the harness logic depends on (fakeable in tests). */
export interface Llm {
	/** Model is known, has credentials, and (for local servers) the server answers. */
	available(ref: string): Promise<boolean>;
	complete(ref: string, request: LlmRequest): Promise<AssistantMessage>;
}

export async function firstAvailable(llm: Llm, refs: readonly string[]): Promise<string | undefined> {
	for (const ref of refs) if (await llm.available(ref)) return ref;
	return undefined;
}

export function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() };
}

export function assistantText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)(:\d+)?/i;
const PROBE_TTL_MS = 30_000;

/** Llm backed by pi's ModelRegistry (auth, models.json providers, virtual-model safe). */
export function registryLlm(registry: ModelRegistry): Llm {
	const probes = new Map<string, { at: number; up: Promise<boolean> }>();

	function probe(baseUrl: string): Promise<boolean> {
		const cached = probes.get(baseUrl);
		if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.up;
		const up = fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(1200) })
			.then((res) => res.status < 500)
			.catch(() => false);
		probes.set(baseUrl, { at: Date.now(), up });
		return up;
	}

	function resolve(ref: string): Model<any> | undefined {
		const { provider, id } = parseModelRef(ref);
		return registry.find(provider, id);
	}

	return {
		async available(ref) {
			const model = resolve(ref);
			if (!model || !registry.hasConfiguredAuth(model)) return false;
			return LOCAL_HOST.test(model.baseUrl ?? "") ? probe(model.baseUrl) : true;
		},
		async complete(ref, request) {
			const model = resolve(ref);
			if (!model) throw new Error(`Model ${ref} is not in the catalog`);
			const stream = registry.streamSimple(
				model,
				{ systemPrompt: request.system, messages: request.messages, tools: request.tools },
				{
					signal: request.signal,
					maxTokens: request.maxTokens,
					reasoning: request.thinking === "off" ? undefined : request.thinking,
				},
			);
			const message = await stream.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(`${ref}: ${message.errorMessage ?? message.stopReason}`);
			}
			return message;
		},
	};
}
