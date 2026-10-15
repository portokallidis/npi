import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, convertToLlm, type SessionEntry, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { changedFiles, gitRoot, restore, snapshot } from "../../core/gitsnap.ts";
import { EXTERNAL_AGENTS, HANDOFF_SYSTEM, parseHandoff } from "../../core/handoff.ts";
import { assistantText, firstAvailable, parseModelRef, userMessage } from "../../core/llm.ts";
import { latestEntry, runtimeHolder } from "../runtime.ts";

const MUTATING = new Set(["edit", "write", "bash", "powershell"]);
const MAX_CHECKPOINTS = 30;
/** Session entry that restores the todo list after a restart or /resume. */
const TODOS_ENTRY = "npi-todos";

const TodoItem = Type.Object({
	text: Type.String(),
	status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")]),
});
const TodoParams = Type.Object({ todos: Type.Array(TodoItem, { description: "The complete, updated list (replaces the previous one)" }) });
type Todo = { text: string; status: "pending" | "in_progress" | "done" };

/** Conversation since the last compaction (summary + kept entries), like pi's handoff example. */
function branchMessages(branch: SessionEntry[]): AgentMessage[] {
	const last = branch.findLastIndex((e) => e.type === "compaction");
	const compaction = branch[last];
	let kept = branch;
	if (last >= 0 && compaction.type === "compaction") {
		const firstKept = branch.findIndex((e) => e.id === compaction.firstKeptEntryId);
		kept = [compaction, ...(firstKept >= 0 ? branch.slice(firstKept, last) : []), ...branch.slice(last + 1)];
	}
	return kept.flatMap((e): AgentMessage[] => {
		if (e.type === "message") return [e.message];
		if (e.type === "compaction") return [{ role: "compactionSummary", summary: e.summary, tokensBefore: e.tokensBefore, timestamp: Date.parse(e.timestamp) } as AgentMessage];
		return [];
	});
}

/**
 * Small workflow tools borrowed from the best harnesses, kept lean:
 * - `todo`: a visible task list the model keeps up to date (Claude Code / Cline style)
 * - file checkpoints before each turn's first change, `/undo` and `/checkpoints` (opencode / Cline style)
 * - `/handoff [--to mode|provider/model|claude|codex|…] <goal>`: fresh focused thread instead of lossy compaction (Amp style)
 */
