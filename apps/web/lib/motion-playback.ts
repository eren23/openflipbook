// Caller must verify ownership and the complete immutable file before slicing.
export function motionPlaybackResponse(request: Request, bytes: Uint8Array) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff",
    "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
  const full = () => new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Length": String(bytes.length) } });
  const range = request.headers.get("range");
  // Unsupported units/multipart ranges and unvalidated If-Range fall back to
  // the full representation, as allowed by RFC 9110 sections 13.1.5 and 14.2.
  if (!range || request.headers.has("if-range") || !range.startsWith("bytes=") || range.includes(",") || !bytes.length) return full();
  const invalid = () => new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${bytes.length}` } });
  const match = range.length <= 256 ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (!match || !match[1] && !match[2]) return invalid();
  const length = BigInt(bytes.length);
  const first = match[1] ? BigInt(match[1]) : null, last = match[2] ? BigInt(match[2]) : null;
  if (first === null && last === 0n) return invalid();
  const start = first ?? (last! >= length ? 0n : length - last!);
  const end = first === null || last === null || last >= length ? length - 1n : last;
  if (start >= length || start > end) return invalid();
  return new Response(new Uint8Array(bytes.subarray(Number(start), Number(end) + 1)), { status: 206,
    headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${length}`, "Content-Length": String(end - start + 1n) } });
}
