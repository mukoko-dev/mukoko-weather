import { defineConfig } from "vitest/config";

// Own config: without it vitest finds the app's vitest.config.ts above this
// directory. The logic under test has no Worker runtime in it.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
