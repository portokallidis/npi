import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runBrainstorm } from "../../brainstorm/pipeline.ts";
import { renderDigest, renderReport, saveReport } from "../../brainstorm/report.ts";
import type { UserChannel } from "../../brainstorm/resolve/index.ts";
import type { BrainstormEvent, BrainstormReport } from "../../brainstorm/types.ts";
import { Budget } from "../../core/budget.ts";
import { RunState } from "../../core/runstate.ts";
import { runtimeHolder } from "../runtime.ts";

const REPORT_TYPE = "brainstorm-report";
const BrainstormParams = Type.Object({
	question: Type.String({ description: "The goal or question with all context the panel needs (it does not see this conversation)" }),
});
const PANEL_ICON = { thinking: "…", done: "✓", failed: "✗", skipped: "–" } as const;

/** Live panel status above the editor: panelists, disputes, spend. */
function createWidget(ctx: ExtensionContext, budget: Budget) {
	const panelists = new Map<string, string>();
	const disputes = new Map<string, string>();
	let phase = "Starting";

	function draw() {
		if (!ctx.hasUI) return;
		const lines = [
			`🧠 Brainstorm — ${phase}  ($${budget.spentUSD.toFixed(3)} / $${budget.limitUSD.toFixed(2)})`,
			`   panel: ${[...panelists].map(([id, s]) => `${id} ${s}`).join("  ") || "selecting…"}`,
			...[...disputes.values()].map((d) => `   ${d}`),
		];
		ctx.ui.setWidget("brainstorm", lines);
	}
	const unsubscribe = budget.onChange(draw);

	return {
		onEvent(event: BrainstormEvent) {
			if (event.type === "phase") phase = event.text;
			else if (event.type === "panelist") panelists.set(event.id, PANEL_ICON[event.status]);
			else {
				const { dispute, status, resolution } = event;
				const mark = status === "resolved" ? "✓" : status === "resolving" ? "⟳" : "•";
				const how = resolution ? ` → ${resolution.method}: ${resolution.verdict.slice(0, 80)}` : ` [${dispute.kind}]`;
				disputes.set(dispute.id, `${mark} ${dispute.topic}${how}`);
			}
			draw();
		},
		dispose() {
			unsubscribe();
			if (ctx.hasUI) ctx.ui.setWidget("brainstorm", undefined);
		},
	};
}

function userChannel(ctx: ExtensionContext): UserChannel | undefined {
	if (!ctx.hasUI) return undefined;
	return {
		select: (title, options) => ctx.ui.select(title, options),
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
	};
}

/** Most recent unfinished-or-finished brainstorm state file under the artifact dir. */
function latestState(artifactRoot: string): string | undefined {
	if (!existsSync(artifactRoot)) return undefined;
	const files = readdirSync(artifactRoot).flatMap((run) => {
		const dir = join(artifactRoot, run);
		return existsSync(dir) && statSync(dir).isDirectory()
			? readdirSync(dir).filter((f) => f.startsWith("brainstorm-state")).map((f) => join(dir, f))
			: [];
	});
	return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

async function brainstorm(
	question: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	holder: ReturnType<typeof runtimeHolder>,
	emit: (event: unknown) => void,
	stateFile?: string,
) {
	const rt = holder.get(ctx);
	const config = rt.config.brainstorm;
	const budget = new Budget(config.maxCostUSD);
	const widget = createWidget(ctx, budget);
	const state = new RunState(stateFile ?? join(rt.artifacts.dir, `brainstorm-state-${Date.now()}.json`), { prompt: question });
	try {
		const report = await runBrainstorm(String(state.meta.prompt ?? question), config, {
			llm: rt.llm,
			runner: rt.runner,
			evidenceAgent: rt.agents().get(config.evidenceAgent),
			user: userChannel(ctx),
			artifacts: rt.artifacts,
			signal,
			budget,
			state,
			onEvent: widget.onEvent,
		});
		const path = saveReport(report, ctx.cwd, config.reportDir);
		emit({
			type: "brainstorm",
			costUSD: report.costUSD,
			pathways: report.map.pathways.length,
			disputes: report.map.disputes.length,
			resolved: report.resolutions.length,
			recommended: !!report.recommended,
		});
		return { report, path, markdown: renderReport(report), digest: renderDigest(report, path) };
	} finally {
		widget.dispose();
	}
}

export default function brainstormExtension(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	pi.on("session_start", () => holder.reset());
	const emit = (e: unknown) => pi.events.emit("harness:telemetry", e);

	// The user sees the full report; the model's context only gets the digest in `content`.
	pi.registerMessageRenderer<{ path: string; markdown: string }>(REPORT_TYPE, (message, { outputPad }, theme) => {
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		const text = message.details?.markdown ?? (typeof message.content === "string" ? message.content : "");
		box.addChild(new Markdown(`${text}

_Saved to ${message.details?.path ?? "?"}_`, 0, 0, getMarkdownTheme()));
		return box;
	});

	pi.registerTool<typeof BrainstormParams, { path: string; report: BrainstormReport } | undefined>({
		name: "brainstorm",
		label: "Brainstorm panel",
		description:
			"Explore an abstract goal or decision with a panel of different AI models, led by a top frontier orchestrator. " +
			"It asks the user a few direction questions, has every panelist propose distinct pathways with trade-offs, merges them into one map, " +
			"settles disputed trade-offs (web evidence, cross-examination, the user, an independent judge), ranks the pathways, and recommends one " +
			"only if the goal is clear. Returns a compact digest plus the path of the full report. Slow (minutes) and costlier than a normal reply.",
		promptSnippet: "Multi-model exploration of all pathways for a goal, with trade-offs and a recommendation",
		parameters: BrainstormParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Panel convened…" }], details: undefined });
			const { report, path, digest } = await brainstorm(params.question, ctx, signal, holder, emit);
			return {
				content: [{ type: "text", text: digest }],
				details: { path, report },
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: report.costUSD },
				},
			};
		},
	});

	pi.registerCommand("brainstorm", {
		description: "Explore a goal with a multi-model panel: /brainstorm <goal> · /brainstorm --resume [state.json] continues an interrupted run",
		handler: async (args, ctx) => {
			let stateFile: string | undefined;
			let question = args.trim();
			const resume = question.match(/^--resume\s*(\S*)/);
			if (resume) {
				const rt = holder.get(ctx);
				stateFile = resume[1] || latestState(join(ctx.cwd, rt.config.context.artifactDir));
				if (!stateFile || !existsSync(stateFile)) return ctx.ui.notify("No brainstorm state to resume", "error");
				question = "(resumed)";
			}
			question ||= (await ctx.ui.editor("What do you want to brainstorm?"))?.trim() ?? "";
			if (!question) return;
			try {
				const { path, markdown, digest } = await brainstorm(question, ctx, undefined, holder, emit, stateFile);
				// Follow-ups can refer to the digest; the full report is rendered for the user and saved to disk.
				pi.sendMessage({ customType: REPORT_TYPE, content: digest, display: true, details: { path, markdown } });
			} catch (error) {
				ctx.ui.notify(`Brainstorm failed: ${(error as Error).message}. Resume with /brainstorm --resume`, "error");
			}
		},
	});
}
