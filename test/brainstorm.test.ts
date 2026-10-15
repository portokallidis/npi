import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_PREFERENCE, OTHER_OPTION } from "../src/brainstorm/frame.ts";
import { normalizeMap } from "../src/brainstorm/map.ts";
import { runBrainstorm } from "../src/brainstorm/pipeline.ts";
import { renderDigest, renderReport, scorecard } from "../src/brainstorm/report.ts";
import { EXPLAIN_OPTION } from "../src/brainstorm/resolve/askUser.ts";
import type { BrainstormConfig, BrainstormEvent, MapOutput } from "../src/brainstorm/types.ts";
import { ArtifactStore } from "../src/core/artifacts.ts";
import { RunState } from "../src/core/runstate.ts";
import type { SubagentRunner } from "../src/core/subagent.ts";
import { FakeLlm, type RecordedCall, textMessage, toolCallMessage } from "./fakes.ts";

const config: BrainstormConfig = {
	orchestrator: ["p/fable", "p/opus"],
	panel: [
		{ id: "a", model: "p/a" },
		{ id: "b", model: "p/b" },
		{ id: "c", model: "p/c" },
	],
	minPanelists: 2,
	fallbackPersonas: [],
	judge: ["p/a", "p/judge"],
	evidenceAgent: "researcher",
	maxDirectionQuestions: 2,
	maxPathwaysPerPanelist: 4,
	maxDisputes: 5,
	crossExamRounds: 2,
	recommendThreshold: 0.6,
	askUser: true,
	maxCostUSD: 10,
	callTimeoutMs: 5000,
	maxOutputTokens: { panelist: 4000, orchestrator: 8000 },
	reportDir: ".npi/brainstorms",
};

const pathway = (name: string, claim: string) => ({
	name,
	summary: `${name} summary`,
	howItWorks: ["step"],
	pros: [`${name} pro`],
	cons: [`${name} con`],
	risks: [],
	effort: "medium",
	bestWhen: `${name} when`,
	claims: [{ id: "c1", text: claim, type: "factual", confidence: 0.8 }],
});

const map: MapOutput = {
	pathways: [
		{ name: "SQLite + Litestream", summary: "s", proposedBy: ["a", "c"], pros: ["cheap"], cons: ["one writer"], risks: [], effort: "low", bestWhen: "small team" },
		{ name: "Managed Postgres", summary: "s", proposedBy: ["b", "ghost"], pros: ["scales"], cons: ["cost"], risks: ["lock-in"], effort: "medium", bestWhen: "growth" },
		{ name: "Firestore", summary: "s", proposedBy: ["orchestrator"], pros: ["no ops"], cons: ["queries"], risks: [], effort: "low", bestWhen: "mobile" },
	],
	consensus: [{ statement: "All options handle 50 users", panelists: ["a", "b", "c"] }],
	disputes: [
		{
			topic: "Write concurrency",
			crux: "Does SQLite WAL allow concurrent writers?",
			kind: "factual",
			importance: 0.9,
			positions: [
				{ stance: "Single writer at a time", panelists: ["a", "c"], claimRefs: ["a:c1"] },
				{ stance: "Multiple concurrent writers", panelists: ["b"], claimRefs: ["b:c1"] },
			],
		},
		{
			topic: "Scaling path",
			crux: "Will 50 users outgrow SQLite?",
			kind: "reasoning",
			importance: 0.7,
			positions: [
				{ stance: "No, ample headroom", panelists: ["a"], claimRefs: [] },
				{ stance: "Yes, plan Postgres now", panelists: ["b"], claimRefs: [] },
			],
		},
		{
			topic: "Ops budget",
			crux: "Can the team run a DB server?",
			kind: "context",
			importance: 0.6,
			positions: [
				{ stance: "Avoid servers", panelists: ["c"], claimRefs: [] },
				{ stance: "Managed Postgres is fine", panelists: ["b"], claimRefs: [] },
			],
		},
		{ topic: "One-sided", crux: "n/a", kind: "reasoning", importance: 0.99, positions: [{ stance: "only one", panelists: ["a", "ghost"], claimRefs: [] }] },
	],
};

