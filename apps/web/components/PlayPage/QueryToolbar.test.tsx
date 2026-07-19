// The main toolbar: submit gating, the upload proxy click, and the setter
// wiring for locale / theme / tier / world-mode cluster. Renders with the
// real English strings so labels match what users see.
import { createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { getStrings } from "@/lib/i18n";

import { QueryToolbar } from "./QueryToolbar";

const t = getStrings("en");

type Props = Parameters<typeof QueryToolbar>[0];

function makeProps(over: Partial<Props> = {}): Props {
  return {
    t,
    input: "",
    onInputChange: vi.fn(),
    onSubmit: vi.fn((e) => e.preventDefault()),
    fileInputRef: createRef<HTMLInputElement | null>(),
    onFileInputChange: vi.fn(),
    busy: false,
    outputLocale: "auto",
    setOutputLocale: vi.fn(),
    theme: "light",
    setTheme: vi.fn(),
    imageTier: "balanced",
    setImageTier: vi.fn(),
    loopKnobs: { maxAttempts: 2, verify: true },
    setLoopKnobs: vi.fn(),
    sessionSpend: null,
    devModel: null,
    setDevModel: undefined,
    worldMode: false,
    setWorldMode: vi.fn(),
    autonomy: "auto",
    setAutonomy: vi.fn(),
    domLabels: false,
    setDomLabels: vi.fn(),
    ...over,
  };
}

describe("QueryToolbar", () => {
  it("types into the query box and submits", () => {
    const props = makeProps({ input: "volcanoes" });
    render(<QueryToolbar {...props} />);
    fireEvent.change(screen.getByPlaceholderText(t.placeholder), {
      target: { value: "volcanoes!" },
    });
    expect(props.onInputChange).toHaveBeenCalledWith("volcanoes!");
    fireEvent.click(screen.getByRole("button", { name: t.go }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("gates Go on non-blank input and busy", () => {
    const { rerender } = render(<QueryToolbar {...makeProps({ input: "   " })} />);
    const go = () => screen.getByRole("button", { name: t.go }) as HTMLButtonElement;
    expect(go().disabled).toBe(true); // whitespace-only doesn't count

    rerender(<QueryToolbar {...makeProps({ input: "ok" })} />);
    expect(go().disabled).toBe(false);

    rerender(<QueryToolbar {...makeProps({ input: "ok", busy: true })} />);
    // Busy: the submit shows the generating glyph and stays disabled.
    const busyBtn = screen.getByRole("button", { name: t.generating }) as HTMLButtonElement;
    expect(busyBtn.disabled).toBe(true);
  });

  it("the upload button proxies a click to the hidden file input", () => {
    const props = makeProps();
    render(<QueryToolbar {...props} />);
    const fileInput = props.fileInputRef.current!;
    const click = vi.spyOn(fileInput, "click");
    fireEvent.click(screen.getByRole("button", { name: t.upload }));
    expect(click).toHaveBeenCalledTimes(1);
    fireEvent.change(fileInput);
    expect(props.onFileInputChange).toHaveBeenCalledTimes(1);
  });

  it("changes the output locale", () => {
    const props = makeProps();
    render(<QueryToolbar {...props} />);
    fireEvent.change(screen.getByRole("combobox", { name: t.langLabel }), {
      target: { value: "fr" },
    });
    expect(props.setOutputLocale).toHaveBeenCalledWith("fr");
  });

  it("theme + tier segmented controls report presses and mark the active one", () => {
    const props = makeProps();
    render(<QueryToolbar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: t.themeSepia }));
    expect(props.setTheme).toHaveBeenCalledWith("sepia");
    const light = screen.getByRole("button", { name: t.themeLight });
    expect(light.getAttribute("aria-pressed")).toBe("true");

    // Scoped: SpeedPreset renders its own tier words elsewhere in the bar.
    const tierGroup = within(screen.getByRole("group", { name: "Image quality tier" }));
    fireEvent.click(tierGroup.getByRole("button", { name: "pro" }));
    expect(props.setImageTier).toHaveBeenCalledWith("pro");
    const balanced = tierGroup.getByRole("button", { name: "balanced" });
    expect(balanced.getAttribute("aria-pressed")).toBe("true");
  });

  it("world mode OFF hides the autonomy + labels sub-toggles", () => {
    const props = makeProps();
    render(<QueryToolbar {...props} />);
    expect(screen.queryByRole("button", { name: "semi" })).toBeNull();
    expect(screen.queryByRole("button", { name: "labels" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "world" }));
    expect(props.setWorldMode).toHaveBeenCalledWith(true);
  });

  it("world mode ON exposes autonomy + DOM-labels toggles and flips them", () => {
    const props = makeProps({ worldMode: true, autonomy: "auto", domLabels: false });
    render(<QueryToolbar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "semi" }));
    expect(props.setAutonomy).toHaveBeenCalledWith("semi");
    fireEvent.click(screen.getByRole("button", { name: "labels" }));
    expect(props.setDomLabels).toHaveBeenCalledWith(true);
    // The world button toggles back off from the same cluster.
    fireEvent.click(screen.getByRole("button", { name: "world" }));
    expect(props.setWorldMode).toHaveBeenCalledWith(false);
  });
});
