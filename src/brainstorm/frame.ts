import type { Budget } from "../core/budget.ts";
import type { Llm } from "../core/llm.ts";
import { callStructured } from "../core/structured.ts";
import { framingPrompt, ORCHESTRATOR_SYSTEM } from "./prompts.ts";
import type { UserChannel } from "./resolve/index.ts";
import { type Direction, type Framing, FramingSchema } from "./types.ts";

export const OTHER_OPTION = "Other — let me type it";
export const NO_PREFERENCE = "No preference / you decide";

export async function frame(
	prompt: string,
	options: { llm: Llm; budget: Budget; model: string; maxQuestions: number; maxTokens: number; signal?: AbortSignal },
): Promise<Framing> {
	const framing = await callStructured(options.llm, options.budget, {
		model: options.model,
		label: "orchestrator:frame",
		system: ORCHESTRATOR_SYSTEM,
		prompt: framingPrompt(prompt, options.maxQuestions),
		schema: FramingSchema,
		toolName: "submit_framing",
		toolDescription: "Submit the goal, its clarity, and the direction questions for the user.",
		thinking: "high",
		maxTokens: options.maxTokens,
		signal: options.signal,
	});
	return { ...framing, questions: framing.questions.slice(0, options.maxQuestions) };
}

/** Ask the user each direction question; unanswered ones are left to the orchestrator's judgement. */
export async function askDirections(framing: Framing, user: UserChannel | undefined): Promise<Direction[]> {
	if (!user) return [];
	const directions: Direction[] = [];
	for (const [i, q] of framing.questions.entries()) {
		const title = `Direction ${i + 1}/${framing.questions.length}: ${q.question}  (${q.why})`;
		const choice = await user.select(title, [...q.options, OTHER_OPTION, NO_PREFERENCE]);
		if (!choice || choice === NO_PREFERENCE) continue;
		const answer = choice === OTHER_OPTION ? (await user.input(q.question))?.trim() : choice;
		if (answer) directions.push({ question: q.question, answer });
	}
	return directions;
}
