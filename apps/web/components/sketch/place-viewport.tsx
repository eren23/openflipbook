"use client";
import { useEffect, useRef, useState } from "react";
import type { PlaceNetwork, PlaceSceneDefinition, PlaceSceneSnapshot } from "@openflipbook/config";
import { buildPlaceScene, disposePlace, THREE, OrbitControls } from "./place-scene-renderer";
import s from "./world-editor.module.css";
import { routeMovement, type WalkWaypoint } from "@/lib/walk-route";
import { loadPlacePhysics } from "@/lib/place-physics";
import { applyRoofMaterials, applyStreetMaterials } from "./street-materials";
import { batchStreetMeshes } from "./street-batching";
import { DRUM_CAMERA, environmentCamera } from "@/lib/drum-environment";
import { loadGeneratedMeshes } from "./generated-mesh";
import { placeCollider } from "@/lib/place-colliders";
import { buildConnectedPlaces } from "./connected-place-renderer";
import { networkPlaceAt } from "@/lib/place-connections";
import {poseInsidePlace,poseSpaceMatches,walkSpace,wrapYaw,type WalkPose} from "@/lib/walk-position";
import {walkPositionClear} from "@/lib/walk-position-physics";
import { resolveSceneObject } from "@/lib/floor-placement";
import { roomLayoutGeometry } from "@/lib/room-layout";
import { loadSurfaceMaterials } from "./surface-materials";
import { capturePlaceView } from "./place-view-capture";
import type { ViewCapture, SavedPlaceView, RefreshPlaceView } from "@/lib/place-view";
import { refreshPlaceView } from "./place-view-refresh";
import { orbitPose, orbitPosition, sampleCameraPath, type CameraRig, type CameraPathDraft } from "@/lib/camera-path";
import { parseSavedCameraPath } from "@/lib/saved-camera-path";
import CameraPathControls from "./camera-path-controls";
import { createCameraPathChecker } from "@/lib/camera-path-check";
import { cameraCollisionSurfaces } from "./camera-collision-surfaces";
import ViewportRecorder from "./viewport-recorder";
import { objectCameraFrame } from "@/lib/object-camera-frame";
import { WalkInput, walkKey } from "@/lib/walk-input";
import WalkControls from "./walk-controls";
import { ViewportPerformance } from "@/lib/viewport-performance";

