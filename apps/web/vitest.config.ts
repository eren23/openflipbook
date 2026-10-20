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
  // Vitest goes through esbuild, which needs the modern automatic runtime
  // or JSX compiles to bare React.createElement with no React import.
  esbuild: { jsx: "automatic" },
  test: {
    // happy-dom over jsdom: faster cold-start, and jsdom's localStorage in
    // this stack came back as a bare {} (no Storage prototype methods).
    environment: "happy-dom",
    include: [
      "lib/**/*.test.{ts,tsx}",
      "hooks/**/*.test.{ts,tsx}",
      "components/**/*.test.{ts,tsx}",
      "tests/**/*.test.{ts,tsx}",
    ],
    globals: false,
    // Each fork reuses one module graph and one happy-dom window for all its test files. This makes
    // the suite about 2.5x faster (Mac 21 s, was 50 s; gVisor 106 s, was 322 s). tests/setup.ts puts
    // back the env vars and globals that a file changes. Use vi.spyOn for DOM prototype members.
    // To find a leak between files, run with --isolate.
    isolate: false,
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["lib/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}"],
      // The RATCHET: floors pinned just under the measured baseline
      // (2026-10-20: lines/stmts 87.13, functions 85.63, branches 88.18). CI
      // runs vitest with --coverage so a PR that drops below any floor
      // FAILS; a PR that raises coverage bumps the floor to the new number.
      // Never lower these to make a PR pass — that defeats the ratchet.
      thresholds: {
        lines: 87,
        statements: 87,
        functions: 85,
        branches: 88,
      },
    },
  },
});
