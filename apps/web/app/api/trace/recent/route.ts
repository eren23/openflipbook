import { type NextRequest, NextResponse } from "next/server";
import { debugAccessAllowed } from "@/lib/debug-access";
import { modalAuthHeaders, modalUrl as joinModalUrl } from "@/lib/modal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Proxies the backend trace buffer (cross-tenant) — gate like the errors GET.
  if (!debugAccessAllowed(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) {
    return NextResponse.json(
      { ok: false, error: "MODAL_API_URL not set" },
      { status: 503 }
    );
  }

  const rawLimit = req.nextUrl.searchParams.get("limit");
  const limit = rawLimit ? Math.max(1, Math.min(200, Number(rawLimit) || 50)) : 50;

  try {
    const upstream = await fetch(
      joinModalUrl(modalUrl, `/trace/recent?limit=${limit}`),
      {
        method: "GET",
        cache: "no-store",
        headers: modalAuthHeaders(),
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
        error: `trace_unreachable: ${(err as Error).message}`,
      },
      { status: 502 }
    );
  }
}
