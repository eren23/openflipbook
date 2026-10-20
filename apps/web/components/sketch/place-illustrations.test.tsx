import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import PlaceIllustrations from "./place-illustrations";
import type { SavedPlaceView } from "@/lib/place-view";
vi.mock("./illustration-region-picker", () => ({ default: ({ onReady, onChange, onBrushChange, disabled }: { onReady(v: boolean): void; onChange(v: string[]): void; onBrushChange(v: unknown): void; disabled: boolean }) => <><button disabled={disabled} onClick={() => { onReady(true); onChange(["roof"]); }}>Select roof fixture</button><button disabled={disabled} onClick={() => { onReady(true); onChange(["roof"]); onBrushChange([{ operation: "paint", radius: 3, points: [[10, 10]] }]); }}>Paint fixture</button></> }));
// happy-dom 20 reports every <img> complete at once. An uncached image in a
// browser is not, and these tests fire its load event themselves.
const complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
const fetcher = vi.fn();
const view = { id: "view", width: 400, height: 300, historical: false } as SavedPlaceView;
let library: { jobs: unknown[]; assets: unknown[]; historical: boolean; accepted_id: string | null; capabilities: { enabled: boolean; model: string; reservation: number; parameters: object }; region_capabilities?: { enabled: boolean; model: string; reservation: number; parameters: object; brush_enabled?: boolean } };
beforeEach(() => {
  library = { jobs: [], assets: [], historical: false, accepted_id: null, capabilities: { enabled: true, model: "fixture", reservation: 0.1, parameters: { fixture: true } } };
  fetcher.mockReset(); vi.stubGlobal("fetch", fetcher);
  fetcher.mockImplementation(async (_url, init) => Response.json(init?.method === "POST" ? { job: {} } : library));
});
const draw = (disabled = false) => render(<PlaceIllustrations sessionId="world" view={view} disabled={disabled}/>);
const writes = () => fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init.body);
it("notifies the walk quote only when the accepted artwork changes after an acknowledged review", async () => {
  const accepted=vi.fn();library.assets=[{id:"art",prompt:"Inked stone",accepted:false,historical:false}];
  fetcher.mockImplementation(async(_url,init)=>{
    if(init?.method==="POST"){library.accepted_id="art";library.assets=[{id:"art",prompt:"Inked stone",accepted:true,historical:false}];return Response.json({});}
    return Response.json(library);
  });
  render(<PlaceIllustrations sessionId="world" view={view} disabled={false} onAcceptedChange={accepted}/>);
  const image=await screen.findByRole("img",{name:"Generated camera illustration"});expect(accepted).not.toHaveBeenCalled();fireEvent.load(image);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Accept illustration"})).toHaveProperty("disabled",false));
  fireEvent.click(screen.getByRole("button",{name:"Accept illustration"}));await waitFor(()=>expect(accepted).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button",{name:"Refresh illustrations"}));await waitFor(()=>expect(fetcher.mock.calls.filter(([,init])=>!init?.method).length).toBe(3));
  expect(accepted).toHaveBeenCalledOnce();expect(writes()).toHaveLength(1);
});
it("shows saved source pixels in the workspace before artwork exists without submitting generation", async () => {
  const target = document.createElement("div");
  const ui = render(<PlaceIllustrations sessionId="world" view={view} disabled={false} surfaceTarget={target}/>); ui.container.appendChild(target);
  await screen.findByRole("img", { name: "Saved camera source render" });
  expect(target.textContent).toContain("No illustration selected"); expect(writes()).toEqual([]);
  fireEvent.change(screen.getByLabelText("Illustration appearance"), { target: { value: "Keep this draft" } });
  ui.rerender(<PlaceIllustrations sessionId="world" view={view} disabled={false}/>);
  expect(screen.getByLabelText("Illustration appearance")).toHaveProperty("value", "Keep this draft");
  expect(target.childElementCount).toBe(0); expect(writes()).toEqual([]);
});
it("reports unresolved generation requests to the camera library until their retry resolves", async () => {
  const onPendingChange = vi.fn(); let lost = true;
  fetcher.mockImplementation(async (_url, init) => { if (init?.method === "POST" && lost) { lost = false; throw new Error("Lost response"); } return Response.json(init?.method === "POST" ? {} : library); });
  render(<PlaceIllustrations sessionId="world" view={view} disabled={false} onPendingChange={onPendingChange}/>);
  await screen.findByRole("checkbox");
  fireEvent.change(screen.getByLabelText("Illustration appearance"), { target: { value: "Inked stone" } }); fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Generate illustration" })); await screen.findByText("Lost response");
  expect(onPendingChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry illustration request" }));
  await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(false)); expect(writes()[0]).toBe(writes()[1]);
});
it("previews a protected refresh from the predecessor, freezes retries and never accepts automatically", async () => {
  library.assets = [{ id: "art", prompt: "Current geometry", accepted: false, historical: false }];
  let lost = true;
  fetcher.mockImplementation(async (_url, init) => {
    if (init?.method !== "POST") return Response.json(library);
    if (lost) { lost = false; throw new Error("Lost refresh response"); }
    library.assets.push({ id: "refreshed", prompt: "Protected artwork", accepted: false, historical: false,
      geometry_refresh: { base_id: "previous_art", base_view: { view_id: "previous" }, changed_pixels: 25, protected_pixels: 119975 } });
    return Response.json({ id: "refreshed" });
  });
  render(<PlaceIllustrations sessionId="world" view={{ ...view, refreshed_from: "previous" }} previousView={{ ...view, id: "previous", historical: true, accepted_illustration_id: "previous_art" }} disabled={false}/>);
  const image = await screen.findByRole("img", { name: "Generated camera illustration" });
  expect(screen.getByRole("button", { name: "Preview protected refresh" })).toHaveProperty("disabled", true); fireEvent.load(image);
  await waitFor(() => expect(screen.getByRole("button", { name: "Preview protected refresh" })).toHaveProperty("disabled", false));
  expect(writes()).toEqual([]); fireEvent.click(screen.getByRole("button", { name: "Preview protected refresh" }));
  await screen.findByText("Lost refresh response"); fireEvent.click(screen.getByRole("button", { name: "Retry artwork refresh" }));
  await waitFor(() => expect(writes()).toHaveLength(2)); expect(writes()[0]).toBe(writes()[1]);
  expect(JSON.parse(writes()[0])).toMatchObject({ action: "compose_refresh", proposal_id: "art", base_id: "previous_art", previous_id: null });
  await screen.findByText("25 refreshed pixels / 119,975 protected pixels");
  fireEvent.click(screen.getByRole("button", { name: "Previous artwork" }));
  expect(screen.getByRole("img", { name: "Region edit previous artwork" }).getAttribute("src")).toContain("previous_art");
  expect(writes()).toHaveLength(2);
});
it("requires explicit appearance and budget consent without generating on reads", async () => {
  draw(); await screen.findByText("Reserve $0.10 for this illustration");
  const button = screen.getByRole("button", { name: "Generate illustration" });
  expect(button).toHaveProperty("disabled", true); fireEvent.change(screen.getByLabelText("Illustration appearance"), { target: { value: "Inked stone" } });
  expect(button).toHaveProperty("disabled", true); fireEvent.click(screen.getByRole("checkbox")); expect(button).toHaveProperty("disabled", false);
  expect(writes()).toEqual([]); fireEvent.click(button);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0])).toMatchObject({ action: "generate", prompt: "Inked stone", confirmed: true, reservation: 0.1, model: "fixture" });
});
it("retries the identical payload after a lost response", async () => {
  let lost = true;
  fetcher.mockImplementation(async (_url, init) => { if (init?.method === "POST" && lost) { lost = false; throw new Error("Lost response"); } return Response.json(init?.method === "POST" ? {} : library); });
  draw(); await screen.findByRole("checkbox");
  fireEvent.change(screen.getByLabelText("Illustration appearance"), { target: { value: "Inked stone" } }); fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Generate illustration" })); await screen.findByText("Lost response");
  expect(screen.getByLabelText("Illustration appearance")).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Retry illustration request" }));
  await waitFor(() => expect(writes()).toHaveLength(2)); expect(writes()[1]).toBe(writes()[0]);
});
it("blocks generation for unsaved or historical geometry", async () => {
  const ui = draw(true); await screen.findByRole("checkbox");
  fireEvent.change(screen.getByLabelText("Illustration appearance"), { target: { value: "Inked stone" } }); fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Generate illustration" })).toHaveProperty("disabled", true);
  ui.rerender(<PlaceIllustrations sessionId="world" view={{ ...view, historical: true }} disabled={false}/>);
  expect(screen.getByRole("button", { name: "Generate illustration" })).toHaveProperty("disabled", true); expect(writes()).toEqual([]);
});
it("counts a cached image as loaded, though next/image reports it before the reset effect runs", async () => {
  complete.mockReturnValue(true);
  try {
    library.assets = [{ id: "art", prompt: "Inked stone", accepted: false, historical: false }];
    draw(); await screen.findByRole("img", { name: "Generated camera illustration" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept illustration" })).toHaveProperty("disabled", false));
  } finally {
    complete.mockReturnValue(false);
  }
});
it("compares saved images read-only and requires loaded pixels before acceptance", async () => {
  library.assets = [{ id: "art", prompt: "Inked stone", accepted: false, historical: false }];
  draw(); const image = await screen.findByRole("img", { name: "Generated camera illustration" });
  expect(screen.getByRole("button", { name: "Accept illustration" })).toHaveProperty("disabled", true); fireEvent.load(image);
  fireEvent.click(screen.getByRole("button", { name: "Source render" })); await screen.findByRole("img", { name: "Illustration source geometry" });
  // next/image reports the load after an async decode(), so wait for the button instead of clicking at once.
  await waitFor(() => expect(screen.getByRole("button", { name: "Accept illustration" })).toHaveProperty("disabled", false));
  expect(writes()).toEqual([]); fireEvent.click(screen.getByRole("button", { name: "Accept illustration" }));
  await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0])).toEqual({ action: "accept", id: "art", previous_id: null });
});
it("overlays the exact source camera with adjustable opacity without mutations", async () => {
  library.assets = [{ id: "art", prompt: "Inked stone", accepted: false, historical: false }, { id: "other", prompt: "Second take", accepted: false, historical: false }];
  draw(); const image = await screen.findByRole("img", { name: "Generated camera illustration" });
  fireEvent.click(screen.getByRole("button", { name: "Overlay" }));
  const source = screen.getByRole("img", { name: "Illustration source geometry" });
  expect(new URL(source.getAttribute("src")!, "http://localhost:3000").pathname).toBe("/api/world/world/views/view/render");
  expect(source.style.opacity).toBe("0.5"); expect(image.style.visibility).toBe("visible");
  expect(source.parentElement).toBe(image.parentElement);
  expect(source.parentElement?.style.aspectRatio).toBe("400 / 300");
  const slider = screen.getByRole("slider", { name: "Source render opacity" });
  for (const value of [0, 100, 35]) {
    fireEvent.change(slider, { target: { value: String(value) } });
    expect(source.style.opacity).toBe(String(value / 100));
  }
  expect(screen.getByRole("button", { name: "Accept illustration" })).toHaveProperty("disabled", true);
  expect(writes()).toEqual([]);
  fireEvent.change(screen.getByLabelText("Saved illustration"), { target: { value: "other" } });
  expect(screen.queryByRole("slider")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Overlay" }));
  expect(screen.getByRole("slider")).toHaveProperty("value", "50");
  expect(writes()).toEqual([]);
});
it("keeps historical overlay inspection read-only and reports missing source pixels", async () => {
  library.assets = [{ id: "art", prompt: "Old image", accepted: false, historical: true }];
  const target = document.createElement("div");
  const ui = render(<PlaceIllustrations sessionId="world" view={{ ...view, historical: true }} disabled={false} surfaceTarget={target}/>);
  ui.container.appendChild(target);
  fireEvent.load(await screen.findByRole("img", { name: "Generated camera illustration" }));
  fireEvent.click(screen.getByRole("button", { name: "Overlay" }));
  const source = screen.getByRole("img", { name: "Illustration source geometry" });
  expect(target.contains(source)).toBe(true);
  fireEvent.error(source); await screen.findByText("Saved source render unavailable.");
  fireEvent.load(source); await waitFor(() => expect(screen.queryByText("Saved source render unavailable.")).toBeNull());
  expect(screen.getByRole("button", { name: "Accept illustration" })).toHaveProperty("disabled", true);
  expect(writes()).toEqual([]); ui.unmount(); expect(target.childElementCount).toBe(0);
});
it("keeps a comparison picked as soon as the image shows", async () => {
  // A slow CPU in miniature: each scheduler clock read jumps 10 ms, so React yields between the
  // commit and its effects. The click lands in that gap, where an effect used to reset the view.
  library.assets = [{ id: "art", prompt: "Old image", accepted: false, historical: true }];
  const real = performance.now.bind(performance); let skew = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => real() + (skew += 10));
  render(<PlaceIllustrations sessionId="world" view={{ ...view, historical: true }} disabled={false}/>);
  await new Promise<void>(resolve => { const observer = new MutationObserver(() => {
    const overlay = screen.queryByRole("button", { name: "Overlay" });
    if (overlay && screen.queryByRole("img", { name: "Generated camera illustration" })) { observer.disconnect(); fireEvent.click(overlay); resolve(); }
  }); observer.observe(document.body, { subtree: true, childList: true, attributes: true }); });
  clock.mockRestore(); await new Promise(resolve => setTimeout(resolve, 50));
  expect(screen.getByRole("button", { name: "Overlay" }).getAttribute("aria-pressed")).toBe("true");
});
it("rejects a malformed library response without crashing the camera panel", async () => {
  fetcher.mockResolvedValue(Response.json({ views: [] })); draw(); await screen.findByText("Invalid illustration library response");
  expect(screen.getByLabelText("Illustration appearance")).toHaveProperty("disabled", false); expect(writes()).toEqual([]);
});
it.each([false, true])("previews an explicitly selected edit, freezes retries and never auto-accepts (brush %s)", async brushed => {
  library.assets = [{ id: "art", prompt: "Inked stone", accepted: false, historical: false }, { id: "base", prompt: "Current artwork", accepted: true, historical: false }]; library.accepted_id = "base";
  let lost = true;
  fetcher.mockImplementation(async (_url, init) => {
    if (init?.method !== "POST") return Response.json(library);
    if (lost) { lost = false; throw new Error("Lost region response"); }
    library.assets.push({ id: "region_new", prompt: "Roof edit", accepted: false, historical: false, region_edit: { object_ids: ["roof"], protected_pixels: 100, base_id: "base" } });
    return Response.json({ id: "region_new" });
  });
  render(<PlaceIllustrations sessionId="world" view={{ ...view, objects: [{ object_id: "roof", rgb: [1, 2, 3] }] }} disabled={false}/>);
  await screen.findByLabelText("Saved illustration"); fireEvent.change(screen.getByLabelText("Saved illustration"), { target: { value: "art" } });
  await waitFor(() => expect(screen.getByRole("img", { name: "Generated camera illustration" }).getAttribute("src")).toContain("/illustrations/art"));
  fireEvent.load(await screen.findByRole("img", { name: "Generated camera illustration" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit selected objects" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Edit selected objects" }));
  expect(screen.getByRole("button", { name: "Preview selected edit" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: brushed ? "Paint fixture" : "Select roof fixture" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview selected edit" })); await screen.findByText("Lost region response");
  expect(screen.getByLabelText("Saved illustration")).toHaveProperty("disabled", true);
  expect(JSON.parse(writes()[0])).toMatchObject({ action: "compose", proposal_id: "art", base_id: "base", object_ids: ["roof"] });
  expect(JSON.parse(writes()[0]).brush_strokes).toEqual(brushed ? [{ operation: "paint", radius: 3, points: [[10, 10]] }] : undefined);
  fireEvent.click(screen.getByRole("button", { name: "Retry selected edit" }));
  await screen.findByRole("button", { name: "Previous artwork" }); expect(writes()[1]).toBe(writes()[0]); expect(writes()).toHaveLength(2);
  expect(screen.getByLabelText("Saved illustration")).toHaveProperty("value", "region_new");
  expect(screen.getByRole("button", { name: "Accept illustration" })).toHaveProperty("disabled", true);
  fireEvent.load(screen.getByRole("img", { name: "Generated camera illustration" }));
  fireEvent.click(screen.getByRole("button", { name: "Previous artwork" }));
  expect(screen.getByRole("img", { name: "Region edit previous artwork" }).getAttribute("src")).toContain("/illustrations/base");
});
it("keeps region selection unavailable for historical or dirty views", async () => {
  library.assets = [{ id: "art", prompt: "Inked stone", accepted: false, historical: false }];
  const current = { ...view, objects: [{ object_id: "roof", rgb: [1, 2, 3] as [number, number, number] }] };
  const ui = render(<PlaceIllustrations sessionId="world" view={current} disabled/>);
  fireEvent.load(await screen.findByRole("img", { name: "Generated camera illustration" }));
  expect(screen.getByRole("button", { name: "Edit selected objects" })).toHaveProperty("disabled", true);
  ui.rerender(<PlaceIllustrations sessionId="world" view={{ ...current, historical: true }} disabled={false}/>);
  expect(screen.getByRole("button", { name: "Edit selected objects" })).toHaveProperty("disabled", true); expect(writes()).toEqual([]);
});
it("requires separate masked intent and reservation, preserving the same payload on lost responses", async () => {
  library.assets = [{ id: "base", prompt: "Accepted painting", accepted: true, historical: false }]; library.accepted_id = "base";
  library.region_capabilities = { enabled: true, model: "masked-model", reservation: 0.2, parameters: { pinned: true } };
  let lost = true;
  fetcher.mockImplementation(async (_url, init) => { if (init?.method === "POST" && lost) { lost = false; throw new Error("Lost masked response"); } return Response.json(init?.method === "POST" ? {} : library); });
  render(<PlaceIllustrations sessionId="world" view={{ ...view, objects: [{ object_id: "roof", rgb: [1, 2, 3] }] }} disabled={false}/>);
  fireEvent.load(await screen.findByRole("img", { name: "Generated camera illustration" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit selected objects" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Edit selected objects" })); fireEvent.click(screen.getByRole("button", { name: "Generate change" }));
  fireEvent.click(screen.getByRole("button", { name: "Select roof fixture" }));
  fireEvent.change(screen.getByLabelText("Selected object change"), { target: { value: "Blue roof tiles" } });
  expect(screen.getByRole("button", { name: "Generate selected change" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Approve masked generation reservation" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate selected change" })); await screen.findByText("Lost masked response");
  expect(screen.getByLabelText("Selected object change")).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Apply draft" })).toHaveProperty("disabled", true);
  expect(JSON.parse(writes()[0])).toMatchObject({ action: "generate_region", prompt: "Blue roof tiles", base_id: "base", object_ids: ["roof"], model: "masked-model", parameters: { pinned: true }, reservation: 0.2, confirmed: true });
  fireEvent.click(screen.getByRole("button", { name: "Retry masked request" })); await waitFor(() => expect(writes()).toHaveLength(2)); expect(writes()[1]).toBe(writes()[0]);
});
it("does not offer direct acceptance for raw masked model output", async () => {
  library.assets = [{ id: "masked", prompt: "Roof edit", accepted: false, historical: false, edit_input: { base_id: "base", object_ids: ["roof"], brush_strokes: [{ operation: "paint", radius: 3, points: [[10, 10]] }] } }];
  draw(); fireEvent.load(await screen.findByRole("img", { name: "Generated camera illustration" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Preview protected result" })).toHaveProperty("disabled", false));
  expect(screen.queryByRole("button", { name: "Accept illustration" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Preview protected result" })); await waitFor(() => expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0])).toMatchObject({ action: "compose", proposal_id: "masked", base_id: "base", object_ids: ["roof"], brush_strokes: [{ operation: "paint", radius: 3, points: [[10, 10]] }] });
});
it("clears consent on a brush edit and freezes strokes across a lost generation response", async () => {
  library.assets = [{ id: "base", prompt: "Painting", accepted: true, historical: false, region_edit: { object_ids: ["roof"], protected_pixels: 100 } }]; library.accepted_id = "base";
  library.region_capabilities = { enabled: true, brush_enabled: true, model: "masked", reservation: 0.2, parameters: {} };
  let lost = true;
  fetcher.mockImplementation(async (_url, init) => { if (init?.method === "POST" && lost) { lost = false; throw new Error("Lost brush response"); } return Response.json(init?.method === "POST" ? {} : library); });
  render(<PlaceIllustrations sessionId="world" view={{ ...view, objects: [{ object_id: "roof", rgb: [1, 2, 3] }] }} disabled={false}/>);
  fireEvent.load(await screen.findByRole("img", { name: "Generated camera illustration" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit selected objects" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Edit selected objects" })); fireEvent.click(screen.getByRole("button", { name: "Generate change" }));
  expect(screen.queryByText("1 objects / 100 protected pixels")).toBeNull();
  expect(screen.getByRole("button", { name: "Close region edit" })).toHaveProperty("disabled", false);
  fireEvent.change(screen.getByLabelText("Selected object change"), { target: { value: "Blue tile patch" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Approve masked generation reservation" }));
  fireEvent.click(screen.getByRole("button", { name: "Paint fixture" }));
  expect(screen.getByRole("checkbox", { name: "Approve masked generation reservation" })).toHaveProperty("checked", false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Approve masked generation reservation" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate selected change" })); await screen.findByText("Lost brush response");
  expect(screen.getByRole("button", { name: "Paint fixture" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Retry masked request" })); await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[1]).toBe(writes()[0]); expect(JSON.parse(writes()[0]).brush_strokes).toEqual([{ operation: "paint", radius: 3, points: [[10, 10]] }]);
});
it("paints keyframes in place of flux, continues from an accepted camera, shows the gate and offers the next rung", async () => {
  Object.assign(library, { keyframe_capabilities: { enabled: true, model: "qwen", reservation: 0.12, parameters: { num_images: 2 } }, chain_sources: [{ view_id: "front", label: "Front door", angle: 12.4 }],
    assets: [{ id: "kf", prompt: "Inked stone", accepted: false, historical: false, keyframe: { version: 1, stage: "first", art: "art", gate: "failed", object_id: "inn", chosen: 0, passed: false, sky_pinned: false,
      candidates: [{ iou: 0.71, centre_dx: 0.052, centre_dy: -0.01, area_ratio: 1.31, painted: 40, passed: false }] } }] });
  draw(); await screen.findByText("Reserve $0.12 for this keyframe");
  expect(screen.queryByRole("button", { name: "Generate illustration" })).toBeNull();
  expect(screen.getByRole("status", { name: "Keyframe gate" }).textContent).toBe("Keyframe from art / camera/paint check failed / IoU 0.710 / centre +5.2%, -1.0% / area 1.31");
  fireEvent.change(screen.getByLabelText("Illustration appearance"), { target: { value: "Warm lamplight" } }); fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Continue from camera"), { target: { value: "front" } });
  fireEvent.click(screen.getByRole("button", { name: "Paint keyframe" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0])).toMatchObject({ action: "generate_keyframe", chain_from: "front", model: "qwen", reservation: 0.12, parameters: { num_images: 2 }, prompt: "Warm lamplight", confirmed: true });
  const rung = screen.getByRole("button", { name: "Retry with words only" });
  await waitFor(() => expect(rung).toHaveProperty("disabled", true)); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(rung);
  await waitFor(() => expect(writes()).toHaveLength(2));
  const words = JSON.parse(writes()[1]);
  expect(words).toMatchObject({ action: "generate_keyframe", art: false, prompt: "Inked stone" }); expect(words.chain_from).toBeUndefined();
});
it.each(["failed", "unmeasured", "missing final"])("keeps a %s keyframe draft visible but unavailable for acceptance", async problem => {
  library.assets = [{ id: "kf", sha256: "a".repeat(64), prompt: "Inked stone", accepted: false, historical: false,
    keyframe: { version: 1, stage: "first", gate: problem === "missing final" ? "passed" : problem, object_id: "inn", chosen: 0, passed: problem === "missing final", sky_pinned: false,
      candidates: [{ iou: 0.9, centre_dx: 0, centre_dy: 0, area_ratio: 1, painted: 40, passed: true }] } }];
  draw(); fireEvent.load(await screen.findByRole("img", { name: "Generated camera illustration" }));
  const accept = await screen.findByRole("button", { name: "Review and accept illustration" });
  expect(accept).toHaveProperty("disabled", true);
  expect(screen.getByRole("status", { name: "Illustration content review" }).textContent).toMatch(/needs a passing camera check and final-image verification/);
  fireEvent.click(accept); expect(writes()).toHaveLength(0);
});
it("reviews the exact final-image hash separately from camera/paint evidence", async () => {
  const sha256 = "a".repeat(64);
  library.assets = [{ id: "kf", sha256, prompt: "Inked stone", accepted: false, historical: false,
    keyframe: { version: 1, stage: "first", gate: "passed", object_id: "inn", chosen: 0, passed: true, sky_pinned: false,
      candidates: [{ iou: 0.7, centre_dx: 0, centre_dy: 0, area_ratio: 1, painted: 40, passed: true }],
      final_image: { version: 1, sha256, candidate_sha256: sha256, width: 256, height: 256, method: "candidate",
        invariants: { dimensions: true, opaque: true, composition: true, protected_pixels: 0, changed_protected_pixels: 0 } } } }];
  draw(); fireEvent.load(await screen.findByRole("img", { name: "Generated camera illustration" }));
  const accept = await screen.findByRole("button", { name: "Review and accept illustration" });
  await waitFor(() => expect(accept).toHaveProperty("disabled", false));
  expect(screen.getByRole("status", { name: "Illustration content review" }).textContent).toMatch(/Camera\/paint checks do not verify this content/);
  fireEvent.click(accept); await waitFor(() => expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0])).toEqual({ action: "accept", id: "kf", previous_id: null, reviewed_sha256: sha256 });
});
it("continues from the nearest accepted camera by default and still paints a first keyframe on request", async () => {
  Object.assign(library, { keyframe_capabilities: { enabled: true, model: "qwen", reservation: 0.12, parameters: {} },
    chain_sources: [{ view_id: "front", label: "Front door", angle: 12.4 }, { view_id: "yard", label: "Back yard", angle: 171 }] });
  draw(); await screen.findByText("Reserve $0.12 for this keyframe");
  const select = screen.getByLabelText<HTMLSelectElement>("Continue from camera");
  expect(select.value).toBe("front");
  expect([...select.options].map(o => o.textContent)).toEqual(["3D render (first keyframe)", "Front door (12°)", "Back yard (171°)"]);
  fireEvent.change(screen.getByLabelText("Illustration appearance"), { target: { value: "Warm lamplight" } });
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Paint keyframe" }));
  await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0]).chain_from).toBe("front");
  fireEvent.change(select, { target: { value: "" } }); expect(select.value).toBe("");
  await waitFor(() => expect(screen.getByRole("checkbox")).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Paint keyframe" }));
  await waitFor(() => expect(writes()).toHaveLength(2)); expect(JSON.parse(writes()[1]).chain_from).toBeUndefined();
});
const identityLabels = ["Bookshop", "Lantern Inn", "Watchtower", "Copper Kettle"];
const identityAsset = (id: string, passed = true) => ({ id, model: "fal-ai/nano-banana-pro/edit", sha256: (id === "first" ? "a" : "b").repeat(64), prompt: "Keep the same mapped buildings", accepted: false, historical: false,
  keyframe: { version: 1, stage: "first", art: "art", reference_profile: "source-art-map-landmarks-v1", gate: passed ? "passed" : "failed", object_id: "inn", chosen: 0, passed, sky_pinned: false,
    candidates: [{ iou: passed ? .9 : .6, centre_dx: 0, centre_dy: 0, area_ratio: 1, painted: 40, passed }],
    final_image: { version: 1, sha256: (id === "first" ? "a" : "b").repeat(64), candidate_sha256: (id === "first" ? "a" : "b").repeat(64), width: 400, height: 300, method: "candidate", invariants: { dimensions: true, opaque: true, composition: true, protected_pixels: 0, changed_protected_pixels: 0 } } } });
it("compares original map, exact camera and candidate and binds all four identity reviews to the selected final bytes", async () => {
  library.assets = [identityAsset("first"), identityAsset("second")];
  render(<PlaceIllustrations sessionId="world" view={view} disabled={false} sourceArtworkUrl="/api/nodes/map/image" landmarkLabels={identityLabels}/>);
  const panel = await screen.findByRole("region", { name: "World identity review" });
  const images = within(panel).getAllByRole("img");
  expect(images.map(image => new URL(image.getAttribute("src")!, "http://localhost").pathname)).toEqual(["/api/nodes/map/image", "/api/world/world/views/view/render", "/api/world/world/illustrations/first"]);
  const checks = within(panel).getAllByRole("checkbox"); expect(checks).toHaveLength(4);
  fireEvent.load(screen.getByRole("img", { name: "Generated camera illustration" })); images.forEach(image => fireEvent.load(image));
  const accept = screen.getByRole("button", { name: "Review and accept illustration" });
  for (const checkbox of checks.slice(0, 3)) fireEvent.click(checkbox);
  expect(accept).toHaveProperty("disabled", true); expect(writes()).toHaveLength(0);
  fireEvent.click(checks[3]!); await waitFor(() => expect(accept).toHaveProperty("disabled", false));
  fireEvent.change(screen.getByLabelText("Saved illustration"), { target: { value: "second" } });
  fireEvent.load(screen.getByRole("img", { name: "Generated camera illustration" })); fireEvent.load(within(panel).getByRole("img", { name: "Candidate artwork for identity review" }));
  expect(checks.every(checkbox => !(checkbox as HTMLInputElement).checked)).toBe(true); expect(accept).toHaveProperty("disabled", true);
  checks.forEach(checkbox => fireEvent.click(checkbox)); await waitFor(() => expect(accept).toHaveProperty("disabled", false));
  fireEvent.click(accept); await waitFor(() => expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0])).toEqual({ action: "accept", id: "second", previous_id: null, reviewed_sha256: "b".repeat(64) });
});
it.each(["fal-ai/nano-banana-pro/edit", "fal-ai/flux-general/image-to-image"])("keeps failed %s framing blocked and cannot replace the map-bound profile with a words-only retry", async model => {
  library.assets = [identityAsset("first", false)];
  Object.assign(library, { keyframe_capabilities: { enabled: true, model, reservation: .3, parameters: {} } });
  render(<PlaceIllustrations sessionId="world" view={view} disabled={false} sourceArtworkUrl="/api/nodes/map/image" landmarkLabels={identityLabels}/>);
  const panel = await screen.findByRole("region", { name: "World identity review" });
  within(panel).getAllByRole("img").forEach(image => fireEvent.load(image)); fireEvent.load(screen.getByRole("img", { name: "Generated camera illustration" }));
  expect(within(panel).getAllByRole("checkbox").every(checkbox => (checkbox as HTMLInputElement).disabled)).toBe(true);
  expect(screen.getByRole("button", { name: "Review and accept illustration" })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("button", { name: "Retry with words only" })).toBeNull(); expect(writes()).toHaveLength(0);
  expect(within(panel).getByRole("status").textContent).toContain("cannot override the camera gate");
});
it("requires available source comparison pixels even when a candidate passes and all building checks are selected", async () => {
  library.assets = [identityAsset("first")];
  render(<PlaceIllustrations sessionId="world" view={view} disabled={false} sourceArtworkUrl="/api/nodes/map/image" landmarkLabels={identityLabels}/>);
  const panel = await screen.findByRole("region", { name: "World identity review" });
  fireEvent.load(screen.getByRole("img", { name: "Generated camera illustration" }));
  within(panel).getAllByRole("checkbox").forEach(checkbox => fireEvent.click(checkbox));
  const images = within(panel).getAllByRole("img"); images.slice(1).forEach(image => fireEvent.load(image));
  const accept = screen.getByRole("button", { name: "Review and accept illustration" }); expect(accept).toHaveProperty("disabled", true);
  fireEvent.load(images[0]!); await waitFor(() => expect(accept).toHaveProperty("disabled", false));
  fireEvent.error(images[0]!); expect(accept).toHaveProperty("disabled", true); expect(writes()).toHaveLength(0);
});
it.each(["fal-ai/nano-banana-pro/edit", "fal-ai/flux-general/image-to-image"])("keeps an unavailable explicit %s profile disabled instead of submitting legacy full-view generation", async model => {
  Object.assign(library, { keyframe_capabilities: { enabled: false, model, reservation: .3, parameters: {}, reason: "Capture a compatible 688 × 384 camera before Nano keyframe painting." } });
  draw(); await screen.findByText("Capture a compatible 688 × 384 camera before Nano keyframe painting.");
  expect(screen.getByRole("button", { name: "Paint keyframe" })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("button", { name: "Generate illustration" })).toBeNull(); expect(writes()).toHaveLength(0);
});
it("paints Flux reference as an independent exact-camera anchor even when a nearest accepted chain exists", async () => {
  Object.assign(library, { keyframe_capabilities: { enabled: true, model: "fal-ai/flux-general/image-to-image", reservation: .15,
    parameters: { num_images: 1, output_format: "jpeg", prompt_version: "saved-camera-flux-reference-controlnet-v1", structural_guidance: "saved-camera-controlnet-v1" } },
    chain_sources: [{ view_id: "front", label: "Front door", angle: 12.4 }] });
  draw(); await screen.findByText(/Flux \/ saved-camera depth/);
  expect(screen.queryByLabelText("Continue from camera")).toBeNull();
  fireEvent.change(screen.getByLabelText("Illustration appearance"), { target: { value: "Inked stone with warm window light" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Reserve/ })); fireEvent.click(screen.getByRole("button", { name: "Paint keyframe" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const body = JSON.parse(writes()[0]); expect(body).toMatchObject({ action: "generate_keyframe", model: "fal-ai/flux-general/image-to-image", reservation: .15 });
  expect(body.chain_from).toBeUndefined(); expect(body.art).toBeUndefined(); expect(body.reference_guidance).toBeUndefined();
});
