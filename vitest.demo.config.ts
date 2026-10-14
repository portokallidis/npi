import { defineConfig } from "vitest/config";

// Live demos against real models (see test/demos/README.md). One at a time, verbose output.
export default defineConfig({
	test: {
		include: ["test/demos/**/*.demo.test.ts"],
		globalSetup: ["test/demos/global-setup.ts"],
		testTimeout: 30 * 60_000,
		hookTimeout: 120_000,
		fileParallelism: false,
		reporters: ["verbose"],
		silent: false,
	},
});
