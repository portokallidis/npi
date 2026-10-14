import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { preview } from "../../core/artifacts.ts";
import { runtimeHolder } from "../runtime.ts";

/** Tools whose output is already compact, or that page through artifacts themselves. */
const EXEMPT = new Set(["read", "delegate", "brainstorm", "tool_search"]);

/**
 * Keeps the main context lean: a large tool result is written to an artifact and replaced by a preview
 * plus the artifact path, which the model can `read` (with offset/limit) if it really needs more.
 */
export default function contextGuard(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	pi.on("session_start", () => holder.reset());

	pi.on("tool_result", (event, ctx) => {
		if (EXEMPT.has(event.toolName) || event.content.some((c) => c.type !== "text")) return;
		const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		const rt = holder.get(ctx);
		const { toolResultInlineChars, toolResultPreviewChars } = rt.config.context;
		if (text.length <= toolResultInlineChars) return;
		const path = rt.artifacts.write(`tool-${event.toolName}`, text, "txt");
		// structuredContent is dropped on purpose: it would carry the full payload back into context.
		return { content: [{ type: "text", text: preview(text, toolResultPreviewChars, path) }], structuredContent: undefined };
	});
}
