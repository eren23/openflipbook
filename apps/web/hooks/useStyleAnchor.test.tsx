import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { isPresetAnchor, presetNodeId, STYLE_PRESETS } from "@/lib/styles";

import { useStyleAnchor } from "./useStyleAnchor";

const SESSION = "test-session-x";

function key(): string {
  return `openflipbook.styleAnchor.${SESSION}`;
}

afterEach(() => {
  window.localStorage.clear();
});

describe("useStyleAnchor.setFromPreset", () => {
  it("stores a synthetic anchor with the preset's prompt fragment", async () => {
    const { result } = renderHook(() => useStyleAnchor(SESSION));
    await waitFor(() => expect(result.current.anchor).toBeNull());

    act(() => result.current.setFromPreset("woodcut"));

    const a = result.current.anchor;
    expect(a).not.toBeNull();
    expect(a!.nodeId).toBe(presetNodeId("woodcut"));
    const woodcut = STYLE_PRESETS.find((p) => p.id === "woodcut");
    expect(a!.style).toBe(woodcut!.promptFragment);
  });

  it("persists the preset choice across remounts", async () => {
    const first = renderHook(() => useStyleAnchor(SESSION));
    await waitFor(() => expect(first.result.current.anchor).toBeNull());
    act(() => first.result.current.setFromPreset("cyberpunk"));

    const raw = window.localStorage.getItem(key());
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.nodeId).toBe(presetNodeId("cyberpunk"));

    first.unmount();

    const second = renderHook(() => useStyleAnchor(SESSION));
    await waitFor(() => expect(second.result.current.anchor).not.toBeNull());
    expect(second.result.current.anchor!.nodeId).toBe(presetNodeId("cyberpunk"));
  });

  it("setFromPreset with an unknown id is a no-op", async () => {
    const { result } = renderHook(() => useStyleAnchor(SESSION));
    await waitFor(() => expect(result.current.anchor).toBeNull());

    act(() => result.current.setFromPreset("does-not-exist"));

    expect(result.current.anchor).toBeNull();
    expect(window.localStorage.getItem(key())).toBeNull();
  });

  it("isPresetAnchor identifies preset-backed anchors", () => {
    expect(isPresetAnchor(presetNodeId("noir"))).toBe(true);
    expect(isPresetAnchor("4a9c1b2e-1234-...")).toBe(false);
  });
});
