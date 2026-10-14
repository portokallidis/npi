import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { bibtex } from "./papers.ts";
import type { ScienceReport } from "./types.ts";

const MARK = { yes: "", partial: " ⚠️", no: " ❌", uncited: "" } as const;
const esc = (s: string) => s.replaceAll("|", "\\|").replace(/\s+/g, " ");

/** Answer with each sentence marked by its verification verdict (⚠️ partial, ❌ unsupported). */
function verifiedAnswer(r: ScienceReport): string {
	let answer = r.synthesis.answer;
	for (const c of r.checks) if (MARK[c.supported]) answer = answer.replace(c.sentence, `${c.sentence}${MARK[c.supported]}`);
	return answer;
}

export function renderScience(r: ScienceReport): string {
	const p = r.protocol;
	const supported = r.checks.filter((c) => c.supported === "yes").length;
	const checked = r.checks.filter((c) => c.supported !== "uncited").length;
	const grade = r.synthesis.outcomes
		.map((o) => `| ${esc(o.outcome)} | ${esc(o.direction)} | **${o.certainty.replace("_", " ")}** | ${esc(o.rationale)} | ${o.supporting.join(", ") || "—"} | ${o.contradicting.join(", ") || "—"} |`)
		.join("\n");
	const table = r.extractions
		.map((x) => {
			const paper = r.papers.find((q) => q.id === x.id);
			const finding = x.outcomes.map((o) => `${o.name}: ${o.finding}`).join("; ");
			return `| ${x.id} | ${esc(paper?.title ?? "")} (${paper?.year ?? "n.d."}) | ${x.design} | ${x.n || "?"} | ${esc(finding)} | ${x.quoteVerified ? "✓" : "✗"} |`;
		})
		.join("\n");
	const refs = r.papers
		.filter((q) => r.screen.included.includes(q.id))
		.map((q) => `- **[${q.id}]** ${q.authors.slice(0, 3).join(", ")}${q.authors.length > 3 ? " et al." : ""} (${q.year ?? "n.d."}). ${q.title}. *${q.venue ?? ""}*${q.doi ? ` https://doi.org/${q.doi}` : q.url ? ` ${q.url}` : ""}`)
		.join("\n");
	const log = r.searchLog.map((l) => `| ${l.at.slice(0, 16)} | ${l.source} | ${esc(l.query)} | ${l.error ? `error: ${esc(l.error)}` : l.found} |`).join("\n");

	return `# ${p.question}

${verifiedAnswer(r) || "_No synthesis produced._"}

*Citation check: ${supported}/${checked} cited sentences fully supported by the cited studies (⚠️ partial, ❌ unsupported).*

## Certainty of evidence (GRADE)
| Outcome | What the evidence shows | Certainty | Why | Supporting | Contradicting |
|---|---|---|---|---|---|
${grade || "| — | | | | | |"}

## Evidence table
| ID | Study | Design | n | Findings | Quote verified |
|---|---|---|---|---|---|
${table || "| — | | | | | |"}

## Open questions
${r.synthesis.openQuestions.map((q) => `- ${q}`).join("\n") || "- —"}

## Suggested next studies
${r.synthesis.nextExperiments.map((q) => `- ${q}`).join("\n") || "- —"}

## Method
**PICO:** P: ${p.population} · I: ${p.intervention} · C: ${p.comparison} · O: ${p.outcomes.join("; ")}
**Include:** ${p.inclusion.join("; ")} · **Exclude:** ${p.exclusion.join("; ")}${p.fromYear ? ` · from ${p.fromYear}` : ""}
${r.directions.length ? `**Your directions:** ${r.directions.map((d) => `${d.question} → ${d.answer}`).join("; ")}\n` : ""}
**PRISMA flow:** ${r.prisma.identified} records identified → ${r.prisma.duplicates} duplicates removed → ${r.prisma.retracted} retracted and ${r.prisma.noAbstract} without abstract removed → ${r.prisma.screened} screened → ${r.prisma.excluded} excluded → **${r.prisma.included} included**
**Screening agreement:** Cohen's κ = ${r.screen.kappa.toFixed(2)} between ${r.screen.screeners.join(" and ")} (${r.screen.disagreements} disagreements settled by ${r.models.verifier})
**Limitations of this review:** decisions use titles and abstracts only; extraction is automated; not a substitute for a registered systematic review.

<details><summary>Search log (reproducibility)</summary>

| Time (UTC) | Database | Query | Results |
|---|---|---|---|
${log}
</details>

## References
${refs || "- —"}

*Models: orchestrator ${r.models.orchestrator}, screeners ${r.models.screeners.join(" + ")}, extractor ${r.models.extractor}, verifier ${r.models.verifier} · cost $${r.costUSD.toFixed(3)}${r.stoppedEarly ? ` · stopped early: ${r.stoppedEarly}` : ""}*
`;
}

export function renderScienceDigest(r: ScienceReport, path: string): string {
	const grade = r.synthesis.outcomes.map((o) => `- ${o.outcome}: ${o.direction} (certainty ${o.certainty.replace("_", " ")})`).join("\n");
	return `Question: ${r.protocol.question}\n${r.prisma.included} studies included of ${r.prisma.identified} found (κ=${r.screen.kappa.toFixed(2)}).\n${grade}\n\nFull report with evidence table, citations and BibTeX: ${path}`;
}

/** Write <dir>/<stamp>.md, .json and .bib; returns the Markdown path relative to cwd. */
export function saveScience(r: ScienceReport, cwd: string, dir: string): string {
	const target = resolve(cwd, dir);
	mkdirSync(target, { recursive: true });
	const stamp = r.startedAt.replace(/[:.]/g, "-");
	const md = join(target, `${stamp}.md`);
	writeFileSync(md, renderScience(r));
	writeFileSync(join(target, `${stamp}.json`), JSON.stringify(r, null, 2));
	writeFileSync(join(target, `${stamp}.bib`), r.papers.filter((p) => r.screen.included.includes(p.id)).map(bibtex).join("\n\n"));
	return relative(cwd, md).replaceAll("\\", "/");
}
