// The SSE chunker that was hand-rolled identically in the play page's generate
// loop, useAscend and useExpandBloom: buffered read → split on the "\n\n" frame
// boundary → yield each `data:` payload string. JSON.parse, abort checks and
// dispatch stay at the caller, so each site keeps its exact ordering. On early
// exit the reader is left as-is (no cancel) — callers own their AbortControllers
// — and a trailing partial frame at stream end is dropped, as every inline copy
// did.
export async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      yield payload;
    }
  }
}
