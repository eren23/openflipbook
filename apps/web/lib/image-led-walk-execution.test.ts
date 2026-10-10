// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Db, Document } from "mongodb";
const state = vi.hoisted(() => ({ db: null as Db | null, backend: vi.fn(), cap: vi.fn(), inputs: vi.fn(), fence: vi.fn(), seed: vi.fn(), get: vi.fn(), upload: vi.fn(), download: vi.fn(), silent: vi.fn() }));
vi.mock("./db",()=>({withDbTransaction:async(run:(db:Db,session:unknown)=>Promise<unknown>)=>run(state.db!,{})}));
vi.mock("./image-led-walk-server",()=>({imageLedBackend:state.backend,imageLedCapabilities:state.cap,imageLedInputs:state.inputs,imageLedSeed:state.seed,ImageLedBackendError:class extends Error {constructor(public status:number,public receipt:Record<string,unknown>){super("Lost");}}}));
vi.mock("./image-led-walk-source",async()=>({...await vi.importActual<Record<string,unknown>>("./image-led-walk-source"),fenceImageLedSource:state.fence}));
vi.mock("./r2",()=>({getStoredBytes:state.get,uploadJpeg:state.upload}));
vi.mock("./motion-execution",()=>({download:state.download,verified:async(file?:{key:string;sha256:string;bytes:number})=>{if(!file)return null;const value=await state.get(file.key);return value?.bytes.length===file.bytes&&imageLedBytesHash(value.bytes)===file.sha256?value.bytes:null;}}));
vi.mock("./motion-video",()=>({silentMotionVideo:state.silent}));
import { processNextImageLedWalk } from "./image-led-walk-execution";
import { imageLedBytesHash, imageLedHash } from "./image-led-walk-source";
import { CreatorError } from "./creator-error";
let rows: Record<string, Document[]>, files: Map<string,Buffer>;
const at=(r:Document,key:string):unknown=>key.split(".").reduce<unknown>((v,k)=>(v as Document|undefined)?.[k],r);
function matches(row:Document,q:Document):boolean{return Object.entries(q).every(([k,v])=>{if(k==="$or")return v.some((part:Document)=>matches(row,part));if(k==="$and")return v.every((part:Document)=>matches(row,part));const actual=at(row,k);if(v&&typeof v==="object"&&!Array.isArray(v)){return Object.entries(v).every(([op,n])=>op==="$exists"?(actual!==undefined)===n:op==="$in"?(n as unknown[]).includes(actual):op==="$nin"?!(n as unknown[]).includes(actual):op==="$lte"?Number(actual)<=Number(n):op==="$gt"?Number(actual)>Number(n):false);}return actual===v;});}
function set(row:Document,k:string,v:unknown){const parts=k.split("."),last=parts.pop()!;let parent=row;for(const part of parts)parent=parent[part] as Document;parent[last]=v;}
function apply(row:Document,u:Document){for(const[k,v]of Object.entries(u.$set??{}))set(row,k,v);for(const[k,v]of Object.entries(u.$inc??{}))set(row,k,Number(at(row,k)??0)+Number(v));for(const k of Object.keys(u.$unset??{}))delete row[k];}
const makeDb=()=>({collection:(name:string)=>({findOne:async(q:Document)=>rows[name]?.find(r=>matches(r,q))??null,findOneAndUpdate:async(q:Document,u:Document)=>{const r=rows[name]?.find(r=>matches(r,q));if(!r)return null;apply(r,u);return structuredClone(r);},updateOne:async(q:Document,u:Document)=>{const r=rows[name]?.find(r=>matches(r,q));if(r)apply(r,u);return{matchedCount:r?1:0};}})}) as unknown as Db;
const job=()=>rows.image_led_walk_steps![0]!;
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("PATH_VIDEO_ENABLED","1");files=new Map();state.get.mockImplementation(async(key:string)=>files.has(key)?{bytes:files.get(key)}:null);state.upload.mockImplementation(async(key:string,bytes:Buffer)=>{files.set(key,bytes);});const parameters={prompt_version:"image-led-walk-v4"};rows={image_led_walk_steps:[{_id:"world:job",id:"job",session_id:"world",walk_id:"walk",kind:"still",index:0,status:"scheduled",input_sha256:"a".repeat(64),quote:{model:"fal-ai/nano-banana-pro/edit",parameters,reservation:.15},ledger_ids:["day"],created_at:new Date(),updated_at:new Date()}],image_led_walks:[{_id:"world:walk",id:"walk",session_id:"world",revision:1,frames:[{index:0,status:"scheduled",job_id:"job",review:{identity:"pending",route:"pending",spatial:"unmeasured"}}],legs:[{index:0,status:"empty",review:{temporal:"pending"}}]}],spend_ledger:[{_id:"day",total:.15}]};state.db=makeDb();state.cap.mockResolvedValue({model:"fal-ai/nano-banana-pro/edit",parameters,reservation:.15});state.inputs.mockResolvedValue({body:{source:{sha256:"source"}},sha256:"a".repeat(64)});state.fence.mockResolvedValue(undefined);state.backend.mockResolvedValue({request_id:"provider_known",model:"fal-ai/nano-banana-pro/edit",profile:"image-led-v1",input_sha256:"b".repeat(64)});});
it("saves its irreversible marker before exactly one POST, then polls only known ID",async()=>{state.backend.mockImplementation(async(path:string)=>{if(path==="generate"){expect(job().status).toBe("submitting");expect(job().submission_started_at).toBeInstanceOf(Date);return{request_id:"provider_known",model:"fal-ai/nano-banana-pro/edit",profile:"image-led-v1",input_sha256:"b".repeat(64)};}return{request_id:"provider_known",model:"fal-ai/nano-banana-pro/edit",profile:"image-led-v1",status:"queued"};});await processNextImageLedWalk(state.db!);await processNextImageLedWalk(state.db!);expect(state.backend.mock.calls.map(c=>c[0])).toEqual(["generate","requests/provider_known?model=fal-ai%2Fnano-banana-pro%2Fedit"]);expect(job().status).toBe("queued");});
it("never resubmits an unknown acknowledgement even after repeated ticks",async()=>{state.backend.mockRejectedValue(new Error("ACK lost"));await processNextImageLedWalk(state.db!);job().next_check=new Date(0);await processNextImageLedWalk(state.db!);expect(job().status).toBe("submission_unknown");expect(job().submission_started_at).toBeInstanceOf(Date);expect(state.backend).toHaveBeenCalledTimes(1);});
it("recovers a known request from a malformed success receipt without another POST",async()=>{state.backend.mockResolvedValueOnce({request_id:"provider_known",model:"wrong"}).mockResolvedValueOnce({request_id:"provider_known",model:"fal-ai/nano-banana-pro/edit",profile:"image-led-v1",status:"queued"});await processNextImageLedWalk(state.db!);job().next_check=new Date(0);await processNextImageLedWalk(state.db!);expect(state.backend.mock.calls.map(c=>c[0])).toEqual(["generate","requests/provider_known?model=fal-ai%2Fnano-banana-pro%2Fedit"]);});
it.each(["preflight","transaction"])("releases the held reservation once for %s source change before POST",async(phase)=>{if(phase==="preflight")state.inputs.mockRejectedValue(new CreatorError("Source changed",409));else state.fence.mockRejectedValue(new CreatorError("Source changed",409));await processNextImageLedWalk(state.db!);await processNextImageLedWalk(state.db!);expect(state.backend).not.toHaveBeenCalled();expect(job().status).toBe("failed");expect(rows.spend_ledger![0]!.total).toBe(0);});
it("does not claim a video on a worker without local video tools",async()=>{job().kind="video";expect(await processNextImageLedWalk(state.db!,false)).toBe(false);expect(state.backend).not.toHaveBeenCalled();expect(job().status).toBe("scheduled");});
it("does not submit a new video when disabled, but recovers an existing paid video through GET",async()=>{vi.stubEnv("PATH_VIDEO_ENABLED","0");job().kind="video";expect(await processNextImageLedWalk(state.db!,true)).toBe(false);job().status="queued";job().provider_request_id="paid_video";state.backend.mockResolvedValue({request_id:"paid_video",model:"fal-ai/nano-banana-pro/edit",profile:"image-led-v1",status:"running"});expect(await processNextImageLedWalk(state.db!,true)).toBe(true);expect(state.backend.mock.calls.map(c=>c[0])).toEqual(["video/requests/paid_video"]);expect(job().status).toBe("running");});
it("marks an expired submission unknown without claiming or POSTing it again",async()=>{job().status="submitting";job().submission_deadline=new Date(0);expect(await processNextImageLedWalk(state.db!)).toBe(true);expect(job().status).toBe("submission_unknown");expect(state.backend).not.toHaveBeenCalled();});
it("preserves original PNG before rejecting changed output receipt; no acceptance or reroll",async()=>{const bytes=await sharp({create:{width:688,height:384,channels:3,background:"#854e67"}}).png().toBuffer();job().status="queued";job().provider_request_id="provider_known";state.backend.mockResolvedValue({request_id:"provider_known",model:"fal-ai/nano-banana-pro/edit",profile:"image-led-v1",status:"ready",image:{url:"https://fal.media/original.png"},raw_image:{valid:true,sha256:"0".repeat(64),bytes:bytes.length,width:688,height:384}});vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Uint8Array(bytes))));await processNextImageLedWalk(state.db!);expect(job().status).toBe("failed");expect(job().original.sha256).toBe(imageLedBytesHash(bytes));expect(files.get(job().original.key)).toEqual(bytes);expect(rows.image_led_walks![0]!.frames[0].raw.sha256).toBe(imageLedBytesHash(bytes));expect(rows.image_led_walks![0]!.frames[0].image).toBeUndefined();expect(rows.image_led_walks![0]!.frames[0].review.identity).toBe("pending");expect(state.backend.mock.calls.map(c=>c[0])).toEqual(["requests/provider_known?model=fal-ai%2Fnano-banana-pro%2Fedit"]);});
it("stores exact raw plus a declared uniform-scale derivative with pending review",async()=>{const bytes=await sharp({create:{width:1376,height:768,channels:3,background:"#854e67"}}).png().toBuffer();job().status="storage_failed";job().provider_request_id="provider_known";job().provider_result={status:"ready",image:{url:"https://fal.media/original.png"},raw_image:{valid:true,sha256:imageLedBytesHash(bytes),bytes:bytes.length,width:1376,height:768}};vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Uint8Array(bytes))));await processNextImageLedWalk(state.db!);expect(job().status).toBe("ready");const frame=rows.image_led_walks![0]!.frames[0];expect(frame.raw.sha256).toBe(imageLedBytesHash(bytes));expect(frame.image).toMatchObject({width:688,height:384,content_type:"image/jpeg"});expect(frame.derivative).toEqual({kind:"uniform-scale-jpeg-v1",source_sha256:imageLedBytesHash(bytes),crop:false,stretch:false});expect(frame.review.identity).toBe("pending");expect(imageLedHash(frame.review)).not.toBe(imageLedHash({identity:"approved"}));expect(state.backend).not.toHaveBeenCalled();});
it("releases an unsent old-model reservation once after a profile switch without POST", async () => {
  state.cap.mockResolvedValue({ model: "openai/gpt-image-2.5/sunburst/edit", parameters: { prompt_version: "image-led-walk-v4" }, reservation: .15 });
  await processNextImageLedWalk(state.db!); await processNextImageLedWalk(state.db!);
  expect(state.backend).not.toHaveBeenCalled(); expect(job().status).toBe("failed"); expect(job().reservation_released).toBe(true); expect(rows.spend_ledger![0]!.total).toBe(0);
});
it("recovers a legacy NanoPro known job by immutable quoted model without consulting changed capabilities", async () => {
  job().status = "submission_unknown"; job().provider_request_id = "legacy_saved"; job().quote.parameters = { prompt_version: "image-led-walk-v3" };
  state.cap.mockRejectedValue(new Error("Switched current model disabled"));
  state.backend.mockResolvedValue({ request_id: "legacy_saved", model: job().quote.model, profile: "image-led-v1", status: "running" });
  await processNextImageLedWalk(state.db!);
  expect(state.cap).not.toHaveBeenCalled(); expect(state.inputs).not.toHaveBeenCalled();
  expect(state.backend.mock.calls.map(c => c[0])).toEqual(["requests/legacy_saved?model=fal-ai%2Fnano-banana-pro%2Fedit"]); expect(job().status).toBe("running");
});
it("claims a scheduled job exactly once when two workers race", async () => {
  await Promise.all([processNextImageLedWalk(state.db!), processNextImageLedWalk(state.db!)]);
  expect(state.backend.mock.calls.filter(c => c[0] === "generate")).toHaveLength(1); expect(job().status).toBe("queued");
});
it("stores a quoted common canvas from a different model aspect without changing the native original", async () => {
  const bytes = await sharp({ create: { width: 1536, height: 864, channels: 3, background: "#854e67" } }).png().toBuffer();
  const canvas = { kind: "contain-jpeg-v1", width: 688, height: 384, background: "#20231e" };
  job().quote.playback = canvas; job().status = "storage_failed"; job().provider_request_id = "provider_known";
  job().provider_result = { status: "ready", image: { url: "https://fal.media/original.png" }, raw_image: { valid: true, sha256: imageLedBytesHash(bytes), bytes: bytes.length, width: 1536, height: 864 } };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes))));
  await processNextImageLedWalk(state.db!);
  const frame = rows.image_led_walks![0]!.frames[0];
  expect(job().status).toBe("ready"); expect(files.get(frame.raw.key)).toEqual(bytes);
  expect(frame.image).toMatchObject({ width: 688, height: 384, content_type: "image/jpeg" });
  expect(frame.derivative).toEqual({ kind: "contain-jpeg-v1", source_sha256: imageLedBytesHash(bytes), crop: false, stretch: false, canvas });
  expect(frame.review).toEqual({ identity: "pending", route: "pending", spatial: "unmeasured" }); expect(state.backend).not.toHaveBeenCalled();
});
it("releases a stale canvas reservation once before any provider submission", async () => {
  job().quote.playback = { kind: "contain-jpeg-v1", width: 688, height: 384, background: "#20231e" };
  state.inputs.mockResolvedValue({ body: {}, sha256: job().input_sha256, playback: { ...job().quote.playback, height: 387 } });
  await processNextImageLedWalk(state.db!); await processNextImageLedWalk(state.db!);
  expect(state.backend).not.toHaveBeenCalled(); expect(job().status).toBe("failed"); expect(rows.spend_ledger![0]!.total).toBe(0);
});
it.each([[3.04, "ready"], [5.04, "failed"]])("checks a %s s clip against the quoted 3 s video duration", async (duration, status) => {
  const bytes = Buffer.from("mp4"); job().kind = "video"; job().quote.parameters = { duration: 3, prompt_version: "image-led-walk-video-v4" };
  job().status = "storage_failed"; job().provider_request_id = "provider_known"; job().provider_result = { status: "ready", video: { url: "https://fal.media/leg.mp4" } };
  state.download.mockResolvedValue(bytes); state.silent.mockResolvedValue({ bytes, hashes: { playback_sha256: "c".repeat(64) }, media: { duration } });
  await processNextImageLedWalk(state.db!, true);
  expect(job().status).toBe(status); expect(state.backend).not.toHaveBeenCalled();
});
const DEPTH = "fal-ai/image-preprocessors/depth-anything/v2", fixture = (name: string) => readFileSync(path.join(__dirname, "../tests/fixtures/copy-first", name));
async function copyJob(depth: Buffer, prior = fixture("prior.png"), tz = .1) {
  const raw = { key: "world/image-led/walk/old/original-prior.png", sha256: imageLedBytesHash(prior), bytes: prior.length, width: 96, height: 64, content_type: "image/png" };
  files.set(raw.key, prior);
  Object.assign(job(), { index: 1, quote: { model: DEPTH, parameters: { tz, max_turn_degrees: 3, pitch_degrees: 0, offset: .4, fov_degrees: 60, bg_fill: true, warp_version: "copy-first-warp-v1" }, reservation: .02, copy_first: { prior_raw_sha256: raw.sha256, yaw_degrees: 0 } } });
  rows.image_led_walks![0]!.frames = [{ index: 0, status: "ready", raw, review: { identity: "approved", route: "approved", spatial: "unmeasured" } }, { index: 1, status: "storage_failed", job_id: "job", review: { identity: "pending", route: "pending", spatial: "unmeasured" } }];
  Object.assign(job(), { status: "storage_failed", provider_request_id: "depth_known", provider_result: { status: "ready", image: { url: "https://fal.media/depth.png" }, raw_image: { valid: true, sha256: imageLedBytesHash(depth), bytes: depth.length, width: (await sharp(depth).metadata()).width, height: (await sharp(depth).metadata()).height } } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(depth))));
  return raw;
}
it("submits a copied view as one depth request and polls it under the depth model", async () => {
  job().quote = { ...job().quote, model: DEPTH, copy_first: { prior_raw_sha256: "f".repeat(64), yaw_degrees: 0 } };
  state.backend.mockImplementation(async (p: string) => p === "copy-first/generate" ? { request_id: "depth_known", model: DEPTH, profile: "image-led-v1", input_sha256: "b".repeat(64) } : { request_id: "depth_known", model: DEPTH, profile: "image-led-v1", status: "queued" });
  state.cap.mockResolvedValue({ model: DEPTH, parameters: job().quote.parameters, reservation: .15 });
  await processNextImageLedWalk(state.db!); await processNextImageLedWalk(state.db!);
  expect(state.cap).toHaveBeenCalledWith(state.db, "copy_first");
  expect(state.backend.mock.calls.map(c => c[0])).toEqual(["copy-first/generate", `requests/depth_known?model=${encodeURIComponent(DEPTH)}`]); expect(job().status).toBe("queued");
});
it("stores the warped prior as the still, keeps the depth map as the provider original, and records provenance", async () => {
  const depth = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#808080" } }).png().toBuffer(), prior = await copyJob(depth);
  await processNextImageLedWalk(state.db!);
  const frame = rows.image_led_walks![0]!.frames[1], still = files.get(frame.raw.key)!;
  expect(job().status).toBe("ready"); expect(job().original.sha256).toBe(imageLedBytesHash(depth));
  expect(frame.raw).toMatchObject({ sha256: imageLedBytesHash(still), width: 96, height: 64, content_type: "image/png" }); expect(frame.raw.key).toContain("/copy-");
  expect(frame.copy_first).toEqual({ prior_raw_sha256: prior.sha256, yaw_degrees: 0, warp_version: "copy-first-warp-v1", depth_request_id: "depth_known", depth_sha256: imageLedBytesHash(depth), tz: .1, pitch_degrees: 0, offset: .4, fov_degrees: 60, bg_fill: true, uncovered_pixels: 0 });
  expect(frame.derivative.source_sha256).toBe(frame.raw.sha256); expect(frame.review.identity).toBe("pending"); expect(state.backend).not.toHaveBeenCalled();
});
it.each([
  ["uncovered pixels", () => fixture("depth.png"), .12, /Copy-first refused: \d+ pixels are not covered/],
  ["a depth size that differs", () => sharp({ create: { width: 48, height: 32, channels: 3, background: "#808080" } }).png().toBuffer(), .1, /Depth map size differs/],
])("fails a copied view with %s and never asks the provider again", async (_name, depth, tz, error) => {
  await copyJob(await depth(), fixture("prior.png"), tz);
  if (tz === .12) job().quote.copy_first.yaw_degrees = 2;
  await processNextImageLedWalk(state.db!); await processNextImageLedWalk(state.db!);
  expect(job().status).toBe("failed"); expect(job().error).toMatch(error); expect(rows.image_led_walks![0]!.frames[1].raw).toBeUndefined(); expect(state.backend).not.toHaveBeenCalled();
});
it("fails a copied view when the previous original changed after the quote", async () => {
  await copyJob(await sharp({ create: { width: 96, height: 64, channels: 3, background: "#808080" } }).png().toBuffer());
  job().quote.copy_first.prior_raw_sha256 = "0".repeat(64);
  await processNextImageLedWalk(state.db!);
  expect(job().status).toBe("failed"); expect(job().error).toMatch(/previous view changed/);
});
