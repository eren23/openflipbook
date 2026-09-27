import { ANKH_MAP, DRUM_MAP_ANCHOR } from "./ankh-scene";
import { DRUM_ENVIRONMENT, DRUM_EDIT } from "./drum-assets";

async function dataUrl(path: string) {
  const response = await fetch(path);
  if (!response.ok) throw new Error("Could not load the saved demo image");
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the demo image"));
    reader.readAsDataURL(blob);
  });
}

// Reuse the same import on retries. This stores references, never owner credentials.
export async function importDrumWorld() {
  const key = "ofb-drum-import-v1";
  let session = sessionStorage.getItem(key);
  if (!session) { session = crypto.randomUUID(); sessionStorage.setItem(key, session); }
  async function save(name: string, path: string, parent: string | null, edit = false) {
    // Known projection, without inventing a reconstructed camera pose.
    const scene_view = { node_id: "", level: name === "map" ? "map" : "street", observer: null, map_crop: null };
    const response = await fetch("/api/nodes", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `drum-v1-${name}` },
      body: JSON.stringify({ session_id: session, scene_view, parent_id: parent, page_title: name === "map" ? "Ankh-Morpork" : name === "teal" ? "The Mended Drum / Teal roof" : "The Mended Drum", query: "Imported Mended Drum demo asset", image_data_url: await dataUrl(path), image_model: "imported-demo-asset", prompt_author_model: "imported-demo-asset", aspect_ratio: "16:9", relation: edit ? "edit" : "descend", scale: parent && !edit ? "component" : "peer", ...(parent && !edit ? { click_in_parent: { x_pct: DRUM_MAP_ANCHOR.x, y_pct: DRUM_MAP_ANCHOR.y } } : {}) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not save the demo world");
    return data.id as string;
  }
  const map = await save("map", ANKH_MAP, null);
  const source = await save("street", DRUM_ENVIRONMENT, map);
  const edited = await save("teal", DRUM_EDIT, source, true);
  return { source, edited, map, session, place: `place_${source}` };
}

export function drumWorldEditorUrl(source: string, place?: string) {
  const query = new URLSearchParams({ source });
  if (place) query.set("place", place);
  return `/sketch/world?${query}`;
}
