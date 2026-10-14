import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { BrainstormReport, Dispute, Pathway, Resolution } from "./types.ts";

const METHOD_LABEL: Record<Resolution["method"], string> = {
	evidence: "web evidence",
	"cross-exam": "cross-examination",
	user: "your input",
	judge: "independent judge",
};

const cell = (items: readonly string[], max = 3) => items.slice(0, max).join("; ").replaceAll("|", "\\|") || "—";

/** Per panelist: disputes they were party to, and how many they were on the winning side of. */
export function scorecard(report: BrainstormReport): { id: string; disputes: number; won: number }[] {
	return report.panel.map((p) => {
		let disputes = 0;
		let won = 0;
		for (const r of report.resolutions) {
			const d = report.map.disputes.find((x) => x.id === r.disputeId);
			const side = d?.positions.findIndex((pos) => pos.panelists.includes(p.id)) ?? -1;
			if (side === -1) continue;
			disputes++;
			if (side === r.winningPosition) won++;
		}
		return { id: p.id, disputes, won };
	});
}

function ordered(report: BrainstormReport): Pathway[] {
	const fit = new Map(report.convergence.ranking.map((r) => [r.pathway, r.fit]));
	return [...report.map.pathways].sort((a, b) => (fit.get(b.id) ?? -1) - (fit.get(a.id) ?? -1));
}

function disputeSection(d: Dispute, r: Resolution | undefined): string {
	const positions = d.positions
		.map((p, i) => `${r?.winningPosition === i ? "✅" : "▫️"} **${p.panelists.join(", ") || "?"}:** ${p.stance}`)
		.join("\n");
	if (!r) return `#### ${d.topic} — unresolved\n*Crux:* ${d.crux}\n\n${positions}`;
	const sources = r.sources.length ? `\n*Sources:* ${r.sources.map((s) => `<${s}>`).join(", ")}` : "";
	const full = r.artifact ? `\n*Full research:* ${r.artifact}` : "";
	return `#### ${d.topic} — settled by ${METHOD_LABEL[r.method]} (confidence ${r.confidence.toFixed(2)})
*Crux:* ${d.crux}

${positions}

**Verdict:** ${r.verdict} — *${r.rationale}*${sources}${full}`;
}

