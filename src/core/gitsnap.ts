import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
	const { stdout } = await run("git", args, { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
	return stdout.trim();
}

export async function gitRoot(cwd: string): Promise<string | undefined> {
	return git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
}

/**
 * Snapshot the working tree (tracked + untracked, honouring .gitignore) as a git tree object, using a
 * private index so the user's staging area is never touched. Returns the tree hash.
 */
export async function snapshot(root: string): Promise<string> {
	const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
	const env = { GIT_INDEX_FILE: join(gitDir, "npi-snapshot-index") };
	await git(root, ["read-tree", "--empty"], env);
	await git(root, ["add", "-A", "--", "."], env);
	return git(root, ["write-tree"], env);
}

/** Make the working tree match a snapshot: rewrite its files and delete files created since. */
export async function restore(root: string, tree: string): Promise<{ restored: number; removed: number }> {
	const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
	const env = { GIT_INDEX_FILE: join(gitDir, "npi-restore-index") };
	const wanted = new Set((await git(root, ["ls-tree", "-r", "--name-only", tree])).split("\n").filter(Boolean));
	const present = (await git(root, ["ls-files", "-co", "--exclude-standard"])).split("\n").filter(Boolean);
	let removed = 0;
	for (const file of present) {
		if (!wanted.has(file)) {
			rmSync(join(root, file), { force: true });
			removed++;
		}
	}
	await git(root, ["read-tree", tree], env);
	await git(root, ["checkout-index", "-a", "-f"], env);
	return { restored: wanted.size, removed };
}

/** Files that differ between two snapshots (for a one-line summary). */
export async function changedFiles(root: string, from: string, to: string): Promise<string[]> {
	return (await git(root, ["diff", "--name-only", from, to])).split("\n").filter(Boolean);
}

export async function worktreeAdd(root: string, path: string, branch: string): Promise<void> {
	await git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
}

export async function diffStat(cwd: string): Promise<string> {
	await git(cwd, ["add", "-A"]);
	return git(cwd, ["diff", "--cached", "--stat", "HEAD"]);
}

export async function commitAll(cwd: string, message: string): Promise<string | undefined> {
	await git(cwd, ["add", "-A"]);
	const status = await git(cwd, ["status", "--porcelain"]);
	if (!status) return undefined;
	await git(cwd, ["commit", "-q", "-m", message]);
	return git(cwd, ["rev-parse", "--short", "HEAD"]);
}
