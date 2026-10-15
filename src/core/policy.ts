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

export function globToRegExp(glob: string): RegExp {
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

/** Shell redirection, substitution or write-capable flags that could write despite a read-only-looking command. */
const SHELL_WRITES =
	/(^|[^<>&|0-9])>>?(?!&)|\btee\b|\|\s*(sh|bash|zsh|pwsh)\b|\$\(|`|\bfind\b.*\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b|\bgit\s+branch\s+.*(-[dDmMcC]\b|--(delete|move|copy|force)\b)/;

/**
 * Split a shell command on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes (best effort, no
 * heredocs), so every segment of `ls && rm -rf x` is checked on its own.
 */
export function splitShell(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === "\\" && quote === '"' && i + 1 < command.length) {
				current += c + command[++i];
				continue;
			}
			if (c === quote) quote = undefined;
			current += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			current += c;
			continue;
		}
		if (c === "\\" && i + 1 < command.length) {
			current += c + command[++i];
			continue;
		}
		// `>&2` / `2>&1` / `&>` are redirections, not separators.
		const redirect = c === "&" && (command[i - 1] === ">" || command[i + 1] === ">");
		if ((c === ";" || c === "\n" || c === "|" || c === "&") && !redirect) {
			if (current.trim()) parts.push(current.trim());
			current = "";
			if ((c === "&" || c === "|") && command[i + 1] === c) i++;
			continue;
		}
		current += c;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

/** Words of a shell command that name a protected path (e.g. `cat .env`, `type ~/.ssh/id_rsa`). */
export function protectedShellPaths(command: string, cwd: string, home: string, globs: readonly string[]): string[] {
	const words = command.split(/[\s;|&<>()]+/).map((w) =>
		w
			.replace(/^['"]|['"]$/g, "")
			.replace(/^-{1,2}[\w-]+=/, "")
			.replace(/^\$HOME(?=[/\\])/, "~"),
	);
	const candidates = words.filter((w) => w && /[./\\~]/.test(w) && !/^[a-z]+:\/\//i.test(w));
	return [...new Set(candidates.filter((w) => isProtected(w.replaceAll("\\", "/"), cwd, home, globs)))];
}

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

	// `experiment run` executes a shell command per seed: judge it exactly like bash (it cannot be sandboxed).
	if (tool === "experiment" && input.action === "run") {
		if (env.sandboxed) return { action: "ask", reason: `experiment command runs outside the sandbox: ${String(input.command ?? "").slice(0, 160)}` };
		return decide(level, { tool: "bash", input: { command: input.command } }, cfg, env);
	}

	if (SHELL.has(tool)) {
		const command = String(input.command ?? "");
		// Only `bash` can be wrapped in the container; a sandboxed route must not escape via powershell.
		if (env.sandboxed && tool === "powershell") return { action: "deny", reason: "sandboxed mode: use bash (it runs in the container)" };
		const secrets = protectedShellPaths(command, env.cwd, env.home, cfg.protectedPaths);
		if (secrets.length) return { action: "ask", reason: `touches protected path(s): ${secrets.join(", ")}` };
		if (effective === "readonly") {
			const segments = splitShell(command);
			return segments.length > 0 && segments.every((s) => matchesAny(s, cfg.readonlyCommands) && !SHELL_WRITES.test(s))
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
