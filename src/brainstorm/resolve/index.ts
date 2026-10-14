import type { Dispute, Resolution } from "../types.ts";
import { resolveWithUser } from "./askUser.ts";
import type { ResolveContext } from "./context.ts";
import { crossExamine } from "./crossExam.ts";
import { resolveWithEvidence } from "./evidence.ts";

export type { ResolveContext, UserChannel } from "./context.ts";
export { judge } from "./judge.ts";

/** Route a dispute to the resolver that suits its kind; each falls back to the judge. */
export function resolveDispute(dispute: Dispute, ctx: ResolveContext): Promise<Resolution> {
	switch (dispute.kind) {
		case "factual":
			return resolveWithEvidence(dispute, ctx);
		case "reasoning":
			return crossExamine(dispute, ctx);
		case "context":
			return resolveWithUser(dispute, ctx);
	}
}
