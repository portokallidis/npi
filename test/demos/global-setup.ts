// One benchmark run per `npm run demo`: workers share the run id; the report is rendered at the end.
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readBench, renderBenchReport } from "../../src/core/bench.ts";

const dir = join(process.cwd(), ".npi", "benchmarks");

export default function setup() {
	const runId = new Date().toISOString().replace(/[:.]/g, "-");
	process.env.NPI_BENCH_RUN = runId;
	return () => {
		const file = join(dir, `${runId}.jsonl`);
		if (!existsSync(file)) return;
		const report = renderBenchReport(readBench(file));
		const out = join(dir, `${runId}.md`);
		writeFileSync(out, report);
		copyFileSync(out, join(dir, "latest.md"));
		// Opt-in: refresh the committed sample report (device names come from NPI_DEVICE_* labels, never IPs).
		if (process.env.NPI_BENCH_PUBLISH === "1") copyFileSync(out, join(process.cwd(), "docs", "benchmarks.md"));
		console.log(`\nBenchmark report: ${out}`);
	};
}
