import { createHash } from "node:crypto";
import sharp from "sharp";
import { expect, it } from "vitest";
import { buildH3ReferenceVideoPacket, H3_REFERENCE_MODEL } from "./image-led-h3-reference-video-packet";
import type { ReferenceVideoPacketInput, ReferenceVideoImage } from "./image-led-reference-video-packet";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function image(color: string, width = 640, height = 360): Promise<ReferenceVideoImage> {
 const bytes = await sharp({create:{width,height,channels:3,background:color}}).png().toBuffer();
 return {bytes,sha256:sha(bytes),content_type:"image/png",width,height};
}
async function fixture(): Promise<ReferenceVideoPacketInput> {
 const frames=await Promise.all(["#123456","#234567","#345678","#456789","#56789a","#6789ab"].map(c=>image(c)));
 const refs=await Promise.all(["#220000","#002200","#000022","#222200"].map(c=>image(c,320,320)));
 return {context:{owner_route_id:"owned-route",owner_revision:1,source_binding_sha256:"a".repeat(64),frame_review_sha256:"b".repeat(64),still_manifest_sha256:"c".repeat(64),six_frame_sha256:frames.map(f=>f.sha256)},
  source:{sha256:"d".repeat(64),width:2048,height:1152},points:[[940,900],[1020,815],[1060,720],[1070,630],[1050,545],[1030,465]].map(([x,y])=>({x:x!/2048,y:y!/1152})),from_index:1,
  endpoints:[{...frames[1]!,checkpoint_index:1},{...frames[2]!,checkpoint_index:2}],
  landmarks:refs.map((ref,i)=>({id:`geo_${i}`,source_id:`gen_${i}`,label:["Bookshop","Inn","Forge","Conservatory"][i]!,source_rectangle:{left:i*320,top:0,width:320,height:320},image:ref,visual:"domed invented historical storefront"}))};
}
const decode=(url:string)=>Buffer.from(url.slice(url.indexOf(",")+1),"base64");
it("transmits both exact endpoints and all four original crops through the H3 reference schema",async()=>{
 const input=await fixture(),p=await buildH3ReferenceVideoPacket(input);
 expect(p.model).toBe(H3_REFERENCE_MODEL);expect(p.body.duration).toBe(4);
 expect(decode(p.body.image_url)).toEqual(input.endpoints[0].bytes);expect(decode(p.body.end_image_url)).toEqual(input.endpoints[1].bytes);
 p.body.reference_image_urls.forEach((url,i)=>expect(decode(url)).toEqual(input.landmarks[i]!.image.bytes));
 expect(p.body.prompt_expansion_mode).toBe("disabled");expect(p.body.prompt.length).toBeLessThan(1800);
 expect(p.body.prompt).not.toMatch(/domed|historical storefront|@Image|calibrated|metres/);
 expect(p.body.prompt).toContain("increasingly clipped");expect(p.body.prompt).toContain("gently left");
 expect(p.input_pins.references.map(r=>r.reference)).toEqual(["Image 1","Image 2","Image 3","Image 4"]);
 expect(p.estimate).toMatchObject({reservation_usd:.42,automatic_retries:0});expect(p.authorization).toBe("not-granted");
});
it("blocks tampered original crops, nonadjacent frames and missing full-route approvals",async()=>{
 const a=await fixture();a.landmarks[0]!.image.bytes.fill(0);await expect(buildH3ReferenceVideoPacket(a)).rejects.toThrow("bytes");
 const b=await fixture();b.endpoints[1].checkpoint_index=3;await expect(buildH3ReferenceVideoPacket(b)).rejects.toThrow("adjacent");
 const c=await fixture();c.context.six_frame_sha256.pop();await expect(buildH3ReferenceVideoPacket(c)).rejects.toThrow("complete");
});
it("snapshots exact source/context before awaited image decoding",async()=>{
 const input=await fixture(),start=Buffer.from(input.endpoints[0].bytes),ref=Buffer.from(input.landmarks[0]!.image.bytes);
 const pending=buildH3ReferenceVideoPacket(input);input.endpoints[0].bytes.fill(0);input.landmarks[0]!.image.bytes.fill(0);input.context.owner_revision=99;
 const p=await pending;expect(decode(p.body.image_url)).toEqual(start);expect(decode(p.body.reference_image_urls[0]!)).toEqual(ref);expect(p.input_pins.context.owner_revision).toBe(1);
});
it("rejects otherwise valid image pixels too large for the closed reservation",async()=>{
 const input=await fixture();const huge=await image("#112200",2000,1200);input.endpoints[0]={...huge,checkpoint_index:1};input.endpoints[1]={...await image("#223300",2000,1200),checkpoint_index:2};
 input.context.six_frame_sha256[1]=input.endpoints[0].sha256;input.context.six_frame_sha256[2]=input.endpoints[1].sha256;
 for(let i=0;i<4;i++){const ref=await image(["#330000","#003300","#000033","#333300"][i]!,500,500);input.landmarks[i]!.image=ref;input.landmarks[i]!.source_rectangle={left:i*500,top:0,width:500,height:500};}
 await expect(buildH3ReferenceVideoPacket(input)).rejects.toThrow("reservation");
});
