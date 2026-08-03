import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    cache: false,
    environment: "node",
    fileParallelism: false,
    include: ["{actions,agent,convex,src}/**/*.test.{ts,tsx}"],
    maxWorkers: 1,
    pool: "forks",
  },
});
