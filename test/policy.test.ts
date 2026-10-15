import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NpiConfig } from "../src/core/config.ts";
import { decide, isProtected, protectedShellPaths, sandboxCommand, splitShell } from "../src/core/policy.ts";

const { guard } = JSON.parse(readFileSync(new URL("../config/npi.json", import.meta.url), "utf8")) as NpiConfig;
const env = { cwd: "/home/u/proj", home: "/home/u", sandboxed: false };
const run = (level: "readonly" | "ask" | "auto", tool: string, input: Record<string, unknown>, hints = {}, e = env) =>
	decide(level, { tool, input, hints }, guard, e).action;

describe("policy", () => {
	it("protects secrets and git internals in every mode", () => {
		expect(isProtected(".env.local", env.cwd, env.home, guard.protectedPaths)).toBe(true);
		expect(isProtected("/home/u/.ssh/id_ed25519", env.cwd, env.home, guard.protectedPaths)).toBe(true);
		expect(isProtected("src/app.ts", env.cwd, env.home, guard.protectedPaths)).toBe(false);
		expect(run("auto", "write", { path: ".git/config" }, {}, { ...env, sandboxed: true })).toBe("deny");
	});

	it("readonly allows inspection only", () => {
		expect(run("readonly", "edit", { path: "src/a.ts" })).toBe("deny");
		expect(run("readonly", "bash", { command: "git diff --stat" })).toBe("allow");
		expect(run("readonly", "bash", { command: "rg TODO src" })).toBe("allow");
		expect(run("readonly", "bash", { command: "cat a > b" })).toBe("deny");
		expect(run("readonly", "bash", { command: "npm install" })).toBe("deny");
		expect(run("readonly", "web_search", { query: "x" })).toBe("allow");
		expect(run("readonly", "mcp__x__thing", {}, { readOnlyHint: true })).toBe("allow");
		expect(run("readonly", "mcp__x__thing", {})).toBe("deny");
	});

	it("readonly checks every segment of a chained command", () => {
		expect(splitShell(`ls && rm -rf x; echo "a;b" | wc -l || true`)).toEqual(["ls", "rm -rf x", `echo "a;b"`, "wc -l", "true"]);
		expect(splitShell("grep x a 2>&1")).toEqual(["grep x a 2>&1"]);
		expect(run("readonly", "bash", { command: "ls && rm -rf x" })).toBe("deny");
		expect(run("readonly", "bash", { command: "ls; git status" })).toBe("allow");
		expect(run("readonly", "bash", { command: "git log | head -5" })).toBe("allow");
		expect(run("readonly", "bash", { command: "find . -name '*.tmp' -delete" })).toBe("deny");
		expect(run("readonly", "bash", { command: "find . -exec rm {} ;" })).toBe("deny");
		expect(run("readonly", "bash", { command: "git branch -D feature" })).toBe("deny");
		expect(run("readonly", "bash", { command: "git branch -a" })).toBe("allow");
		expect(run("readonly", "bash", { command: "git branch" })).toBe("allow");
	});

	it("asks before shell commands touch protected paths", () => {
		expect(protectedShellPaths("cat .env && ls", env.cwd, env.home, guard.protectedPaths)).toEqual([".env"]);
		expect(run("readonly", "bash", { command: "cat .env" })).toBe("ask");
		expect(run("ask", "bash", { command: "cat ~/.ssh/id_rsa" })).toBe("ask");
		expect(run("ask", "powershell", { command: "Get-Content $HOME/.aws/credentials" })).toBe("ask");
		expect(run("ask", "bash", { command: "cat .gitignore src/env.ts" })).toBe("allow");
	});

	it("blocks powershell on sandboxed routes", () => {
		expect(run("auto", "powershell", { command: "ls" }, {}, { ...env, sandboxed: true })).toBe("deny");
	});

	it("ask gates risky commands, outside writes and state-changing browser tools", () => {
		expect(run("ask", "bash", { command: "npm test" })).toBe("allow");
		expect(run("ask", "bash", { command: "rm -rf build" })).toBe("ask");
		expect(run("ask", "bash", { command: "git push origin main" })).toBe("ask");
		expect(run("ask", "write", { path: "/etc/hosts" })).toBe("ask");
		expect(run("ask", "write", { path: "src/a.ts" })).toBe("allow");
		expect(run("ask", "mcp__playwright__browser_fill_form", {})).toBe("ask");
		expect(run("ask", "mcp__playwright__browser_navigate", {})).toBe("allow");
	});

	it("auto only applies when sandboxed", () => {
		expect(run("auto", "bash", { command: "rm -rf build" })).toBe("ask");
		expect(run("auto", "bash", { command: "rm -rf build" }, {}, { ...env, sandboxed: true })).toBe("allow");
	});

	it("wraps commands for the docker sandbox with safe quoting", () => {
		const cmd = sandboxCommand("echo 'hi' && ls", "/p", { sandboxImage: "img", sandboxNetwork: "none" });
		expect(cmd).toBe(`MSYS_NO_PATHCONV=1 docker run --rm -i -v "/p:/work" -w /work --network none img sh -lc 'echo '\\''hi'\\'' && ls'`);
	});
});
