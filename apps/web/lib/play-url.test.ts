import { expect, it } from "vitest";
import { playNodeUrl } from "./play-url";

it("retains the exact session and node in an explorer URL", () => {
  const url = new URL(playNodeUrl("world & one", "node/two"), "https://example.test");
  expect(url.pathname).toBe("/play");
  expect(url.searchParams.get("continue")).toBe("world & one");
  expect(url.searchParams.get("node")).toBe("node/two");
});
