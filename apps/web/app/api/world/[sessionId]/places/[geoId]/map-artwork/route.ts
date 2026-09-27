import { creatorRoute, checkCreatorWrite, CreatorError } from "@/lib/creator";
import { mapArtworkContext, saveMapAlignment } from "@/lib/map-artwork-server";
import { createMapArtworkSketch } from "@/lib/sketch-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; geoId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const p = await params; return creatorRoute(() => mapArtworkContext(p.sessionId, p.geoId));
}
export async function POST(req: Request, { params }: Params) {
  const p = await params; return creatorRoute(() => createMapArtworkSketch(req, p.sessionId, p.geoId));
}
export async function PATCH(req:Request,{params}:Params) {
  const p=await params;
  return creatorRoute(async()=>{
    checkCreatorWrite(req);const reader=req.body?.getReader();if(!reader)throw new CreatorError("Missing alignment JSON",400);
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new CreatorError("Alignment exceeds 16 KiB",413);}chunks.push(value);}}finally{reader.releaseLock();}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new CreatorError("Invalid alignment JSON",400);}
    if(!body||typeof body!=="object"||Array.isArray(body))throw new CreatorError("Invalid alignment",400);
    return saveMapAlignment(p.sessionId,p.geoId,body);
  });
}
