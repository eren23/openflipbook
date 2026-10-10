import { CreatorError } from "@/lib/creator";
import { streetMedia } from "@/lib/street-walk-server";
import { NextResponse } from "next/server";
import { worldReadHeaders } from "@/lib/world-read-response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request,{params}:{params:Promise<{id:string;step:string}>}) {try{const p=await params;return await streetMedia(p.id,p.step,"video",req);}catch(e){return NextResponse.json({error:e instanceof CreatorError?e.message:"Street video unavailable"},{status:e instanceof CreatorError?e.status:503,headers:worldReadHeaders});}}
