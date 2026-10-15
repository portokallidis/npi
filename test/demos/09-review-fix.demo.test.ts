// Demo 9 — Review then fix (slow-ish). A throwaway git repo gets a "refactor" commit that breaks a discount
// calculation. The read-only `reviewer` must spot it; the `coder` fixes it in its own git worktree and branch;
// the test is then run in that worktree to prove the fix. The main checkout is never touched.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { agents, banner, bench, demo, makeRunner, ms, recordAgent } from "./common.ts";

function buggyRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "npi-shop-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
	writeFileSync(join(dir, ".gitignore"), ".npi/\n");
	writeFileSync(
		join(dir, "test.js"),
		`import assert from "node:assert";\nimport { applyDiscount, total } from "./src/cart.js";\nassert.equal(total([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25);\nassert.equal(applyDiscount(100, 15), 85);\nassert.equal(applyDiscount(19.99, 10), 17.99);\nconsole.log("all tests passed");\n`,
	);
	const good = `export function total(items) {\n\treturn items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n\n/** pct is a percentage, e.g. 15 for 15% off. */\nexport function applyDiscount(amount, pct) {\n\treturn Math.round(amount * (1 - pct / 100) * 100) / 100;\n}\n`;
	writeFileSync(join(dir, "src", "cart.js"), good);
	git("init", "-q");
	git("config", "user.email", "demo@example.com");
	git("config", "user.name", "demo");
	git("add", "-A");
	git("commit", "-qm", "cart: totals and discounts");
	// The "refactor" that breaks it: drops the /100 and the rounding.
	writeFileSync(join(dir, "src", "cart.js"), good.replace("return Math.round(amount * (1 - pct / 100) * 100) / 100;", "return amount * (1 - pct); // simplified"));
	git("commit", "-qam", "refactor: simplify discount");
	return dir;
}

it("review finds the bug, coder fixes it in a worktree, tests pass", (t) =>
	bench.run("review + fix", async (metrics) => {
		const { llm } = await demo();
		const defs = await agents();
		const reviewer = defs.get("reviewer")!;
		const coder = defs.get("coder")!;
		const reviewerModel = (await llm.available("local/large")) ? "local/large" : "local/small";
		if (!(await llm.available(reviewerModel))) return t.skip();
		const repo = buggyRepo();
		const runner = await makeRunner(repo, { contextTokens: 60_000, summaryTokens: 500 });

		const s1 = Date.now();
		const review = await runner.run({ agent: reviewer, model: reviewerModel, task: "Review the last commit: git diff HEAD~1 HEAD. Run node test.js to check behaviour.", policy: { level: "readonly", sandboxed: false } });
		await recordAgent("reviewer", review, Date.now() - s1);
		const reviewMs = Date.now() - s1;
		const caught = /discount|pct|percent|100/i.test(review.text) && /cart\.js/.test(review.text);

		const s2 = Date.now();
		const fix = await runner.run({
			agent: coder,
			model: reviewerModel,
			task: "`node test.js` fails after the last commit. Fix the bug in src/cart.js so all tests pass. Do not edit test.js. Run node test.js to verify.",
			policy: { level: "ask", sandboxed: false },
		});
		await recordAgent("coder", fix, Date.now() - s2);
		const fixMs = Date.now() - s2;

		const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo }).toString();
		const worktree = worktrees.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).find((p) => p.includes(".npi"));
		let passed = false;
		let testOut = "";
		try {
			testOut = execFileSync("node", ["test.js"], { cwd: worktree ?? repo }).toString();
			passed = /all tests passed/.test(testOut);
		} catch (error) {
			testOut = String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 300);
		}
		const mainStillBroken = (() => {
			try {
				execFileSync("node", ["test.js"], { cwd: repo });
				return false;
			} catch {
				return true;
			}
		})();

		Object.assign(metrics, {
			model: reviewerModel,
			"review caught bug": caught ? "yes" : "no",
			"review s": (reviewMs / 1000).toFixed(1),
			"fix s": (fixMs / 1000).toFixed(1),
			"tests pass in worktree": passed ? "yes" : "no",
			"main checkout untouched": mainStillBroken ? "yes" : "no",
		});
		banner(`Review + fix on ${reviewerModel} in ${ms(s1)}`, [
			`— reviewer (${(reviewMs / 1000).toFixed(1)}s, ${review.usage.turns} turns)`,
			review.text,
			"",
			`— coder (${(fixMs / 1000).toFixed(1)}s, ${fix.usage.turns} turns)${fix.error ? ` error: ${fix.error}` : ""}`,
			fix.text,
			"",
			`node test.js in worktree: ${passed ? "PASS" : "FAIL"} ${testOut.trim().slice(0, 200)}`,
			`main checkout still has the bug (untouched): ${mainStillBroken}`,
		]);
		expect(caught).toBe(true);
		expect(passed).toBe(true);
		expect(mainStillBroken).toBe(true);
	}));
