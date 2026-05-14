import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useStyleGalleryDismissed } from "./useStyleGalleryDismissed";

const SESSION = "test-dismiss-session";
const KEY = `openflipbook.styleGallery.dismissed.${SESSION}`;

afterEach(() => {
  window.sessionStorage.clear();
});

describe("useStyleGalleryDismissed", () => {
  it("starts not-dismissed on a fresh session", async () => {
    const { result } = renderHook(() => useStyleGalleryDismissed(SESSION));
    await waitFor(() => expect(result.current[0]).toBe(false));
  });

  it("dismiss() flips state and writes to localStorage", async () => {
    const { result } = renderHook(() => useStyleGalleryDismissed(SESSION));
    await waitFor(() => expect(result.current[0]).toBe(false));
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    expect(window.sessionStorage.getItem(KEY)).toBe("1");
  });

  it("a dismiss recorded earlier in the same browser session survives remount", async () => {
    window.sessionStorage.setItem(KEY, "1");
    const { result } = renderHook(() => useStyleGalleryDismissed(SESSION));
    await waitFor(() => expect(result.current[0]).toBe(true));
  });

  it("switching to a different sessionId resets the flag", async () => {
    window.sessionStorage.setItem(KEY, "1");
    const { result, rerender } = renderHook(
      ({ id }) => useStyleGalleryDismissed(id),
      { initialProps: { id: SESSION } },
    );
    await waitFor(() => expect(result.current[0]).toBe(true));
    rerender({ id: "other-session" });
    await waitFor(() => expect(result.current[0]).toBe(false));
  });
});
