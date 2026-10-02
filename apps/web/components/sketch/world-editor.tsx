"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Compass, Copy, Download, Eye, Footprints, GitFork, Image as ImageIcon, Map, Orbit, Plus, RotateCcw, Trash2, Play, ZoomIn, ZoomOut, Columns2, RectangleHorizontal, Focus } from "lucide-react";
import type { PlaceComponent, PlaceNetwork, PlaceSceneDefinition, PlaceSceneObject, PlaceSceneSnapshot, WorldEditProposal } from "@openflipbook/config";
import { COMPONENTS, emptyPlaceScene, footprintComponent, gardenScene, newComponent, parsePlaceScene, sceneChanges } from "@/lib/place-scene";
import type { SketchState } from "@/lib/sketch-types";
import s from "./world-editor.module.css";
import { ankhStreetScene, ANKH_MAP, DRUM_MAP_ANCHOR, DRUM_APPROACH } from "@/lib/ankh-scene";
import { alignedDrumScene, type AlignmentProfile } from "@/lib/drum-alignment";
import MeshGenerator from "./mesh-generator";
import PlaceBuilder from "./place-builder";
import type { MeshJob } from "@/lib/mesh-asset";
import BuildingInspector from "./building-inspector";
import AdjacentPlaceEditor from "./adjacent-place-editor";
import {useWalkPosition} from "@/hooks/useWalkPosition";
import { FURNISHINGS, bindObjectToFloor, findFloorPlacement, footprintsOverlap, resolveSceneObject, validateFloorPlacements, type FloorPlacement } from "@/lib/floor-placement";
import { validateRoomCirculation } from "@/lib/room-circulation";
import { proportionalMeshDimensions, resizeMesh, type MeshDimensions } from "@/lib/mesh-dimensions";
import MaterialEditor, { GroundMaterialEditor } from "./material-editor";
import MeshOrientationEditor from "./mesh-orientation-editor";
import { orientedMeshDimensions, reorientMesh, type MeshOrientation } from "@/lib/mesh-orientation";
import { duplicateMesh, replaceMeshAsset } from "@/lib/mesh-placement";
import { proposeMeshShell, removeMeshShell } from "@/lib/mesh-shell";
import PlaceViewLibrary from "./place-view-library";
import type { CaptureMotion } from "./place-camera-motion";
import type { CapturePlaceView, SavedPlaceView, RefreshPlaceView } from "@/lib/place-view";
import { WalkVideo } from "./path-video";
import { WORLD_EDITOR_VIEWS, worldEditorSelection, worldEditorHref, type WorldEditorView } from "@/lib/world-editor-selection";
import { routeParam, type WalkPose } from "@/lib/walk-position";
import type { WalkWaypoint } from "@/lib/walk-route";
import { networkView } from "@/lib/place-connections";
const Viewport = dynamic(() => import("./place-viewport"), { ssr: false });
interface Context {
  session_id: string; place_id: string; source_node_id: string | null; source_url: string | null;
  initial: PlaceSceneDefinition; scene: PlaceSceneSnapshot | null; history: PlaceSceneSnapshot[];
  drawing: SketchState | null;
  requested_source_node_id?: string;
  requested_source_url?: string;
}
async function request(url: string, body?: unknown) {
  const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Could not load the place");
  return data;
}
export default function WorldEditor() {
  const [context, setContext] = useState<Context | null>(null), [definition, setDefinition] = useState<PlaceSceneDefinition | null>(null);
  const [newWorld, setNewWorld] = useState(false);
  const liveDefinition = useRef(definition); liveDefinition.current = definition;
  const meshPending = useRef(false);
  const forkPending = useRef<{ source: string; body: { node_id: string | null; request_id: string } } | null>(null);
  const [measuringMesh, setMeasuringMesh] = useState(false);
  const [capture, setCapture] = useState<CapturePlaceView | null>(null);
  const [refreshView, setRefreshView] = useState<RefreshPlaceView | null>(null);
  const onRefreshReady = useCallback((next: RefreshPlaceView | null) => setRefreshView(() => next), []);
  const [loadView, setLoadView] = useState<{ requestId: string; view: SavedPlaceView } | undefined>();
  const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
  const loadCameraPath = (view: SavedPlaceView) => { setMode("orbit"); setFloorId(view.floor_id ?? ""); setSelected(view.path?.target_id ?? null); setLoadView({ requestId: crypto.randomUUID(), view }); };
  const onCaptureReady = useCallback((next: CapturePlaceView | null) => setCapture(() => next), []);
  const [network,setNetwork]=useState<PlaceNetwork|null>(null),[networkError,setNetworkError]=useState("");
  const [walkingPlace,setWalkingPlace]=useState<string|null>(null);
  const creationRequest = useRef<{ request_id: string; definition: PlaceSceneDefinition } | null>(null);
  const generationJob = useRef<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null), [mode, setMode] = useState<WorldEditorView>("plan");
  const [illustrationTarget, setIllustrationTarget] = useState<HTMLDivElement | null>(null);
  const refreshAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController(); refreshAbort.current = abort;
    return () => { abort.abort(); };
  }, [context?.scene, network, definition]);
  const refreshIllustration: RefreshPlaceView = async view => {
    const signal = refreshAbort.current?.signal;
    if (!context?.scene || !signal || dirty) throw new Error("Save scene changes before refreshing a view");
    if (view.mode === "walk" && networkError) throw new Error("Reload connected geometry before refreshing a walk view");
    const { refreshPlaceViewOffscreen } = await import("./place-view-refresh");
    return refreshPlaceViewOffscreen(view, context.scene, networkError ? null : network, { mesh: meshBase, material: materialBase }, signal);
  };
  const [drawFootprint, setDrawFootprint] = useState(false);
  const [floorId, setFloorId] = useState("");
  const [focusKey, setFocusKey] = useState(0);
  const [proposal, setProposal] = useState<WorldEditProposal | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [demo, setDemo] = useState(false), [confirmedScale, setConfirmedScale] = useState(false);
  const [kind, setKind] = useState<PlaceComponent>("bench"), [shape, setShape] = useState("");
  const [undoStack, setUndoStack] = useState<PlaceSceneDefinition[]>([]), [walkKey, setWalkKey] = useState(0);
  const [template, setTemplate] = useState("garden");
  const [ankhDemo, setAnkhDemo] = useState(false), [mapFocused, setMapFocused] = useState(false), [tour, setTour] = useState(false);
  const position=useWalkPosition(!demo&&context?.scene?context.session_id:null);
  const skipResume=useRef(false);
  // A walk handed over from /play: spawn once on its first point, then walk it.
  const [handoff,setHandoff]=useState<WalkWaypoint[]|null>(null),handoffPose=useRef<WalkPose|null>(null);
  function getWalkPose(){
    const start=handoffPose.current;handoffPose.current=null;
    if(skipResume.current){skipResume.current=false;return null;}return start??position.getPose();
  }
  async function load() {
    setLoadView(undefined);
    generationJob.current = undefined;
    const query = new URLSearchParams(window.location.search);
    if (["1", "ankh"].includes(query.get("demo") ?? "")) {
      const ankh = query.get("demo") === "ankh";
      setDemo(true); setAnkhDemo(ankh); const initial = ankh ? ankhStreetScene() : gardenScene(); setDefinition(initial);
      setTemplate(ankh ? "ankh" : "garden"); if (ankh) setMode("reference");
      if (query.get("view") === "split") setMode("split");
      setContext({ session_id: "demo", place_id: ankh ? "drum" : "garden", source_node_id: "", source_url: ankh ? ANKH_MAP : "", initial, scene: null, history: [], drawing: null });
      return;
    }
    if (!query.get("source") && !query.get("world")) {
      const initial = emptyPlaceScene();
      setNewWorld(true); setDefinition(initial); setTemplate("empty");
      setContext({ session_id: "", place_id: "place_root", source_node_id: null, source_url: null, initial, scene: null, history: [], drawing: null });
      return;
    }
    const data: Context = await request(`/api/world/scene-context?${query}`);
    let connected:PlaceNetwork|null=null, connectedFailed=false;setNetworkError("");
    if(data.scene){
      try{
        connected=(await request(`/api/world/${data.session_id}/places/${data.place_id}/connections`)).network;
        if(connected&&connected.chunks.find(c=>c.scene.place_id===data.place_id)?.scene.revision!==data.scene.revision)throw new Error("Place changed while loading connected areas. Reload.");
      }catch(e){setNetworkError((e as Error).message);connected=null;connectedFailed=true;setMode(old=>old==="walk"?"plan":old);}
    }
    setNetwork(connected);
    setWalkingPlace(data.place_id);
    let initial = data.initial;
    if (!data.scene) setTemplate("empty");
    if (!data.scene && query.get("template") === "drum") {
      const profile = query.get("profile") as AlignmentProfile;
      data.initial = ankhStreetScene();
      initial = alignedDrumScene(data.initial, ["original", "vertical_only", "shape_fit"].includes(profile) ? profile : "shape_fit").definition;
      initial.material_pack = "ankh-street-v1";
      initial.objects.find(o => o.kind === "tavern")!.roof_material = query.get("roof") === "teal" ? "teal" : "terracotta";
      setTemplate("ankh");
    }
    setNewWorld(false); setContext(data); setDefinition(initial); setProposal(null); setUndoStack([]); setConfirmedScale(!!data.scene);
    const selection = worldEditorSelection(initial, query.get("object"), query.get("floor"));
    setSelected(selection.object_id); setFloorId(selection.floor_id ?? "");
    const requestedMode = query.get("view") as WorldEditorView | null;
    if (selection.object_id && (requestedMode === "orbit" || requestedMode === "split")) setFocusKey(k => k + 1);
    setMode(requestedMode && WORLD_EDITOR_VIEWS.includes(requestedMode) && (requestedMode !== "reference" || data.source_url) && (requestedMode !== "walk" || !connectedFailed)
      ? requestedMode : initial.material_pack ? "orbit" : "plan");
    // A /play walk's route (walk-position routeQuery). It is taken off the URL
    // so a later load (save, fork) does not restart it.
    const route=data.scene&&requestedMode==="walk"&&!connectedFailed?routeParam(query.get("route")??"",data.scene.definition):[];
    if(query.has("route")){const url=new URL(window.location.href);url.searchParams.delete("route");window.history.replaceState(null,"",url);}
    handoffPose.current=route[0]&&data.scene?{version:1,place_id:data.place_id,scene_revision:data.scene.revision,position:{x:route[0].x,y:0.82,z:route[0].z},yaw:route[0].yaw,pitch:0}:null;
    // The tour walks in the loaded network's coordinates; the pose stays place-local.
    const chunk=connected&&route.length?networkView(connected,data.place_id).chunks.find(c=>c.scene.place_id===data.place_id):undefined;
    setHandoff(route.length?route.map(p=>({...p,x:p.x+(chunk?.x??0),z:p.z+(chunk?.z??0)})):null);if(route.length)setTour(true);
  }
  useEffect(() => { void load().catch(e => setError((e as Error).message)); }, []);
  const dirty = !!definition && !!context && sceneChanges(context.scene?.definition ?? null, definition).length > 0;
  const routeAvailable = ankhDemo && template === "ankh" && !!definition && !!context && sceneChanges(context.initial, definition).length === 0;
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty && !demo) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, demo]);
  function change(next: PlaceSceneDefinition) {
    setLoadView(undefined);
    setTour(false);
    if(mode==="walk"&&(network||next.objects.some(o=>o.kind==="building"&&o.asset_id)))setMode("plan");
    if (definition) setUndoStack(old => [...old.slice(-29), definition]);
    setDefinition(next.objects.some(o => o.kind === "building") ? {...next, version: 2} : next); setProposal(null); setError("");
  }
  function updateObject(patch: Partial<PlaceSceneObject>) {
    if (!definition) return;
    try {
      const next = { ...definition, objects: definition.objects.map(o => o.id === selected ? resizeMesh(o, patch) : o) };
      validateFloorPlacements(next); validateRoomCirculation(next);
      change(patch.materials !== undefined || definition.objects.find(o => o.id === selected)?.asset_id ? parsePlaceScene(next) : next);
    } catch (e) { setError((e as Error).message); }
  }
  async function preview(next = definition) {
    if (!context || !next) return;
    setBusy(true); setError("");
    try {
      const clean = parsePlaceScene(next);
      if (demo || newWorld) { setProposal({ id: "draft", scene_id: "draft", base_revision: 0, definition: clean, changes: sceneChanges(null, clean), affected_node_ids: [] }); return; }
      const result = await request(endpoint, { action: "preview", source_node_id: context.source_node_id, base_revision: context.scene?.revision ?? 0, definition: clean, generation_job_id: generationJob.current });
      setProposal(result.proposal);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function apply() {
    if (!proposal || demo || !context) return;
    setBusy(true); setError("");
    try {
      if (newWorld) {
        creationRequest.current ??= { request_id: crypto.randomUUID(), definition: proposal.definition };
        await request("/api/creator/identity", {});
        const saved = await request("/api/creator/worlds", creationRequest.current);
        window.history.replaceState(null, "", worldEditorHref(saved, {object_id:selected, floor_id:floorId || null}, {view:mode}));
        creationRequest.current = null;
      } else await request(endpoint, { action: "apply", proposal_id: proposal.id });
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const endpoint = context ? `/api/world/${context.session_id}/places/${context.place_id}/scene` : "";
  async function openPlace(pid:string,nextMode:typeof mode="plan"){
    if(!context||dirty||busy)return;
    const previousUrl=window.location.href;
    window.history.replaceState(null,"",`/sketch/world?${new URLSearchParams({world:context.session_id,place:pid})}`);
    setSelected(null);setBusy(true);setError("");
    try{await load();setMode(nextMode);}catch(e){window.history.replaceState(null,"",previousUrl);setError((e as Error).message);}finally{setBusy(false);}
  }
  function switchView(next:typeof mode){
    position.flush();
    setTour(false);setDrawFootprint(false);
    if(mode==="walk"&&next!=="walk"&&network&&walkingPlace&&walkingPlace!==context?.place_id){void openPlace(walkingPlace,next);return;}
    setMode(next);
  }
  useEffect(()=>{
    if(!context?.scene||!definition||demo)return;
    const url=new URL(window.location.href);
    const selection = worldEditorSelection(definition, selected, floorId || null);
    url.searchParams.set("view",mode);
    if(selection.object_id)url.searchParams.set("object",selection.object_id);else url.searchParams.delete("object");
    if(selection.floor_id)url.searchParams.set("floor",selection.floor_id);else url.searchParams.delete("floor");
    window.history.replaceState(null,"",url);
  },[mode,context?.scene,demo,selected,floorId,definition]);
  async function forkWorld() {
    if (!context?.scene || dirty) return;
    setBusy(true); setError("");
    try {
      await request("/api/creator/identity", {});
      if (forkPending.current?.source !== context.session_id) forkPending.current = { source: context.session_id, body: { node_id: context.source_node_id, request_id: crypto.randomUUID() } };
      const saved = await request(`/api/sessions/${forkPending.current.source}/fork`, forkPending.current.body);
      window.history.replaceState(null, "", worldEditorHref({session_id: saved.session_id, place_id: context.place_id}, {object_id: selected, floor_id: floorId || null}, {view: mode, camera: new URLSearchParams(window.location.search).get("camera")}));
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const object = definition?.objects.find(o => o.id === selected);
  const floors = definition?.objects.flatMap(building => building.structure?.floors.map(floor => ({ building, floor })) ?? []) ?? [];
  const activeFloor = floors.find(f => f.floor.id === floorId);
  const placement: FloorPlacement | undefined = activeFloor ? { building_id: activeFloor.building.id, floor_id: activeFloor.floor.id } : undefined;
  function selectObject(id: string) {
    if (!definition) return;
    const next = worldEditorSelection(definition, id, null);
    setSelected(next.object_id); setFloorId(next.floor_id ?? "");
    const selectedObject = definition?.objects.find(o => o.id === id);
    if (selectedObject?.placement) { setFloorId(selectedObject.placement.floor_id); if (!FURNISHINGS.includes(kind)) setKind("bench"); }
  }
  function assignFloor(id: string) {
    if (!definition || !object) return;
    const destination = floors.find(f => f.floor.id === id);
    if (destination) {
      const placed = findFloorPlacement(definition, object, { building_id: destination.building.id, floor_id: id });
      if (!placed) { setError("No clear space on this floor for the object at its current size."); return; }
      updateObject(placed); setFloorId(id); if (!FURNISHINGS.includes(kind)) setKind("bench"); return;
    }
    const resolved = resolveSceneObject(definition, object);
    const ground: PlaceSceneObject = { ...object, x: resolved.x, z: resolved.z, heading: resolved.heading };
    delete ground.placement;
    const candidates = [{ x: ground.x, z: ground.z }];
    for (let z = 1; z < definition.depth; z += 1) for (let x = 1; x < definition.width; x += 1) candidates.push({ x, z });
    for (const point of candidates) {
      const next = { ...ground, ...point, heading: Math.atan2(Math.sin(ground.heading), Math.cos(ground.heading)) };
      if (definition.objects.some(o => o.id !== object.id && !o.placement && o.kind !== "path" && footprintsOverlap(next, o, 0.2))) continue;
      try { change(parsePlaceScene({ ...definition, objects: definition.objects.map(o => o.id === object.id ? next : o) })); setFloorId(""); return; } catch { /* Find valid outdoor ground. */ }
    }
    setError("No clear outdoor space. Enlarge the place or remove an object.");
  }
  const meshBase = context?.session_id && !demo ? `/api/world/${encodeURIComponent(context.session_id)}/meshes` : undefined;
  const materialBase = context?.session_id && !demo ? `/api/world/${encodeURIComponent(context.session_id)}/materials` : undefined;
  const captureMotion: CaptureMotion = async (view, preparation, signal) => {
    const sceneSignal = refreshAbort.current?.signal;
    if (!context?.scene || !sceneSignal || dirty) throw new Error("Save scene changes before preparing motion");
    const { captureMotionReferencesOffscreen } = await import("./camera-motion-capture");
    return captureMotionReferencesOffscreen(view, context.scene, preparation, { mesh: meshBase, material: materialBase }, AbortSignal.any([signal, sceneSignal]));
  };
  async function savedMeshSize(id: string): Promise<MeshDimensions> {
    if (!meshBase) throw new Error("Saved mesh storage is unavailable");
    const response = await fetch(`${meshBase}/${encodeURIComponent(id)}?geometry=1`, { cache: "no-store", signal: AbortSignal.timeout(45_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Saved mesh could not be measured");
    return data.size;
  }
  async function placeMesh(job: Pick<MeshJob, "asset_id" | "prompt">) {
    if (!definition || !job.asset_id || definition.objects.length >= 100 || busy || meshPending.current) return;
    meshPending.current = true; setBusy(true); setMeasuringMesh(true); setError("");
    try {
      const size = await savedMeshSize(job.asset_id);
      if (liveDefinition.current !== definition) throw new Error("The draft changed while measuring the mesh. Place it again.");
      const object: PlaceSceneObject = { ...newComponent("mesh", 0, 0), ...proportionalMeshDimensions(size, { width: 3, height: 3, depth: 3 }), mesh_scale: "uniform", asset_id: job.asset_id, label: job.prompt.slice(0, 100) };
      if (object.width < 0.1 || object.depth < 0.1 || object.height < 0.01) throw new Error("This mesh is too thin for the current placement limits at 3 m. Its proportions have not been changed.");
      if (placement) {
        const placed = findFloorPlacement(definition, object, placement);
        if (!placed) throw new Error("No clear space on this floor for the mesh. Place it outdoors and adjust its size first.");
        change(parsePlaceScene({ ...definition, objects: [...definition.objects, placed] })); setSelected(placed.id); setMode("split"); setFocusKey(k => k + 1); return;
      }
      for (let z = 2; z <= definition.depth - 2; z += 2) for (let x = 2; x <= definition.width - 2; x += 2) {
        object.x = x; object.z = z;
        if (definition.objects.some(o => !o.placement && o.kind !== "path" && footprintsOverlap(object, o, 0.2))) continue;
        try { const next = parsePlaceScene({ ...definition, objects: [...definition.objects, object] }); change(next); setSelected(object.id); setMode("split"); setFocusKey(k => k + 1); return; } catch { /* Try the next unoccupied placement. */ }
      }
      throw new Error("No clear footprint for this mesh. Move or remove an object, or enlarge the place.");
    } catch (e) { setError((e as Error).message); }
    finally { meshPending.current = false; setBusy(false); setMeasuringMesh(false); }
  }
  function setMeshOrientation(orientation: MeshOrientation) {
    if (!object || !definition || busy || meshPending.current) return;
    try { change(parsePlaceScene({ ...definition, objects: definition.objects.map(o => o.id === object.id ? reorientMesh(o, orientation) : o) })); }
    catch (e) { setError((e as Error).message); }
  }
  async function replaceMesh(asset: Pick<MeshJob, "asset_id" | "prompt">) {
    if (!definition || !object?.asset_id || !asset.asset_id || busy || meshPending.current) return;
    meshPending.current = true; setBusy(true); setMeasuringMesh(true); setError("");
    try {
      const size = await savedMeshSize(asset.asset_id);
      if (liveDefinition.current !== definition) throw new Error("The draft changed while measuring the replacement. Try again.");
      change(replaceMeshAsset(definition, object.id, asset.asset_id, size)); setSelected(object.id); setMode("split"); setFocusKey(k => k + 1);
    } catch (e) { setError((e as Error).message); }
    finally { meshPending.current = false; setBusy(false); setMeasuringMesh(false); }
  }
  function duplicateSelectedMesh() {
    if (!definition || !object || busy) return;
    try { const copy = duplicateMesh(definition, object.id); change(copy.definition); setSelected(copy.id); setMode("split"); setFocusKey(k => k + 1); }
    catch (e) { setError((e as Error).message); }
  }
  function toggleMeshShell() {
    if (!definition || !object || busy) return;
    try {
      change(object.kind === "mesh" ? proposeMeshShell(definition, object.id) : removeMeshShell(definition, object.id));
      setFloorId(""); setMode("split"); setFocusKey(k => k + 1);
    } catch (e) { setError((e as Error).message); }
  }
  async function setMeshStretch(stretch: boolean) {
    if (!object?.asset_id || busy || meshPending.current) return;
    if (stretch) { updateObject({ mesh_scale: "stretch" }); return; }
    meshPending.current = true; setBusy(true); setMeasuringMesh(true); setError("");
    try {
      const size = await savedMeshSize(object.asset_id);
      if (liveDefinition.current !== definition) throw new Error("The draft changed while measuring the mesh. Try again.");
      const next = { ...definition!, objects: definition!.objects.map(o => o.id === object.id ? { ...o, ...proportionalMeshDimensions(orientedMeshDimensions(size, o.mesh_orientation), o), mesh_scale: "uniform" as const } : o) };
      change(parsePlaceScene(next));
    } catch (e) { setError((e as Error).message); }
    finally { meshPending.current = false; setBusy(false); setMeasuringMesh(false); }
  }
  const drawing = context?.drawing;
  const shapes = drawing?.scene.elements.filter(e => !e.id.startsWith("ofb-") && !["frame", "image", "text"].includes(e.type) && !e.isDeleted && e.customData?.role !== "mask") ?? [];
  function add() {
    if (!definition) return;
    let o = newComponent(kind, definition.width / 2, definition.depth / 2);
    const element = shapes.find(e => e.id === shape);
    if (element && drawing) {
      o = { ...o, drawing_element_id: element.id, x: (element.x + element.width / 2) / drawing.frame.width * definition.width, z: (element.y + element.height / 2) / drawing.frame.height * definition.depth,
        width: Math.max(0.1, Math.abs(element.width) / drawing.frame.width * definition.width), depth: Math.max(0.1, Math.abs(element.height) / drawing.frame.height * definition.depth), heading: typeof element.angle === "number" ? element.angle : 0 };
    }
    if (placement && activeFloor) {
      const placed = element ? bindObjectToFloor(definition, o, placement) : findFloorPlacement(definition, o, placement);
      if (!placed) { setError("No clear space on the selected floor for this furnishing."); return; }
      try { change(parsePlaceScene({ ...definition, objects: [...definition.objects, placed] })); setSelected(placed.id); }
      catch (e) { setError((e as Error).message); }
      return;
    }
    change({ ...definition, objects: [...definition.objects, o] }); setSelected(o.id);
  }
  function placeFootprint(start: { x: number; z: number }, end: { x: number; z: number }) {
    if (!definition || definition.objects.length >= 100) return;
    let o = footprintComponent(kind, start, end, definition);
    if (!o) return;
    if (placement && activeFloor) {
      // The drawn rectangle stays aligned to the displayed plan; the binding
      // stores its inverse building transform, not a second absolute position.
      o = bindObjectToFloor(definition, o, placement);
    }
    try {
      const next = parsePlaceScene({ ...definition, version: kind === "building" ? 2 : definition.version, objects: [...definition.objects, o] });
      change(next); setSelected(o.id); setDrawFootprint(false);
    } catch (e) { setError((e as Error).message); }
  }
  return <main className={s.editor}>
    <header className={s.header}>
      <a href={context?.source_node_id ? `/sketch?source=${encodeURIComponent(context.requested_source_node_id ?? context.source_node_id)}` : "/"} title={context?.source_node_id ? "Back to Sketch" : "My Worlds"}><ArrowLeft size={18} /><span>{context?.source_node_id ? "Sketch" : "My Worlds"}</span></a>
      {context?.source_node_id && context.scene?.definition.material_pack === "ankh-street-v1" && <a title="Street image" aria-label="Street image" href={`/sketch/world/ankh?source=${encodeURIComponent(context.requested_source_node_id ?? context.source_node_id)}&place=${encodeURIComponent(context.place_id)}`}><ImageIcon size={18} /></a>}
      <strong>World editor</strong><span className={s.status} role="status">{mode==="walk"&&network?`Connected walk · ${network.chunks.length} places`:demo ? "Local preview" : context?.scene ? `Revision ${context.scene.revision}${dirty ? " · Unsaved changes" : " · Saved"}` : "Unpublished place"}</span>
      {context?.scene && !dirty && <>
        <a href={`/api/export/session/${encodeURIComponent(context.session_id)}`} title="Export world" aria-label="Export world"><Download size={17} /></a>
        <button title="Fork world" aria-label="Fork world" disabled={busy} onClick={() => void forkWorld()}><GitFork size={17} /></button>
      </>}
      {context?.scene && context.source_node_id && !dirty && <a href={worldEditorHref(context, {object_id:selected, floor_id:floorId || null}, {map:true, view:mode, camera:selectedCamera})} title="Repaint map artwork" aria-label="Repaint map artwork"><Map size={18} /></a>}
      {context?.scene && context.source_node_id && !dirty && <a href={`/play?continue=${encodeURIComponent(context.session_id)}&node=${encodeURIComponent(context.requested_source_node_id ?? context.source_node_id)}`} title="Explore world" aria-label="Explore world"><Compass size={18} /></a>}
      <button title="Undo draft edit" aria-label="Undo draft edit" disabled={!undoStack.length || busy} onClick={() => { const last = undoStack.at(-1); if (last) {
        setDefinition(last); setUndoStack(old => old.slice(0, -1)); setProposal(null); setError("");
        const restored = last.objects.find(o => o.id === selected);
        if (!restored) setSelected(null);
        else if (restored.placement) setFloorId(restored.placement.floor_id);
      } }}><RotateCcw size={17} /></button>
      <button disabled={!definition || !dirty || busy || (!context?.scene && !confirmedScale)} onClick={() => void preview()}><Eye size={16} />Preview</button>
    </header>
    {measuringMesh && <p className={s.loading} role="status">Measuring saved mesh...</p>}
    {error && <div role="alert" className={s.error}>{error}{creationRequest.current ? <button disabled={busy} onClick={() => void apply()}>Retry save</button> : <button onClick={() => { setError(""); void load().catch(e => setError((e as Error).message)); }}>Reload</button>}</div>}
    {networkError&&<div role="alert" className={s.error}>{networkError}<button onClick={()=>void load().catch(e=>setError((e as Error).message))}>Reload connections</button></div>}
    {position.state.status==="error"&&<div role="alert" className={s.error}>{position.state.message}{position.state.conflict?<button onClick={()=>window.location.reload()}>Reload saved position</button>:<button onClick={position.retry}>Retry position save</button>}</div>}
    {definition && context ? <div className={s.body}>
      <section className={s.stage} inert={busy}>
        <nav className={s.viewTabs} aria-label="Place view">{([
          ["plan", Map, "Plan"], ["illustration", ImageIcon, "Illustration"], ["orbit", Orbit, "3D"], ["split", Columns2, "Plan + 3D"], ["walk", Footprints, "Walk"], ["reference", ImageIcon, "Reference"],
        ] as const).filter(([value]) => value !== "reference" || context.source_url).map(([value, Icon, label]) => <button key={value} disabled={value==="walk"&&(!position.ready||!!networkError||dirty&&(!!network||definition.objects.some(o=>o.kind==="building"&&o.asset_id)))} title={value==="walk"&&dirty?"Save validated geometry before walking":label} aria-pressed={mode === value} onClick={() => switchView(value)}><Icon size={16} />{label}</button>)}
          {(mode === "plan" || mode === "split") && <button title={`Draw ${kind} footprint`} aria-label="Draw footprint" aria-pressed={drawFootprint} disabled={definition.objects.length >= 100} onClick={() => setDrawFootprint(v => !v)}><RectangleHorizontal size={18} /></button>}
          {(mode === "orbit" || mode === "split") && <button title="Frame selected in 3D" aria-label="Frame selected in 3D" disabled={!object} onClick={() => setFocusKey(k => k + 1)}><Focus size={18} /></button>}
          {mode === "walk" && <button title="Return to entrance" aria-label="Return to entrance" onClick={() => {skipResume.current=true;setTour(false); setWalkKey(k => k + 1); }}><RotateCcw size={16} /></button>}
          {ankhDemo && <button disabled={!routeAvailable} title={routeAvailable ? "Walk the approach" : "Route unavailable for edited layout"} aria-label="Walk the approach" onClick={() => { setMode("walk"); setTour(true); setWalkKey(k => k + 1); }}><Play size={16} /></button>}
        </nav>
        {mode !== "walk" && mode !== "reference" && mode !== "illustration" && !!floors.length && <label className={s.stageFooter}>Level<select aria-label="Editing floor" value={activeFloor ? floorId : ""} onChange={e => { const nextFloor = floors.find(f => f.floor.id === e.target.value); setFloorId(e.target.value); if(nextFloor && object?.placement?.floor_id !== nextFloor.floor.id)setSelected(nextFloor.building.id); else if(!nextFloor && object?.placement)setSelected(object.placement.building_id); setDrawFootprint(false); if (e.target.value && !FURNISHINGS.includes(kind)) setKind("bench"); }}><option value="">Outdoors</option>{floors.map(({building, floor}) => <option key={floor.id} value={floor.id}>{building.label} / {floor.label}</option>)}</select></label>}
        <div ref={setIllustrationTarget} className={s.illustrationStage} hidden={mode !== "illustration"} role="region" aria-label="Illustration workspace"><p className={s.illustrationEmpty}>No saved camera view</p></div>
        {mode === "reference" ? <div className={`${s.reference} ${ankhDemo ? s.mapReference : ""}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- saved R2 illustration */}
          <img src={context.source_url ?? undefined} alt="Saved source illustration" style={ankhDemo ? { transform: mapFocused ? "scale(4)" : "scale(1)", transformOrigin: `${DRUM_MAP_ANCHOR.x}% ${DRUM_MAP_ANCHOR.y}%` } : undefined} />
          <span>{ankhDemo ? "Ankh-Morpork · Illustrated map / authored street" : "Saved illustration · Geometry unverified"}</span>
          {ankhDemo && <div className={s.mapActions}><button aria-label={mapFocused ? "Show whole map" : "Focus Mended Drum"} title={mapFocused ? "Show whole map" : "Focus Mended Drum"} onClick={() => setMapFocused(v => !v)}>{mapFocused ? <ZoomOut size={18} /> : <ZoomIn size={18} />}</button><button disabled={!routeAvailable} onClick={() => { setMode("walk"); setTour(true); setWalkKey(k => k + 1); }}><Footprints size={17} />Enter street</button></div>}
        </div> : mode === "illustration" ? null : mode === "split" ? <div className={s.splitViews}>
          <section className={s.splitPane} aria-label="Live plan"><span className={s.paneLabel}>Plan</span><Viewport floorId={activeFloor?.floor.id} assetBaseUrl={meshBase} materialBaseUrl={materialBase} definition={definition} mode="plan" selected={selected} onSelect={selectObject} drawing={drawFootprint} onFootprint={placeFootprint} onCancelDrawing={() => setDrawFootprint(false)} /></section>
          <section className={s.splitPane} aria-label="Live 3D"><span className={s.paneLabel}>3D</span><Viewport floorId={activeFloor?.floor.id} assetBaseUrl={meshBase} materialBaseUrl={materialBase} definition={definition} mode="orbit" selected={selected} focusKey={focusKey} onSelect={selectObject} captureSnapshot={context.scene ?? undefined} onCaptureReady={onCaptureReady} onRefreshReady={onRefreshReady} network={!dirty&&!networkError?network:null} loadView={!dirty ? loadView : undefined}/></section>
        </div> : mode==="walk"&&(!position.ready||!!networkError)?<p className={s.loading}>Loading saved position...</p>:<Viewport floorId={mode === "walk" ? undefined : activeFloor?.floor.id} assetBaseUrl={meshBase} materialBaseUrl={materialBase} key={walkKey} definition={definition} mode={mode} selected={selected} focusKey={focusKey} onSelect={selectObject} network={!dirty&&!networkError?network:null} placeId={context.place_id} onPlaceChange={setWalkingPlace} sceneRevision={context.scene?.revision} getWalkPose={!dirty?getWalkPose:undefined} onWalkPose={!dirty&&!demo&&context.scene?position.record:undefined} route={tour ? (handoff ?? DRUM_APPROACH) : undefined} drawing={mode === "plan" && drawFootprint} onFootprint={placeFootprint} onCancelDrawing={() => setDrawFootprint(false)} captureSnapshot={context.scene ?? undefined} onCaptureReady={onCaptureReady} onRefreshReady={onRefreshReady} loadView={!dirty ? loadView : undefined}/>}
        <footer className={s.stageFooter}><span>{mode==="walk"&&network?`${network.chunks.length} connected places`:`${definition.width} × ${definition.depth} m · Authored dimensions`}</span><span>{mode==="walk"&&network?network.chunks.reduce((n,c)=>n+c.scene.definition.objects.length,0):definition.objects.length} objects</span></footer>
        {mode==="walk"&&!dirty&&context.scene&&<span role="status" className={s.stageFooter}>{position.state.status==="saving"?"Saving position...":position.state.status==="saved"?"Position saved":"Position not saved"}</span>}
      </section>
      <aside className={s.inspector} inert={busy || !!creationRequest.current}>
        {network&&<label>Place<select aria-label="Connected place" disabled={dirty} value={mode==="walk"?walkingPlace??context.place_id:context.place_id} onChange={e=>void openPlace(e.target.value)}>{network.chunks.map(c=><option key={c.scene.place_id} value={c.scene.place_id}>{c.scene.definition.label}</option>)}</select></label>}
        {!demo && context.scene && <PlaceViewLibrary
          key={`${context.session_id}:${context.place_id}`} onLoadPath={loadCameraPath}
          sessionId={context.session_id} placeId={context.place_id} revision={context.scene.revision}
          capture={capture} refreshView={mode === "illustration" ? refreshIllustration : refreshView} captureMotion={captureMotion}
          disabled={dirty || busy || mode === "reference"}
          surfaceTarget={mode === "illustration" ? illustrationTarget : null}
          onOpenIllustration={() => switchView("illustration")} selectedObject={selected} onSelectedViewChange={setSelectedCamera}
          selectedObjectLabel={object?.label} onComposeSelection={mode === "walk" ? undefined : () => { if (!object || dirty || busy) return; setCapture(null); setLoadView(undefined); setMode("orbit"); setFocusKey(k => k + 1); }}
          onSelectObject={id => { if (definition.objects.some(o => o.id === id)) selectObject(id); }}/>
        }
        {/* A /play walk's route, walked in 3D: checkpoint views along it, then one video. */}
        {!demo && context.scene && mode === "walk" && handoff && <WalkVideo key={`walk:${context.session_id}:${context.place_id}:${context.scene.revision}`}
          sessionId={context.session_id} placeId={context.place_id} route={handoff} capture={capture} disabled={dirty || busy}/>}
        {mode==="walk"&&network?<button onClick={()=>void openPlace(walkingPlace??context.place_id)}><Map size={16}/>Edit this place</button>:<>
        {context.scene&&!demo&&<AdjacentPlaceEditor key={`${context.scene.place_id}:${context.scene.revision}`} scene={context.scene} disabled={dirty||mode==="walk"} onSaved={async pid=>{
          const previousUrl=window.location.href;
          if(pid)window.history.replaceState(null,"",`/sketch/world?${new URLSearchParams({world:context.session_id,place:pid})}`);
          try{await load();if(pid){setSelected(null);setMode("plan");}}
          catch(e){window.history.replaceState(null,"",previousUrl);throw e;}
        }} onBusy={setBusy}/>}
        {context.scene&&!demo&&<PlaceBuilder key={`build:${context.scene.place_id}:${context.scene.revision}`} scene={context.scene} targetFloor={placement} onTargetFloorChange={target => { setFloorId(target?.floor_id ?? ""); setSelected(target?.building_id ?? null); setFocusKey(k => k + 1); }} disabled={dirty||mode==="walk"||busy} reviewingBuildId={!busy&&mode!=="walk"?proposal?.generation_job_id:undefined} onBusy={setBusy} onPreview={(p,target)=>{generationJob.current=p.generation_job_id;change(p.definition);setProposal(p);setMode("split");setFloorId(target?.floor_id ?? "");setSelected(target?.building_id ?? null);setFocusKey(k=>k+1);}}/>}
        {!demo && !newWorld && <MeshGenerator sessionId={context.session_id} onPlace={placeMesh} {...(object?.asset_id ? { replacement: { assetId: object.asset_id, replace: replaceMesh } } : {})}/>}
        {!context.scene && <label>Starting layout<select aria-label="Starting layout" value={template} onChange={e => { setTemplate(e.target.value); const next = gardenScene(); change(e.target.value === "ankh" ? ankhDemo ? context.initial : ankhStreetScene() : e.target.value === "garden" ? next : { ...next, label: "New place", objects: [] }); }}><option value="garden">Garden template</option><option value="ankh">Mended Drum street</option><option value="empty">Empty place</option></select></label>}
        <label>Place name<input aria-label="Place name" value={definition.label} maxLength={160} onChange={e => change({ ...definition, label: e.target.value })} /></label>
        <div className={s.fields}>{(["width", "depth"] as const).map(key => <label key={key}>{key === "width" ? "Place width (m)" : "Place depth (m)"}<input aria-label={`Place ${key}`} type="number" min={4} max={100} step={1} value={definition[key]} onChange={e => { setConfirmedScale(false); change({ ...definition, [key]: Number(e.target.value) }); }} /></label>)}</div>
        {!context.scene && <label className={s.checkbox}><input type="checkbox" checked={confirmedScale} onChange={e => setConfirmedScale(e.target.checked)} />Confirm authored dimensions</label>}
        <h2>Objects</h2>
        <div className={s.objects}><button aria-label="Select ground" aria-pressed={!selected && !floorId} onClick={() => { setSelected(null); setFloorId(""); }}><i style={{ backgroundColor: "#88a980" }}/><span>Ground</span><small>surface</small></button>{definition.objects.map(o => <button key={o.id} aria-pressed={selected === o.id} onClick={() => selectObject(o.id)}><i style={{ backgroundColor: o.color }} /><span>{o.label}</span><small>{o.kind}</small></button>)}</div>
        {!object && !floorId && !demo && !newWorld && <GroundMaterialEditor sessionId={context.session_id} binding={definition.ground_material} onChange={ground_material => {
          try { change(parsePlaceScene({ ...definition, ground_material })); } catch (e) { setError((e as Error).message); }
        }}/>}
        <div className={s.addRow}><select aria-label="Component type" value={kind} onChange={e => setKind(e.target.value as PlaceComponent)}>{COMPONENTS.filter(k => !placement || FURNISHINGS.includes(k)).map(k => <option key={k} value={k}>{k[0]!.toUpperCase() + k.slice(1)}</option>)}</select><button title="Add object" aria-label="Add object" disabled={definition.objects.length >= 100} onClick={add}><Plus size={18} /></button></div>
        {!!shapes.length && <label>Drawing shape<select aria-label="Drawing shape" value={shape} onChange={e => setShape(e.target.value)}><option value="">Unbound</option>{shapes.map((e, i) => <option key={e.id} value={e.id}>{e.type} {i + 1}</option>)}</select></label>}
        {object && <div className={s.objectFields}>
          <div className={s.sectionHeading}><h2>{object.kind}</h2>{object.kind === "mesh" && <button title="Duplicate mesh" aria-label="Duplicate mesh" disabled={busy || definition.objects.length >= 100} onClick={duplicateSelectedMesh}><Copy size={16}/></button>}<button title="Remove object" aria-label="Remove object" onClick={() => {
            const next = { ...definition, objects: definition.objects.filter(o => o.id !== object.id) };
            try { validateFloorPlacements(next); change(next); setSelected(null); } catch (e) { setError((e as Error).message); }
          }}><Trash2 size={16} /></button></div>
          <label>Name<input aria-label="Object name" value={object.label} maxLength={100} onChange={e => updateObject({ label: e.target.value })} /></label>
          {FURNISHINGS.includes(object.kind) && !!floors.length && <label>Placement<select aria-label="Object floor" value={object.placement?.floor_id ?? ""} onChange={e => assignFloor(e.target.value)}><option value="">Outdoors</option>{floors.map(({building, floor}) => <option key={floor.id} value={floor.id}>{building.label} / {floor.label}</option>)}</select></label>}
          <div className={s.fields}>{(["x", "z", "width", "depth", "height"] as const).map(key => <label key={key}>{({ x: object.placement ? "Local east" : "East", z: object.placement ? "Local south" : "South", width: "Width", depth: "Depth", height: "Height" })[key]} (m)<input aria-label={`Object ${key}`} type="number" min={key === "x" || key === "z" ? object.placement ? -100 : 0 : 0.01} max={100} step={0.1} value={Number(object[key].toFixed(3))} onChange={e => updateObject({ [key]: Number(e.target.value) })} /></label>)}
          <label>Rotation<input aria-label="Object rotation" type="number" min={-360} max={360} step={5} value={Math.round(object.heading * 180 / Math.PI)} onChange={e => updateObject({ heading: Number(e.target.value) * Math.PI / 180 })} /></label></div>
          {object.asset_id && <><label className={s.checkbox}><input type="checkbox" aria-label="Stretch mesh" disabled={busy} checked={object.mesh_scale !== "uniform"} onChange={e => void setMeshStretch(e.target.checked)}/>Stretch mesh</label><span className={s.meshMeta}>{object.kind === "building" ? "Mesh + authored shell / structural collision" : `${object.mesh_role === "exterior" ? "Solid exterior / no interior" : "Mesh asset"} / box collision`} / {object.mesh_scale === "uniform" ? "proportions locked" : "independent axis sizes"}</span></>}
          {object.kind !== "mesh" && <label className={s.color}>Material color<input aria-label="Material color" type="color" value={object.color} onChange={e => updateObject({ color: e.target.value })} /></label>}
          {object.kind === "volume" && <span className={s.meshMeta}>Authored volume / solid box / no interior</span>}
          {object.asset_id && <MeshOrientationEditor value={object.mesh_orientation} disabled={busy} onChange={setMeshOrientation}/>}
          {object.asset_id && !object.placement && <button disabled={busy} onClick={toggleMeshShell}><RectangleHorizontal size={16}/>{object.kind === "mesh" ? "Add structural shell" : "Remove structural shell"}</button>}
          {object.kind === "building" && object.asset_id && <p role="status" className={s.meshMeta}>{dirty ? proposal ? "Mesh shell / preview validated" : "Mesh shell / validation pending" : "Mesh shell / saved geometry"}</p>}
          {object.kind === "building" && object.structure && <BuildingInspector object={object} definition={definition} activeFloorId={activeFloor?.floor.id} onChange={updateObject} onError={setError} onFloorSelect={id => { setFloorId(id); if (!FURNISHINGS.includes(kind)) setKind("bench"); }}/>}
          {(object.kind === "building" && object.structure || object.kind === "path") && !demo && !newWorld && <MaterialEditor key={object.id} sessionId={context.session_id} object={object} onChange={updateObject}/>}
          {(object.kind === "tavern" || object.kind === "house") && <>
            <div className={s.fields}><label>Eave height (m)<input aria-label="Eave height" type="number" min={0.1} max={object.height - 0.05} step={0.1} value={Number((object.eave_height ?? object.height * 11 / 14).toFixed(3))} onChange={e => updateObject({ eave_height: Number(e.target.value) })} /></label><label>Ridge offset (m)<input aria-label="Ridge offset" type="number" min={-object.width * 0.45} max={object.width * 0.45} step={0.1} value={Number((object.roof_offset ?? 0).toFixed(3))} onChange={e => updateObject({ roof_offset: Number(e.target.value) })} /></label></div>
            <div className={s.addRow} role="group" aria-label="Roof material">{(["terracotta", "teal"] as const).map(material => <button key={material} title={`${material} roof`} aria-label={`${material} roof`} aria-pressed={(object.roof_material ?? "terracotta") === material} onClick={() => updateObject({ roof_material: material })}><span style={{ display: "block", width: 22, height: 22, background: material === "teal" ? "#438780" : "#9a5140", border: "1px solid #647970" }} /></button>)}</div>
          </>}
        </div>}
        <details><summary>Entrance</summary><div className={s.fields}>{(["x", "z"] as const).map(key => <label key={key}>{key === "x" ? "East" : "South"} (m)<input aria-label={`Entrance ${key}`} type="number" step={0.1} value={definition.entrance[key]} onChange={e => change({ ...definition, entrance: { ...definition.entrance, [key]: Number(e.target.value) } })} /></label>)}</div></details>
        {context.history.length > 1 && <label>Restore revision<select aria-label="Restore revision" value="" onChange={e => { const old = context.history.find(h => h.revision === Number(e.target.value)); if (old) { change(old.definition); void preview(old.definition); } }}><option value="">Select revision</option>{context.history.filter(h => h.revision !== context.scene?.revision).map(h => <option key={h.revision} value={h.revision}>Revision {h.revision}</option>)}</select></label>}
        {proposal && <section className={s.proposal} aria-label="World change preview"><h2>Review changes</h2><ul>{[...proposal.changes, ...(!context.scene && definition.material_pack ? sceneChanges(context.initial, proposal.definition) : [])].map((text, i) => <li key={i}>{text}</li>)}</ul><p>{proposal.affected_node_ids.length} saved illustrations remain historical.</p><button className={s.apply} disabled={busy || demo} onClick={() => void apply()}><Check size={17} />Apply to world</button><button onClick={() => setProposal(null)}>Cancel preview</button></section>}
        </>}
      </aside>
    </div> : !error && <p className={s.loading}>Loading place...</p>}
  </main>;
}
