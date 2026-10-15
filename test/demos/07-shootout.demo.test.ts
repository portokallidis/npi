// Demo 7 — Model shootout (quick). The same three jobs on every available local model: structured
// extraction (tool-call JSON), routing classification, and summarizing a noisy log. Accuracy, latency and
// throughput per model end up side by side in the benchmark report.
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { Budget } from "../../src/core/budget.ts";
import { digestToolOutput } from "../../src/core/digest.ts";
import { llmClassifier } from "../../src/core/router.ts";
import { callStructured } from "../../src/core/structured.ts";
import { banner, bench, config, demo } from "./harness.ts";

const Invoice = Type.Object({
	vendor: Type.String(),
	amount: Type.Number(),
	currency: Type.String({ description: "ISO code, e.g. EUR" }),
	date: Type.String({ description: "YYYY-MM-DD" }),
});

const invoices: [string, { vendor: string; amount: number; currency: string; date: string }][] = [
	["Thanks for your order! Hetzner Online GmbH charged €38.70 on 3 March 2026 for server CX42.", { vendor: "Hetzner", amount: 38.7, currency: "EUR", date: "2026-03-03" }],
	["Receipt #8841 — JetBrains s.r.o., All Products Pack, total USD 289.00, paid 2026-01-15.", { vendor: "JetBrains", amount: 289, currency: "USD", date: "2026-01-15" }],
	["Your Backblaze B2 bill for February: $6.12, charged on the 1st of March 2026.", { vendor: "Backblaze", amount: 6.12, currency: "USD", date: "2026-03-01" }],
	["Rechnung: Deutsche Bahn AG, ICE Berlin–München, 129,90 EUR, Reisedatum 22.04.2026.", { vendor: "Deutsche Bahn", amount: 129.9, currency: "EUR", date: "2026-04-22" }],
];

const routes: [string, string][] = [
	["what do studies show about magnesium and sleep quality", "science"],
	["write a limerick about kubernetes", "chat"],
	["help me design the data model before we write the migration", "plan"],
	["is the Framework 16 laptop shipping with the new AMD chips yet", "research"],
	["give me several different ways to grow a newsletter to 10k readers and which to pick", "brainstorm"],
	["explain the difference between TCP and UDP", "chat"],
];

const models = ["local/small", "local/large"];

for (const model of models) {
	it(`quick: shootout on ${model}`, (t) =>
		bench.run(`shootout: ${model}`, async (metrics) => {
			const { llm } = await demo();
			if (!(await llm.available(model))) return t.skip();
			const budget = new Budget(Number.POSITIVE_INFINITY);

			// 1. Structured extraction: exact field matches across 4 messy receipts.
			let fields = 0;
			const t1 = Date.now();
			for (const [text, expected] of invoices) {
				const got = await callStructured(llm, budget, {
					model,
					label: "shootout:extract",
					system: "Extract invoice data exactly.",
					prompt: text,
					schema: Invoice,
					toolName: "submit_invoice",
					toolDescription: "Submit the extracted invoice fields.",
					maxTokens: 300,
				}).catch(() => undefined);
				if (!got) continue;
				if (got.vendor.toLowerCase().includes(expected.vendor.toLowerCase().split(" ")[0])) fields++;
				if (Math.abs(got.amount - expected.amount) < 0.005) fields++;
				if (got.currency.toUpperCase() === expected.currency) fields++;
				if (got.date === expected.date) fields++;
			}
			const extractMs = Date.now() - t1;

			// 2. Routing classification on prompts no keyword catches.
			const classify = llmClassifier(llm, { ...config, router: { ...config.router, classifierModels: [model], classifierTimeoutMs: 120_000 } });
			let routed = 0;
			const t2 = Date.now();
			for (const [prompt, expected] of routes) if ((await classify(prompt))?.route === expected) routed++;
			const routeMs = Date.now() - t2;

			// 3. Summarize a noisy log and keep the one line that matters.
			const noise = readFileSync(new URL("../../node_modules/@earendil-works/pi-coding-agent/docs/extensions.md", import.meta.url), "utf8");
			const log = `${noise.slice(0, 6000)}\nERROR payment-worker: connection refused to redis://cache:6379 (attempt 5/5), queue=invoices\n${noise.slice(6000, 12000)}`;
			const t3 = Date.now();
			const digest = await digestToolOutput(log, { llm, models: [model], tool: "bash", path: "x.txt", previewChars: 2000, maxInputChars: 60_000, timeoutMs: 300_000 });
			const digestMs = Date.now() - t3;
			const body = digest.text.split("--- raw head ---")[0];
			// Did the model explain the error itself, and did the verbatim error-line safety net keep it?
			const modelKept = /redis|6379|connection refused/i.test(body.split("Error lines (verbatim):")[0]);
			const kept = /redis|6379|connection refused/i.test(body);

			Object.assign(metrics, {
				extraction: `${fields}/${invoices.length * 4} fields`,
				"extraction s": (extractMs / 1000).toFixed(1),
				routing: `${routed}/${routes.length}`,
				"routing s": (routeMs / 1000).toFixed(1),
				"model explained error": modelKept ? "yes" : "no",
				"error kept (with safety net)": kept ? "yes" : "no",
				"digest s": (digestMs / 1000).toFixed(1),
			});
			banner(`Shootout — ${model}`, [
				`structured extraction  ${fields}/${invoices.length * 4} fields correct   ${(extractMs / 1000).toFixed(1).padStart(6)}s total`,
				`routing                ${routed}/${routes.length} correct            ${(routeMs / 1000).toFixed(1).padStart(6)}s total`,
				`log digest             model explained the error: ${modelKept ? "yes" : "no"}; kept with safety net: ${kept ? "yes" : "no"}   ${(digestMs / 1000).toFixed(1).padStart(6)}s`,
			]);
			expect(fields).toBeGreaterThan(invoices.length * 2);
			expect(kept).toBe(true);
		}));
}