export default function PlaceViewport({ definition: localDefinition, mode, loadView, onSelect, route, selected, focusKey = 0, drawing = false, onFootprint, onCancelDrawing, assetBaseUrl, materialBaseUrl, network, placeId, onPlaceChange, sceneRevision, getWalkPose, onWalkPose, floorId, captureSnapshot, onCaptureReady, onRefreshReady }: { definition: PlaceSceneDefinition; mode: "plan" | "orbit" | "walk"; loadView?: { requestId: string; view: SavedPlaceView } | undefined; onSelect: (id: string) => void; route?: readonly WalkWaypoint[] | undefined; selected?: string | null; focusKey?: number; drawing?: boolean; onFootprint?: (start: { x: number; z: number }, end: { x: number; z: number }) => void; onCancelDrawing?: () => void; assetBaseUrl?: string | undefined; materialBaseUrl?: string | undefined; network?: PlaceNetwork | null; placeId?: string; onPlaceChange?: (id:string)=>void; sceneRevision?:number|undefined; getWalkPose?:(()=>WalkPose|null)|undefined; onWalkPose?:((pose:WalkPose)=>void)|undefined; floorId?: string | undefined; captureSnapshot?: PlaceSceneSnapshot | undefined; onCaptureReady?: ((capture: (() => ViewCapture) | null) => void) | undefined; onRefreshReady?: ((refresh: RefreshPlaceView | null) => void) | undefined }) {
  const host = useRef<HTMLDivElement>(null), input = useRef(new WalkInput());
  const captureRef = useRef(onCaptureReady); captureRef.current = onCaptureReady;
  const refreshRef = useRef(onRefreshReady); refreshRef.current = onRefreshReady;
  const loadRef = useRef(loadView); loadRef.current = loadView;
  const lastFrame = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState("");
  const [cameraRig, setCameraRig] = useState<{ id: number; rig: CameraRig; initial?: CameraPathDraft } | null>(null);
  const rigSequence = useRef(0);
  const [routeStatus, setRouteStatus] = useState("");
  const [currentPlace,setCurrentPlace]=useState("");
  const [currentRoom, setCurrentRoom] = useState("");
  const [draft, setDraft] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const selectRef = useRef(onSelect); selectRef.current = onSelect;
  const placeRef=useRef(onPlaceChange);placeRef.current=onPlaceChange;
  const poseRef=useRef({getWalkPose,onWalkPose});poseRef.current={getWalkPose,onWalkPose};
  const [recovery,setRecovery]=useState("");
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const focusRef = useRef(focusKey); focusRef.current = focusKey;
  const drawRef = useRef({ drawing, onFootprint, onCancelDrawing }); drawRef.current = { drawing, onFootprint, onCancelDrawing };
  useEffect(() => { if (!drawing) setDraft(null); }, [drawing]);
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const walkInput = input.current;
    delete container.dataset.ready;
    delete container.dataset.camera;
    delete container.dataset.routeState;
    delete container.dataset.placeId;
    delete container.dataset.loadedPlaces;
    delete container.dataset.poseRestore;
    delete container.dataset.performance;
    const performanceStats = new ViewportPerformance();
    let stopped = false, frame = 0, revealFrame = 0, dirty = true, capturePublished = false;
    captureRef.current?.(null);
    refreshRef.current?.(null);
    const abort = new AbortController();
    let cleanup = () => {};
    setError(""); setCurrentPlace(""); setCurrentRoom("");setRecovery(""); walkInput.clear();
    setRouteStatus(route ? "Walking to the Drum" : "");
    void (async () => {
      const connected=network&&placeId&&mode==="walk"?buildConnectedPlaces(network,placeId):null;
      const definition=connected?.definition??localDefinition;
      const { scene, solids } = connected??buildPlaceScene(definition, {cutaway: mode === "plan", floorId: mode === "walk" ? undefined : floorId});
      const resolvedObjects = definition.objects.map(o => resolveSceneObject(definition, o));
      let renderer: THREE.WebGLRenderer;
      try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
      catch { disposePlace(scene); throw new Error("3D is unavailable in this browser"); }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
      renderer.domElement.style.visibility = "hidden";
      container.appendChild(renderer.domElement);
      const extent = Math.max(definition.width, definition.depth);
      const streetReference = mode === "orbit" && definition.material_pack === "ankh-street-v1";
      const camera = mode === "plan" ? new THREE.OrthographicCamera() : streetReference ? environmentCamera() : new THREE.PerspectiveCamera(60, 1, 0.05, Math.max(400,extent*6));
      const cx = definition.width / 2, cz = definition.depth / 2;
      if (mode === "plan") { camera.position.set(cx, extent * 2, cz); camera.up.set(0, 0, -1); camera.lookAt(cx, 0, cz); }
      else if (!streetReference) { camera.position.set(cx + extent * 0.68, extent * 0.75, cz + extent * 0.86); camera.lookAt(cx, 0, cz); }
      const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(cx, 0, cz);
      // OrbitControls changes orientation in its constructor; restore the authored target.
      if (streetReference) controls.target.fromArray(DRUM_CAMERA.target);
      let applyingCameraPath = false;
      controls.addEventListener("change", () => { dirty = true; if (streetReference && !applyingCameraPath) camera.position.y = Math.max(1.6, camera.position.y); });
      controls.enabled = mode === "orbit"; controls.maxPolarAngle = streetReference ? Math.PI * 0.7 : Math.PI / 2 - 0.04; controls.minDistance = 2; controls.maxDistance = extent * 3;
      const minimumCameraElevation = Math.ceil(THREE.MathUtils.radToDeg(Math.PI / 2 - controls.maxPolarAngle));
      if (mode === "orbit") {
        controls.minPolarAngle = THREE.MathUtils.degToRad(1);
        controls.maxPolarAngle = THREE.MathUtils.degToRad(90 - minimumCameraElevation);
      }
      controls.update();
      let targetLabel = "Scene centre";
      let cameraTargetId: string | null = null;
      let pathDraft: CameraPathDraft | null = null, fixedProjection: number[] | null = null;
      let pathChecker: ReturnType<typeof createCameraPathChecker> | null = null;
      let checkedClearance = 0;
      const cameraClearance = () => {
        if (!(camera instanceof THREE.PerspectiveCamera)) return 0.2;
        const halfHeight = camera.near * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        return Math.max(0.2, Math.hypot(camera.near, halfHeight, halfHeight * camera.aspect));
      };
      const cameraListeners = new Set<(event: "start" | "end" | "reset") => void>();
      const emitCamera = (event: "start" | "end" | "reset") => cameraListeners.forEach(listener => listener(event));
      const manualStart = () => emitCamera("start");
      const previousTarget = controls.target.clone();
      const manualEnd = () => {
        if (!previousTarget.equals(controls.target)) { targetLabel = "Custom pivot"; cameraTargetId = null; emitCamera("reset"); }
        else emitCamera("end");
        previousTarget.copy(controls.target);
      };
      controls.addEventListener("start", manualStart); controls.addEventListener("end", manualEnd);
      const rig: CameraRig = {
        minElevation: minimumCameraElevation, maxElevation: 89,
        minDistance: controls.minDistance, maxDistance: controls.maxDistance,
        read: () => orbitPose(camera.position, controls.target),
        write: pose => {
          if (stopped || !Object.values(pose).every(Number.isFinite)) return;
          const bounded = { azimuth: pose.azimuth, elevation: THREE.MathUtils.clamp(pose.elevation, rig.minElevation, rig.maxElevation), distance: THREE.MathUtils.clamp(pose.distance, rig.minDistance, rig.maxDistance) };
          applyingCameraPath = true;
          try { camera.position.copy(orbitPosition(controls.target, bounded)); controls.update(); dirty = true; }
          finally { applyingCameraPath = false; }
        },
        targetSelection: () => {
          fixedProjection = null; resize();
          const object = resolvedObjects.find(o => o.id === selectedRef.current);
          controls.target.set(object?.x ?? cx, object ? object.elevation + object.height / 2 : 0, object?.z ?? cz);
          targetLabel = object?.label ?? "Scene centre"; cameraTargetId = object?.id ?? null; previousTarget.copy(controls.target);
          rig.write(rig.read()); return targetLabel;
        },
        targetLabel: () => targetLabel,
        setActive: active => { controls.enablePan = !active; },
        draft: state => { pathDraft = state ? { version: 1, ...structuredClone(state), pivot: controls.target.toArray(), target_id: cameraTargetId } : null; },
        check: async frames => {
          const pivot = controls.target.clone(), targetId = cameraTargetId;
          if (!(camera instanceof THREE.PerspectiveCamera)) throw new Error("Camera paths require a perspective camera");
          const clearance = cameraClearance(); checkedClearance = clearance;
          const checker = await (pathChecker ??= createCameraPathChecker(solids, cameraCollisionSurfaces(scene)).catch(error => { pathChecker = null; throw error; }));
          if (stopped || disposed) throw new Error("Camera geometry is no longer available");
          return checker.check(frames, pivot, clearance, targetId ?? undefined);
        },
        subscribe: listener => { cameraListeners.add(listener); return () => { cameraListeners.delete(listener); }; },
      };
      const resize = () => {
        dirty = true;
        const cw = Math.max(1, container.clientWidth), ch = Math.max(1, container.clientHeight);
        const aspect = fixedProjection ? fixedProjection[5]! / fixedProjection[0]! : cw / Math.max(ch, 1);
        const w = Math.max(1, Math.min(cw, ch * aspect)), h = Math.max(1, Math.min(ch, cw / aspect));
        renderer.setSize(w, h, false);
        Object.assign(renderer.domElement.style, { width: `${w}px`, height: `${h}px`, left: `${(cw - w) / 2}px`, top: `${(ch - h) / 2}px` });
        if (camera instanceof THREE.OrthographicCamera) {
          const half = Math.max(definition.depth / 2 + 1, (definition.width / 2 + 1) * h / Math.max(w, 1));
          camera.left = -half * w / h; camera.right = half * w / h; camera.top = half; camera.bottom = -half;
        } else camera.aspect = aspect;
        camera.updateProjectionMatrix();
        if (fixedProjection) { camera.projectionMatrix.fromArray(fixedProjection); camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert(); }
        if (checkedClearance && cameraClearance() > checkedClearance + 1e-6) { checkedClearance = 0; emitCamera("start"); }
      };
      const observer = new ResizeObserver(resize); observer.observe(container); resize();
      let yaw = definition.entrance.yaw, pitch = 0;
      let guiding = !!route, stalled = 0;
      const routeState = { index: 0, held: 0 };
      const endRoute = (status: string) => { guiding = false; container.dataset.routeState = status; setRouteStatus(status === "complete" ? "At the Mended Drum" : status === "blocked" ? "Route blocked" : ""); };
      let pointer: { x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;
      let footprintStart: { x: number; z: number; px: number; py: number } | null = null;
      const groundPoint = (e: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
        return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      };
      const down = (e: PointerEvent) => {
        if (!e.isPrimary || e.button !== 0) return;
        pointer = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false }; renderer.domElement.setPointerCapture(e.pointerId);
        if (mode === "plan" && drawRef.current.drawing) {
          const p = groundPoint(e), rect = renderer.domElement.getBoundingClientRect();
          if (p && p.x >= 0 && p.x <= definition.width && p.z >= 0 && p.z <= definition.depth) footprintStart = { x: p.x, z: p.z, px: e.clientX - rect.left, py: e.clientY - rect.top };
        }
      };
      const move = (e: PointerEvent) => {
        if (!pointer) return;
        const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
        if (Math.abs(e.clientX - pointer.startX) + Math.abs(e.clientY - pointer.startY) > 2) pointer.moved = true;
        if (footprintStart && drawRef.current.drawing) {
          const rect = renderer.domElement.getBoundingClientRect();
          const px = Math.max(0, Math.min(rect.width, e.clientX - rect.left)), py = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
          setDraft({ left: Math.min(px, footprintStart.px), top: Math.min(py, footprintStart.py), width: Math.abs(px - footprintStart.px), height: Math.abs(py - footprintStart.py) });
        }
        if (mode === "walk") { if (guiding && pointer.moved) endRoute("cancelled"); yaw -= dx * 0.005; pitch = THREE.MathUtils.clamp(pitch - dy * 0.005, -1.1, 1.1); }
        pointer.x = e.clientX; pointer.y = e.clientY;
      };
      const up = (e: PointerEvent) => {
        if (mode === "plan" && drawRef.current.drawing) {
          const p = groundPoint(e);
          if (footprintStart && p && pointer?.moved) drawRef.current.onFootprint?.(footprintStart, p);
        } else if (pointer && !pointer.moved) {
          const rect = renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
          ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
          const target = ray.intersectObjects(scene.children, true).find(hit => {
            if (!hit.object.userData.objectId) return false;
            for (let parent: THREE.Object3D | null = hit.object; parent; parent = parent.parent) if (!parent.visible) return false;
            return true;
          });
          if (target) selectRef.current(target.object.userData.objectId);
        }
        pointer = null; footprintStart = null; setDraft(null);
      };
      const cancel = () => { pointer = null; footprintStart = null; setDraft(null); };
      const keydown = (e: KeyboardEvent) => { if (e.key === "Escape" && drawRef.current.drawing) { cancel(); drawRef.current.onCancelDrawing?.(); return; } if (mode !== "walk" || (e.target as HTMLElement)?.closest("input,select,textarea,[contenteditable=true]")) return; const key = walkKey(e.key); if (key) { walkInput.hold(key, `keyboard:${key}`); e.preventDefault(); } };
      const keyup = (e: KeyboardEvent) => { const key = walkKey(e.key); if (key) walkInput.release(`keyboard:${key}`); };
      const blur = () => walkInput.clear();
      const visibility = () => { performanceStats.reset(); delete container.dataset.performance; if (document.hidden) blur(); };
      renderer.domElement.addEventListener("pointerdown", down); renderer.domElement.addEventListener("pointermove", move); renderer.domElement.addEventListener("pointerup", up); renderer.domElement.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup); window.addEventListener("blur", blur);
      document.addEventListener("visibilitychange", visibility);
      let step: ((dt: number) => void) | undefined, freePhysics = () => {};
      let disposed = false;
      let outline: THREE.LineSegments | null = null, outlinedId: string | null | undefined;
      const clearOutline = () => { if (outline) { scene.remove(outline); outline.geometry.dispose(); (outline.material as THREE.Material).dispose(); outline = null; } };
      cleanup = () => {
        if (disposed) return; disposed = true;
        cancelAnimationFrame(revealFrame);
        captureRef.current?.(null);
        refreshRef.current?.(null);
        setCameraRig(null); cameraListeners.clear();
        if (pathChecker) void pathChecker.then(checker => checker.free()).catch(() => {});
        delete container.dataset.ready;
        delete container.dataset.performance; performanceStats.reset();
        observer.disconnect(); controls.removeEventListener("start", manualStart); controls.removeEventListener("end", manualEnd); controls.dispose(); renderer.domElement.removeEventListener("pointerdown", down); renderer.domElement.removeEventListener("pointermove", move); renderer.domElement.removeEventListener("pointerup", up); renderer.domElement.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur);
        document.removeEventListener("visibilitychange", visibility); walkInput.clear();
        clearOutline(); freePhysics(); disposePlace(scene); renderer.dispose();
        // Keep the last rendered pixels until its replacement has decoded textures and drawn.
        if (lastFrame.current !== renderer.domElement) renderer.domElement.remove();
      };
      let textured=0;
      for(const part of connected?.parts??[{scene,definition}]){
        if(part.definition.material_pack==="ankh-street-v1")textured+=await applyStreetMaterials(part.scene,abort.signal);
        if(stopped)return;
        applyRoofMaterials(part.scene,part.definition);
        textured += await loadSurfaceMaterials(part.scene, part.definition, materialBaseUrl, abort.signal);
        if (stopped) return;
        batchStreetMeshes(part.scene);
        await loadGeneratedMeshes(part.scene,part.definition,assetBaseUrl,abort.signal);
        if(stopped)return;
      }
      container.dataset.textured=String(textured);
      container.dataset.loadedPlaces=String(connected?.chunks.length??1);
      if (stopped) return;
      if (mode === "orbit") setCameraRig({ id: ++rigSequence.current, rig });
      if (mode === "walk") {
        const R = await loadPlacePhysics();
        if (stopped) return;
        const world = new R.World({ x: 0, y: -9.81, z: 0 });
        freePhysics = () => world.free();
        for (const box of solids) world.createCollider(placeCollider(R,box));
        world.step();
        const chunks=connected?.chunks??(placeId&&sceneRevision?[{x:0,z:0,scene:{place_id:placeId,revision:sceneRevision,definition:localDefinition}}]:[]);
        const saved=poseRef.current.getWalkPose?.(),savedChunk=saved?chunks.find(c=>c.scene.place_id===saved.place_id):undefined;
        let spawn={x:definition.entrance.x,y:0.82,z:definition.entrance.z};
        if(saved&&savedChunk&&(saved.space!==undefined||saved.scene_revision===savedChunk.scene.revision)&&poseInsidePlace(saved,savedChunk.scene.definition)&&poseSpaceMatches(saved,savedChunk.scene.definition)){
          const candidate={x:saved.position.x+savedChunk.x,y:saved.position.y,z:saved.position.z+savedChunk.z};
          if(walkPositionClear(R,world,candidate)){
            spawn=candidate;yaw=saved.yaw;pitch=saved.pitch;
            container.dataset.poseRestore=saved.scene_revision===savedChunk.scene.revision?"restored":"revalidated";
          }
        }
        if(saved&&!container.dataset.poseRestore){
          if(savedChunk){spawn={x:savedChunk.x+savedChunk.scene.definition.entrance.x,y:0.82,z:savedChunk.z+savedChunk.scene.definition.entrance.z};yaw=savedChunk.scene.definition.entrance.yaw;}
          setRecovery("Saved position is no longer available. Returned to the entrance.");container.dataset.poseRestore="recovered";
        }
        if(!walkPositionClear(R,world,spawn)){
          const raised={...spawn,y:spawn.y+0.2};
          if(!walkPositionClear(R,world,raised))throw new Error("The entrance is obstructed. Edit the place before walking.");
          spawn=raised;
        }
        const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x,spawn.y,spawn.z));
        const collider = world.createCollider(R.ColliderDesc.capsule(0.5, 0.3), body);
        const controller = world.createCharacterController(0.02); controller.enableSnapToGround(0.2); controller.setSlideEnabled(true);
        if (definition.version === 2) controller.enableAutostep(0.25, 0.2, false);
        // Populate the query pipeline before the first character movement.
        world.step();
        let verticalSpeed = 0,poseElapsed=0;
        step = dt => {
          if (guiding && walkInput.active) endRoute("cancelled");
          const pressed = walkInput.sample(dt);
          yaw += (pressed("ArrowLeft") - pressed("ArrowRight")) * dt * 1.5;
          const forward = pressed("w") + pressed("ArrowUp") - pressed("s") - pressed("ArrowDown"), right = pressed("d") - pressed("a");
          const norm = Math.max(1, Math.hypot(forward, right)), speed = 2.5 * dt / norm;
          const old = body.translation();
          let x = (right * Math.cos(yaw) - forward * Math.sin(yaw)) * speed, z = (-forward * Math.cos(yaw) - right * Math.sin(yaw)) * speed;
          if (guiding && route) {
            const movement = routeMovement(route, routeState, old, yaw, dt);
            x = movement.x; z = movement.z; yaw = movement.yaw;
            container.dataset.routeState = "walking";
            if (movement.done) endRoute("complete");
          }
          verticalSpeed = controller.computedGrounded() ? -0.2 : Math.max(-20, verticalSpeed - 9.81 * dt);
          controller.computeColliderMovement(collider, { x: THREE.MathUtils.clamp(old.x + x, 0.35, definition.width - 0.35) - old.x, y: definition.version === 2 ? verticalSpeed * dt : -0.08, z: THREE.MathUtils.clamp(old.z + z, 0.35, definition.depth - 0.35) - old.z });
          const delta = controller.computedMovement();
          if (guiding) {
            stalled = Math.hypot(x, z) > 0.001 && Math.hypot(delta.x, delta.z) < Math.hypot(x, z) * 0.1 ? stalled + dt : 0;
            if (stalled > 1.5) endRoute("blocked");
          }
          // The authored place has a flat floor at Y=0. Keep Rapier's contact
          // tolerance from accumulating a small downward camera drift.
          body.setNextKinematicTranslation({ x: old.x + delta.x, y: Math.max(0.82, old.y + delta.y), z: old.z + delta.z });
          world.timestep = dt; world.step();
          const pos = body.translation(); camera.position.set(pos.x, pos.y + 0.78, pos.z); camera.rotation.set(pitch, yaw, 0, "YXZ");
          poseElapsed+=dt;
          if(poseElapsed>=0.25){
            poseElapsed=0;
            const pid=connected?networkPlaceAt(connected.chunks,pos.x,pos.z):placeId;
            const chunk=chunks.find(c=>c.scene.place_id===pid);
            if(chunk){
              const round=(v:number)=>Math.round(v*1000)/1000;
              const localPosition={x:round(Math.max(0,Math.min(chunk.scene.definition.width,pos.x-chunk.x))),y:round(pos.y),z:round(Math.max(0,Math.min(chunk.scene.definition.depth,pos.z-chunk.z)))};
              const space = walkSpace(chunk.scene.definition, localPosition), building = chunk.scene.definition.objects.find(o => o.id === space?.building_id);
              const floor = building?.structure?.floors.findIndex(f => f.id === space?.floor_id) ?? -1;
              const room = building && floor >= 0 ? roomLayoutGeometry(building, floor).rooms.find(r => r.id === space?.room_id) : undefined;
              setCurrentRoom(building && floor >= 0 ? [building.label, building.structure!.floors[floor]!.label, room?.label].filter(Boolean).join(" / ") : "");
              if (poseRef.current.onWalkPose && walkPositionClear(R,world,pos,collider)) poseRef.current.onWalkPose({version:1,place_id:chunk.scene.place_id,scene_revision:chunk.scene.revision,
                position:localPosition,yaw:wrapYaw(yaw),pitch,space});
            }
          }
          if(connected){
            const pid=networkPlaceAt(connected.chunks,pos.x,pos.z);
            if(pid!==container.dataset.placeId){container.dataset.placeId=pid??"";setCurrentPlace(connected.chunks.find(c=>c.scene.place_id===pid)?.scene.definition.label??"");if(pid)placeRef.current?.(pid);}
          }
        };
      }
      let last = performance.now(), focused = 0, loadedRequest = "";
      const renderedPosition = camera.position.clone(), renderedRotation = camera.quaternion.clone();
      const restorePath = async (request: NonNullable<typeof loadView>) => {
        const view = request.view, source = view.sources[0];
        if (view.historical || !view.path || mode !== "orbit" || !(camera instanceof THREE.PerspectiveCamera) || view.sources.length !== 1
          || !captureSnapshot || source?.scene_id !== captureSnapshot.id || source.place_id !== captureSnapshot.place_id || source.revision !== captureSnapshot.revision
          || view.floor_id !== (floorId ?? null) || JSON.stringify(localDefinition) !== JSON.stringify(captureSnapshot.definition)) throw new Error("Saved path geometry or floor is no longer current");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(localDefinition)));
        if ([...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("") !== source.definition_sha256) throw new Error("Saved path geometry differs from this scene");
        const path = parseSavedCameraPath(view.path, view.camera, [{ ...source, definition: localDefinition }]);
        if (path.keyframes.some(f => f.elevation < rig.minElevation - 1e-6 || f.elevation > rig.maxElevation + 1e-6 || f.distance < rig.minDistance - 1e-6 || f.distance > rig.maxDistance + 1e-6)) throw new Error("Saved path exceeds the current camera limits");
        if (stopped || disposed || loadRef.current !== request) return;
        emitCamera("start"); setError(""); focused = focusRef.current;
        fixedProjection = [...view.camera.projection_matrix]; camera.near = view.camera.near; camera.far = view.camera.far;
        camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(1 / fixedProjection[5]!));
        controls.target.fromArray(path.pivot); previousTarget.copy(controls.target); cameraTargetId = path.target_id;
        targetLabel = resolvedObjects.find(o => o.id === path.target_id)?.label ?? "Saved pivot";
        pathDraft = path; resize(); rig.write(sampleCameraPath(path.keyframes, path.time));
        setCameraRig({ id: ++rigSequence.current, rig, initial: path });
        cancelAnimationFrame(revealFrame);
        revealFrame = requestAnimationFrame(() => {
          if (stopped || loadRef.current !== request) return;
          const stage = container.closest<HTMLElement>(`.${s.stage}`);
          if (stage) { stage.scrollTop = 0; stage.scrollIntoView({ block: "start", behavior: "instant" }); }
        });
      };
      const draw = (now: number) => {
        if (stopped) return;
        const cpuStart = performance.now(); let rendered = false;
        const dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000)); last = now;
        try {
          const request = loadRef.current;
          if (mode === "orbit" && request && request.requestId !== loadedRequest) {
            loadedRequest = request.requestId;
            void restorePath(request).catch(e => { if (!stopped && loadRef.current === request) setError((e as Error).message); });
          }
          if (mode === "orbit" && camera instanceof THREE.PerspectiveCamera && focused !== focusRef.current) {
            focused = focusRef.current;
            const object = resolvedObjects.find(o => o.id === selectedRef.current);
            if (object) {
              fixedProjection = null; pathDraft = null; resize();
              const framed = objectCameraFrame(object, camera.getEffectiveFOV(), camera.aspect, controls.minDistance);
              controls.target.copy(framed.target);
              // A portrait viewport may need more distance than the default orbit limit.
              controls.maxDistance = Math.max(extent * 3, framed.distance);
              rig.maxDistance = controls.maxDistance;
              camera.far = Math.max(camera.far, framed.distance + framed.radius * 2); camera.updateProjectionMatrix();
              camera.position.copy(framed.position); controls.update(); dirty = true;
              capturePublished = false;
              targetLabel = object.label; cameraTargetId = object.id; previousTarget.copy(controls.target); emitCamera("reset");
            }
          }
          if (outlinedId !== selectedRef.current) {
            clearOutline(); outlinedId = selectedRef.current; dirty = true;
            const object = resolvedObjects.find(o => o.id === outlinedId);
            if (object && mode !== "walk" && (!object.placement || !floorId && mode === "orbit" || object.placement.floor_id === floorId)) {
              const box = new THREE.BoxGeometry(object.width, object.height, object.depth);
              outline = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: "#167ca4", depthTest: false, transparent: true, opacity: 0.85 }));
              box.dispose(); outline.position.set(object.x, object.elevation + object.height / 2, object.z); outline.rotation.y = -object.heading; outline.renderOrder = 10; scene.add(outline);
            }
          }
          if (step) step(dt); else if (mode === "orbit") controls.update();
          // Physics and pose recovery continue while idle; static geometry only
          // needs another draw when the camera changes (or recording requests it).
          dirty ||= !camera.position.equals(renderedPosition) || !camera.quaternion.equals(renderedRotation);
          if (dirty || renderer.domElement.dataset.recording === "true") {
            renderer.render(scene, camera); dirty = false; rendered = true;
            renderedPosition.copy(camera.position); renderedRotation.copy(camera.quaternion);
            if (lastFrame.current !== renderer.domElement) {
              lastFrame.current?.remove(); lastFrame.current = renderer.domElement;
              renderer.domElement.style.visibility = "visible";
            }
          }
        } catch (e) { cleanup(); setError((e as Error).message); return; }
        container.dataset.camera = camera.position.toArray().map(n => n.toFixed(3)).join(",");
        container.dataset.direction = camera.getWorldDirection(new THREE.Vector3()).toArray().map(n => n.toFixed(6)).join(",");
        container.dataset.projection = camera.projectionMatrix.toArray().join(",");
        container.dataset.yaw = yaw.toFixed(4);
        container.dataset.ready = "true";
        if (!capturePublished && captureSnapshot) {
          capturePublished = true;
          refreshRef.current?.(async view => {
            if (stopped || disposed) throw new Error("Camera view is no longer available");
            if (JSON.stringify(localDefinition) !== JSON.stringify(captureSnapshot.definition)) throw new Error("Save scene changes before refreshing a view");
            return refreshPlaceView(renderer, view, captureSnapshot, network, { mesh: assetBaseUrl, material: materialBaseUrl }, abort.signal);
          });
          captureRef.current?.(() => {
            if (stopped || disposed) throw new Error("Camera view is no longer available");
            if (JSON.stringify(localDefinition) !== JSON.stringify(captureSnapshot.definition)) throw new Error("Save scene changes before capturing a view");
            const sources = (connected?.chunks ?? [{ scene: captureSnapshot, x: 0, z: 0 }]).map(({ scene: source, x, z }) => ({ scene_id: source.id, place_id: source.place_id, revision: source.revision, definition: source.definition, x, z }));
            const path = pathDraft ? structuredClone(pathDraft) : null;
            if (path && mode === "orbit") { emitCamera("start"); rig.write(sampleCameraPath(path.keyframes, path.time)); }
            const captured = capturePlaceView(renderer, scene, camera, sources, mode, floorId);
            return path && mode === "orbit" ? { ...captured, path } : captured;
          });
        }
        const measured = performanceStats.record(now, performance.now() - cpuStart, rendered, !document.hidden);
        if (measured) container.dataset.performance = JSON.stringify({ ...measured, mode,
          draw_calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
          canvas_width: renderer.domElement.width, canvas_height: renderer.domElement.height,
          pixel_ratio: renderer.getPixelRatio() });
        frame = requestAnimationFrame(draw);
      };
      if (!stopped) frame = requestAnimationFrame(draw);
    })().catch(e => { cleanup(); if (!stopped) setError((e as Error).message); });
    return () => { stopped = true; abort.abort(); cancelAnimationFrame(frame); cleanup(); walkInput.clear(); };
  }, [localDefinition, mode, route, assetBaseUrl, materialBaseUrl, network, placeId, sceneRevision, floorId, captureSnapshot]);
  return <div className={s.viewportWrap}>
    {recovery && <p role="status" className={s.recoveryStatus}>{recovery}</p>}
    {currentRoom && <p role="status" aria-label="Current room" className={s.recoveryStatus}>{currentRoom}</p>}
    <div className={s.viewportArea}>
    <div ref={host} className={s.viewport} data-testid="place-viewport" data-mode={mode} data-drawing={drawing} data-selected={selected ?? ""} />
    <ViewportRecorder viewKey={`${mode}:${floorId ?? ""}:${sceneRevision ?? ""}`} boundary={localDefinition} canvas={() => host.current?.dataset.ready === "true" ? lastFrame.current : null}/>
    {draft && <div className={s.footprintDraft} style={draft} />}
    {error && <p role="alert" className={s.canvasError}>{error}</p>}
    {routeStatus && <span role="status" className={s.routeStatus}>{routeStatus}</span>}
    {currentPlace && <span role="status" className={s.routeStatus}>{currentPlace}</span>}
    {mode === "walk" && <WalkControls input={input.current}/>}
    </div>
    {mode === "orbit" && cameraRig && <CameraPathControls key={cameraRig.id} rig={cameraRig.rig} selected={selected} initialPath={cameraRig.initial}/>}
  </div>;
}
