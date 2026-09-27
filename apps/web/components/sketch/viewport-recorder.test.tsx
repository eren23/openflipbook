import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ViewportRecorder from "./viewport-recorder";

const tracks = [{ stop: vi.fn() }];
const capture = vi.fn(() => ({ getTracks: () => tracks }));
let recorders: FakeRecorder[];
class FakeRecorder {
  static isTypeSupported = vi.fn((type: string) => type === "video/webm;codecs=vp9");
  state = "inactive";
  mimeType: string;
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  constructor(public stream: unknown, public options: MediaRecorderOptions) { this.mimeType = options.mimeType!; recorders.push(this); }
  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["encoded video"]) }); this.onstop?.(); });
}
const source = { captureStream: capture, dataset: {} as Record<string, string> };
const canvas = () => source as unknown as HTMLCanvasElement;
const boundary = {};
const start = () => fireEvent.click(screen.getByRole("button", { name: "Record viewport video" }));

beforeEach(() => {
  recorders = []; vi.clearAllMocks(); vi.useFakeTimers();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:recorded-video"), revokeObjectURL: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("ViewportRecorder", () => {
  it("records only the actual canvas stream and provides a silent video download", () => {
    render(<ViewportRecorder canvas={canvas} boundary={boundary} viewKey="orbit"/>);
    start();
    expect(capture).toHaveBeenCalledWith(30);
    expect(source.dataset.recording).toBe("true");
    expect(recorders[0]!.options).toEqual({ mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: 8_000_000 });
    expect(screen.getByRole("status").textContent).toBe("Recording");
    fireEvent.click(screen.getByRole("button", { name: "Stop viewport recording" }));
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(source.dataset.recording).toBeUndefined();
    expect(screen.getByRole("link", { name: "Download viewport video" }).getAttribute("download")).toMatch(/\.webm$/);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("stops at two minutes and releases its object URL on unmount", () => {
    const ui = render(<ViewportRecorder canvas={canvas} boundary={boundary} viewKey="walk"/>);
    start(); act(() => vi.advanceTimersByTime(120_000));
    expect(recorders[0]!.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Download viewport video" })).toBeTruthy();
    ui.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:recorded-video");
  });
  it("ends the current recording when geometry or mode changes", () => {
    const ui = render(<ViewportRecorder canvas={canvas} boundary={boundary} viewKey="orbit"/>);
    start(); ui.rerender(<ViewportRecorder canvas={canvas} boundary={boundary} viewKey="walk"/>);
    expect(recorders[0]!.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Download viewport video" })).toBeTruthy();
    start(); ui.rerender(<ViewportRecorder canvas={canvas} boundary={{}} viewKey="walk"/>);
    expect(recorders[1]!.stop).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:recorded-video");
  });
  it("does not create a stream before rendering or without an encoder", () => {
    const ui = render(<ViewportRecorder canvas={() => null} boundary={boundary} viewKey="orbit"/>);
    start(); expect(screen.getByRole("alert").textContent).toContain("finish loading"); expect(capture).not.toHaveBeenCalled();
    vi.stubGlobal("MediaRecorder", undefined);
    ui.rerender(<ViewportRecorder canvas={canvas} boundary={boundary} viewKey="orbit"/>);
    start(); expect(screen.getByRole("alert").textContent).toContain("unavailable"); expect(capture).not.toHaveBeenCalled();
  });
  it("releases recording tracks and ignores late output after unmount", () => {
    const ui = render(<ViewportRecorder canvas={canvas} boundary={boundary} viewKey="orbit"/>);
    start(); ui.unmount();
    expect(tracks[0]!.stop).toHaveBeenCalledOnce(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops without replacing the download when the encoder fails", () => {
    render(<ViewportRecorder canvas={canvas} boundary={boundary} viewKey="orbit"/>);
    start(); act(() => recorders[0]!.onerror?.());
    expect(tracks[0]!.stop).toHaveBeenCalledOnce(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Recording failed");
  });
});
