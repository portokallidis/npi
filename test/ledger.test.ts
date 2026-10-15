import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addLedgerItem, ledgerPrompt, loadLedger, parseLedger, renderLedger, resolveLedgerItems } from "../src/core/ledger.ts";

const tmpLedger = () => join(mkdtempSync(join(tmpdir(), "npi-ledger-")), ".npi", "ledger.md");

describe("ledger", () => {
	it("round-trips through Markdown and tolerates hand edits", () => {
		const path = tmpLedger();
		addLedgerItem(path, "invariant", "All queries are scoped by tenant_id");
		addLedgerItem(path, "failed", "LoRA rank 4: diverged after 2k steps (lr 3e-4)");
		addLedgerItem(path, "failed", "LoRA rank 4: diverged after 2k steps (lr 3e-4)");
		const md = readFileSync(path, "utf8");
		expect(md).toMatch(/## Failed \(don't retry\)\n\n- \[\d{4}-\d{2}-\d{2}\] LoRA rank 4/);
		expect(loadLedger(path).failed).toHaveLength(1);
		const edited = parseLedger(`${md}\n* a hand-written question without a date\n`);
		expect(edited.question.map((i) => i.text)).toEqual(["a hand-written question without a date"]);
		expect(parseLedger(renderLedger(edited))).toEqual(edited);
	});

	it("resolves questions into decisions", () => {
		const path = tmpLedger();
		addLedgerItem(path, "question", "Postgres or SQLite for the edge cache?");
		expect(resolveLedgerItems(path, "question", "postgres", "SQLite: single-node, no ops")).toBe(1);
		const ledger = loadLedger(path);
		expect(ledger.question).toEqual([]);
		expect(ledger.decision[0].text).toBe("Postgres or SQLite for the edge cache? → SQLite: single-node, no ops");
		expect(resolveLedgerItems(path, "question", "nothing")).toBe(0);
	});

	it("keeps invariants and failures under the cap and drops oldest decisions first", () => {
		const path = tmpLedger();
		addLedgerItem(path, "invariant", "never DROP COLUMN in one step");
		addLedgerItem(path, "failed", "single-seed gains are noise");
		for (let i = 0; i < 20; i++) addLedgerItem(path, "decision", `decision number ${i} ${"x".repeat(40)}`);
		const prompt = ledgerPrompt(loadLedger(path), 700, ".npi/ledger.md") ?? "";
		expect(prompt.length).toBeLessThan(800);
		expect(prompt).toContain("never DROP COLUMN");
		expect(prompt).toContain("single-seed gains");
		expect(prompt).toContain("decision number 19");
		expect(prompt).not.toContain("decision number 0 ");
		expect(prompt).toMatch(/more item\(s\) in \.npi\/ledger\.md/);
		expect(ledgerPrompt(loadLedger(tmpLedger()), 700, "x")).toBeUndefined();
	});
});
