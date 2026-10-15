/** Where a /handoff goes: an npi mode, a specific model, or an external agent CLI. */
export type HandoffTarget =
	| { kind: "same" }
	| { kind: "route"; route: string }
	| { kind: "model"; model: string }
	| { kind: "external"; agent: string };

export const EXTERNAL_AGENTS: Record<string, (file: string) => string> = {
	claude: (f) => `claude "$(cat ${f})"`,
	codex: (f) => `codex "$(cat ${f})"`,
	opencode: (f) => `opencode run "$(cat ${f})"`,
	gemini: (f) => `gemini -i "$(cat ${f})"`,
	pi: (f) => `pi "$(cat ${f})"`,
};

/** "/handoff --to code fix the rest" -> target + goal. `--to` accepts a route, provider/model, or agent name. */
export function parseHandoff(args: string, routes: readonly string[]): { target: HandoffTarget; goal: string } {
	const match = args.match(/^\s*--to\s+(\S+)\s*([\s\S]*)$/);
	if (!match) return { target: { kind: "same" }, goal: args.trim() };
	const [, to, goal] = match;
	if (routes.includes(to)) return { target: { kind: "route", route: to }, goal: goal.trim() };
	if (EXTERNAL_AGENTS[to]) return { target: { kind: "external", agent: to }, goal: goal.trim() };
	if (to.includes("/")) return { target: { kind: "model", model: to }, goal: goal.trim() };
	throw new Error(`Unknown handoff target "${to}". Use a mode (${routes.join(", ")}), provider/model, or ${Object.keys(EXTERNAL_AGENTS).join(", ")}`);
}

export const HANDOFF_SYSTEM = `You transfer context to a fresh thread that may run on a different model or a different agent (Claude Code, Codex, …) that has never seen this conversation. Write a self-contained prompt:

## Context
What we are doing and why; decisions made (and rejected options, briefly); current state.
## Files
Relevant paths, and what changed in each.
## Artifacts
Paths to reports/notes worth reading (only if useful).
## Task
The next task, stated precisely, with acceptance criteria.

Be concise — every line must earn its place. No preamble.`;
