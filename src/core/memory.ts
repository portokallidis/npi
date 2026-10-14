import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Long-term memory as one plain Markdown file — greppable, editable by hand, diff-friendly:
 *   - 2026-10-14 [project] The user prefers pnpm over npm #prefs #pin
 */
export interface Note {
	date: string;
	project: string;
	text: string;
	tags: string[];
}

const LINE = /^- (\d{4}-\d{2}-\d{2}) \[([^\]]*)\] (.*)$/;
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];

export function notesPath(dir: string): string {
	return join(dir, "notes.md");
}

export function loadNotes(dir: string): Note[] {
	const path = notesPath(dir);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.flatMap((line) => {
			const m = line.match(LINE);
			if (!m) return [];
			const tags = [...m[3].matchAll(/#([\w-]+)/g)].map((t) => t[1].toLowerCase());
			return [{ date: m[1], project: m[2], text: m[3].replace(/\s*#[\w-]+/g, "").trim(), tags }];
		});
}

export function remember(dir: string, note: Omit<Note, "date">): Note {
	mkdirSync(dir, { recursive: true });
	const full = { ...note, text: note.text.replace(/\s+/g, " ").trim(), date: new Date().toISOString().slice(0, 10) };
	const tags = full.tags.map((t) => ` #${t.replace(/[^\w-]/g, "")}`).join("");
	appendFileSync(notesPath(dir), `- ${full.date} [${full.project}] ${full.text}${tags}\n`);
	return full;
}

/** Keyword overlap, boosted for the current project and recency. No embeddings: fast, local, predictable. */
export function recall(notes: readonly Note[], query: string, project: string, limit = 8): Note[] {
	const q = new Set(words(query));
	return notes
		.map((n, i) => {
			const hits = [...new Set([...words(n.text), ...n.tags])].filter((w) => q.has(w)).length;
			const score = hits + (hits && n.project === project ? 0.5 : 0) + i / Math.max(1, notes.length) / 10;
			return { n, score, hits };
		})
		.filter((x) => x.hits > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((x) => x.n);
}

/** #pin notes (global or for this project) that always ride along in the prompt, newest first, capped. */
export function pinned(notes: readonly Note[], project: string, maxChars: number): string[] {
	const out: string[] = [];
	let used = 0;
	for (const n of [...notes].reverse()) {
		if (!n.tags.includes("pin") || (n.project && n.project !== project && n.project !== "*")) continue;
		const line = `- ${n.text}`;
		if (used + line.length > maxChars) break;
		out.push(line);
		used += line.length;
	}
	return out;
}