function responder(clarity = 0.8) {
	return (call: RecordedCall) => {
		const tool = call.request.tools?.[0]?.name;
		if (tool === "submit_framing") {
			return toolCallMessage("submit_framing", {
				goal: "Pick a database for an internal tool",
				goalClarity: 0.4,
				questions: [
					{ question: "How many concurrent writers?", why: "drives SQLite viability", options: ["<5", "5-50"] },
					{ question: "Ops capacity?", why: "managed vs self-hosted", options: ["none", "some"] },
				],
			});
		}
		if (tool === "submit_pathways") {
			const id = call.ref.split("/")[1];
			return toolCallMessage("submit_pathways", { pathways: [pathway(`${id}-path`, `claim ${id}`)], assumptions: [] });
		}
		if (tool === "submit_map") return toolCallMessage("submit_map", map);
		if (tool === "submit_reply") {
			const conceding = call.ref === "p/b";
			return toolCallMessage("submit_reply", {
				action: conceding ? "concede" : "rebut",
				statement: conceding ? "Fair, headroom is ample" : "50 users is far below SQLite limits",
				reason: "benchmarks",
				confidence: 0.85,
			});
		}
		if (tool === "submit_ruling") {
			return toolCallMessage("submit_ruling", { winningPosition: 0, verdict: "One writer at a time; readers concurrent", confidence: 0.95, rationale: "per docs" });
		}
		if (tool === "submit_convergence") {
			return toolCallMessage("submit_convergence", {
				goalClarity: clarity,
				ranking: [
					{ pathway: "p1", fit: 0.9, why: "fits small team" },
					{ pathway: "p2", fit: 0.6, why: "overkill" },
					{ pathway: "p3", fit: 0.3, why: "query limits" },
				],
				recommendation: { pathway: "p1", rationale: "Cheapest and enough", conditions: ["writers > 50"], firstSteps: ["enable WAL"] },
				decisionCriteria: ["write concurrency", "ops capacity"],
				openQuestions: [],
				summary: "SQLite fits.",
			});
		}
		return textMessage("unexpected");
	};
}

const evidenceRunner: SubagentRunner = {
	async run(req) {
		return {
			agent: req.agent.name,
			model: "p/research",
			text: "VERDICT: position 0.\nSOURCES:\n- https://sqlite.org/wal.html — single writer.",
			artifact: ".npi/artifacts/run/001-researcher.md",
			usage: { input: 10, output: 10, costUSD: 0.02, turns: 2, peakContextTokens: 10 },
		};
	},
};

const researcher = { name: "researcher", description: "", systemPrompt: "", filePath: "" };

function scriptedUser(answers: (string | undefined)[], typed?: string) {
	const asked: { title: string; options: string[] }[] = [];
	return {
		asked,
		channel: {
			async select(title: string, options: string[]) {
				asked.push({ title, options });
				const next = answers.shift();
				return next === "FIRST" ? options[0] : next;
			},
			async input() {
				return typed;
			},
		},
	};
}

describe("normalizeMap", () => {
	it("ids pathways, filters unknown panelists, drops one-sided disputes and ranks the rest", () => {
		const m = normalizeMap(map, ["a", "b", "c"], 2);
		expect(m.pathways.map((p) => [p.id, p.proposedBy])).toEqual([
			["p1", ["a", "c"]],
			["p2", ["b"]],
			["p3", ["orchestrator"]],
		]);
		expect(m.disputes.map((d) => [d.id, d.topic])).toEqual([
			["d1", "Write concurrency"],
			["d2", "Scaling path"],
		]);
	});
});

