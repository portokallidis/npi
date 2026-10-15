import { exec } from "node:child_process";
import { basename } from "node:path";
import { errorLines } from "./digest.ts";
import { globToRegExp } from "./policy.ts";

/** A verification command run after the agent edits matching files (typecheck, lint, schema validation). */
export interface CheckConfig {
	/** Glob over changed paths (relative to cwd). Without "/" it matches the file name anywhere: "*.ts". */
	glob: string;
	/** Shell command; `{file}` (or `{files}`) is replaced with the changed path(s), else it runs once. */
	command: string;
	timeoutMs?: number;
}

export interface CheckRun {
	command: string;
	ok: boolean;
	output: string;
}

const quote = (p: string) => `"${p.replaceAll('"', '\\"')}"`;

export function matchesGlob(path: string, glob: string): boolean {
	const p = path.replaceAll("\\", "/").replace(/^\.\//, "");
	return globToRegExp(glob).test(glob.includes("/") ? p : basename(p));
}

/** Concrete commands for a set of changed files: one per check, or one per file for `{file}`; deduplicated. */
export function plannedChecks(checks: readonly CheckConfig[], changed: readonly string[]): { command: string; timeoutMs: number }[] {
	const out = new Map<string, number>();
	for (const check of checks) {
		const files = changed.filter((f) => matchesGlob(f, check.glob));
		if (!files.length) continue;
		const timeout = check.timeoutMs ?? 120_000;
		if (check.command.includes("{files}")) out.set(check.command.replaceAll("{files}", files.map(quote).join(" ")), timeout);
		else if (check.command.includes("{file}")) for (const f of files) out.set(check.command.replaceAll("{file}", quote(f)), timeout);
		else out.set(check.command, timeout);
	}
	return [...out].map(([command, timeoutMs]) => ({ command, timeoutMs }));
}

export function runCheck(command: string, cwd: string, timeoutMs: number): Promise<CheckRun> {
	return new Promise((resolve) => {
		exec(command, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
			const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
			const timedOut = error && (error as { killed?: boolean }).killed;
			resolve({ command, ok: !error, output: timedOut ? `${output}\n(timed out after ${timeoutMs} ms)` : output });
		});
	});
}

/** Failure report for the model: error lines first (verbatim), then the tail of the output, capped. */
export function failureReport(runs: readonly CheckRun[], maxChars = 4000): string {
	const failed = runs.filter((r) => !r.ok);
	const per = Math.max(500, Math.floor(maxChars / Math.max(1, failed.length)));
	const blocks = failed.map((r) => {
		const errors = errorLines(r.output).join("\n");
		const tail = r.output.slice(-Math.max(0, per - errors.length - 100));
		const body = errors && !tail.includes(errors) ? `${errors}\n…\n${tail}` : tail || "(no output)";
		return `$ ${r.command}\n${body.slice(-per)}`;
	});
	return `Post-edit checks failed (${failed.length}/${runs.length}). Fix these before finishing:\n\n${blocks.join("\n\n")}`;
}
