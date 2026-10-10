// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
const state = vi.hoisted(()=>({node:vi.fn(),owner:vi.fn(),get:vi.fn(),put:vi.fn(),download:vi.fn()}));
vi.mock("./db",()=>({getNode:state.node}));
vi.mock("./creator",async()=>({...(await vi.importActual<Record<string,unknown>>("./creator")),requireCreator:state.owner}));
vi.mock("./r2",async()=>({...(await vi.importActual<Record<string,unknown>>("./r2")),getStoredBytes:state.get,uploadJpeg:state.put}));
vi.mock("./descent-video-store",async()=>({...(await vi.importActual<Record<string,unknown>>("./descent-video-store")),downloadDescentVideo:state.download}));
import { createStreetStep, listStreetSteps, saveStreetEndpoint, streetMedia, endpointInput } from "./street-walk-server";
import { CreatorError } from "./creator-error";

const request1="11111111-1111-4111-8111-111111111111",request2="22222222-2222-4222-8222-222222222222",request3="33333333-3333-4333-8333-333333333333";
const sha=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
function box(type:string,payload=Buffer.alloc(0)){const b=Buffer.alloc(8+payload.length);b.writeUInt32BE(b.length);b.write(type,4);payload.copy(b,8);return b;}
const mp4=Buffer.concat([box("ftyp",Buffer.from("isom0000")),box("moov"),box("mdat",Buffer.from([1,2,3,4,5,6]))]);
let source:Buffer,endpoint:Buffer;
let rows:Map<string,Record<string,unknown>>,bindings:Map<string,Record<string,unknown>>,media:Map<string,{bytes:Buffer;contentType:string}>;
const field=(row:Record<string,unknown>,key:string)=>key.split(".").reduce<unknown>((v,p)=>(v as Record<string,unknown> | undefined)?.[p],row);
const matches=(r:Record<string,unknown>,query:Record<string,unknown>)=>Object.entries(query).every(([k,v])=>v&&typeof v==="object"&&"$exists" in v?(field(r,k)!==undefined)===(v as {$exists:boolean}).$exists:field(r,k)===v);
function fakeDb(){return{collection:(name:string)=>{const data=name==="street_walk_requests"?bindings:rows;return{
  findOne:vi.fn(async(q:Record<string,unknown>)=>structuredClone([...data.values()].find(r=>matches(r,q))??null)),
  insertOne:vi.fn(async(row:Record<string,unknown>)=>{if(data.has(String(row._id)))throw Object.assign(new Error("duplicate"),{code:11000});data.set(String(row._id),structuredClone(row));return{insertedId:row._id};}),
  updateOne:vi.fn(async(q:Record<string,unknown>,update:{$set?:Record<string,unknown>;$addToSet?:Record<string,string>;$unset?:Record<string,string>})=>{const row=[...data.values()].find(r=>matches(r,q));if(!row)return{matchedCount:0};if(update.$set)Object.assign(row,structuredClone(update.$set));for(const[k,v]of Object.entries(update.$addToSet??{}))row[k]=[...new Set([...(row[k] as string[]),v])];for(const k of Object.keys(update.$unset??{}))delete row[k];return{matchedCount:1};}),
  find:vi.fn((q:Record<string,unknown>)=>({sort:()=>({limit:()=>({toArray:async()=>[...data.values()].filter(r=>matches(r,q))})})})),
};}};}
beforeEach(async()=>{
  vi.unstubAllGlobals();vi.unstubAllEnvs();for(const mock of Object.values(state))mock.mockReset();
  source=await sharp({create:{width:256,height:256,channels:3,background:"#f00"}}).png().toBuffer();
  endpoint=await sharp({create:{width:256,height:256,channels:3,background:"#00f"}}).png().toBuffer();
  rows=new Map();bindings=new Map();media=new Map([["world/street.png",{bytes:source,contentType:"image/png"}]]);
  state.node.mockResolvedValue({id:"street",session_id:"world",image_key:"world/street.png",page_title:"Bookshop street",scene_view:{level:"street"}});
  state.owner.mockResolvedValue(fakeDb());state.get.mockImplementation(async(key:string)=>media.get(key)??null);
  state.put.mockImplementation(async(key:string,bytes:Buffer,type:string)=>{media.set(key,{bytes,contentType:type});return{key};});state.download.mockResolvedValue(mp4);
  vi.stubEnv("MODAL_API_URL","http://local.test");
  vi.stubGlobal("fetch",vi.fn().mockImplementation(async()=>new Response(JSON.stringify({video_url:"https://v3.fal.media/street.mp4",model:"minimax/h3-max/image-to-video",content_type:"video/mp4",duration_seconds:5}),{headers:{"content-type":"application/json"}})));
});
const input=(id=request1,parent_id:string|null=null,direction="forward")=>({request_id:id,parent_id,direction});
const frame=()=>({image_data_url:`data:image/png;base64,${endpoint.toString("base64")}`,video_sha256:sha(mp4),time_seconds:5.14,duration_seconds:5.184});
it("denies another owner and map inputs before provider/image access",async()=>{
  state.owner.mockRejectedValueOnce(new CreatorError("Not owner",403));await expect(createStreetStep("street",input())).rejects.toMatchObject({status:403});
  state.node.mockResolvedValueOnce({id:"street",session_id:"world",image_key:"map.png",scene_view:{level:"city"}});await expect(createStreetStep("street",input())).rejects.toMatchObject({status:409});
  expect(fetch).not.toHaveBeenCalled();expect(state.get).not.toHaveBeenCalled();
});
it("claims before one paid call and sends only the exact saved street source with fixed intent",async()=>{
  vi.mocked(fetch).mockImplementationOnce(async(_url,init)=>{
    expect([...rows.values()][0]?.status).toBe("submitting");
    const body=JSON.parse(String(init?.body));expect(body.street_walk).toEqual({direction:"forward"});expect(body.duration).toBe(5);expect(body.video_tier).toBe("balanced");
    expect(Buffer.from(body.image_data_url.split(",")[1],"base64")).toEqual(source);expect(body.end_image_data_url).toBeUndefined();expect(body.focus).toBeUndefined();
    return new Response(JSON.stringify({video_url:"https://fal.media/a.mp4",model:"minimax/h3-max/image-to-video",content_type:"video/mp4",duration_seconds:5}));
  });
  const result=await createStreetStep("street",input());expect(result.segment.status).toBe("ready");expect(result.segment.source_sha256).toBe(sha(source));expect(result.segment.video_sha256).toBe(sha(mp4));expect(fetch).toHaveBeenCalledOnce();
});
it("reuses a lost acknowledgement and a different UUID for the same immutable edge without billing again",async()=>{
  const a=await createStreetStep("street",input());const b=await createStreetStep("street",input(request2));
  expect(b.segment.id).toBe(a.segment.id);expect(b.segment.request_ids).toEqual([request1,request2]);expect(fetch).toHaveBeenCalledOnce();
  expect((await listStreetSteps("street")).segments[0]!.request_ids).toContain(request2);
});
it("binds every original and alias UUID to one direction/source body before another paid call",async()=>{
  await createStreetStep("street",input());await createStreetStep("street",input(request2));
  await expect(createStreetStep("street",input(request1,null,"left"))).rejects.toMatchObject({status:409});
  await expect(createStreetStep("street",input(request2,null,"right"))).rejects.toMatchObject({status:409});expect(fetch).toHaveBeenCalledOnce();
});
it("a second tab during submission reuses the claim while only the first call proceeds",async()=>{
  let finish!:(r:Response)=>void;vi.mocked(fetch).mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
  const first=createStreetStep("street",input());await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());
  const second=await createStreetStep("street",input(request2));expect(second.segment.status).toBe("submitting");expect(fetch).toHaveBeenCalledOnce();
  finish(new Response(JSON.stringify({video_url:"https://fal.media/a.mp4",model:"minimax/h3-max/image-to-video",content_type:"video/mp4",duration_seconds:5})));await first;
});
it("keeps transport ambiguity fenced across repeated UUIDs rather than rerolling",async()=>{
  vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"));const a=await createStreetStep("street",input());expect(a.segment.status).toBe("submission_unknown");
  const b=await createStreetStep("street",input(request2));expect(b.segment.status).toBe("submission_unknown");expect(fetch).toHaveBeenCalledOnce();
});
it("recovers a retained provider request only through the free result reader",async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({provider_request_id:"saved-provider-request"}),{status:502}));
  const first=await createStreetStep("street",input());expect(first.segment.status).toBe("submission_unknown");expect(first.segment.provider_request_id).toBe("saved-provider-request");
  const recovered=await createStreetStep("street",input(request1));expect(recovered.segment.status).toBe("ready");
  expect(String(vi.mocked(fetch).mock.calls[1]![0])).toContain("/street-walk/recover");expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]![1]?.body))).toEqual({provider_request_id:"saved-provider-request"});
});
it("a storage failure retries only the exact known MP4 without another model submission",async()=>{
  state.download.mockRejectedValueOnce(new Error("storage offline"));const first=await createStreetStep("street",input());expect(first.segment.status).toBe("storage_failed");
  const recovered=await createStreetStep("street",input(request2));expect(recovered.segment.status).toBe("ready");expect(fetch).toHaveBeenCalledOnce();expect(state.download).toHaveBeenCalledTimes(2);expect(recovered.segment.video_sha256).toBe(sha(mp4));
});
it("requires a saved endpoint before continuing and pins its actual SHA as the new input",async()=>{
  const first=await createStreetStep("street",input());await expect(createStreetStep("street",input(request2,first.segment.id))).rejects.toMatchObject({status:409});expect(fetch).toHaveBeenCalledOnce();
  await saveStreetEndpoint("street",first.segment.id,frame());
  const next=await createStreetStep("street",input(request2,first.segment.id));expect(next.segment.source_sha256).toBe(sha(endpoint));
  const body=JSON.parse(String(vi.mocked(fetch).mock.calls[1]![1]?.body));expect(Buffer.from(body.image_data_url.split(",")[1],"base64")).toEqual(endpoint);
});
it("rejects a foreign parent, changed endpoint bytes and wrong video receipts before a new submission",async()=>{
  const first=await createStreetStep("street",input());await saveStreetEndpoint("street",first.segment.id,frame());
  await expect(createStreetStep("street",input(request2,"foreign"))).rejects.toMatchObject({status:404});
  await expect(saveStreetEndpoint("street",first.segment.id,{...frame(),video_sha256:"0".repeat(64)})).rejects.toMatchObject({status:400});
  const key=([...rows.values()][0]!.endpoint as {key:string}).key;media.set(key,{bytes:source,contentType:"image/png"});
  await expect(createStreetStep("street",input(request3,first.segment.id))).rejects.toMatchObject({status:409});expect(fetch).toHaveBeenCalledOnce();
});
it("cannot replace an acknowledged endpoint and serves exact stored bytes and ranges",async()=>{
  const first=await createStreetStep("street",input());const a=await saveStreetEndpoint("street",first.segment.id,frame());
  const b=await saveStreetEndpoint("street",first.segment.id,{...frame(),image_data_url:`data:image/png;base64,${source.toString("base64")}`});expect(b.sha256).toBe(a.sha256);
  const full=await streetMedia("street",first.segment.id,"video",new Request("http://local.test"));expect(full.status).toBe(200);expect(Buffer.from(await full.arrayBuffer())).toEqual(mp4);
  const part=await streetMedia("street",first.segment.id,"video",new Request("http://local.test",{headers:{Range:"bytes=3-10"}}));expect(part.status).toBe(206);expect(Buffer.from(await part.arrayBuffer())).toEqual(mp4.subarray(3,11));
  const conditional=await streetMedia("street",first.segment.id,"video",new Request("http://local.test",{headers:{Range:"bytes=3-10","If-Range":"other"}}));expect(conditional.status).toBe(200);
});
it.each([0,2,4.7,NaN,Infinity])("rejects partial or invalid endpoint playhead %s",time=>{expect(()=>endpointInput({...frame(),time_seconds:time},sha(mp4))).toThrow();});
