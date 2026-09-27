import type { PlaceSceneDefinition } from "@openflipbook/config";
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
