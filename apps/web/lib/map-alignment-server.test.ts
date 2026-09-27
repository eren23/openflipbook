/* eslint-disable @typescript-eslint/no-explicit-any -- schemaless test doubles (in-memory Mongo rows, page JSON) */
// @vitest-environment node
import {beforeEach,afterEach,expect,it,vi} from "vitest";
import sharp from "sharp";
const memory=vi.hoisted(()=>({rows:new Map<string,Map<string,any>>(),owner:true,bytes:Buffer.alloc(0) as Buffer}));
function collection(name:string){
  if(!memory.rows.has(name))memory.rows.set(name,new Map());const rows=memory.rows.get(name)!;
  const matches=(d:any,q:any)=>Object.entries(q).every(([k,v])=>d[k]===v);
  return {findOne:async(q:any)=>structuredClone([...rows.values()].find(d=>matches(d,q))??null),find:(q:any)=>{const cursor={sort:()=>cursor,limit:()=>cursor,toArray:async()=>structuredClone([...rows.values()].filter(d=>matches(d,q)))};return cursor;},
    insertOne:async(d:any)=>{if(rows.has(d._id))throw Object.assign(new Error("Duplicate"),{code:11000});rows.set(d._id,structuredClone(d));},
    replaceOne:async(q:any,d:any)=>{if(![...rows.values()].some(d=>matches(d,q)))return {matchedCount:0};rows.set(d._id,structuredClone(d));return {matchedCount:1};}};
}
vi.mock("./db",()=>({getDb:async()=>({collection})}));
vi.mock("./creator",()=>({CreatorError:class extends Error{constructor(message:string,public status:number){super(message);}},requireCreator:async()=>{if(!memory.owner)throw Object.assign(new Error("Not owner"),{status:403});return {collection};}}));
vi.mock("./r2",()=>({getStoredBytes:async()=>({bytes:memory.bytes,contentType:"image/png"})}));
import {emptyPlaceScene,newComponent} from "./place-scene";
import {mapArtworkContext,saveMapAlignment} from "./map-artwork-server";
const definition={...emptyPlaceScene(),objects:[[8,8],[28,8],[8,28]].map(([x,z],i)=>({...newComponent("house",x!,z!),id:`house_${i}`}))};
const body={revision:0,scene_revision:2,map_node_id:"map",frame:{width:512,height:288},registration:{x:50,y:50,width:40,rotation:0},landmarks:definition.objects.map((o,i)=>({object_id:o.id,x:20+i*20,y:40}))};
beforeEach(async()=>{
  memory.rows.clear();memory.owner=true;vi.stubEnv("NEXT_PUBLIC_WORLD_SCENES","1");memory.bytes=await sharp({create:{width:512,height:288,channels:3,background:"#867954"}}).png().toBuffer();
  await collection("nodes").insertOne({_id:"map",session_id:"world",parent_id:null,image_key:"saved.png"});
  await collection("place_scenes").insertOne({_id:"world:place",session_id:"world",place_id:"place",id:"scene",revision:2,source_node_id:"map",definition});
  await collection("place_scene_versions").insertOne({_id:"world:place:1",session_id:"world",place_id:"place",id:"scene",revision:1,definition});
});
afterEach(()=>vi.unstubAllEnvs());
it("saves and reopens explicit landmarks without accepting artwork or mutating geometry",async()=>{
  const before=await collection("place_scenes").findOne({_id:"world:place"});
  const saved=await saveMapAlignment("world","place",body);
  expect(saved.alignment.revision).toBe(1);expect((await mapArtworkContext("world","place")).alignment).toEqual(saved.alignment);
  expect((await mapArtworkContext("world","place")).registration).toBeNull();
  expect(await collection("place_scenes").findOne({_id:"world:place"})).toEqual(before);
  expect(memory.rows.get("map_artwork_versions")?.size).toBe(0);
});
it("replays the identical save after a lost response but rejects a conflicting old revision",async()=>{
  const a=await saveMapAlignment("world","place",body);expect(await saveMapAlignment("world","place",body)).toEqual(a);
  await expect(saveMapAlignment("world","place",{...body,landmarks:[]})).rejects.toMatchObject({status:409});
  const next=await saveMapAlignment("world","place",{...body,revision:1,landmarks:[]});expect(next.alignment.revision).toBe(2);
});
it.each(["owner","geometry","image","dimensions","identity"])("rejects invalid %s before a draft write",async reason=>{
  const input=structuredClone(body);if(reason==="owner")memory.owner=false;if(reason==="geometry")input.scene_revision=1;if(reason==="image")input.map_node_id="foreign";if(reason==="dimensions")input.frame.width=300;if(reason==="identity")input.landmarks[0]!.object_id="foreign";
  await expect(saveMapAlignment("world","place",input)).rejects.toThrow();expect(memory.rows.get("map_alignment_drafts")?.size??0).toBe(0);
});
it("marks saved measurements historical after a geometry change",async()=>{
  await saveMapAlignment("world","place",body);memory.rows.get("place_scenes")!.get("world:place").revision=3;
  const result=await mapArtworkContext("world","place");expect(result.alignment_stale).toBe(true);expect(result.alignment?.scene_revision).toBe(2);
});
