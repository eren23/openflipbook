import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const HERE = resolve(fileURLToPath(import.meta.url), "..");

export default defineConfig({
  resolve: {
    // Mirror tsconfig "paths" so component/hook imports under @/ resolve in tests.
    alias: { "@": HERE },
  },
  test: {
    // happy-dom over jsdom: faster cold-start, and jsdom's localStorage in
    // this stack came back as a bare {} (no Storage prototype methods).
    environment: "happy-dom",
    include: ["lib/**/*.test.ts", "hooks/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["lib/**/*.ts", "hooks/**/*.ts"],
      exclude: ["**/*.test.{ts,tsx}"],
    },
  },
});
