// The ⌘-click hint bubble: anchored at the click point, focused on open,
// Enter/↵ submits trimmed+capped text, Esc (key or button) cancels.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HintPrompt } from "./HintPrompt";

type Props = Parameters<typeof HintPrompt>[0];

function mount(over: Partial<Pick<Props, "xPx" | "yPx" | "placeholder">> = {}) {
  const props = {
    xPx: 120,
    yPx: 80,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  const view = render(<HintPrompt {...props} />);
  return {
    props,
    view,
    input: within(view.container).getByLabelText("Click hint") as HTMLInputElement,
  };
}

describe("HintPrompt", () => {
  it("anchors above the click point and focuses the input on open", () => {
    const { view, input } = mount();
    const bubble = view.container.firstElementChild as HTMLElement;
    expect(bubble.style.left).toBe("120px");
    expect(bubble.style.top).toBe("68px"); // yPx - 12
    expect(document.activeElement).toBe(input);
  });

  it("clamps the anchor to the top edge (no off-screen bubble)", () => {
    const { view } = mount({ yPx: 4 });
    const bubble = view.container.firstElementChild as HTMLElement;
    expect(bubble.style.top).toBe("0px");
  });

  it("submits the trimmed text on Enter (form submit)", () => {
    const { props, input } = mount();
    fireEvent.change(input, { target: { value: "  cross-section  " } });
    fireEvent.submit(input.closest("form")!);
    expect(props.onSubmit).toHaveBeenCalledWith("cross-section");
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("the ↵ button is a submit control, and overlong hints are capped at 240 chars", () => {
    const { props, input } = mount();
    // happy-dom doesn't synthesize implicit form submission from a button
    // click, so pin the wiring (type=submit) and drive the same path.
    const enter = screen.getByRole("button", { name: "Submit hint" });
    expect(enter.getAttribute("type")).toBe("submit");
    fireEvent.change(input, { target: { value: "x".repeat(300) } });
    fireEvent.submit(input.closest("form")!);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect((props.onSubmit.mock.calls[0]![0] as string).length).toBe(240);
  });

  it("Escape cancels without submitting", () => {
    const { props, input } = mount();
    fireEvent.change(input, { target: { value: "half a thought" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("the esc button cancels", () => {
    const { props } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("uses the resolver's clarifying question as placeholder when given", () => {
    const { input } = mount({ placeholder: "Enter the lighthouse?" });
    expect(input.placeholder).toBe("Enter the lighthouse?");
    // …and the default placeholder otherwise.
    const { input: plain } = mount();
    expect(plain.placeholder).toContain("add a note");
  });
});