/** Full report: what the user reads and what is saved to disk. */
export function renderReport(report: BrainstormReport): string {
	const { convergence: c, map } = report;
	const pathways = ordered(report);
	const fit = new Map(c.ranking.map((r) => [r.pathway, r]));
	const directions = report.directions.length
		? report.directions.map((d) => `- **${d.question}** → ${d.answer}`).join("\n")
		: "- _None given — the panel worked from the stated goal._";

	const recommendation = report.recommended
		? `## ✅ Recommendation: ${map.pathways.find((p) => p.id === report.recommended?.pathway)?.name}
${report.recommended.rationale}

**First steps**
${report.recommended.firstSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

**Reconsider if:** ${report.recommended.conditions.join("; ") || "—"}`
		: `## No single recommendation yet
The goal isn't specific enough to pick one pathway (clarity ${c.goalClarity.toFixed(2)}). What would decide it:
${c.decisionCriteria.map((x) => `- ${x}`).join("\n") || "- (none given)"}`;

	const table = pathways
		.map((p) => `| ${p.id} | **${p.name}** | ${fit.get(p.id)?.fit.toFixed(2) ?? "—"} | ${p.effort} | ${cell(p.pros)} | ${cell(p.cons)} | ${p.bestWhen.replaceAll("|", "\\|")} |`)
		.join("\n");
	const details = pathways
		.map(
			(p) => `### ${p.id}. ${p.name}
${p.summary}
- **Pros:** ${p.pros.join("; ") || "—"}
- **Cons:** ${p.cons.join("; ") || "—"}
- **Risks:** ${p.risks.join("; ") || "—"}
- **Best when:** ${p.bestWhen}
- **Fit:** ${fit.get(p.id)?.why ?? "—"}
- *Proposed by:* ${p.proposedBy.join(", ")}`,
		)
		.join("\n\n");
	const disputes = map.disputes.map((d) => disputeSection(d, report.resolutions.find((r) => r.disputeId === d.id))).join("\n\n");
	const score = scorecard(report)
		.map((s) => `| ${s.id} | ${report.panel.find((p) => p.id === s.id)?.model} | ${s.disputes} | ${s.won} |`)
		.join("\n");
	const skipped = report.skipped.length ? `\n\n**Not on the panel:** ${report.skipped.map((s) => `${s.id} (${s.reason})`).join("; ")}` : "";
	const cost = Object.entries(report.costByLabel)
		.map(([k, v]) => `${k} $${v.toFixed(3)}`)
		.join(", ");

	return `# Brainstorm: ${report.framing.goal}

${c.summary.replaceAll(String.raw`\n`, "\n")}

**Directions**
${directions}

${recommendation}

## All pathways
| | Pathway | Fit | Effort | Pros | Cons | Best when |
|---|---|---|---|---|---|---|
${table}

${details}

## Where the panel agreed
${map.consensus.map((x) => `- ${x.statement}`).join("\n") || "- (none recorded)"}

## Disputed trade-offs
${disputes || "_No material disagreements._"}

${c.openQuestions.length ? `## Open questions\n${c.openQuestions.map((q) => `- ${q}`).join("\n")}\n\n` : ""}## Panel
| Panelist | Model | Disputes | On winning side |
|---|---|---|---|
${score}${skipped}

*Orchestrator ${report.orchestrator} · judge ${report.judge} · cost $${report.costUSD.toFixed(3)} (${cost || "n/a"})${report.stoppedEarly ? ` · stopped early: ${report.stoppedEarly}` : ""}*
`;
}

/**
 * What goes back into the calling conversation: the decision-relevant core only (recommendation or
 * criteria + pathway one-liners), with a pointer to the full report on disk.
 */
export function renderDigest(report: BrainstormReport, reportPath: string): string {
	const fit = new Map(report.convergence.ranking.map((r) => [r.pathway, r.fit]));
	const lines = ordered(report).map((p) => `- ${p.id} ${p.name} (fit ${fit.get(p.id)?.toFixed(2) ?? "?"}, effort ${p.effort}): + ${cell(p.pros, 2)} / − ${cell(p.cons, 2)}`);
	const rec = report.recommended
		? `Recommendation: ${report.map.pathways.find((p) => p.id === report.recommended?.pathway)?.name} — ${report.recommended.rationale}`
		: `No recommendation (goal clarity ${report.convergence.goalClarity.toFixed(2)}). Deciding factors: ${report.convergence.decisionCriteria.join("; ") || "n/a"}`;
	const settled = report.resolutions.map((r) => `- ${report.map.disputes.find((d) => d.id === r.disputeId)?.topic}: ${r.verdict}`);
	return `Goal: ${report.framing.goal}\n${rec}\n\nPathways:\n${lines.join("\n")}${settled.length ? `\n\nSettled:\n${settled.join("\n")}` : ""}\n\nFull report (pathway details, disputes, sources): ${reportPath}`;
}

/** Write `<dir>/<timestamp>.md` and `.json`; returns the Markdown path relative to cwd. */
export function saveReport(report: BrainstormReport, cwd: string, dir: string): string {
	const target = resolve(cwd, dir);
	mkdirSync(target, { recursive: true });
	const stamp = report.startedAt.replace(/[:.]/g, "-");
	const mdPath = join(target, `${stamp}.md`);
	writeFileSync(mdPath, renderReport(report));
	writeFileSync(join(target, `${stamp}.json`), JSON.stringify(report, null, 2));
	return relative(cwd, mdPath).replaceAll("\\", "/");
}
