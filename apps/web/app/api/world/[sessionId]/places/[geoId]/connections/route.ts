import { checkCreatorWrite, CreatorError, creatorRoute } from "@/lib/creator";
import { readPlaceNetwork } from "@/lib/place-connections-store";
import { previewAdjacentPlace } from "@/lib/place-scene-server";
import { isSafeId } from "@/lib/ids";
import { placeScenesEnabled } from "@/lib/place-scene-enabled";
import { adjacentBuildCapabilities, generateAdjacentPlace } from "@/lib/adjacent-place-build";

export const runtime="nodejs";
export const dynamic="force-dynamic";
interface Params {params:Promise<{sessionId:string;geoId:string}>}
export async function GET(req:Request,{params}:Params){
  const {sessionId,geoId}=await params;
  return creatorRoute(async()=>{
    if(!placeScenesEnabled()||!isSafeId(sessionId)||!isSafeId(geoId))throw new CreatorError("Invalid place",400);
    if(new URL(req.url).searchParams.get("generation")==="1")return adjacentBuildCapabilities(sessionId,geoId);
    return {network:await readPlaceNetwork(sessionId,geoId)};
  });
}
export async function POST(req:Request,{params}:Params){
  const {sessionId,geoId}=await params;
  return creatorRoute(async()=>{
    checkCreatorWrite(req);
    const text=await req.text();if(text.length>150_000)throw new CreatorError("Proposal too large",413);
    let input;try{input=JSON.parse(text);}catch{throw new CreatorError("Invalid JSON",400);}
    if(!input||typeof input!=="object"||Array.isArray(input))throw new CreatorError("Invalid request",400);
    if(input.action==="generate")return generateAdjacentPlace(sessionId,geoId,input);
    if(input.action!==undefined)throw new CreatorError("Invalid connection action",400);
    return previewAdjacentPlace(sessionId,geoId,input);
  });
}
