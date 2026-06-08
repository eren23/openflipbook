import { type NextRequest, NextResponse } from "next/server";
import { modalUrl as joinModalUrl } from "@/lib/modal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) {
    return NextResponse.json(
      { ok: false, error: "MODAL_API_URL not set" },
      { status: 503 }
    );
  }

  const rawLimit = req.nextUrl.searchParams.get("limit");
  const limit = rawLimit ? Math.max(0, Math.min(500, Number(rawLimit) || 100)) : 100;

  try {
    const upstream = await fetch(
      joinModalUrl(modalUrl, `/trace/abort-stats?limit=${limit}`),
      {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(6000),
      }
    );
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
        error: `abort_stats_unreachable: ${(err as Error).message}`,
      },
      { status: 502 }
    );
  }
}
