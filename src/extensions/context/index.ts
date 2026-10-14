import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { digestToolOutput } from "../../core/digest.ts";
import { runtimeHolder } from "../runtime.ts";

/** Tools whose output is already compact, or that page through artifacts themselves. */
const EXEMPT = new Set(["read", "delegate", "brainstorm", "science", "tool_search"]);

/**
 * Keeps the main context lean: a large tool result is written to an artifact and replaced by a digest from
 * the small local model (or a plain preview) plus the artifact path, which the model can `read` if needed.
 */
export default function contextGuard(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	pi.on("session_start", () => holder.reset());

	pi.on("tool_result", async (event, ctx) => {
		if (EXEMPT.has(event.toolName) || event.content.some((c) => c.type !== "text")) return;
		const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		const rt = holder.get(ctx);
		const c = rt.config.context;
		if (text.length <= c.toolResultInlineChars) return;
		const path = rt.artifacts.write(`tool-${event.toolName}`, text, "txt");
		const digest = await digestToolOutput(text, {
			llm: rt.llm,
			models: c.digestModels,
			tool: event.toolName,
			path,
			previewChars: c.toolResultPreviewChars,
			maxInputChars: c.digestMaxInputChars,
			timeoutMs: c.digestTimeoutMs,
		});
		// structuredContent is dropped on purpose: it would carry the full payload back into context.
		return { content: [{ type: "text", text: digest.text }], structuredContent: undefined };
	});
}
