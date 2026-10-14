import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Full outputs live on disk; contexts carry only a summary plus the artifact path. Any agent with the
 * `read` tool can open (or page through with offset/limit) an artifact when it actually needs the detail.
 */
export class ArtifactStore {
	readonly dir: string;
	private counter = 0;

	constructor(
		readonly cwd: string,
		baseDir: string,
		readonly runId: string = new Date().toISOString().replace(/[:.]/g, "-"),
	) {
		this.dir = resolve(cwd, baseDir, runId);
	}

	/** Write content and return its path relative to cwd (what we show to models). */
	write(name: string, content: string, ext = "md"): string {
		mkdirSync(this.dir, { recursive: true });
		const safe = name.replace(/[^\w.-]+/g, "-").slice(0, 60) || "artifact";
		const file = join(this.dir, `${String(++this.counter).padStart(3, "0")}-${safe}.${ext}`);
		writeFileSync(file, content);
		return relative(this.cwd, file).replaceAll("\\", "/");
	}
}

/** Rough token estimate (4 chars/token) for budgeting without a tokenizer. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);

/** Head of a long text, cut at a line boundary, with a pointer to the full artifact. */
export function preview(text: string, maxChars: number, path: string): string {
	if (text.length <= maxChars) return text;
	const cut = text.lastIndexOf("\n", maxChars);
	const head = text.slice(0, cut > maxChars / 2 ? cut : maxChars);
	return `${head}\n\n[… ${text.length - head.length} more chars (~${approxTokens(text)} tokens total) in ${path} — read it with offset/limit only if needed]`;
}

/**
 * Extract the caller-facing summary from a subagent's final message: the "## Summary" section if present,
 * otherwise the head of the text. Capped at `maxTokens`.
 */
export function extractSummary(text: string, maxTokens: number): string {
	const match = text.match(/^#{1,3}\s*Summary\s*$([\s\S]*?)(?=^#{1,3}\s|\s*$(?![\s\S]))/im);
	const summary = (match?.[1] ?? text).trim();
	const maxChars = maxTokens * 4;
	if (summary.length <= maxChars) return summary;
	const cut = summary.lastIndexOf("\n", maxChars);
	return `${summary.slice(0, cut > maxChars / 2 ? cut : maxChars)} …`;
}
