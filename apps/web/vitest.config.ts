import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const HERE = resolve(fileURLToPath(import.meta.url), "..");

export default defineConfig({
  resolve: {
    // Mirror tsconfig "paths" so component/hook imports under @/ resolve in tests.
    alias: { "@": HERE },
  },
  // tsconfig uses `jsx: "preserve"` so Next.js can run its own transform.
  // Vitest goes through esbuild, which needs to be told to use the modern
  // automatic runtime — otherwise JSX compiles to bare React.createElement
  // calls with no React import in scope.
  esbuild: { jsx: "automatic" },
  test: {
    // happy-dom over jsdom: faster cold-start, and jsdom's localStorage in
    // this stack came back as a bare {} (no Storage prototype methods).
    environment: "happy-dom",
    include: [
      "lib/**/*.test.{ts,tsx}",
      "hooks/**/*.test.{ts,tsx}",
      "tests/**/*.test.{ts,tsx}",
    ],
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["lib/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}"],
    },
  },
});
