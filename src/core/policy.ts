import { isAbsolute, relative, resolve } from "node:path";

/** Per-route permission level. `auto` is honoured only when the route is sandboxed. */
export type PolicyLevel = "readonly" | "ask" | "auto";

export interface GuardConfig {
	/** Globs (relative to cwd, or ~/…) that may never be written; `ask`/`readonly` block, `auto` blocks too. */
	protectedPaths: string[];
	/** Regexes for shell commands that need approval under `ask`. */
	askCommands: string[];
	/** Regexes for shell commands allowed under `readonly`. */
	readonlyCommands: string[];
	/** Tools always allowed under `readonly` (they only read or delegate read-only work). */
	readonlyTools: string[];
	/** Regexes for MCP/extension tool names that need approval under `ask` (e.g. form submits). */
	askTools: string[];
	sandboxImage: string;
	sandboxNetwork: string;
}

export interface ToolHints {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
}

export type Decision = { action: "allow" } | { action: "ask" | "deny"; reason: string };

const SHELL = new Set(["bash", "powershell"]);
const WRITERS = new Set(["edit", "write"]);

function globToRegExp(glob: string): RegExp {
	// Placeholders first so the regex fragments we insert are not re-processed.
	const pattern = glob
		.replace(/\*\*\//g, "\u0001")
		.replace(/\*\*/g, "\u0002")
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\u0001/g, "(?:.*/)?")
		.replace(/\u0002/g, ".*");
	return new RegExp(`^${pattern}$`, "i");
}

/** Path as matched against protected globs: relative to cwd when inside it, else absolute with "~" for home. */
function normalizePath(path: string, cwdIn: string, homeIn: string): string {
	const cwd = resolve(cwdIn);
	const home = resolve(homeIn);
	const abs = path.startsWith("~/") ? resolve(home, path.slice(2)) : resolve(cwd, path);
	const rel = relative(cwd, abs);
	if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.replaceAll("\\", "/");
	const homeRel = relative(home, abs);
	return !homeRel.startsWith("..") && !isAbsolute(homeRel) ? `~/${homeRel.replaceAll("\\", "/")}` : abs.replaceAll("\\", "/");
}

export function isProtected(path: string, cwd: string, home: string, globs: readonly string[]): boolean {
	const p = normalizePath(path, cwd, home);
	return globs.some((g) => globToRegExp(g).test(p));
}

const matchesAny = (text: string, patterns: readonly string[]) =>
	patterns.some((p) => {
		try {
			return new RegExp(p, "i").test(text);
		} catch {
			return false;
		}
	});

/** Shell redirection or chaining that could write despite a read-only-looking command. */
const SHELL_WRITES = /(^|[^<>&|0-9])>>?(?!&)|\btee\b|\|\s*(sh|bash|zsh|pwsh)\b|\$\(|`/;

/**
 * Decide whether a tool call may run under a route's policy. Pure: no I/O, so it is unit-tested and
 * cheap to call on every tool call.
 */
export function decide(
	level: PolicyLevel,
	call: { tool: string; input: Record<string, unknown>; hints?: ToolHints },
	cfg: GuardConfig,
	env: { cwd: string; home: string; sandboxed: boolean },
): Decision {
	const { tool, input, hints } = call;
	const effective: PolicyLevel = level === "auto" && !env.sandboxed ? "ask" : level;
	const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;

	if (WRITERS.has(tool)) {
		if (path && isProtected(path, env.cwd, env.home, cfg.protectedPaths)) return { action: "deny", reason: `${path} is protected` };
		if (effective === "readonly") return { action: "deny", reason: "read-only mode: no file changes" };
		if (effective === "ask" && path && normalizePath(path, env.cwd, env.home).match(/^(~|\/|[a-z]:)/i)) {
			return { action: "ask", reason: `writes outside the project: ${path}` };
		}
		return { action: "allow" };
	}

	if (SHELL.has(tool)) {
		const command = String(input.command ?? "");
		if (effective === "readonly") {
			return matchesAny(command, cfg.readonlyCommands) && !SHELL_WRITES.test(command)
				? { action: "allow" }
				: { action: "deny", reason: "read-only mode: only inspection commands" };
		}
		if (effective === "ask" && matchesAny(command, cfg.askCommands)) return { action: "ask", reason: `risky command: ${command.slice(0, 160)}` };
		return { action: "allow" };
	}

	if (effective === "readonly") {
		if (cfg.readonlyTools.includes(tool) || hints?.readOnlyHint === true) return { action: "allow" };
		return { action: "deny", reason: `read-only mode: ${tool} may change state` };
	}
	if (effective === "ask" && (hints?.destructiveHint === true || matchesAny(tool, cfg.askTools))) {
		return { action: "ask", reason: `${tool} can change external state` };
	}
	return { action: "allow" };
}

/** Wrap a shell command so it runs in a throwaway container with only the project mounted. */
export function sandboxCommand(command: string, cwd: string, cfg: Pick<GuardConfig, "sandboxImage" | "sandboxNetwork">): string {
	const quoted = `'${command.replaceAll("'", `'\\''`)}'`;
	// MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting /work.
	return `MSYS_NO_PATHCONV=1 docker run --rm -i -v "${cwd}:/work" -w /work --network ${cfg.sandboxNetwork} ${cfg.sandboxImage} sh -lc ${quoted}`;
}
