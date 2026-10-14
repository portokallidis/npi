/**
 * Local / self-hosted OpenAI-compatible servers, configured from environment variables (see .env.example)
 * instead of hand-edited models.json. Models are discovered from each server's /v1/models.
 * llama.cpp router servers are registered as `llamacpp` through their OpenAI-compatible /v1 API; pi's own
 * `/llama` command (load/unload/download models) keeps working from the same LLAMA_BASE_URL.
 */
const SERVERS = [
	{ provider: "llamacpp", url: "LLAMA_BASE_URL", key: "LLAMA_API_KEY", suffix: "/v1" },
	{ provider: "ollama", url: "OLLAMA_BASE_URL", key: "OLLAMA_API_KEY", suffix: "" },
	{ provider: "lmstudio", url: "LMSTUDIO_BASE_URL", key: "LMSTUDIO_API_KEY", suffix: "" },
	{ provider: "vllm", url: "VLLM_BASE_URL", key: "VLLM_API_KEY", suffix: "" },
	{ provider: "openai-compatible", url: "OPENAI_COMPATIBLE_BASE_URL", key: "OPENAI_COMPATIBLE_API_KEY", suffix: "" },
] as const;

const DISCOVERY_TIMEOUT_MS = 2000;
const DEFAULT_CONTEXT = 32_768;

interface Discovered {
	id: string;
	contextWindow: number;
}

/** OpenAI-compatible /models, plus LM Studio's native /api/v1/models for context sizes when available. */
export async function discover(baseUrl: string, apiKey?: string): Promise<Discovered[]> {
	const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	const root = baseUrl.replace(/\/+$/, "");
	const res = await fetch(`${root}/models`, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data: { id: string; status?: { args?: string[] } }[] = (await res.json())?.data ?? [];
	const ids = data.map((m) => m.id).filter((id) => !/embed/i.test(id));
	const contexts = new Map<string, number>();
	// llama.cpp router: per-model --ctx-size in status.args.
	for (const m of data) {
		const i = m.status?.args?.indexOf("--ctx-size") ?? -1;
		if (i >= 0) contexts.set(m.id, Number(m.status!.args![i + 1]) || DEFAULT_CONTEXT);
	}
	try {
		const native = await fetch(`${root.replace(/\/v1$/, "")}/api/v1/models`, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
		if (native.ok) for (const m of (await native.json())?.models ?? []) if (m.key && m.max_context_length) contexts.set(m.key, m.max_context_length);
	} catch {
		// Not LM Studio: keep defaults.
	}
	return ids.map((id) => ({ id, contextWindow: contexts.get(id) ?? DEFAULT_CONTEXT }));
}

export interface LocalProvider {
	name: string;
	config: {
		baseUrl: string;
		api: "openai-completions";
		apiKey: string;
		models: ReturnType<typeof toConfig>;
		refreshModels: () => Promise<ReturnType<typeof toConfig>>;
	};
}

function toConfig(models: Discovered[]) {
	return models.map((m) => ({
		id: m.id,
		name: m.id,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow,
		maxTokens: Math.min(16_384, Math.floor(m.contextWindow / 4)),
	}));
}

/** Provider configs for every local server set in the environment (offline servers get an empty, refreshable list). */
export async function localProviders(env: NodeJS.ProcessEnv = process.env): Promise<LocalProvider[]> {
	const found = await Promise.all(
		SERVERS.map(async ({ provider, url, key, suffix }): Promise<LocalProvider | undefined> => {
			const configured = env[url]?.replace(/\/+$/, "");
			if (!configured) return undefined;
			const baseUrl = suffix && !configured.endsWith(suffix) ? `${configured}${suffix}` : configured;
			let models: Discovered[] = [];
			try {
				models = await discover(baseUrl, env[key]);
			} catch {
				// Server offline right now: register anyway; refreshModels picks models up later (e.g. on /model).
			}
			return {
				name: provider,
				config: {
					baseUrl,
					api: "openai-completions",
					apiKey: env[key] || provider,
					models: toConfig(models),
					refreshModels: async () => toConfig(await discover(baseUrl, env[key])),
				},
			};
		}),
	);
	return found.filter((p): p is LocalProvider => !!p);
}
