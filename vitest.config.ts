import { defineConfig } from "vitest/config";

// Unit + integration tests. Demos (real models, slow) run separately: `npm run demo`.
export default defineConfig({
	test: { exclude: ["**/node_modules/**", "test/demos/**"] },
});