export default function workflow(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	let todos: Todo[] = [];
	let checkpoints: { tree: string; at: string; label: string }[] = [];
	let root: string | undefined | null = null; // null = not checked yet
	let snappedThisTurn = false;
	let activeRoute: string | undefined;

	pi.events.on("npi:route", (name) => {
		activeRoute = typeof name === "string" ? name : undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		holder.reset();
		todos = latestEntry<{ todos: Todo[] }>(ctx, TODOS_ENTRY)?.todos ?? [];
		checkpoints = [];
		root = null;
		showTodos(ctx);
	});

	// ---- todo ------------------------------------------------------------------------------------
	function showTodos(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const icon = { pending: "○", in_progress: "◐", done: "●" } as const;
		ctx.ui.setWidget("todo", todos.length && todos.some((t) => t.status !== "done") ? todos.map((t) => `${icon[t.status]} ${t.text}`) : undefined);
	}

	pi.registerTool<typeof TodoParams, { todos: Todo[] }>({
		name: "todo",
		label: "Todo",
		description: "Track a multi-step task: send the full updated list each time (pending / in_progress / done). Keep exactly one item in_progress.",
		promptSnippet: "Maintain a visible todo list for multi-step work",
		parameters: TodoParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			todos = params.todos;
			pi.appendEntry(TODOS_ENTRY, { todos });
			showTodos(ctx);
			const open = todos.filter((t) => t.status !== "done").length;
			return { content: [{ type: "text", text: `${todos.length} items, ${open} open` }], details: { todos } };
		},
	});

	// ---- checkpoints -----------------------------------------------------------------------------
	pi.on("turn_start", () => {
		snappedThisTurn = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (snappedThisTurn || !MUTATING.has(event.toolName)) return;
		snappedThisTurn = true;
		if (root === null) root = (await gitRoot(ctx.cwd)) ?? undefined;
		if (!root) return;
		try {
			const tree = await snapshot(root);
			if (checkpoints.at(-1)?.tree !== tree) {
				checkpoints.push({ tree, at: new Date().toLocaleTimeString(), label: `before ${event.toolName}` });
				checkpoints = checkpoints.slice(-MAX_CHECKPOINTS);
			}
		} catch {
			// A snapshot failure must never block the tool.
		}
	});

	pi.registerCommand("undo", {
		description: "Restore files to a checkpoint taken before the agent changed them: /undo [n] (default: the latest)",
		handler: async (args, ctx) => {
			if (!root || !checkpoints.length) return ctx.ui.notify("No checkpoints yet (needs a git repo and a file change)", "info");
			const n = Math.max(1, Number.parseInt(args, 10) || 1);
			const target = checkpoints[checkpoints.length - n];
			if (!target) return ctx.ui.notify(`Only ${checkpoints.length} checkpoint(s)`, "error");
			const now = await snapshot(root);
			const files = await changedFiles(root, target.tree, now);
			if (!files.length) return ctx.ui.notify("Files already match that checkpoint", "info");
			const ok = !ctx.hasUI || (await ctx.ui.confirm(`Restore ${files.length} file(s) to ${target.at} (${target.label})?`, files.slice(0, 15).join("\n")));
			if (!ok) return;
			checkpoints.push({ tree: now, at: new Date().toLocaleTimeString(), label: "before /undo (redo point)" });
			await restore(root, target.tree);
			ctx.ui.notify(`Restored ${files.length} file(s). /undo again returns to the state before this undo.`, "info");
		},
	});

	pi.registerCommand("checkpoints", {
		description: "List file checkpoints for /undo",
		handler: async (_args, ctx) => {
			ctx.ui.notify(checkpoints.map((c, i) => `${checkpoints.length - i}. ${c.at} ${c.label} ${c.tree.slice(0, 8)}`).reverse().join("\n") || "No checkpoints", "info");
		},
	});

	// ---- handoff ---------------------------------------------------------------------------------
	pi.registerCommand("handoff", {
		description: "Start a focused new thread: /handoff [--to mode|provider/model|claude|codex|opencode|gemini|pi] <goal>",
		handler: async (args, ctx) => {
			const rt = holder.get(ctx);
			let parsed: ReturnType<typeof parseHandoff>;
			try {
				parsed = parseHandoff(args, Object.keys(rt.config.routes));
			} catch (error) {
				return ctx.ui.notify((error as Error).message, "error");
			}
			const { target, goal } = parsed;
			if (!goal) return ctx.ui.notify("Usage: /handoff [--to target] <goal for the new thread>", "error");
			const messages = branchMessages(ctx.sessionManager.getBranch());
			if (!messages.length) return ctx.ui.notify("Nothing to hand off yet", "info");

			// Summarize on the current route's model (handoffs are worth a good model, and it saw the work).
			const route = rt.config.routes[activeRoute ?? ""] ?? rt.config.routes[rt.config.router.defaultRoute];
			const model =
				ctx.model && !ctx.model.provider.startsWith("npi")
					? `${ctx.model.provider}/${ctx.model.id}`
					: await firstAvailable(rt.llm, [...route.models, ...rt.config.routes[rt.config.router.defaultRoute].models]);
			if (!model) return ctx.ui.notify("No model available to write the handoff", "error");
			ctx.ui.setWorkingMessage?.("Writing handoff…");
			const conversation = serializeConversation(convertToLlm(messages)).slice(-120_000);
			const reply = await rt.llm.complete(model, {
				system: HANDOFF_SYSTEM,
				messages: [userMessage(`## Conversation\n\n${conversation}\n\n## Goal for the new thread\n\n${goal}`)],
				maxTokens: 3000,
			});
			ctx.ui.setWorkingMessage?.();
			let prompt = assistantText(reply).trim();
			if (ctx.hasUI) prompt = (await ctx.ui.editor("Edit handoff prompt", prompt))?.trim() ?? "";
			if (!prompt) return ctx.ui.notify("Handoff cancelled", "info");

			const file = rt.artifacts.write("handoff", prompt);
			if (target.kind === "external") {
				return ctx.ui.notify(`Handoff saved to ${file}\nContinue in ${target.agent}:\n  ${EXTERNAL_AGENTS[target.agent](file)}`, "info");
			}
			const text = target.kind === "route" ? `#${target.route} ${prompt}` : prompt;
			const next = target.kind === "model" ? parseModelRef(target.model) : undefined;
			await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				withSession: async (fresh) => {
					if (next) {
						const m = fresh.modelRegistry.find(next.provider, next.id);
						if (m) await pi.setModel(m);
						else fresh.ui.notify(`Model ${target.kind === "model" ? target.model : ""} not found; kept the default`, "warning");
					}
					fresh.ui.setEditorText(text);
					fresh.ui.notify(`Handoff ready (also saved to ${file}). Review and press Enter.`, "info");
				},
			});
		},
	});
}
