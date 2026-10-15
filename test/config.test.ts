import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deepMerge, loadNpiConfig } from "../src/core/config.ts";

const emptyAgentDir = () => mkdtempSync(join(tmpdir(), "npi-agent-"));

describe("config overlays", () => {
	afterEach(() => {
		delete process.env.NPI_PROFILE;
	});

	it("merges objects, replaces arrays and deletes on null", () => {
		expect(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1, e: 2 }, { a: { c: [3] }, d: null, $comment: "x" })).toEqual({ a: { b: 1, c: [3] }, e: 2 });
	});

	it("loads the packaged config with every route and no profile", () => {
		const config = loadNpiConfig(emptyAgentDir());
		expect(config.profile).toBeUndefined();
		expect(Object.keys(config.routes)).toContain("science");
	});

	it("applies a packaged profile: removes routes and adds its prompt", () => {
		const config = loadNpiConfig(emptyAgentDir(), { profile: "dev" });
		expect(config.profile?.name).toBe("dev");
		expect(config.profile?.prompt).toMatch(/Profile: dev/);
		expect(config.routes.science).toBeUndefined();
		expect(config.routes.code).toBeDefined();
		process.env.NPI_PROFILE = "research";
		expect(loadNpiConfig(emptyAgentDir()).routes.browse).toBeUndefined();
	});

	it("ships valid dev, research and saas profiles with tier model lists", () => {
		for (const name of ["dev", "research", "saas"]) {
			const config = loadNpiConfig(emptyAgentDir(), { profile: name });
			expect(config.routes.code.tiers?.heavy?.length, name).toBeGreaterThan(0);
			expect(config.routes.code.models, name).toEqual(loadNpiConfig(emptyAgentDir()).routes.code.models);
		}
	});

	it("layers a user profile and a trusted project's .pi/npi.json", () => {
		const agentDir = emptyAgentDir();
		mkdirSync(join(agentDir, "profiles"));
		writeFileSync(join(agentDir, "profiles", "lab.json"), JSON.stringify({ description: "my lab", routes: { browse: null } }));
		const project = mkdtempSync(join(tmpdir(), "npi-proj-"));
		mkdirSync(join(project, ".pi"));
		writeFileSync(join(project, ".pi", "npi.json"), JSON.stringify({ profile: "lab", guard: { defaultPolicy: "readonly" } }));

		const config = loadNpiConfig(agentDir, { projectDir: project });
		expect(config.profile).toEqual({ name: "lab", description: "my lab" });
		expect(config.routes.browse).toBeUndefined();
		expect(config.guard.defaultPolicy).toBe("readonly");
		// Untrusted project: its file is ignored entirely.
		expect(loadNpiConfig(agentDir).guard.defaultPolicy).toBe("ask");
	});

	it("rejects unknown profiles and a removed default route", () => {
		expect(() => loadNpiConfig(emptyAgentDir(), { profile: "nope" })).toThrow(/Unknown profile/);
		const agentDir = emptyAgentDir();
		mkdirSync(join(agentDir, "profiles"));
		writeFileSync(join(agentDir, "profiles", "bad.json"), JSON.stringify({ routes: { chat: null } }));
		expect(() => loadNpiConfig(agentDir, { profile: "bad" })).toThrow(/defaultRoute "chat" is not a route/);
	});
});
