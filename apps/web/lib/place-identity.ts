import type { EntityBBox, PlaceUpdate, SceneView, WorldEntityGeo, ViewVerdict } from "@openflipbook/config";
import { isSafeId } from "./ids";

export function isVerifiedView(verdict: ViewVerdict | null | undefined, options: { outward?: boolean; interior?: boolean } = {}): boolean {
  if (!verdict?.accepted) return false;
  const required = [verdict.medium, verdict.conformance, options.interior ? verdict.interior : verdict.same_place];
  if (!options.outward) required.push(verdict.detail);
  return required.every(value => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10);
}

export function validReferenceBox(value: unknown): value is EntityBBox {
  if (!value || typeof value !== "object") return false;
  const b = value as EntityBBox;
  return [b.x_pct, b.y_pct, b.w_pct, b.h_pct].every(Number.isFinite) &&
    b.x_pct >= 0 && b.y_pct >= 0 && b.w_pct > 0 && b.h_pct > 0 &&
    b.x_pct + b.w_pct <= 1 && b.y_pct + b.h_pct <= 1;
}

export function parsePlaceUpdate(value: unknown): PlaceUpdate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["expected_updated_at", "label", "visual", "identity_locked", "reference"].includes(k))) return null;
  if (typeof v.expected_updated_at !== "string" || !Number.isFinite(Date.parse(v.expected_updated_at))) return null;
  if (v.label !== undefined && (typeof v.label !== "string" || !v.label.trim() || v.label.length > 160)) return null;
  if (v.visual !== undefined && (typeof v.visual !== "string" || v.visual.length > 2000)) return null;
  if (v.identity_locked !== undefined && typeof v.identity_locked !== "boolean") return null;
  if (v.reference !== undefined && v.reference !== null) {
    const r = v.reference as Record<string, unknown>;
    if (typeof r !== "object" || !isSafeId(r.node_id) || !validReferenceBox(r.bbox)) return null;
    if (Object.keys(r).some(k => !["node_id", "bbox"].includes(k))) return null;
  }
  return v as unknown as PlaceUpdate;
}

export function placeViewKind(view: SceneView | null | undefined): string | null {
  if (!view?.focus_id) return null;
  if (view.place_form === "interior") return "interior";
  if (view.closeup) return "closeup";
  return view.level === "map" ? "map" : "scene";
}

export function preservePlaceIdentity(previous: WorldEntityGeo, incoming: WorldEntityGeo): WorldEntityGeo {
  return {
    ...incoming,
    ...(previous.identity_anchor !== undefined ? { identity_anchor: previous.identity_anchor } : {}),
    ...(previous.identity_locked !== undefined ? { identity_locked: previous.identity_locked } : {}),
    ...(previous.identity_locked ? { label: previous.label, visual: previous.visual } : {}),
  };
}
