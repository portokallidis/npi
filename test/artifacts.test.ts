import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore, extractSummary, preview } from "../src/core/artifacts.ts";

describe("artifacts", () => {
	it("writes numbered artifacts and returns cwd-relative paths", () => {
		const cwd = mkdtempSync(join(tmpdir(), "harness-"));
		const store = new ArtifactStore(cwd, ".harness/artifacts", "run1");
		const a = store.write("researcher report", "full text");
		const b = store.write("x", "{}", "json");
		expect(a).toBe(".harness/artifacts/run1/001-researcher-report.md");
		expect(b).toBe(".harness/artifacts/run1/002-x.json");
		expect(readFileSync(join(cwd, a), "utf8")).toBe("full text");
	});

	it("previews long text with a pointer and leaves short text alone", () => {
		expect(preview("short", 100, "p")).toBe("short");
		const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const out = preview(long, 100, "a/b.md");
		expect(out.length).toBeLessThan(260);
		expect(out).toMatch(/in a\/b\.md — read it/);
	});

	it("extracts the Summary section, else the capped head", () => {
		const text = "# Findings\nlots of detail\n\n## Summary\nWAL allows one writer.\nSee https://x\n\n## Sources\n- https://x";
		expect(extractSummary(text, 100)).toBe("WAL allows one writer.\nSee https://x");
		expect(extractSummary("## Summary\nfinal bit", 100)).toBe("final bit");
		expect(extractSummary("a".repeat(1000), 10).length).toBeLessThanOrEqual(42);
	});
});

describe("digest error lines", () => {
	it("extracts error-looking lines verbatim and dedupes them", async () => {
		const { errorLines } = await import("../src/core/digest.ts");
		const text = "starting\nERROR payment-worker: connection refused to redis://cache:6379\nok\nAssertionError: expected 1 to equal 2\nERROR payment-worker: connection refused to redis://cache:6379\nnpm ERR! code ELIFECYCLE\ndone";
		expect(errorLines(text)).toEqual(["ERROR payment-worker: connection refused to redis://cache:6379", "AssertionError: expected 1 to equal 2", "npm ERR! code ELIFECYCLE"]);
		expect(errorLines("all good\nnothing to see")).toEqual([]);
	});
});
