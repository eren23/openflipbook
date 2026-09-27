import type { ViewCapture, ViewSource } from "./place-view";

export const ILLUSTRATION_IDENTITY_VERSION = "visible-object-identities-v1";
export const usesIllustrationIdentity = (parameters?: Record<string, unknown>) =>
  parameters?.prompt_version === "saved-camera-depth-identity-v2" || parameters?.prompt_version === "registered-object-inpaint-depth-identity-v2";

// Screen locations come from actual opaque mask pixels, not projected boxes
// that might describe occluded objects. This is identity context, not a mask
// supplied to the provider or evidence that its output preserves geometry.
export function illustrationIdentity(view: Pick<ViewCapture, "width" | "height" | "objects" | "floor_id" | "mode">,
  sources: ViewSource[], pixels: Uint8Array) {
  if (pixels.length !== view.width * view.height * 4) throw new Error("Identity mask dimensions differ from the saved camera");
  const records = new Map(view.objects.map(o => [o.rgb[0] * 65536 + o.rgb[1] * 256 + o.rgb[2],
    { id: o.object_id, count: 0, x: 0, y: 0, minX: view.width, minY: view.height, maxX: 0, maxY: 0 }]));
  for (let p = 0; p < pixels.length; p += 4) {
    const record = records.get(pixels[p]! * 65536 + pixels[p + 1]! * 256 + pixels[p + 2]!);
    if (!record || pixels[p + 3] !== 255) continue;
    const x = (p / 4) % view.width, y = Math.floor(p / 4 / view.width);
    record.count++; record.x += x + 0.5; record.y += y + 0.5;
    record.minX = Math.min(record.minX, x); record.maxX = Math.max(record.maxX, x + 1);
    record.minY = Math.min(record.minY, y); record.maxY = Math.max(record.maxY, y + 1);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const visible = [...records.values()].filter(r => r.count >= 4).sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const objects = visible.slice(0, 24).map(r => {
    const source = sources.find(s => s.definition.objects.some(o => o.id === r.id));
    const object = source?.definition.objects.find(o => o.id === r.id);
    if (!source || !object) throw new Error("Visible identity is missing from the saved geometry");
    return { id: object.id, label: object.label, kind: object.kind,
      place_id: source.place_id, scene_revision: source.revision,
      visible_pixels: r.count,
      center_percent: [round(r.x / r.count / view.width * 100), round(r.y / r.count / view.height * 100)],
      bounds_percent: [round(r.minX / view.width * 100), round(r.minY / view.height * 100), round(r.maxX / view.width * 100), round(r.maxY / view.height * 100)],
      dimensions_m: [object.width, object.height, object.depth],
    };
  });
  return { version: ILLUSTRATION_IDENTITY_VERSION, mode: view.mode, floor_id: view.floor_id,
    omitted_visible_objects: Math.max(0, visible.length - objects.length), objects };
}
