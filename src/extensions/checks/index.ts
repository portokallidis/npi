import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { failureReport, plannedChecks, runCheck } from "../../core/checks.ts";
import { runtimeHolder } from "../runtime.ts";

const WRITERS = new Set(["edit", "write"]);
/** Automatic fix rounds per user prompt before the gate stops re-prompting. */
const MAX_ROUNDS = 3;
const STRUGGLE_CHANNEL = "npi:struggle";

/**
 * Post-edit check gate: when an agent run that changed files ends, run the configured `checks` whose glob
 * matches those files (typecheck, lint, schema/ontology validators). Failures go back to the model as a
 * follow-up message so it fixes them immediately; two failing rounds in a row escalate the next turn's tier.
 */
export default function checks(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	const pending = new Map<string, string>(); // toolCallId -> path
	const changed = new Set<string>();
	let rounds = 0;
	let failedRounds = 0;

	pi.on("session_start", () => {
		holder.reset();
		pending.clear();
		changed.clear();
		rounds = 0;
		failedRounds = 0;
	});

	pi.on("before_agent_start", (event) => {
		if (event.messageType === "user") rounds = 0;
	});

	pi.on("tool_call", (event, ctx) => {
		if (!WRITERS.has(event.toolName)) return;
		const input = event.input as Record<string, unknown>;
		const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
		if (!path) return;
		const rel = relative(ctx.cwd, resolve(ctx.cwd, path));
		if (!rel.startsWith("..") && !isAbsolute(rel)) pending.set(event.toolCallId, rel);
	});

	pi.on("tool_execution_end", (event) => {
		const path = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (path && !event.isError) changed.add(path);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const configured = holder.get(ctx).config.checks ?? [];
		if (!changed.size || !configured.length) return;
		const files = [...changed];
		changed.clear();
		const planned = plannedChecks(configured, files);
		if (!planned.length) return;

		if (ctx.hasUI) ctx.ui.setStatus("npi-checks", `checks: running ${planned.length}…`);
		const runs = await Promise.all(planned.map((c) => runCheck(c.command, ctx.cwd, c.timeoutMs)));
		const failed = runs.filter((r) => !r.ok).length;
		if (ctx.hasUI) ctx.ui.setStatus("npi-checks", failed ? `checks: ${failed}/${runs.length} failing` : `checks: ${runs.length} passed`);
		pi.events.emit("npi:telemetry", { type: "checks", runs: runs.length, failed });
		if (!failed) {
			failedRounds = 0;
			return;
		}

		failedRounds++;
		if (failedRounds >= 2) pi.events.emit(STRUGGLE_CHANNEL, "checks");
		if (rounds >= MAX_ROUNDS) {
			if (ctx.hasUI) ctx.ui.notify(`Checks still failing after ${MAX_ROUNDS} automatic fix rounds; leaving it to you.`, "warning");
			return;
		}
		rounds++;
		pi.sendMessage({ customType: "npi-checks", content: failureReport(runs), display: true }, { triggerTurn: true, deliverAs: "followUp" });
	});
}
