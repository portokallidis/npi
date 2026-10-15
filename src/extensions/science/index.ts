import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Budget } from "../../core/budget.ts";
import { RunState } from "../../core/runstate.ts";
import { type PaperSourceName, searchAll } from "../../science/papers.ts";
import { runScience } from "../../science/pipeline.ts";
import { renderScience, renderScienceDigest, saveScience } from "../../science/report.ts";
import { runtimeHolder } from "../runtime.ts";

const REPORT_TYPE = "science-report";
const ScienceParams = Type.Object({ question: Type.String({ description: "The research question with all relevant context" }) });
const PapersParams = Type.Object({
	query: Type.String(),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
	fromYear: Type.Optional(Type.Integer()),
});

function latestState(root: string): string | undefined {
	if (!existsSync(root)) return undefined;
	return readdirSync(root)
		.flatMap((run) => {
			const dir = join(root, run);
			return statSync(dir).isDirectory() ? readdirSync(dir).filter((f) => f.startsWith("science-state")).map((f) => join(dir, f)) : [];
		})
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/**
 * Science mode: `science` runs the systematic-review pipeline; `papers` is a quick literature lookup.
 * Both return compact text; full abstracts, the report, JSON trace and BibTeX go to files.
 */
export default function science(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	pi.on("session_start", () => holder.reset());

	async function run(question: string, ctx: ExtensionContext, signal?: AbortSignal, stateFile?: string) {
		const rt = holder.get(ctx);
		const config = rt.config.science;
		const budget = new Budget(config.maxCostUSD);
		const state = new RunState(stateFile ?? join(rt.artifacts.dir, `science-state-${Date.now()}.json`), { prompt: question });
		const status = (text: string) => ctx.hasUI && ctx.ui.setWidget("science", [`🔬 ${text}  ($${budget.spentUSD.toFixed(3)} / $${budget.limitUSD.toFixed(2)})`]);
		try {
			const report = await runScience(String(state.meta.prompt ?? question), config, {
				llm: rt.llm,
				user: ctx.hasUI ? { select: (t, o) => ctx.ui.select(t, o), input: (t, p) => ctx.ui.input(t, p) } : undefined,
				state,
				budget,
				signal,
				onEvent: (e) => e.type === "phase" && status(e.text),
			});
			const path = saveScience(report, ctx.cwd, config.reportDir);
			pi.events.emit("npi:telemetry", {
				type: "science",
				costUSD: report.costUSD,
				screened: report.prisma.screened,
				included: report.prisma.included,
				supported: report.checks.filter((c) => c.supported === "yes").length,
				sentences: report.checks.length,
				stoppedEarly: report.stoppedEarly,
			});
			return { report, path, markdown: renderScience(report), digest: renderScienceDigest(report, path) };
		} finally {
			if (ctx.hasUI) ctx.ui.setWidget("science", undefined);
		}
	}

	pi.registerMessageRenderer<{ path: string; markdown: string }>(REPORT_TYPE, (message, { outputPad }, theme) => {
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Markdown(`${message.details?.markdown ?? ""}\n\n_Saved to ${message.details?.path ?? "?"}_`, 0, 0, getMarkdownTheme()));
		return box;
	});

	pi.registerTool({
		name: "science",
		label: "Literature review",
		description:
			"Answer a research question from the scientific literature with a systematic-review-style pipeline: protocol (PICO), multi-database search " +
			"(OpenAlex, PubMed, Semantic Scholar, arXiv), dual-model screening, structured extraction, GRADE certainty, and sentence-level citation checks. " +
			"Slow (minutes). Returns a digest and the path of the full report (+ BibTeX).",
		promptSnippet: "Systematic literature review with graded evidence and verified citations",
		parameters: ScienceParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { report, path, digest } = await run(params.question, ctx, signal);
			return {
				content: [{ type: "text", text: digest }],
				details: { path },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: report.costUSD } },
			};
		},
	});

	pi.registerTool({
		name: "papers",
		label: "Paper search",
		description: "Quick literature search across OpenAlex, PubMed, Semantic Scholar and arXiv. Returns titles, years, DOIs and a short abstract snippet; full abstracts are saved to a file.",
		promptSnippet: "Search scholarly papers (OpenAlex, PubMed, Semantic Scholar, arXiv)",
		parameters: PapersParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const rt = holder.get(ctx);
			const limit = params.limit ?? 8;
			const found = await searchAll([params.query], rt.config.science.sources as PaperSourceName[], { perQuery: limit, fromYear: params.fromYear, signal });
			const ranked = found.papers.filter((p) => !p.retracted).sort((a, b) => b.sources.length - a.sources.length || (b.citations ?? 0) - (a.citations ?? 0)).slice(0, limit);
			const file = rt.artifacts.write("papers", ranked.map((p) => `## [${p.id}] ${p.title} (${p.year ?? "n.d."})\n${p.doi ? `doi:${p.doi}` : (p.url ?? "")}\n\n${p.abstract}`).join("\n\n"));
			const lines = ranked.map((p) => `[${p.id}] ${p.title} (${p.year ?? "n.d."}${p.citations ? `, ${p.citations} cites` : ""}) ${p.doi ? `doi:${p.doi}` : (p.url ?? "")}\n    ${p.abstract.slice(0, 220)}…`);
			const failed = found.log.filter((l) => l.error).map((l) => `${l.source}: ${l.error}`);
			return {
				content: [{ type: "text", text: `${lines.join("\n") || "No results."}\n\nFull abstracts: ${file}${failed.length ? `\n(unavailable: ${failed.join("; ")})` : ""}` }],
				details: undefined,
			};
		},
	});

	pi.registerCommand("science", {
		description: "Systematic literature review: /science <question> · /science --resume [state.json]",
		handler: async (args, ctx) => {
			let question = args.trim();
			let stateFile: string | undefined;
			const resume = question.match(/^--resume\s*(\S*)/);
			if (resume) {
				stateFile = resume[1] || latestState(join(ctx.cwd, holder.get(ctx).config.context.artifactDir));
				if (!stateFile || !existsSync(stateFile)) return ctx.ui.notify("No science run to resume", "error");
				question = "(resumed)";
			}
			question ||= (await ctx.ui.editor("Research question"))?.trim() ?? "";
			if (!question) return;
			try {
				const { path, markdown, digest } = await run(question, ctx, undefined, stateFile);
				pi.sendMessage({ customType: REPORT_TYPE, content: digest, display: true, details: { path, markdown } });
			} catch (error) {
				ctx.ui.notify(`Science run failed: ${(error as Error).message}. Resume with /science --resume`, "error");
			}
		},
	});
}
