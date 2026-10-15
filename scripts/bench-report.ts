// Merge benchmark runs into one report:
//   npm run bench:report                      -> all runs in .npi/benchmarks → .npi/benchmarks/combined.md
//   npm run bench:report -- --last 3 --publish -> last 3 runs, also written to docs/benchmarks.md
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BenchRecord, readBench, renderBenchReport } from "../src/core/bench.ts";

const dir = join(process.cwd(), ".npi", "benchmarks");
const args = process.argv.slice(2);
const last = Number(args[args.indexOf("--last") + 1]) || Number.POSITIVE_INFINITY;
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().slice(-last);
// Keep the first env record (client machine); demos from later runs replace earlier runs of the same demo.
const records: BenchRecord[] = [];
for (const f of files) {
	const run = readBench(join(dir, f));
	const demos = new Set(run.filter((r) => r.kind === "demo").map((r) => (r as { demo: string }).demo));
	for (let i = records.length - 1; i >= 0; i--) {
		const r = records[i];
		if (r.kind !== "env" && demos.has(r.demo)) records.splice(i, 1);
	}
	records.push(...run.filter((r) => r.kind !== "env" || !records.some((x) => x.kind === "env")));
}
const report = renderBenchReport(records).replace(/^Run `[^`]*`/m, `Runs: ${files.map((f) => f.replace(".jsonl", "")).join(", ")}`);
writeFileSync(join(dir, "combined.md"), report);
if (args.includes("--publish")) writeFileSync(join(process.cwd(), "docs", "benchmarks.md"), report);
console.log(`Merged ${files.length} run(s) → ${join(dir, "combined.md")}${args.includes("--publish") ? " and docs/benchmarks.md" : ""}`);