describe("runBrainstorm (explore and decide)", () => {
	it("frames with the orchestrator, asks directions, explores, settles disputes and recommends", async () => {
		const llm = new FakeLlm(responder());
		const user = scriptedUser(["5-50", OTHER_OPTION, "FIRST"], "No ops staff at all");
		const events: BrainstormEvent[] = [];
		const cwd = mkdtempSync(join(tmpdir(), "bs-"));
		const artifacts = new ArtifactStore(cwd, ".npi/artifacts", "run");

		const report = await runBrainstorm("We need a DB for an internal tool", config, {
			llm,
			runner: evidenceRunner,
			evidenceAgent: researcher,
			user: user.channel,
			artifacts,
			onEvent: (e) => events.push(e),
		});

		// Orchestrator is the first available top model and drives frame/map/converge.
		const orchestratorCalls = llm.calls.filter((c) => ["submit_framing", "submit_map", "submit_convergence"].includes(c.request.tools?.[0]?.name ?? ""));
		expect(orchestratorCalls.map((c) => c.ref)).toEqual(["p/fable", "p/fable", "p/fable"]);

		// Directions: picked option, typed "Other", and they reach the panel's brief.
		expect(report.directions).toEqual([
			{ question: "How many concurrent writers?", answer: "5-50" },
			{ question: "Ops capacity?", answer: "No ops staff at all" },
		]);
		expect(user.asked[0].options).toEqual(["<5", "5-50", OTHER_OPTION, NO_PREFERENCE]);
		const panelPrompt = llm.calls.find((c) => c.request.tools?.[0]?.name === "submit_pathways")!.prompt;
		expect(panelPrompt).toMatch(/Ops capacity\? → No ops staff at all/);

		// Map input is the compact structure, and full proposals are on disk.
		const mapPromptText = llm.calls.find((c) => c.request.tools?.[0]?.name === "submit_map")!.prompt;
		expect(mapPromptText).toMatch(/\[a:c1\] \(factual, 0.8\) claim a/);
		expect(JSON.parse(readFileSync(join(cwd, report.proposals[0].artifact!), "utf8")).panelist).toBe("a");

		// Each dispute kind reached its resolver.
		const by = (topic: string) => report.resolutions.find((r) => report.map.disputes.find((d) => d.id === r.disputeId)?.topic === topic);
		expect(by("Write concurrency")).toMatchObject({ method: "evidence", sources: ["https://sqlite.org/wal.html"], artifact: ".npi/artifacts/run/001-researcher.md" });
		expect(by("Scaling path")).toMatchObject({ method: "cross-exam", winningPosition: 0 });
		expect(by("Ops budget")).toMatchObject({ method: "user", verdict: "Avoid servers" });
		expect(llm.calls.filter((c) => c.request.tools?.[0]?.name === "submit_ruling").every((c) => c.ref === "p/judge")).toBe(true);

		// Converge sees settled facts; recommendation given because clarity >= threshold.
		expect(llm.calls.find((c) => c.request.tools?.[0]?.name === "submit_convergence")!.prompt).toMatch(/Write concurrency: One writer at a time/);
		expect(report.recommended?.pathway).toBe("p1");
		expect(scorecard(report).find((s) => s.id === "a")).toEqual({ id: "a", disputes: 2, won: 2 });

		const md = renderReport(report);
		expect(md).toMatch(/## ✅ Recommendation: SQLite \+ Litestream/);
		expect(md).toMatch(/\| p1 \| \*\*SQLite \+ Litestream\*\* \| 0\.90 \| low \|/);
		const digest = renderDigest(report, "r.md");
		expect(digest.length).toBeLessThan(md.length / 2);
		expect(digest).toMatch(/Full report .*: r\.md/);
		expect(events.some((e) => e.type === "dispute" && e.status === "resolved")).toBe(true);
	});

	it("withholds the recommendation when the goal stays unclear, giving decision criteria instead", async () => {
		const llm = new FakeLlm(responder(0.3));
		const report = await runBrainstorm("db?", config, { llm });
		expect(report.directions).toEqual([]); // no UI: no questions asked
		expect(report.recommended).toBeUndefined();
		expect(renderReport(report)).toMatch(/No single recommendation yet[\s\S]*- write concurrency/);
		// No research runner: the factual dispute goes to the judge.
		expect(report.resolutions.find((r) => r.disputeId === "d1")?.method).toBe("judge");
	});

	it("uses the user's free-text explanation for context disputes via the judge", async () => {
		const llm = new FakeLlm(responder());
		const user = scriptedUser([NO_PREFERENCE, NO_PREFERENCE, EXPLAIN_OPTION], "We have no ops staff");
		const report = await runBrainstorm("db?", config, { llm, user: user.channel });
		const ops = report.resolutions.find((r) => report.map.disputes.find((d) => d.id === r.disputeId)?.topic === "Ops budget");
		expect(ops).toMatchObject({ method: "user", trail: ["The user (the person asking) says: We have no ops staff"] });
	});

	it("fills the panel with personas when only one model is available, and fails with none", async () => {
		const llm = new FakeLlm(responder());
		llm.unavailable.add("p/b").add("p/c");
		const report = await runBrainstorm("q", { ...config, fallbackPersonas: ["a skeptic"] }, { llm });
		expect(report.panel.map((p) => [p.id, p.model, p.persona])).toEqual([
			["a", "p/a", undefined],
			["a-alt1", "p/a", "a skeptic"],
		]);
		expect(report.skipped.some((s) => s.id === "diversity")).toBe(true);
		llm.unavailable.add("p/a");
		await expect(runBrainstorm("q", config, { llm })).rejects.toThrow(/Only 0 panelist/);
	});

	it("falls back to the next orchestrator model", async () => {
		const llm = new FakeLlm(responder());
		llm.unavailable.add("p/fable");
		const report = await runBrainstorm("q", config, { llm });
		expect(report.orchestrator).toBe("p/opus");
	});

	it("stops early on budget exhaustion but still ranks the pathways", async () => {
		const llm = new FakeLlm(responder());
		// $0.01 per call: frame + 3 panelists + map = $0.05 reaches the cap before resolution.
		const report = await runBrainstorm("q", { ...config, maxCostUSD: 0.05 }, { llm });
		expect(report.stoppedEarly).toMatch(/Budget exceeded/);
		expect(report.convergence.ranking).toHaveLength(3);
		expect(report.costUSD).toBeCloseTo(0.06);
	});

	it("resumes from checkpointed stages without re-calling models or re-asking the user", async () => {
		const file = join(mkdtempSync(join(tmpdir(), "rs-")), "state.json");
		const first = await runBrainstorm("db?", config, { llm: new FakeLlm(responder()), state: new RunState(file) });

		const broken = new FakeLlm(() => {
			throw new Error("models are down");
		});
		const again = await runBrainstorm("db?", config, { llm: broken, state: new RunState(file) });
		expect(broken.calls).toHaveLength(0);
		expect(again.recommended).toEqual(first.recommended);
		expect(again.resolutions.map((r) => r.disputeId).sort()).toEqual(first.resolutions.map((r) => r.disputeId).sort());
		expect(again.costUSD).toBe(0);
	});
});
