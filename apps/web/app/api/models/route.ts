import { NextResponse } from "next/server";
import { modalUrl as joinModalUrl } from "@/lib/modal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Thin proxy to the backend's GET /models — the image-model registry
 * (slug + capabilities) the dev model dropdown lists. */
export async function GET() {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) {
    return NextResponse.json({ error: "MODAL_API_URL not set." }, { status: 503 });
  }
  try {
    const upstream = await fetch(joinModalUrl(modalUrl, "/models"), {
      cache: "no-store",
    });
    return NextResponse.json(await upstream.json(), {
      status: upstream.status,
    });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
