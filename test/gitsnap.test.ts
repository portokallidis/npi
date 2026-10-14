import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedFiles, restore, snapshot } from "../src/core/gitsnap.ts";

function repo() {
	const dir = mkdtempSync(join(tmpdir(), "snap-"));
	const g = (...args: string[]) => execFileSync("git", args, { cwd: dir });
	g("init", "-q");
	g("config", "user.email", "t@t");
	g("config", "user.name", "t");
	writeFileSync(join(dir, "a.txt"), "one");
	writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
	g("add", "-A");
	g("commit", "-qm", "init");
	return { dir, g };
}

describe("git snapshots", () => {
	it("restores edits, deletes new files, keeps ignored files and the user's index untouched", async () => {
		const { dir, g } = repo();
		writeFileSync(join(dir, "staged.txt"), "s");
		g("add", "staged.txt");
		const before = await snapshot(dir);

		writeFileSync(join(dir, "a.txt"), "two");
		writeFileSync(join(dir, "new.txt"), "n");
		writeFileSync(join(dir, "ignored.txt"), "keep");
		const after = await snapshot(dir);
		expect((await changedFiles(dir, before, after)).sort()).toEqual(["a.txt", "new.txt"]);

		await restore(dir, before);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one");
		expect(existsSync(join(dir, "new.txt"))).toBe(false);
		expect(readFileSync(join(dir, "ignored.txt"), "utf8")).toBe("keep");
		expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir }).toString().trim()).toBe("staged.txt");
	});
});
