import { checkCreatorWrite, CreatorError, creatorRoute } from "@/lib/creator";
import { readWalkPosition, saveWalkPosition } from "@/lib/walk-position-server";
import { placeScenesEnabled } from "@/lib/place-scene-enabled";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ sessionId: string }> };
const enabled = () => { if(!placeScenesEnabled())throw new CreatorError("World scenes are disabled",403); };
export async function GET(_req: Request,{params}:Params) {
  return creatorRoute(async()=>{enabled();return readWalkPosition((await params).sessionId);});
}
export async function POST(req: Request,{params}:Params) {
  return creatorRoute(async()=>{
    enabled();checkCreatorWrite(req);
    const text=await req.text();if(text.length>4096)throw new CreatorError("Position request too large",413);
    let body;try{body=JSON.parse(text);}catch{throw new CreatorError("Invalid JSON",400);}
    return saveWalkPosition((await params).sessionId,body);
  });
}
