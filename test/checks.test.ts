import { describe, expect, it } from "vitest";
import { failureReport, matchesGlob, plannedChecks, runCheck } from "../src/core/checks.ts";

describe("post-edit checks", () => {
	it("matches bare globs anywhere and path globs from the root", () => {
		expect(matchesGlob("src/a/b.ts", "*.ts")).toBe(true);
		expect(matchesGlob("src\\a\\b.ts", "*.ts")).toBe(true);
		expect(matchesGlob("src/a/b.tsx", "*.ts")).toBe(false);
		expect(matchesGlob("api/openapi.yaml", "openapi.yaml")).toBe(true);
		expect(matchesGlob("ontology/core.ttl", "ontology/**")).toBe(true);
		expect(matchesGlob("other/core.ttl", "ontology/**")).toBe(false);
	});

	it("plans one command per check, per file for {file}, all files for {files}, deduplicated", () => {
		const planned = plannedChecks(
			[
				{ glob: "*.ts", command: "npx tsc --noEmit" },
				{ glob: "*.ts", command: "npx tsc --noEmit" },
				{ glob: "*.py", command: "ruff check {file}", timeoutMs: 5 },
				{ glob: "*.ttl", command: "pyshacl {files}" },
				{ glob: "*.go", command: "go vet ./..." },
			],
			["a.ts", "b.ts", "x.py", "y.py", "o.ttl", "p.ttl"],
		);
		expect(planned).toEqual([
			{ command: "npx tsc --noEmit", timeoutMs: 120_000 },
			{ command: 'ruff check "x.py"', timeoutMs: 5 },
			{ command: 'ruff check "y.py"', timeoutMs: 5 },
			{ command: 'pyshacl "o.ttl" "p.ttl"', timeoutMs: 120_000 },
		]);
	});

	it("runs commands and reports failures with error lines first", async () => {
		const ok = await runCheck(`node -e "console.log('fine')"`, process.cwd(), 20_000);
		expect(ok).toMatchObject({ ok: true, output: "fine" });
		const bad = await runCheck(`node -e "console.log('noise\\nsrc/a.ts(3,5): error TS2322: bad type'); process.exit(2)"`, process.cwd(), 20_000);
		expect(bad.ok).toBe(false);
		const report = failureReport([ok, bad]);
		expect(report).toMatch(/failed \(1\/2\)/);
		expect(report).toContain("error TS2322: bad type");
		expect(report).not.toContain("fine");
	});
});
