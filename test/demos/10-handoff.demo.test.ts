// Demo 10 — Handoff (quick). A long, messy working session is condensed into a self-contained prompt for a
// fresh session or another agent (the /handoff command). Checks the prompt keeps the decisions, files and next task,
// and measures how much smaller it is than the transcript — on each local model.
import { expect, it } from "vitest";
import { approxTokens } from "../../src/core/artifacts.ts";
import { HANDOFF_SYSTEM } from "../../src/core/handoff.ts";
import { assistantText, userMessage } from "../../src/core/llm.ts";
import { banner, bench, demo, ms } from "./common.ts";

const transcript = `USER: The invoice export is slow, 40s for 10k rows. Can you look?
ASSISTANT: I profiled src/export/invoices.ts. 85% of time is in formatRow(), which calls Intl.NumberFormat per row.
TOOL bash: node --cpu-prof scripts/export.js ... (2,300 lines of profiler output omitted)
ASSISTANT: Option A: cache one NumberFormat per currency. Option B: move formatting to SQL. Option C: stream rows.
USER: A and C, not B — the DB team won't take more load.
ASSISTANT: Done with A in src/export/format.ts (new formatterFor(currency) cache). Export now 9s. Tests in test/export.test.ts pass.
TOOL bash: npm test ... 214 passed
USER: Great. Streaming next, but I'm out of context here. Also remember the CSV must keep the BOM for Excel users.
ASSISTANT: Noted: keep the UTF-8 BOM. For streaming I'd use a Node Readable over the cursor in src/db/cursor.ts and pipe to the response in src/routes/export.ts.`;

for (const model of ["local/small", "local/large"]) {
	it(`quick: handoff prompt on ${model}`, (t) =>
		bench.run(`handoff: ${model}`, async (metrics) => {
			const { llm } = await demo();
			if (!(await llm.available(model))) return t.skip();
			const start = Date.now();
			const reply = await llm.complete(model, {
				system: HANDOFF_SYSTEM,
				messages: [userMessage(`## Conversation\n\n${transcript}\n\n## Goal for the new thread\n\nImplement streaming for the invoice export.`)],
				label: "handoff",
				maxTokens: 1500,
			});
			const prompt = assistantText(reply).trim();
			const checks = {
				"keeps decision (no SQL)": /\bB\b|sql|db team|database/i.test(prompt),
				"keeps BOM requirement": /BOM/i.test(prompt),
				"names files": /cursor\.ts/.test(prompt) && /routes\/export\.ts|export\.ts/.test(prompt),
				"states the task": /stream/i.test(prompt),
			};
			const kept = Object.values(checks).filter(Boolean).length;
			Object.assign(metrics, { "facts kept": `${kept}/4`, "transcript tokens": approxTokens(transcript), "handoff tokens": approxTokens(prompt) });
			banner(`Handoff by ${model} in ${ms(start)} — kept ${kept}/4 key facts`, [...Object.entries(checks).map(([k, v]) => `${v ? "✓" : "✗"} ${k}`), "", prompt]);
			expect(kept).toBeGreaterThanOrEqual(3);
		}));
}
