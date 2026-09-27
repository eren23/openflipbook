/* eslint-disable @typescript-eslint/no-explicit-any -- schemaless test doubles (in-memory Mongo rows, page JSON) */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { blankSketch } from "@/lib/sketch-types";
const state = vi.hoisted(() => ({
  doc: null as any,
  candidates: [] as any[],
  downloads: [] as string[],
  fail: false,
}));
vi.mock("next/dynamic", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    default: () =>
      forwardRef(function Canvas(props: any, ref) {
        useImperativeHandle(ref, () => ({
          export: async () => ({
            guide: "data:image/png;base64,YQ==",
            mask: "data:image/png;base64,YQ==",
          }),
        }));
        return (
          <button
            onClick={() =>
              props.onChange({
                elements: [
                  {
                    id: "shape",
                    type: "rectangle",
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                  },
                ],
                files: {},
              })
            }
          >
            Test stroke
          </button>
        );
      }),
  };
});
vi.mock("@/lib/sketch-files", () => ({
  download: (_blob: Blob, name: string) => state.downloads.push(name),
  fileData: async () => "data:image/png;base64,YQ==",
  imageSize: async () => ({ width: 1024, height: 1024 }),
  exportBundle: async () => new Blob(["bundle"]),
  importSketch: async () => ({ state: blankSketch() }),
}));
import SketchWorkspace from "./sketch-workspace";
const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status });
beforeEach(() => {
  window.history.replaceState({}, "", "/sketch");
  state.doc = null;
  state.candidates = [];
  state.downloads = [];
  state.fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (state.fail) return json({ error: "Storage unavailable" }, 503);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url === "/api/generate-page") {
        const c = {
          id: "candidate",
          draft_id: "draft",
          revision: state.doc.revision,
          model: "flare",
          status: "ready",
          image_url: "http://images/candidate.png",
          mock: true,
          matches_draft: true,
          outside_changed: 0,
          workflow: state.doc.state.workflow ?? "render",
        };
        state.candidates = [c];
        return json({ candidate: c });
      }
      if (url.endsWith("/accept")) {
        state.candidates[0].saved_node_id = "saved";
        return json({ node_id: "saved" });
      }
      if (url.endsWith("/discard")) {
        state.candidates = [];
        return json({ discarded: true });
      }
      if (url.endsWith("/restore")) return json({ sketch: state.doc });
      if (
        url.endsWith("/source") ||
        url.startsWith("/api/image/") ||
        url.startsWith("data:") ||
        url.startsWith("http://images")
      )
        return new Response("image");
      if (init?.method === "DELETE") return json({ deleted: true });
      if (url === "/api/sketches" && !init?.method)
        return json({ sketches: state.doc ? [state.doc] : [] });
      if (init?.method === "POST" || init?.method === "PUT")
        state.doc = {
          id: "draft",
          session_id: "world",
          revision: (state.doc?.revision ?? 0) + 1,
          state: body.state,
          source_url:
            body.source_data_url || body.source_node_id
              ? "http://images/source"
              : (state.doc?.source_url ?? null),
          source_node_id: body.source_node_id ?? null,
          updated_at: new Date().toISOString(),
        };
      return json({ sketch: state.doc, candidates: state.candidates });
    }),
  );
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function ready() {
  render(<SketchWorkspace />);
  await act(async () => {});
}
it("opens the illustrated street as a native editable source without generating", async () => {
  window.history.replaceState({}, "", "/sketch?example=drum");
  await ready();
  await waitFor(() => expect((screen.getByLabelText("Sketch title") as HTMLInputElement).value).toBe("The Mended Drum / roof material"));
  expect((screen.getByLabelText("Image model") as HTMLSelectElement).value).toBe("nano");
  expect((screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement).disabled).toBe(false);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/generate-page")).toBe(false);
});
it("rejects an unknown example without importing arbitrary URLs", async () => {
  window.history.replaceState({}, "", "/sketch?example=https://example.com/image.png");
  await ready();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unknown sketch example"));
  expect(fetch).not.toHaveBeenCalled();
});
async function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  await act(async () => {});
}
it("keeps the user's idea while selecting finished designs and material variants", async () => {
  await ready();
  fireEvent.change(screen.getByLabelText("Your idea"), {
    target: { value: "Wing chair with red trim" },
  });
  fireEvent.change(screen.getByLabelText("Finish as"), {
    target: { value: "object" },
  });
  fireEvent.change(screen.getByLabelText("Workflow"), {
    target: { value: "material" },
  });
  fireEvent.change(screen.getByLabelText("Material"), {
    target: { value: "ceramic" },
  });
  await click("Save drawing");
  expect(state.doc.state).toMatchObject({
    prompt: "Wing chair with red trim",
    workflow: "material",
    material: "ceramic",
    output: "object",
  });
});
it("requires explicit whole-image scope for alternate views and labels the result", async () => {
  window.history.replaceState({}, "", "/sketch?source=original");
  await ready();
  await screen.findByRole("heading", { name: "Draw a correction" });
  fireEvent.change(screen.getByLabelText("Workflow"), {
    target: { value: "viewpoint" },
  });
  fireEvent.change(screen.getByLabelText("Proposed view"), {
    target: { value: "front" },
  });
  await click("Generate");
  expect(screen.getByRole("alert").textContent).toContain("whole-image");
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/generate-page"),
  ).toHaveLength(0);
  await click("Whole image");
  await click("Generate");
  expect(screen.getByText("Proposed view · Geometry unverified")).toBeTruthy();
  expect(state.doc.state.viewpoint).toBe("front");
});
it("requires a distinct object reference for placement", async () => {
  window.history.replaceState({}, "", "/sketch?source=original");
  await ready();
  await screen.findByRole("heading", { name: "Draw a correction" });
  fireEvent.change(screen.getByLabelText("Workflow"), {
    target: { value: "placement" },
  });
  await click("Generate");
  expect(screen.getByRole("alert").textContent).toContain("object reference");
  fireEvent.change(screen.getByLabelText("Object reference file"), {
    target: {
      files: [new File(["object"], "chair.png", { type: "image/png" })],
    },
  });
  await screen.findByAltText("Object reference");
  await click("Generate");
  expect(state.doc.state.subject_data_url).toBeTruthy();
  expect(state.doc.state.style_data_url).toBeUndefined();
});
it("draws, saves, exports, generates a private preview and explicitly keeps it", async () => {
  await ready();
  fireEvent.change(screen.getByLabelText("Sketch title"), {
    target: { value: "Harbor" },
  });
  fireEvent.change(screen.getByLabelText("Your idea"), {
    target: { value: "A lighthouse" },
  });
  await click("Test stroke");
  await click("Save drawing");
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved"),
  );
  for (const name of ["Scene", "PNG", "Bundle"]) await click(name);
  expect(state.downloads).toEqual([
    "Harbor.excalidraw",
    "Harbor.png",
    "Harbor.ofb-sketch",
  ]);
  await click("Generate");
  const image = screen.getByAltText("Generated candidate");
  Object.defineProperty(image, "naturalWidth", { value: 1024 });
  fireEvent.load(image);
  expect(screen.getByText("Mock result")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Keep Version" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  await click("Keep Version");
  expect(
    screen.getByRole("link", { name: "Open in World" }).getAttribute("href"),
  ).toContain("node=saved");
  await click("PNG");
  expect(state.downloads).toHaveLength(4);
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/generate-page"),
  ).toHaveLength(1);
});
it("imports corrections, updates scope, references and models, then discards a preview", async () => {
  await ready();
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: {
      files: [new File(["image"], "Harbor.png", { type: "image/png" })],
    },
  });
  await screen.findByRole("heading", { name: "Draw a correction" });
  await click("Whole image");
  await click("Selected area");
  fireEvent.change(screen.getByLabelText("Image model"), {
    target: { value: "nano" },
  });
  fireEvent.change(screen.getByLabelText("Style reference file"), {
    target: {
      files: [new File(["style"], "style.png", { type: "image/png" })],
    },
  });
  await act(async () => {});
  await click("Generate");
  fireEvent.change(screen.getByLabelText("Before and after comparison"), {
    target: { value: "75" },
  });
  await click("Discard candidate");
  expect(screen.queryByRole("button", { name: "Keep Version" })).toBeNull();
  expect(state.candidates).toHaveLength(0);
});
it("opens the library, reloads a saved draft, deletes it and recovers from save errors", async () => {
  await ready();
  await click("Save drawing");
  await click("Open sketches");
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Untitled sketch / }));
  await act(async () => {});
  await click("Open sketches");
  await click("Delete Untitled sketch");
  await click("Close sketches");
  state.fail = true;
  fireEvent.change(screen.getByLabelText("Your idea"), {
    target: { value: "Unsaved idea" },
  });
  await click("Save drawing");
  expect(screen.getByRole("alert").textContent).toContain(
    "Storage unavailable",
  );
  state.fail = false;
  await click("Dismiss error");
  await click("New sketch");
  expect(
    (screen.getByLabelText("Your idea") as HTMLTextAreaElement).value,
  ).toBe("");
});
it("loads a source-node correction without publishing or generating", async () => {
  window.history.replaceState({}, "", "/sketch?source=source-node");
  await ready();
  await screen.findByRole("heading", { name: "Draw a correction" });
  expect(state.doc.source_node_id).toBe("source-node");
  expect(
    vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/generate-page"),
  ).toBe(false);
});
