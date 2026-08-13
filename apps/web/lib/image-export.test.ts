import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadBlob, ensureSvgXmlns } from "./image-export";

describe("ensureSvgXmlns", () => {
  it("injects the xmlns when a serialized SVG lacks it", () => {
    expect(ensureSvgXmlns('<svg width="10"><rect /></svg>')).toContain(
      'xmlns="http://www.w3.org/2000/svg"',
    );
  });

  it("is idempotent — never adds a second xmlns", () => {
    const already = '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>';
    expect(ensureSvgXmlns(already)).toBe(already);
  });
});

describe("downloadBlob", () => {
  beforeEach(() => {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
      () => "blob:stub",
    );
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.useRealTimers());

  it("clicks an anchor for the blob then revokes the url", () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    vi.useFakeTimers();
    downloadBlob(new Blob(["x"]), "map.png");
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:stub");
    click.mockRestore();
  });
});
