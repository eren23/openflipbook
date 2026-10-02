import type { ObserverPose, PlaceSceneDefinition, WorldVec2 } from "@openflipbook/config";
import type { WalkWaypoint } from "./walk-route";
import {storeyHeight} from "./building-structure";
import {roomAt} from "./room-layout";
import {footprintContainsPoint} from "./building-footprint";

interface WalkSpace {building_id:string;floor_id:string;room_id?:string}

export interface WalkPose {
  version: 1;
  place_id: string;
  scene_revision: number;
  // Place-local metres; y is the capsule centre, not the camera's eye height.
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  space?: WalkSpace | null;
}
export interface SavedWalkPosition { revision: number; pose: WalkPose | null }
export interface WalkPositionWrite { request_id: string; base_revision: number; pose: WalkPose }

export function parseWalkPose(value: unknown): WalkPose | null {
  if (!value || typeof value !== "object") return null;
  const v = value as WalkPose, p = v.position;
  if (v.version !== 1 || typeof v.place_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.place_id)
    || !Number.isSafeInteger(v.scene_revision) || v.scene_revision < 1 || !p
    || ![p.x,p.y,p.z,v.yaw,v.pitch].every(Number.isFinite)
    || p.x < 0 || p.x > 100 || p.z < 0 || p.z > 100 || p.y < 0.8 || p.y > 200
    || Math.abs(v.yaw) > Math.PI || Math.abs(v.pitch) > 1.1) return null;
  const safe=(id:unknown):id is string=>typeof id==="string"&&/^[a-zA-Z0-9_-]{1,160}$/.test(id);
  if(v.space!==undefined&&v.space!==null&&(!safe(v.space.building_id)||!safe(v.space.floor_id)))return null;
  if(v.space?.room_id!==undefined&&!safe(v.space.room_id))return null;
  return {version:1,place_id:v.place_id,scene_revision:v.scene_revision,position:{x:p.x,y:p.y,z:p.z},yaw:v.yaw,pitch:v.pitch,
    ...(v.space!==undefined?{space:v.space?{building_id:v.space.building_id,floor_id:v.space.floor_id,...(v.space.room_id?{room_id:v.space.room_id}:{})}:null}:{})};
}

export function walkSpace(definition: PlaceSceneDefinition, position: WalkPose["position"]): WalkSpace | null {
  for(const b of definition.objects){
    if(b.kind!=="building"||!b.structure||position.y>=b.height-b.structure.roof_height)continue;
    const dx=position.x-b.x,dz=position.z-b.z,c=Math.cos(b.heading),s=Math.sin(b.heading);
    if(Math.abs(dx*c+dz*s)>=b.width/2||Math.abs(-dx*s+dz*c)>=b.depth/2)continue;
    if(b.structure.footprint&&!footprintContainsPoint(b,{x:dx*c+dz*s,z:-dx*s+dz*c}))continue;
    const index=Math.max(0,Math.floor((position.y-0.8+0.05)/storeyHeight(b))),floor=b.structure.floors[index];
    if(floor){const room=roomAt(b,index,{x:dx*c+dz*s,z:-dx*s+dz*c});return {building_id:b.id,floor_id:floor.id,...(room?{room_id:room.id}:{})};}
  }
  return null;
}

export const poseSpaceMatches = (pose:WalkPose,definition:PlaceSceneDefinition) => pose.space===undefined||JSON.stringify(pose.space)===JSON.stringify(walkSpace(definition,pose.position));

export function poseInsidePlace(pose: WalkPose, definition: PlaceSceneDefinition) {
  return pose.position.x <= definition.width && pose.position.z <= definition.depth;
}

export function parseWalkWrite(value: unknown): WalkPositionWrite | null {
  if (!value || typeof value !== "object") return null;
  const v = value as WalkPositionWrite, pose = parseWalkPose(v.pose);
  if (!pose || !Number.isSafeInteger(v.base_revision) || v.base_revision < 0
    || typeof v.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.request_id)) return null;
  return {request_id:v.request_id,base_revision:v.base_revision,pose};
}

export const wrapYaw = (yaw: number) => Math.atan2(Math.sin(yaw),Math.cos(yaw));

// The one conversion between /play and the 3D walk. /play stands in map units
// with gaze 0 = +x; the walk is in metres and moves along (-sin yaw, -cos yaw)
// in (x, z). A scene's map geo puts scene x on map x and scene z on map y.
// `place` is the scene geo's absolute centre and its map units per metre.
interface MapPlace { pos: WorldVec2; unit: number }
export interface WalkPoint { x: number; z: number; yaw: number; pitch: number }
export function observerToWalk(o: Pick<ObserverPose,"pos"|"gaze"|"pitch">, place: MapPlace): WalkPoint {
  return { x:(o.pos.x-place.pos.x)/place.unit, z:(o.pos.y-place.pos.y)/place.unit,
    yaw:wrapYaw(-o.gaze-Math.PI/2), pitch:Math.max(-1.1,Math.min(1.1,o.pitch??0)) };
}
export function walkToObserver(w: WalkPoint, place: MapPlace) {
  return { pos:{x:place.pos.x+w.x*place.unit,y:place.pos.y+w.z*place.unit}, gaze:wrapYaw(-w.yaw-Math.PI/2), pitch:w.pitch };
}

// The `route` query a /play walk hands to the editor: "x,z,yaw;..." in metres
// from the scene centre. Parsing turns it into place-local waypoints.
export const routeQuery = (points: readonly WalkPoint[]) => points.map(p => [p.x,p.z,p.yaw].map(v => v.toFixed(2)).join(",")).join(";");
export function routeParam(value: string, definition: Pick<PlaceSceneDefinition,"width"|"depth">): WalkWaypoint[] {
  const points: WalkWaypoint[] = [];
  for (const part of value.split(";")) {
    const v = part.split(",").map(n => n.trim() ? Number(n) : NaN);
    if (v.length !== 3 || !v.every(Number.isFinite)) continue;
    const x = v[0]!+definition.width/2, z = v[1]!+definition.depth/2;
    if (x < 0 || x > definition.width || z < 0 || z > definition.depth) continue;
    points.push({x,z,yaw:wrapYaw(v[2]!)});
    if (points.length === 32) break;
  }
  return points;
}
