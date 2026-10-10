import { creatorRoute, checkCreatorWrite, CreatorError } from "@/lib/creator";
import { saveStreetEndpoint, streetMedia } from "@/lib/street-walk-server";
import { NextResponse } from "next/server";
import { worldReadHeaders } from "@/lib/world-read-response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = {params: Promise<{id: string; step: string}>};
export async function POST(req: Request,{params}:Params) {return creatorRoute(async()=>{checkCreatorWrite(req);const p=await params;return saveStreetEndpoint(p.id,p.step,await req.json());});}
export async function GET(req: Request,{params}:Params) {try{const p=await params;return await streetMedia(p.id,p.step,"frame",req);}catch(e){return NextResponse.json({error:e instanceof CreatorError?e.message:"Street frame unavailable"},{status:e instanceof CreatorError?e.status:503,headers:worldReadHeaders});}}
