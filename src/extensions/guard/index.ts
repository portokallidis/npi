import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decide, type PolicyLevel, sandboxCommand } from "../../core/policy.ts";
import { runtimeHolder } from "../runtime.ts";

const ROUTE_CHANNEL = "harness:route";
const LEVELS: PolicyLevel[] = ["readonly", "ask", "auto"];

/**
 * Approval gates + sandbox, per mode. Each tool call is checked against the active route's policy:
 * `readonly` blocks changes, `ask` asks before risky calls, `auto` runs freely but only inside the
 * Docker sandbox. Protected paths (secrets, .git) are blocked everywhere. No UI => "ask" means block.
 */
export default function guard(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	let route: string | undefined;
	let override: PolicyLevel | undefined;

	pi.on("session_start", () => {
		holder.reset();
		override = undefined;
	});
	pi.events.on(ROUTE_CHANNEL, (name) => {
		route = typeof name === "string" ? name : undefined;
	});

	const current = (rt: ReturnType<typeof holder.get>) => {
		const r = route ? rt.config.routes[route] : undefined;
		return { level: override ?? r?.policy ?? rt.config.guard.defaultPolicy, sandboxed: !!r?.sandbox };
	};

	pi.on("tool_call", async (event, ctx) => {
		const rt = holder.get(ctx);
		const { level, sandboxed } = current(rt);
		const hints = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations;
		const input = event.input as Record<string, unknown>;
		const decision = decide(level, { tool: event.toolName, input, hints }, rt.config.guard, { cwd: ctx.cwd, home: homedir(), sandboxed });

		if (decision.action === "deny") return { block: true, reason: `Blocked by ${level} policy: ${decision.reason}` };
		if (decision.action === "ask") {
			const ok = ctx.hasUI && (await ctx.ui.confirm(`Allow ${event.toolName}?`, `${decision.reason}\n\n(mode: ${route ?? "?"}, policy: ${level})`));
			if (!ok) return { block: true, reason: `Not approved: ${decision.reason}` };
		}
		if (sandboxed && event.toolName === "bash" && typeof input.command === "string") {
			input.command = sandboxCommand(input.command, ctx.cwd, rt.config.guard);
		}
		return undefined;
	});

	pi.registerCommand("policy", {
		description: "Show or override the approval policy for this session: /policy [readonly|ask|auto|reset]",
		handler: async (args, ctx) => {
			const arg = args.trim() as PolicyLevel | "reset" | "";
			if (arg === "reset") override = undefined;
			else if (LEVELS.includes(arg as PolicyLevel)) override = arg as PolicyLevel;
			else if (arg) return ctx.ui.notify(`Usage: /policy [${LEVELS.join("|")}|reset]`, "error");
			const { level, sandboxed } = current(holder.get(ctx));
			const note = level === "auto" && !sandboxed ? " (acts as ask: this mode is not sandboxed)" : "";
			ctx.ui.notify(`policy: ${level}${override ? " (session override)" : ""}${sandboxed ? ", sandboxed" : ""}${note}`, "info");
		},
	});
}
