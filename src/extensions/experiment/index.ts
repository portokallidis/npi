import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	appendExperiment,
	compare,
	type ExperimentRecord,
	formatComparison,
	leaderboard,
	loadExperiments,
	runSeeds,
	type SeedRun,
	summarizeRuns,
	type Verdict,
} from "../../core/experiment.ts";
import { gitRoot, headSha, snapshot } from "../../core/gitsnap.ts";
import { addLedgerItem, ledgerPath } from "../../core/ledger.ts";
import { runtimeHolder } from "../runtime.ts";

const FILE = ".npi/experiments.jsonl";
const VERDICTS = ["pending", "accepted", "rejected", "inconclusive"] as const;

const Params = Type.Object({
	action: Type.Union([Type.Literal("run"), Type.Literal("record"), Type.Literal("compare"), Type.Literal("verdict"), Type.Literal("list")]),
	name: Type.Optional(Type.String({ description: "Experiment name (run/record/verdict), e.g. 'lora-r8-lr3e-4'" })),
	hypothesis: Type.Optional(Type.String({ description: "run/record: what you expect and why (falsifiable)" })),
	command: Type.Optional(
		Type.String({ description: "run: shell command run once per seed ({seed} placeholder and SEED env). It must print a final JSON line of numeric metrics, e.g. {\"acc\":0.91}" }),
	),
	seeds: Type.Optional(Type.Array(Type.Number(), { description: "run: seeds (use ≥5 for any claim); record: seeds matching `results`" })),
	results: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Number()), { description: "record: one metrics object per seed, for runs done elsewhere" })),
	timeoutMs: Type.Optional(Type.Number({ description: "run: per-seed timeout (default 10 min)" })),
	baseline: Type.Optional(Type.String({ description: "compare: experiment A (baseline)" })),
	candidate: Type.Optional(Type.String({ description: "compare: experiment B (candidate)" })),
	metric: Type.Optional(Type.String({ description: "compare/list: metric name" })),
	verdict: Type.Optional(Type.Union(VERDICTS.map((v) => Type.Literal(v)))),
	reason: Type.Optional(Type.String({ description: "verdict: why (a rejected experiment is added to the ledger's failed list)" })),
});

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, isError });

/**
 * `experiment` tool + `/exp`: seed-locked runs with mean ± CI, paired permutation tests between variants, and
 * provenance (git HEAD, exact working-tree snapshot, session entry, model) so any result can be reproduced or
 * revisited with /tree. Rejected experiments land in the ledger so they are not retried.
 */
