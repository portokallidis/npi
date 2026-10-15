import { approxTokens, preview } from "./artifacts.ts";
import { assistantText, firstAvailable, type Llm, userMessage } from "./llm.ts";
import { withTimeout } from "./pool.ts";

const DIGEST_SYSTEM = `You compress tool output for another AI agent that cannot see it. Keep exactly what it needs to continue: errors and their locations, key numbers, file paths, names, URLs, decisions, and anything surprising. Drop boilerplate and repetition. Plain lines, no preamble, at most 15 lines.`;

const ERROR_LINE = /\b(ERROR|FATAL|FAIL(ED|URE)?|PANIC|Traceback|Exception|AssertionError|Uncaught|ERR!|E[A-Z]{4,}\b|exit code [1-9]|error:)/;
const MAX_ERROR_LINES = 12;

/** Lines that look like errors, verbatim and de-duplicated: a guarantee no model can summarize away. */
export function errorLines(text: string): string[] {
	const seen = new Set<string>();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line && line.length < 400 && ERROR_LINE.test(line)) seen.add(line);
		if (seen.size >= MAX_ERROR_LINES) break;
	}
	return [...seen];
}

const withErrors = (body: string, errors: readonly string[]) =>
	errors.length ? `${body}\n\nError lines (verbatim):\n${errors.map((e) => `  ${e}`).join("\n")}` : body;

/**
 * Turn an oversized tool result into what enters the context: a small-model digest (fast, free, private
 * when local) plus a short head of the raw output and the artifact path. Error-looking lines are always
 * appended verbatim, because models (even large ones) sometimes summarize the surrounding noise instead.
 * Falls back to the plain preview when no summarizer is available or it is too slow — offloading must
 * never block or fail the tool.
 */
export async function digestToolOutput(
	text: string,
	options: { llm: Llm; models: readonly string[]; tool: string; path: string; previewChars: number; maxInputChars: number; timeoutMs: number },
): Promise<{ text: string; by?: string }> {
	const errors = errorLines(text);
	const fallback = { text: withErrors(preview(text, options.previewChars, options.path), errors) };
	const model = await firstAvailable(options.llm, options.models).catch(() => undefined);
	if (!model) return fallback;
	const abort = new AbortController();
	try {
		const input = text.length > options.maxInputChars ? `${text.slice(0, options.maxInputChars * 0.7)}\n…\n${text.slice(-options.maxInputChars * 0.3)}` : text;
		const mustKeep = errors.length ? `\n\nThese lines look like errors — your digest must explain them:\n${errors.join("\n")}` : "";
		const reply = await withTimeout(
			options.llm.complete(model, {
				system: DIGEST_SYSTEM,
				messages: [userMessage(`Output of the \`${options.tool}\` tool (${approxTokens(text)} tokens):${mustKeep}\n\n${input}`)],
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
		return { text: `${withErrors(`Digest of ${approxTokens(text)}-token output (by ${model}):\n${digest}`, errors)}\n\n--- raw head ---\n${head}`, by: model };
	} catch {
		return fallback;
	}
}
