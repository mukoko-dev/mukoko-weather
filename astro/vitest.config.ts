import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
  },
  resolve: {
    alias: [
      { find: /^~\//, replacement: here("./src/") },
      { find: /^@\//, replacement: here("../src/") },
    ],
  },
});