export default function experiment(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	pi.on("session_start", () => holder.reset());
	const file = (cwd: string) => join(cwd, FILE);

	async function provenance(ctx: ExtensionContext): Promise<Pick<ExperimentRecord, "git" | "sessionEntry" | "model">> {
		const root = await gitRoot(ctx.cwd);
		const git = root ? { head: await headSha(root), tree: await snapshot(root).catch(() => undefined) } : undefined;
		// The physical model that produced the latest reply (ctx.model is the virtual `npi/auto` under routing).
		const last = ctx.sessionManager
			.getBranch()
			.findLast((e) => e.type === "message" && e.message.role === "assistant");
		const reply = last?.type === "message" && last.message.role === "assistant" ? last.message : undefined;
		return {
			git,
			sessionEntry: ctx.sessionManager.getLeafId() ?? undefined,
			model: reply ? `${reply.provider}/${reply.model}` : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		};
	}

	function save(ctx: ExtensionContext, record: ExperimentRecord) {
		appendExperiment(file(ctx.cwd), record);
		pi.events.emit("npi:telemetry", { type: "experiment", name: record.name, seeds: record.runs.length, verdict: record.verdict });
	}

	pi.registerTool({
		name: "experiment",
		label: "Experiment",
		description:
			"Experiment log with statistics. run: execute a command once per seed and record metrics with provenance. record: log results produced elsewhere. compare: baseline vs candidate on a metric (paired permutation test + bootstrap CI). verdict: accept/reject (rejections go to the ledger). list: leaderboard.",
		promptSnippet: "Run seed-locked experiments, compare variants statistically, log verdicts",
		parameters: Params,
		async execute(_id, p, _signal, onUpdate, ctx) {
			const store = file(ctx.cwd);
			if (p.action === "list") return text(leaderboard([...loadExperiments(store).values()], p.metric));

			if (p.action === "compare") {
				const all = loadExperiments(store);
				const a = all.get(p.baseline ?? "");
				const b = all.get(p.candidate ?? "");
				if (!a || !b) return text(`Unknown experiment: ${!a ? p.baseline : p.candidate}. Known: ${[...all.keys()].join(", ") || "none"}`, true);
				const metrics = p.metric ? [p.metric] : Object.keys(a.runs.find((r) => !r.error)?.metrics ?? {});
				try {
					return text(metrics.map((m) => formatComparison(compare(a, b, m), a.name, b.name)).join("\n\n"));
				} catch (error) {
					return text((error as Error).message, true);
				}
			}

			if (!p.name) return text(`${p.action} needs a name`, true);

			if (p.action === "verdict") {
				const prev = loadExperiments(store).get(p.name);
				if (!prev || !p.verdict) return text(prev ? "verdict needs `verdict`" : `Unknown experiment ${p.name}`, true);
				save(ctx, { ...prev, ts: new Date().toISOString(), verdict: p.verdict as Verdict, reason: p.reason });
				if (p.verdict === "rejected") {
					const rt = holder.get(ctx);
					addLedgerItem(
						ledgerPath(ctx.cwd, rt.config.ledger?.file ?? ".npi/ledger.md"),
						"failed",
						`experiment ${p.name}${prev.hypothesis ? ` (${prev.hypothesis})` : ""}: ${p.reason ?? "rejected"}`,
					);
				}
				return text(`${p.name}: ${p.verdict}${p.verdict === "rejected" ? " (added to the ledger's failed list)" : ""}`);
			}

			let runs: SeedRun[];
			if (p.action === "run") {
				if (!p.command) return text("run needs a command", true);
				const seeds = p.seeds?.length ? p.seeds : [0, 1, 2, 3, 4];
				onUpdate?.({ content: [{ type: "text", text: `Running ${seeds.length} seeds…` }], details: undefined });
				runs = await runSeeds(p.command, seeds, ctx.cwd, p.timeoutMs ?? 600_000);
			} else {
				if (!p.results?.length) return text("record needs results (one metrics object per seed)", true);
				runs = p.results.map((metrics, i) => ({ seed: p.seeds?.[i] ?? i, metrics }));
			}
			const record: ExperimentRecord = {
				name: p.name,
				ts: new Date().toISOString(),
				hypothesis: p.hypothesis,
				command: p.command,
				runs,
				verdict: "pending",
				...(await provenance(ctx)),
			};
			save(ctx, record);
			const failures = runs.filter((r) => r.error);
			const lines = [
				`${p.name}: ${runs.length - failures.length}/${runs.length} seeds succeeded (logged to ${FILE}, git ${record.git?.head?.slice(0, 7) ?? "n/a"})`,
				...summarizeRuns(runs),
				...failures.map((f) => `seed ${f.seed} failed: ${f.error}`),
			];
			if (runs.length - failures.length < 5) lines.push("Fewer than 5 successful seeds: report results as exploratory.");
			return text(lines.join("\n"), failures.length === runs.length);
		},
	});

	pi.registerCommand("exp", {
		description: "Experiment leaderboard: /exp [metric] [--lower]  ·  /exp compare <baseline> <candidate> [metric]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const all = loadExperiments(file(ctx.cwd));
			if (parts[0] === "compare") {
				const [a, b] = [all.get(parts[1] ?? ""), all.get(parts[2] ?? "")];
				if (!a || !b) return ctx.ui.notify("Usage: /exp compare <baseline> <candidate> [metric]", "error");
				const metrics = parts[3] ? [parts[3]] : Object.keys(a.runs.find((r) => !r.error)?.metrics ?? {});
				try {
					return ctx.ui.notify(metrics.map((m) => formatComparison(compare(a, b, m), a.name, b.name)).join("\n\n"), "info");
				} catch (error) {
					return ctx.ui.notify((error as Error).message, "error");
				}
			}
			const lower = parts.includes("--lower");
			ctx.ui.notify(leaderboard([...all.values()], parts.find((x) => x !== "--lower"), !lower), "info");
		},
	});
}
