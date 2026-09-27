import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {PlaceSceneDefinition} from "@openflipbook/config";
const state=vi.hoisted(()=>({owner:true,metadata:{} as Record<string,unknown>,scene:{place_id:"p",revision:1,definition:{} as PlaceSceneDefinition},fail:false}));
vi.mock("next/headers",()=>({cookies:async()=>({get:()=>({value:"owner"})})}));
vi.mock("./db",()=>{
  const db={collection:(name:string)=>({
    findOne:async(q:{place_id?:string})=>name==="session_owners"?state.owner?{}:null:name==="place_scenes"?state.scene?.place_id===q.place_id?state.scene:null:state.metadata,
    updateOne:async(q:{_id:string},update:{$set:Record<string,unknown>})=>{state.metadata={...state.metadata,_id:q._id,...update.$set};if(state.fail)throw new Error("storage failed");},
  })};
  return {getDb:async()=>db,withDbTransaction:async(run:(database:typeof db,session:object)=>Promise<unknown>)=>{const old=structuredClone(state.metadata);try{return await run(db,{});}catch(e){state.metadata=old;throw e;}}};
});
import {readWalkPosition,saveWalkPosition} from "./walk-position-server";
import {GET,POST} from "@/app/api/creator/worlds/[sessionId]/walk/route";
import {emptyPlaceScene} from "./place-scene";
const input=()=>({request_id:crypto.randomUUID(),base_revision:0,pose:{version:1,place_id:"p",scene_revision:1,position:{x:2,y:0.82,z:3},yaw:0,pitch:0}});
beforeEach(()=>{vi.stubEnv("MONGODB_URI","mongodb://test");vi.stubEnv("MONGODB_DB","test");state.owner=true;state.metadata={_id:"world",title:"Keep",visibility:"private"};state.scene={place_id:"p",revision:1,definition:emptyPlaceScene()};state.fail=false;});
afterEach(()=>vi.unstubAllEnvs());
describe("owner-scoped position persistence",()=>{
  it("saves a private position and resume target without changing the scene",async()=>{
    const before=structuredClone(state.scene),v=input();expect(await readWalkPosition("world")).toEqual({revision:0,pose:null});
    expect(await saveWalkPosition("world",v)).toEqual({revision:1,pose:v.pose});
    expect(state.metadata).toMatchObject({title:"Keep",visibility:"private",resume_place_id:"p",resume_node_id:null,resume_view:"walk"});
    expect(state.scene).toEqual(before);
  });
  it("replays lost responses but rejects changed requests and stale tabs",async()=>{
    const v=input(),saved=await saveWalkPosition("world",v);
    expect(await saveWalkPosition("world",v)).toEqual(saved);
    await expect(saveWalkPosition("world",{...v,pose:{...v.pose,yaw:0.2}})).rejects.toMatchObject({status:409});
    await expect(saveWalkPosition("world",input())).rejects.toMatchObject({status:409});
    expect((await readWalkPosition("world")).revision).toBe(1);
  });
  it("rejects obsolete geometry, missing places and positions outside dimensions",async()=>{
    const v=input();state.scene.revision=2;await expect(saveWalkPosition("world",v)).rejects.toMatchObject({status:409});
    state.scene.revision=1;await expect(saveWalkPosition("world",{...v,pose:{...v.pose,place_id:"missing"}})).rejects.toMatchObject({status:404});
    await expect(saveWalkPosition("world",{...v,pose:{...v.pose,position:{x:99,y:1,z:1}}})).rejects.toMatchObject({status:400});
    expect(state.metadata.walk_position).toBeUndefined();
  });
  it("rolls back failed metadata persistence",async()=>{
    state.fail=true;await expect(saveWalkPosition("world",input())).rejects.toThrow("storage failed");expect(state.metadata.walk_position).toBeUndefined();
  });
  it("denies foreign reads/writes and validates private routes",async()=>{
    const params={params:Promise.resolve({sessionId:"world"})},req=(body:string,origin="http://local")=>new Request("http://local/api",{method:"POST",headers:{"Content-Type":"application/json",origin},body});
    state.owner=false;expect((await GET(req("{}"),params)).status).toBe(403);expect((await POST(req(JSON.stringify(input())),params)).status).toBe(403);
    state.owner=true;expect((await POST(req("{"),params)).status).toBe(400);expect((await POST(req("x".repeat(4097)),params)).status).toBe(413);
    expect((await POST({url:"http://local/api",headers:new Headers({"content-type":"application/json",origin:"http://evil"})} as Request,params)).status).toBe(403);
    const res=await POST(req(JSON.stringify(input())),params);expect(res.status).toBe(200);expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
