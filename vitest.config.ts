import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		cache: false,
		environment: "node",
		fileParallelism: false,
		maxWorkers: 1,
		pool: "forks",
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
		},
	},
});
