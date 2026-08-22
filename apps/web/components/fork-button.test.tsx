import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ForkButton from "./fork-button";

afterEach(() => vi.unstubAllGlobals());

describe("ForkButton", () => {
  it("posts the fork and opens the new session live", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ session_id: "session_fork" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const loc = { href: "" };
    vi.stubGlobal("location", loc);

    render(<ForkButton sessionId="session_src" nodeId="n1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fork this world" }));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session_src/fork",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ node_id: "n1" }),
      })
    );
    expect(loc.href).toBe("/play?continue=session_fork");
  });

  it("a failed fork surfaces retry copy instead of navigating", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    const loc = { href: "" };
    vi.stubGlobal("location", loc);

    render(<ForkButton sessionId="session_src" nodeId="n1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fork this world" }));
    });
    expect(screen.getByRole("button", { name: "fork failed — retry" })).toBeTruthy();
    expect(loc.href).toBe("");
  });
});
