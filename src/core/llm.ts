import type { AssistantMessage, Message, Model, Tool } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./config.ts";

export interface ModelRef {
	provider: string;
	id: string;
}

/**
 * "openrouter/z-ai/glm-5.3" -> { provider: "openrouter", id: "z-ai/glm-5.3" }.
 * "local/<name>" is an alias resolved from NPI_LOCAL_<NAME> (see .env.example), so shared configs can
 * say "local/large" while each machine maps it to its own server, e.g. "llama.cpp/qwen3.8-27b".
 */
export function parseModelRef(ref: string): ModelRef {
	if (ref.startsWith("local/")) {
		const target = process.env[`NPI_LOCAL_${ref.slice(6).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
		if (target && !target.startsWith("local/")) return parseModelRef(target);
	}
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) throw new Error(`Invalid model ref "${ref}" (expected provider/model-id)`);
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export interface LlmRequest {
	system?: string;
	messages: Message[];
	tools?: Tool[];
	thinking?: ThinkingLevel;
	/** What this call is for (benchmarks/telemetry), e.g. "panel:gpt" or "science:extract". */
	label?: string;
	/** Output cap for this call (keeps each role's contribution to downstream contexts bounded). */
	maxTokens?: number;
	signal?: AbortSignal;
}

/** The narrow model-calling surface npi's logic depends on (fakeable in tests). */
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

const TRANSIENT = /HTTP (429|5\d\d)\b|\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_[A-Z_]+)\b|fetch failed|connection error|socket hang up|overloaded|rate limit/i;
const RETRIES = 2;
const RETRY_DELAYS_MS = [3000, 10000];

/** Self-hosted servers (loopback or private LAN): probe them before use, since they may be switched off. */
const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)(:\d+)?/i;
const PROBE_TTL_MS = 30_000;

/** One finished model call, for benchmarks and telemetry. */
export interface CallRecord {
	ref: string;
	label?: string;
	provider: string;
	modelId: string;
	baseUrl: string;
	local: boolean;
	thinking: boolean;
	startedAt: number;
	/** Time to the first streamed token (text, thinking or tool call). */
	ttftMs?: number;
	totalMs: number;
	input: number;
	output: number;
	cacheRead: number;
	reasoning?: number;
	costUSD: number;
	stop: string;
	error?: string;
}

export const isLocalUrl = (url: string | undefined) => LOCAL_HOST.test(url ?? "");

/** Llm backed by pi's ModelRegistry (auth, models.json providers, virtual-model safe). */
export function registryLlm(registry: ModelRegistry, observe?: (call: CallRecord) => void): Llm {
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

	const llm: Llm = {
		async available(ref) {
			const model = resolve(ref);
			if (!model || !registry.hasConfiguredAuth(model)) return false;
			return LOCAL_HOST.test(model.baseUrl ?? "") ? probe(model.baseUrl) : true;
		},
		async complete(ref, request) {
			// Transient failures (dropped connections, busy single-slot local servers, 429/5xx) are retried.
			for (let attempt = 0; ; attempt++) {
				try {
					return await completeOnce(ref, request);
				} catch (error) {
					const message = (error as Error).message;
					if (attempt >= RETRIES || request.signal?.aborted || !TRANSIENT.test(message)) throw error;
					await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
				}
			}
		},
	};

	async function completeOnce(ref: string, request: LlmRequest): Promise<AssistantMessage> {
			const model = resolve(ref);
			if (!model) throw new Error(`Model ${ref} is not in the catalog`);
			const local = LOCAL_HOST.test(model.baseUrl ?? "");
			// Local servers think by default and ignore pi's "off": LM Studio honours reasoning_effort,
			// llama.cpp/vLLM honour chat_template_kwargs. Unspecified thinking means off for local models.
			const noThink = local && (request.thinking === undefined || request.thinking === "off");
			const startedAt = Date.now();
			let ttftMs: number | undefined;
			const record = (message: AssistantMessage | undefined, error?: string) =>
				observe?.({
					ref,
					label: request.label,
					provider: model.provider,
					modelId: model.id,
					baseUrl: model.baseUrl ?? "",
					local,
					thinking: !noThink && request.thinking !== "off" && request.thinking !== undefined,
					startedAt,
					ttftMs,
					totalMs: Date.now() - startedAt,
					input: message?.usage.input ?? 0,
					output: message?.usage.output ?? 0,
					cacheRead: message?.usage.cacheRead ?? 0,
					reasoning: message?.usage.reasoning,
					costUSD: message?.usage.cost.total ?? 0,
					stop: message?.stopReason ?? "error",
					error,
				});
			const stream = registry.streamSimple(
				model,
				{ systemPrompt: request.system, messages: request.messages, tools: request.tools },
				{
					signal: request.signal,
					maxTokens: request.maxTokens,
					reasoning: request.thinking === "off" || noThink ? undefined : request.thinking,
					...(noThink && { samplingParams: { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } } }),
				},
			);
			let message: AssistantMessage;
			try {
				if (observe) {
					for await (const event of stream) {
						if (ttftMs === undefined && /_(delta|start)$/.test(event.type) && event.type !== "start") ttftMs = Date.now() - startedAt;
					}
				}
				message = await stream.result();
			} catch (error) {
				record(undefined, (error as Error).message);
				throw error;
			}
			record(message, message.stopReason === "error" || message.stopReason === "aborted" ? message.errorMessage ?? message.stopReason : undefined);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(`${ref}: ${message.errorMessage ?? message.stopReason}`);
			}
			return message;
	}
	return llm;
}
