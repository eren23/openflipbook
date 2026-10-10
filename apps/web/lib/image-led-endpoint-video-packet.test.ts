import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import sharp from "sharp";
import { buildEndpointLedVideoPacket } from "./image-led-endpoint-video-packet";
import type { ReferenceVideoPacketInput, ReferenceVideoImage } from "./image-led-reference-video-packet";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function image(color: string, width = 640, height = 360): Promise<ReferenceVideoImage> {
  const bytes = await sharp({create:{width,height,channels:3,background:color}}).png().toBuffer();
  return {bytes,sha256:sha(bytes),content_type:"image/png",width,height};
}
async function fixture(): Promise<ReferenceVideoPacketInput> {
  const frames = await Promise.all(["#123456","#234567","#345678","#456789","#56789a","#6789ab"].map(c=>image(c)));
  const refs = await Promise.all(["#220000","#002200","#000022","#222200"].map(c=>image(c,320,320)));
  return { context:{owner_route_id:"owned-route",owner_revision:1,source_binding_sha256:"a".repeat(64),frame_review_sha256:"b".repeat(64),
    still_manifest_sha256:"c".repeat(64),six_frame_sha256:frames.map(f=>f.sha256)},source:{sha256:"d".repeat(64),width:2048,height:1152},
    points:[[940,900],[1020,815],[1060,720],[1070,630],[1050,545],[1030,465]].map(([x,y])=>({x:x!/2048,y:y!/1152})),from_index:1,
    endpoints:[{...frames[1]!,checkpoint_index:1},{...frames[2]!,checkpoint_index:2}],
    landmarks:refs.map((ref,i)=>({id:`geo_${i}`,source_id:`gen_${i}`,label:["Bookshop","Inn","Forge","Conservatory"][i]!,
      source_rectangle:{left:i*320,top:0,width:320,height:320},image:ref,visual:"a domed invented building"})) };
}
const decode=(url:string)=>Buffer.from(url.slice(url.indexOf(",")+1),"base64");
it("uses the dedicated endpoint schema and forwards only the exact adjacent PNG bytes",async()=>{
  const input=await fixture(),packet=await buildEndpointLedVideoPacket(input);
  expect(packet.model).toBe("fal-ai/kling-video/o3/standard/image-to-video");
  expect(Object.keys(packet.body).sort()).toEqual(["duration","end_image_url","generate_audio","image_url","prompt","shot_type"]);
  expect(decode(packet.body.image_url)).toEqual(input.endpoints[0].bytes);
  expect(decode(packet.body.end_image_url)).toEqual(input.endpoints[1].bytes);
  expect(packet.body.prompt).toContain("gently left");
  expect(packet.body.prompt).not.toMatch(/@Image|@Element|domed|calibrated|metres/);
  expect(packet.input_pins.judge_only_original_references.map(r=>r.sha256)).toEqual(input.landmarks.map(r=>r.image.sha256));
  expect(packet.input_pins.original_reference_pixels_forwarded_to_provider).toBe(false);
  expect(packet.authorization).toBe("not-granted");
});
it("blocks altered bytes, stale endpoint approvals and an incorrect adjacent position",async()=>{
  const stale=await fixture();stale.context.six_frame_sha256[2]="e".repeat(64);
  await expect(buildEndpointLedVideoPacket(stale)).rejects.toThrow("adjacent");
  const wrong=await fixture();wrong.endpoints[1].checkpoint_index=3;
  await expect(buildEndpointLedVideoPacket(wrong)).rejects.toThrow("adjacent");
  const altered=await fixture();altered.endpoints[0].bytes.fill(0);
  await expect(buildEndpointLedVideoPacket(altered)).rejects.toThrow("bytes");
});
it("snapshots all source pins before asynchronous decoding and never creates authorization",async()=>{
  const input=await fixture(),start=Buffer.from(input.endpoints[0].bytes),original=structuredClone(input.context);
  const pending=buildEndpointLedVideoPacket(input);
  input.endpoints[0].bytes.fill(0);input.context.owner_revision=99;input.landmarks[0]!.visual="force a new building";
  const packet=await pending;
  expect(decode(packet.body.image_url)).toEqual(start);
  expect(packet.input_pins.context).toEqual(original);
  expect(packet.estimate).toMatchObject({seconds:4,estimated_usd:.336,reservation_usd:.34,automatic_retries:0});
});
it("rejects an undersized endpoint even when its hash and opaque encoding are valid",async()=>{
  const input=await fixture(),small=await image("#ab1234",299,360);
  input.context.six_frame_sha256[1]=small.sha256;input.endpoints[0]={...small,checkpoint_index:1};
  input.endpoints[1]={...await image("#ab2345",299,360),checkpoint_index:2};input.context.six_frame_sha256[2]=input.endpoints[1].sha256;
  await expect(buildEndpointLedVideoPacket(input)).rejects.toThrow(/300/);
});
