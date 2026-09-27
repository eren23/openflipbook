import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ForkButton from "./fork-button";

afterEach(() => vi.unstubAllGlobals());

describe("ForkButton", () => {
  it("does not carry an unresolved fork payload into a different source page", async () => {
    let lost = true;
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      if (url.includes("/fork") && lost) { lost = false; throw new Error("Lost response"); }
      return { ok: true, json: async () => ({ session_id: "new_copy" }) };
    });
    vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("location", { href: "" });
    const ui = render(<ForkButton sessionId="original" nodeId="n1"/>);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Fork this world" })));
    ui.rerender(<ForkButton sessionId="another" nodeId="n2"/>);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "fork failed — retry" })));
    const first = JSON.parse(fetchMock.mock.calls.find(([url]) => url === "/api/sessions/original/fork")![1]!.body as string);
    const second = JSON.parse(fetchMock.mock.calls.find(([url]) => url === "/api/sessions/another/fork")![1]!.body as string);
    expect(second.node_id).toBe("n2"); expect(second.request_id).not.toBe(first.request_id);
  });
  it("retries a lost acknowledgement with the same body after an identity handshake", async () => {
    let lost = true;
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      if (url.includes("/fork") && lost) { lost = false; throw new Error("Lost response"); }
      return { ok: true, json: async () => ({ session_id: "same_copy" }) };
    });
    vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("location", { href: "" });
    render(<ForkButton sessionId="session_src" nodeId="n1"/>);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Fork this world" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "fork failed — retry" })));
    const requests = fetchMock.mock.calls.filter(([url]) => url.includes("/fork"));
    expect(requests).toHaveLength(2); expect(requests[0]![1]!.body).toBe(requests[1]![1]!.body);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/creator/identity");
  });
  it("posts the fork and opens the new session live", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => ({
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
        body: expect.any(String),
      })
    );
    expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url.includes("/fork"))![1]!.body as string)).toMatchObject({ node_id: "n1", request_id: expect.any(String) });
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
