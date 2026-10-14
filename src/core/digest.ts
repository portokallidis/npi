import { approxTokens, preview } from "./artifacts.ts";
import { assistantText, firstAvailable, type Llm, userMessage } from "./llm.ts";
import { withTimeout } from "./pool.ts";

const DIGEST_SYSTEM = `You compress tool output for another AI agent that cannot see it. Keep exactly what it needs to continue: errors and their locations, key numbers, file paths, names, URLs, decisions, and anything surprising. Drop boilerplate and repetition. Plain lines, no preamble, at most 15 lines.`;

/**
 * Turn an oversized tool result into what enters the context: a small-model digest (fast, free, private
 * when local) plus a short head of the raw output and the artifact path. Falls back to the plain preview
 * when no summarizer is available or it is too slow — offloading must never block or fail the tool.
 */
export async function digestToolOutput(
	text: string,
	options: { llm: Llm; models: readonly string[]; tool: string; path: string; previewChars: number; maxInputChars: number; timeoutMs: number },
): Promise<{ text: string; by?: string }> {
	const fallback = { text: preview(text, options.previewChars, options.path) };
	const model = await firstAvailable(options.llm, options.models).catch(() => undefined);
	if (!model) return fallback;
	const abort = new AbortController();
	try {
		const input = text.length > options.maxInputChars ? `${text.slice(0, options.maxInputChars * 0.7)}\n…\n${text.slice(-options.maxInputChars * 0.3)}` : text;
		const reply = await withTimeout(
			options.llm.complete(model, {
				system: DIGEST_SYSTEM,
				messages: [userMessage(`Output of the \`${options.tool}\` tool (${approxTokens(text)} tokens):\n\n${input}`)],
				thinking: "off",
				label: "digest",
				maxTokens: 600,
				signal: abort.signal,
			}),
			options.timeoutMs,
			"digest",
			// Free the (often single-slot) local server instead of letting the request run on.
			() => abort.abort(),
		);
		const digest = assistantText(reply).trim();
		if (!digest) return fallback;
		const head = preview(text, Math.min(800, options.previewChars), options.path);
		return { text: `Digest of ${approxTokens(text)}-token output (by ${model}):\n${digest}\n\n--- raw head ---\n${head}`, by: model };
	} catch {
		return fallback;
	}
}
