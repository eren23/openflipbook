export interface WorldSummary {
  id: string;
  title: string;
  image_url: string | null;
  node_count: number;
  pinned: boolean;
  archived: boolean;
  last_opened_at: string;
  resume_node_id: string | null;
  resume_place_id?: string | null;
  resume_view?: "walk" | null;
  place_count?: number;
}

export interface AuthorNote {
  place_id: string | null;
  label: string;
  text: string;
  revision: number;
  updated_at: string | null;
  missing_place?: boolean;
}

export const NOTE_LIMIT = 20_000;

export function parseNote(value: unknown): { place_id: string | null; text: string; revision: number } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.place_id !== null && (typeof v.place_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.place_id))) return null;
  if (typeof v.text !== "string" || v.text.length > NOTE_LIMIT || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0) return null;
  return { place_id: v.place_id as string | null, text: v.text, revision: Number(v.revision) };
}

export function parseWorldPatch(value: unknown): { title?: string; pinned?: boolean; archived?: boolean; resume_node_id?: string; resume_place_id?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const out: { title?: string; pinned?: boolean; archived?: boolean; resume_node_id?: string; resume_place_id?: string } = {};
  for (const key of Object.keys(v)) {
    if (key === "title" && typeof v[key] === "string" && v[key].trim() && v[key].trim().length <= 160) out.title = v[key].trim();
    else if ((key === "pinned" || key === "archived") && typeof v[key] === "boolean") out[key] = v[key];
    else if ((key === "resume_node_id" || key === "resume_place_id") && typeof v[key] === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v[key])) out[key] = v[key];
    else return null;
  }
  return Object.keys(out).length && !(out.resume_node_id && out.resume_place_id) ? out : null;
}

export function creatorWorldUrl(world: Pick<WorldSummary, "id" | "resume_node_id" | "resume_place_id" | "resume_view">): string {
  return world.resume_place_id
    ? `/sketch/world?${new URLSearchParams({ world: world.id, place: world.resume_place_id,...(world.resume_view==="walk"?{view:"walk"}:{}) })}`
    : `/play?${new URLSearchParams({ continue: world.id, ...(world.resume_node_id ? { node: world.resume_node_id } : {}) })}`;
}
