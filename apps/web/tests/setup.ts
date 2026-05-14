/**
 * Vitest global setup. happy-dom + jsdom both emit a non-Storage object as
 * `window.localStorage` in this stack (vitest 2.1 + React 19), so we install
 * a real in-memory Storage shim before each test file. Behavior matches the
 * spec closely enough for our hooks (set / get / remove / clear / length).
 *
 * Also wires the @testing-library/react auto-cleanup between tests — needed
 * because we set `globals: false` in vitest.config, which disables the
 * library's own implicit afterEach hook.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

if (!(globalThis as { __ofbStorageInstalled?: boolean }).__ofbStorageInstalled) {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
  (globalThis as { __ofbStorageInstalled?: boolean }).__ofbStorageInstalled = true;
}
