import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Project ledger: a small, committable Markdown file of the state that must survive compaction and restarts:
 * invariants, decisions, failed approaches (so they are not retried) and open questions. It lives outside the
 * context window and is re-injected every turn, so lossy summaries can never drop it.
 */
export type LedgerSection = "invariant" | "decision" | "failed" | "question";
export const LEDGER_SECTIONS: LedgerSection[] = ["invariant", "decision", "failed", "question"];

const HEADINGS: Record<LedgerSection, string> = {
	invariant: "Invariants",
	decision: "Decisions",
	failed: "Failed (don't retry)",
	question: "Open questions",
};

export interface LedgerItem {
	date: string;
	text: string;
}
export type Ledger = Record<LedgerSection, LedgerItem[]>;

const empty = (): Ledger => ({ invariant: [], decision: [], failed: [], question: [] });

export function parseLedger(md: string): Ledger {
	const ledger = empty();
	let section: LedgerSection | undefined;
	for (const line of md.split(/\r?\n/)) {
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) {
			const title = heading[1].toLowerCase();
			section = LEDGER_SECTIONS.find((s) => title.startsWith(HEADINGS[s].toLowerCase().split(" ")[0]));
			continue;
		}
		const item = line.match(/^\s*[-*]\s+(?:\[(\d{4}-\d{2}-\d{2})\]\s+)?(.+)$/);
		if (section && item) ledger[section].push({ date: item[1] ?? "", text: item[2].trim() });
	}
	return ledger;
}

export function renderLedger(ledger: Ledger): string {
	const parts = ["# Project ledger", "", "<!-- Maintained by npi's `ledger` tool; edit freely. Re-injected into every prompt. -->"];
	for (const s of LEDGER_SECTIONS) {
		parts.push("", `## ${HEADINGS[s]}`);
		if (ledger[s].length) parts.push("", ...ledger[s].map((item) => `- ${item.date ? `[${item.date}] ` : ""}${item.text}`));
	}
	return `${parts.join("\n")}\n`;
}

export const ledgerPath = (cwd: string, file: string) => join(cwd, file);

export function loadLedger(path: string): Ledger {
	return existsSync(path) ? parseLedger(readFileSync(path, "utf8")) : empty();
}

function save(path: string, ledger: Ledger): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, renderLedger(ledger));
}

const today = () => new Date().toISOString().slice(0, 10);

/** Add an item (exact duplicates are ignored). */
export function addLedgerItem(path: string, section: LedgerSection, text: string): Ledger {
	const ledger = loadLedger(path);
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean && !ledger[section].some((i) => i.text === clean)) ledger[section].push({ date: today(), text: clean });
	save(path, ledger);
	return ledger;
}

/**
 * Remove items in `section` containing `match` (case-insensitive). Resolving an open question with a `note`
 * records the answer as a decision. Returns how many items were removed.
 */
export function resolveLedgerItems(path: string, section: LedgerSection, match: string, note?: string): number {
	const ledger = loadLedger(path);
	const needle = match.toLowerCase();
	const removed = ledger[section].filter((i) => i.text.toLowerCase().includes(needle));
	if (!removed.length) return 0;
	ledger[section] = ledger[section].filter((i) => !removed.includes(i));
	if (note) {
		const prefix = section === "question" ? `${removed.map((i) => i.text).join("; ")} → ` : "";
		ledger.decision.push({ date: today(), text: `${prefix}${note}`.replace(/\s+/g, " ").trim() });
	}
	save(path, ledger);
	return removed.length;
}

/**
 * Prompt view under `maxChars`: invariants, failed approaches and open questions first (all of them if they
 * fit), then the newest decisions. Omitted items are counted so the model knows to read the file.
 */
export function ledgerPrompt(ledger: Ledger, maxChars: number, file: string): string | undefined {
	const total = LEDGER_SECTIONS.reduce((n, s) => n + ledger[s].length, 0);
	if (!total) return undefined;
	const lines = [`Project ledger (${file}): invariants are binding; never retry a failed approach without a new reason; record new decisions, failures and questions with the \`ledger\` tool.`];
	let used = lines[0].length;
	let omitted = 0;
	const push = (s: LedgerSection, items: LedgerItem[]) => {
		const kept: string[] = [];
		for (const item of items) {
			const line = `- ${item.text}`;
			if (used + line.length + 1 > maxChars) {
				omitted++;
				continue;
			}
			kept.push(line);
			used += line.length + 1;
		}
		if (kept.length) {
			lines.push(`${HEADINGS[s]}:`, ...kept);
			used += HEADINGS[s].length + 2;
		}
	};
	push("invariant", ledger.invariant);
	push("failed", ledger.failed);
	push("question", ledger.question);
	push("decision", [...ledger.decision].reverse());
	if (omitted) lines.push(`(${omitted} more item(s) in ${file})`);
	return lines.join("\n");
}
