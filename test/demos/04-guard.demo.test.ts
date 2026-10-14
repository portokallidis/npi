// Demo 4 — Safety policies (quick, no model needed). What each mode's policy does with typical tool calls.
import { homedir } from "node:os";
import { it } from "vitest";
import { decide, type PolicyLevel } from "../../src/core/policy.ts";
import { banner, bench, config } from "./harness.ts";

const calls: [string, Record<string, unknown>, { destructiveHint?: boolean; readOnlyHint?: boolean }?][] = [
	["bash", { command: "git diff --stat" }],
	["bash", { command: "npm test" }],
	["bash", { command: "rm -rf dist" }],
	["bash", { command: "git push --force origin main" }],
	["edit", { path: "src/app.ts" }],
	["write", { path: ".env" }],
	["write", { path: "/etc/hosts" }],
	["mcp__playwright__browser_navigate", {}],
	["mcp__playwright__browser_fill_form", {}],
	["web_search", { query: "x" }],
];

it("quick: policy decisions per mode", () =>
	bench.run("guard", async (metrics) => {
	const levels: PolicyLevel[] = ["readonly", "ask", "auto"];
	const env = (sandboxed: boolean) => ({ cwd: process.cwd(), home: homedir(), sandboxed });
	const icon = { allow: "✅", ask: "❓", deny: "⛔" } as const;
	const rows = calls.map(([tool, input, hints]) => {
		const label = `${tool}${input.command ? ` "${input.command}"` : input.path ? ` ${input.path}` : ""}`.padEnd(48);
		const cells = [...levels.map((l) => decide(l, { tool, input, hints }, config.guard, env(false)).action), decide("auto", { tool, input, hints }, config.guard, env(true)).action];
		return `${label} ${cells.map((c) => `${icon[c]} ${c.padEnd(5)}`).join("  ")}`;
	});
	metrics.decisions = rows.length * 4;
	banner("Policy decisions", [`${"call".padEnd(48)} readonly   ask        auto       auto+sandbox`, ...rows]);
	}));
