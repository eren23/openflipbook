import { describe, expect, it } from "vitest";

import { sseData } from "./sse";

function stream(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

async function collect(parts: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of sseData(stream(parts))) out.push(payload);
  return out;
}

describe("sseData", () => {
  it("yields each data: payload", async () => {
    expect(await collect(['data: {"a":1}\n\ndata: {"b":2}\n\n'])).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it("reassembles frames split across reads", async () => {
    expect(await collect(["data: {\n", '"a":1}\n\n'])).toEqual(['{\n"a":1}']);
  });

  it("skips non-data lines and empty payloads", async () => {
    expect(await collect([": ping\n\ndata:\n\ndata: x\n\n"])).toEqual(["x"]);
  });

  it("drops a trailing partial frame, as the inline copies did", async () => {
    expect(await collect(["data: whole\n\ndata: partial"])).toEqual(["whole"]);
  });
});
