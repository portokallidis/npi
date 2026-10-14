import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadNotes, pinned, recall, remember } from "../src/core/memory.ts";

describe("memory", () => {
	it("round-trips notes and recalls by keyword, preferring the current project", () => {
		const dir = join(mkdtempSync(join(tmpdir(), "mem-")), "memory");
		remember(dir, { project: "npi", text: "User prefers pnpm over npm", tags: ["prefs", "pin"] });
		remember(dir, { project: "other", text: "Deploys go through pnpm workspaces", tags: [] });
		remember(dir, { project: "npi", text: "Router classifier timeout is 2.5s", tags: ["router"] });

		const notes = loadNotes(dir);
		expect(notes).toHaveLength(3);
		expect(notes[0]).toMatchObject({ project: "npi", text: "User prefers pnpm over npm", tags: ["prefs", "pin"] });
		expect(recall(notes, "which package manager, pnpm?", "npi").map((n) => n.project)).toEqual(["npi", "other"]);
		expect(recall(notes, "router timeout", "npi")[0].text).toMatch(/2.5s/);
		expect(recall(notes, "kubernetes", "npi")).toEqual([]);
		expect(pinned(notes, "npi", 1000)).toEqual(["- User prefers pnpm over npm"]);
		expect(pinned(notes, "elsewhere", 1000)).toEqual([]);
	});
});
