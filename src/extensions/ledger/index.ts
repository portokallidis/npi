import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	addLedgerItem,
	LEDGER_SECTIONS,
	type LedgerSection,
	ledgerPath,
	ledgerPrompt,
	loadLedger,
	renderLedger,
	resolveLedgerItems,
} from "../../core/ledger.ts";
import { runtimeHolder } from "../runtime.ts";

const LedgerParams = Type.Object({
	action: Type.Union([Type.Literal("add"), Type.Literal("resolve"), Type.Literal("list")]),
	section: Type.Optional(
		Type.Union(
			LEDGER_SECTIONS.map((s) => Type.Literal(s)),
			{ description: "invariant = must always hold; decision = chosen and why; failed = tried and did not work (include why); question = open" },
		),
	),
	text: Type.Optional(Type.String({ description: "add: one self-contained item. resolve: text that identifies the item(s) to remove" })),
	note: Type.Optional(Type.String({ description: "resolve: the answer/outcome, recorded as a decision" })),
});

/**
 * `ledger` tool + `/ledger`: per-project invariants, decisions, failed approaches and open questions in
 * `.npi/ledger.md`, injected into every prompt so compaction and restarts never lose them.
 */
export default function ledger(pi: ExtensionAPI) {
	const holder = runtimeHolder();
	pi.on("session_start", () => holder.reset());

	const pathOf = (cwd: string, rt: ReturnType<typeof holder.get>) => ledgerPath(cwd, rt.config.ledger?.file ?? ".npi/ledger.md");

	pi.registerTool({
		name: "ledger",
		label: "Ledger",
		description:
			"Project ledger that survives compaction and restarts. add: record an invariant, a decision (with the reason), a failed approach (with why it failed) or an open question. resolve: remove items that no longer apply (a note becomes a decision). list: show it.",
		promptSnippet: "Record project invariants, decisions, failed approaches and open questions",
		parameters: LedgerParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const rt = holder.get(ctx);
			const path = pathOf(ctx.cwd, rt);
			const section = params.section as LedgerSection | undefined;
			if (params.action === "list") return { content: [{ type: "text", text: renderLedger(loadLedger(path)) }], details: undefined };
			if (!section || !params.text) return { content: [{ type: "text", text: "add/resolve need section and text" }], details: undefined, isError: true };
			if (params.action === "add") {
				addLedgerItem(path, section, params.text);
				return { content: [{ type: "text", text: `Added to ${section}: ${params.text}` }], details: undefined };
			}
			const n = resolveLedgerItems(path, section, params.text, params.note);
			return { content: [{ type: "text", text: n ? `Resolved ${n} ${section} item(s)` : `No ${section} item matches "${params.text}"` }], details: undefined, isError: !n };
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		const rt = holder.get(ctx);
		const file = rt.config.ledger?.file ?? ".npi/ledger.md";
		const body = ledgerPrompt(loadLedger(ledgerPath(ctx.cwd, file)), rt.config.ledger?.promptChars ?? 2500, file);
		if (body) event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, npi_ledger: body };
	});

	pi.registerCommand("ledger", {
		description: "Show the project ledger (.npi/ledger.md), or open it in the editor: /ledger [edit]",
		handler: async (args, ctx) => {
			const rt = holder.get(ctx);
			const path = pathOf(ctx.cwd, rt);
			const text = renderLedger(loadLedger(path));
			if (args.trim() === "edit" && ctx.hasUI) {
				const edited = await ctx.ui.editor(`Edit ${path}`, text);
				if (edited !== undefined) {
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, edited);
					ctx.ui.notify(`Saved ${path}`, "info");
				}
				return;
			}
			ctx.ui.notify(`${path}\n\n${text}`, "info");
		},
	});
}
