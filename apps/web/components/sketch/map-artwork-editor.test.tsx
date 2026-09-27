import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";
import { mapObject } from "@/lib/map-artwork";
import MapArtworkEditor from "./map-artwork-editor";

const definition = { ...emptyPlaceScene(), objects: [{ ...newComponent("house", 10, 12),id:"inn",label:"Inn" }, { ...newComponent("house", 24, 12),id:"shop",label:"Shop" }] };
const scene = {id:"scene",session_id:"world",place_id:"place",revision:2,source_node_id:"street",source_image_key:"street.png",updated_at:new Date(0).toISOString(),definition};
const baseline = { ...scene,revision:1,definition:{...definition,objects:definition.objects.map(o=>({...o,x:o.x-3}))} };
const registration = {x:50,y:50,width:50,rotation:0};
function setup(registered=true) {
  const fetcher=vi.fn(async (url:string) => ({ok:true,json:async()=>url.startsWith("/api/world/scene-context")?{session_id:"world",place_id:"place"}:{scene,baseline,map:{id:"map",root_id:"root",title:"City",url:"/saved-map.png"},registration:registered?registration:null}}));
  vi.stubGlobal("fetch",fetcher);render(<MapArtworkEditor/>);return fetcher;
}
async function imageLoaded(){const img=await screen.findByRole("img",{name:"Current parent map artwork"});Object.defineProperties(img,{naturalWidth:{value:1000,configurable:true},naturalHeight:{value:600,configurable:true}});fireEvent.load(img);}
beforeEach(()=>{window.history.replaceState(null,"","/sketch/world/map?world=world&place=place&object=inn&view=split&camera=shot");});
it("loads the exact world/place and preserves object and camera on the return link",async()=>{
  const fetcher=setup();await imageLoaded();
  expect(fetcher.mock.calls[0]![0]).toContain("world=world&place=place");
  expect((screen.getByRole("combobox",{name:"Selected world object"}) as HTMLSelectElement).value).toBe("inn");
  expect(screen.getByRole("link",{name:"World"}).getAttribute("href")).toBe("/sketch/world?world=world&place=place&object=inn&view=split&camera=shot");
  expect(screen.getByRole("link",{name:"Open selected object in 3D"}).getAttribute("href")).toBe("/sketch/world?world=world&place=place&object=inn&view=orbit&camera=shot");
});
it("picks the saved artwork footprint at its baseline position and carries its stable ID to 3D",async()=>{
  setup();await imageLoaded();const polygon=screen.getByRole("button",{name:"Select Shop"});
  expect(polygon.getAttribute("points")).toBe(mapObject(baseline.definition.objects[1]!,baseline.definition,registration,{width:1000,height:600}).points.map(p=>`${p.x},${p.y}`).join(" "));
  fireEvent.click(polygon);expect((screen.getByRole("combobox",{name:"Selected world object"}) as HTMLSelectElement).value).toBe("shop");
  await waitFor(()=>expect(new URLSearchParams(location.search).get("object")).toBe("shop"));
  expect(screen.getByRole("link",{name:"Open selected object in 3D"}).getAttribute("href")).toContain("object=shop");
  fireEvent.keyDown(screen.getByRole("button",{name:"Select Inn"}),{key:"Enter"});expect((screen.getByRole("combobox",{name:"Selected world object"}) as HTMLSelectElement).value).toBe("inn");
  expect((screen.getByRole("spinbutton",{name:"Map x"}) as HTMLInputElement).value).toBe("50");
});
it("does not make unregistered artwork clickable or claim its placement is accepted",async()=>{
  setup(false);await imageLoaded();expect(screen.queryByRole("button",{name:"Select Shop"})).toBeNull();
  expect(screen.getByText("Unregistered reference / placement preview")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox",{name:"Selected world object"}),{target:{value:"shop"}});
  expect(screen.getByRole("link",{name:"Open selected object in 3D"}).getAttribute("href")).toContain("object=shop");
  expect((screen.getByRole("checkbox",{name:"Map placement reviewed (approximate)"}) as HTMLInputElement).checked).toBe(false);
});
it("retains source-only legacy entry links without inventing an object match",async()=>{
  window.history.replaceState(null,"","/sketch/world/map?source=street&place=place&object=deleted");setup();await imageLoaded();
  expect((screen.getByRole("combobox",{name:"Selected world object"}) as HTMLSelectElement).value).toBe("");expect(screen.queryByRole("link",{name:"Open selected object in 3D"})).toBeNull();
});
it("keeps world selection on the back link when artwork cannot load",async()=>{
  vi.stubGlobal("fetch",vi.fn(async()=>({ok:false,json:async()=>({error:"Place reference artwork is missing"})})));
  render(<MapArtworkEditor/>);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("link",{name:"World"}).getAttribute("href")).toBe("/sketch/world?world=world&place=place&object=inn&view=split&camera=shot");
  expect(screen.getByText("Artwork unavailable")).toBeTruthy();
});
it("saves landmark coordinates as an unaccepted draft using PATCH, not repaint or generation",async()=>{
  const fetcher=vi.fn(async(url:string,init?:RequestInit)=>({ok:true,json:async()=>init?.method==="PATCH"?{alignment:{revision:1,landmarks:JSON.parse(String(init.body)).landmarks,registration}}:url.startsWith("/api/world/scene-context")?{session_id:"world",place_id:"place"}:{scene,baseline,map:{id:"map",root_id:"root",title:"City",url:"/saved-map.png"},registration:null}}));
  vi.stubGlobal("fetch",fetcher);render(<MapArtworkEditor/>);await imageLoaded();
  fireEvent.click(screen.getByRole("button",{name:"Add landmark coordinates"}));
  fireEvent.change(screen.getByRole("spinbutton",{name:"Inn image x"}),{target:{value:"24.5"}});
  fireEvent.click(screen.getByRole("button",{name:"Save alignment draft"}));
  await screen.findByRole("button",{name:"Alignment draft saved"});
  const writes=fetcher.mock.calls.filter(([,init])=>init?.method);
  expect(writes).toHaveLength(1);expect(writes[0]![1]!.method).toBe("PATCH");
  expect(JSON.parse(String(writes[0]![1]!.body))).toMatchObject({scene_revision:2,map_node_id:"map",revision:0,landmarks:[{object_id:"inn",x:24.5,y:50}]});
  expect(screen.getByText("Unregistered reference / placement preview")).toBeTruthy();
  expect((screen.getByRole("checkbox",{name:"Map placement reviewed (approximate)"}) as HTMLInputElement).checked).toBe(false);
});
it("does not restore historical landmark measurements onto current geometry",async()=>{
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>({ok:true,json:async()=>url.startsWith("/api/world/scene-context")?{session_id:"world",place_id:"place"}:{scene,baseline,map:{id:"map",root_id:"root",title:"City",url:"/saved-map.png"},registration:null,alignment_stale:true,alignment:{revision:2,registration,landmarks:[{object_id:"deleted",x:10,y:20}]}}})));
  render(<MapArtworkEditor/>);await imageLoaded();expect(screen.getByText("Saved draft is historical. Geometry or artwork changed.")).toBeTruthy();
  expect(screen.queryByRole("spinbutton",{name:"Inn image x"})).toBeNull();expect((screen.getByRole("spinbutton",{name:"Map width"}) as HTMLInputElement).value).toBe("20");
});
it("previews selected corrections before explicit Apply and retains its proposal for a lost-response retry", async () => {
  let applied = false, attempts = 0;
  const alignment = { revision: 3, registration, landmarks: [{ object_id: "inn", x: 24, y: 40 }] };
  const proposal = { id: "correction", definition: { ...definition, objects: definition.objects.map(o => o.id === "inn" ? { ...o, x: 14 } : o) }, changes: ["Move Inn"], affected_node_ids: ["street"] };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.body) {
      const body = JSON.parse(String(init.body));
      if (body.action === "preview") return { ok: true, json: async () => ({ proposal }) };
      if (body.action === "apply") { applied = true; if (++attempts === 1) throw new Error("Response lost"); return { ok: true, json: async () => ({}) }; }
    }
    return { ok: true, json: async () => url.startsWith("/api/world/scene-context") ? { session_id: "world", place_id: "place" } : { scene: applied ? { ...scene, revision: 3, definition: proposal.definition } : scene, baseline, map: { id: "map", root_id: "root", title: "City", url: "/saved-map.png" }, registration: null, alignment, alignment_stale: applied } };
  });
  vi.stubGlobal("fetch", fetcher); render(<MapArtworkEditor/>); await imageLoaded();
  const preview = screen.getByRole("button", { name: "Preview selected corrections" });
  expect((preview as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Correct Inn" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Approximate projection reviewed" }));
  fireEvent.click(preview);
  await screen.findByRole("region", { name: "Geometry correction preview" });
  expect(applied).toBe(false);
  const request = fetcher.mock.calls.find(([, init]) => init?.body)!;
  expect(JSON.parse(String(request[1]!.body))).toEqual({ action: "preview", base_revision: 2, map_alignment: { revision: 3, object_ids: ["inn"], confirmed_projection: true } });
  fireEvent.click(screen.getByRole("button", { name: "Apply geometry correction" }));
  await screen.findByText("Response lost");
  fireEvent.click(screen.getByRole("button", { name: "Apply geometry correction" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Geometry correction preview" })).toBeNull());
  expect(attempts).toBe(2); expect(screen.getByText("Saved draft is historical. Geometry or artwork changed.")).toBeTruthy();
  expect(screen.getByText("Unregistered reference / placement preview")).toBeTruthy();
});
it("warns before leaving unsaved measurements and removes the warning after saving", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "PATCH" ? { alignment: { revision: 1 } } : url.startsWith("/api/world/scene-context") ? { session_id: "world", place_id: "place" } : { scene, baseline, map: { id: "map", root_id: "root", title: "City", url: "/saved-map.png" }, registration: null } }));
  vi.stubGlobal("fetch", fetcher); render(<MapArtworkEditor/>); await imageLoaded();
  const unload = () => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
  expect(unload()).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Add landmark coordinates" })); expect(unload()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save alignment draft" }));
  await screen.findByRole("button", { name: "Alignment draft saved" }); expect(unload()).toBe(false);
});
it.each(["map", "replaced-map"])("only explicitly rebases surviving identities when the source image is unchanged (%s)", async mapId => {
  const alignment = { revision: 3, scene_id: scene.id, map_node_id: mapId, frame: { width: 1000, height: 600 }, registration, landmarks: [{ object_id: "inn", x: 24, y: 40 }, { object_id: "removed", x: 60, y: 40 }] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith("/api/world/scene-context") ? { session_id: "world", place_id: "place" } : { scene, baseline, map: { id: "map", root_id: "root", title: "City", url: "/saved-map.png" }, registration: null, alignment, alignment_stale: true } })));
  render(<MapArtworkEditor/>); await imageLoaded();
  expect(screen.queryByRole("spinbutton", { name: "Inn image x" })).toBeNull();
  const rebase = screen.queryByRole("button", { name: "Rebase surviving landmarks" });
  if (mapId !== "map") { expect(rebase).toBeNull(); return; }
  fireEvent.click(rebase!);
  expect((screen.getByRole("spinbutton", { name: "Inn image x" }) as HTMLInputElement).value).toBe("24");
  expect(screen.queryByRole("spinbutton", { name: "removed image x" })).toBeNull();
  expect(screen.getByText("Unsaved alignment changes")).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Approximate projection reviewed" }) as HTMLInputElement).checked).toBe(false);
});
