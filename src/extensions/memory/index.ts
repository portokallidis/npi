import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadNotes, pinned, recall, remember } from "../../core/memory.ts";
import { runtimeHolder } from "../runtime.ts";

const RememberParams = Type.Object({
	text: Type.String({ description: "One self-contained fact, preference or decision worth keeping across sessions" }),
	tags: Type.Optional(Type.Array(Type.String(), { description: 'Short tags; add "pin" only for things that must always be remembered' })),
	global: Type.Optional(Type.Boolean({ description: "true = applies to all projects, not just this one" })),
});
const RecallParams = Type.Object({ query: Type.String({ description: "Keywords to search past notes" }) });

/**
 * Long-term memory across sessions: `remember` / `recall` tools over one Markdown file in the agent dir.
 * Only #pin notes (capped) enter every prompt; everything else costs tokens only when recalled.
 */
export default function memory(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	pi.on("session_start", () => holder.reset());

	const dirOf = (rt: ReturnType<typeof holder.get>) => join(rt.agentDir, rt.config.memory.dir);

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description: "Save a durable note (user preference, project decision, hard-won fact) for future sessions. Not for transient task state.",
		promptSnippet: "Save durable preferences/decisions for future sessions",
		parameters: RememberParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const rt = holder.get(ctx);
			const note = remember(dirOf(rt), { project: params.global ? "*" : basename(ctx.cwd), text: params.text, tags: params.tags ?? [] });
			return { content: [{ type: "text", text: `Remembered (${note.project}): ${note.text}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description: "Search notes saved in earlier sessions (preferences, decisions, facts). Use when the user refers to past work or preferences.",
		promptSnippet: "Search long-term notes from earlier sessions",
		parameters: RecallParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const rt = holder.get(ctx);
			const hits = recall(loadNotes(dirOf(rt)), params.query, basename(ctx.cwd));
			const text = hits.map((n) => `- ${n.date} [${n.project}] ${n.text}${n.tags.length ? ` #${n.tags.join(" #")}` : ""}`).join("\n");
			return { content: [{ type: "text", text: text || "No matching notes." }], details: undefined };
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		const rt = holder.get(ctx);
		const notes = loadNotes(dirOf(rt));
		if (!notes.length) return;
		const pins = pinned(notes, basename(ctx.cwd), rt.config.memory.pinnedChars);
		const body = `${notes.length} notes saved from earlier sessions; use \`recall\` when past preferences or decisions may matter.${pins.length ? `\nAlways keep in mind:\n${pins.join("\n")}` : ""}`;
		event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, npi_memory: body };
	});

	pi.registerCommand("memory", {
		description: "Show the memory file location and pinned notes",
		handler: async (_args, ctx) => {
			const rt = holder.get(ctx);
			const notes = loadNotes(dirOf(rt));
			ctx.ui.notify(`${notes.length} notes in ${join(dirOf(rt), "notes.md")}\n${pinned(notes, basename(ctx.cwd), 4000).join("\n")}`, "info");
		},
	});
}
