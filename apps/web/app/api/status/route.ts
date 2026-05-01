import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) {
    return NextResponse.json(
      { ok: false, error: "MODAL_API_URL not set" },
      { status: 503 }
    );
  }
  try {
    const upstream = await fetch(`${modalUrl.replace(/\/$/, "")}/status`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `status_unreachable: ${(err as Error).message}`,
      },
      { status: 502 }
    );
  }
}
