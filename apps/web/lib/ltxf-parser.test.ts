import { describe, expect, it } from "vitest";

import { codecsFromHeader, parseLTXF } from "./ltxf-parser";

/**
 * Build an LTXF frame: "LTXF" magic + uint32 BE header length + UTF-8 JSON
 * header + payload bytes. Magic is hardcoded here so the test does not
 * silently track changes to the shared constant in @openflipbook/config.
 */
function buildFrame(
  magic: string,
  headerJson: string | null,
  payload: Uint8Array,
  opts: { overrideHeaderLen?: number } = {}
): ArrayBuffer {
  const headerBytes =
    headerJson === null ? new Uint8Array(0) : new TextEncoder().encode(headerJson);
  const headerLen = opts.overrideHeaderLen ?? headerBytes.byteLength;
  const buf = new ArrayBuffer(4 + 4 + headerBytes.byteLength + payload.byteLength);
  const view = new Uint8Array(buf);
  // Magic.
  for (let i = 0; i < 4; i++) view[i] = magic.charCodeAt(i);
  // Big-endian header length.
  view[4] = (headerLen >>> 24) & 0xff;
  view[5] = (headerLen >>> 16) & 0xff;
  view[6] = (headerLen >>> 8) & 0xff;
  view[7] = headerLen & 0xff;
  view.set(headerBytes, 8);
  view.set(payload, 8 + headerBytes.byteLength);
  return buf;
}

describe("parseLTXF", () => {
  it("parses a well-formed frame with header object and payload bytes", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const header = { codecs: "vp9", session_id: "abc", frame_index: 7 };
    const frame = buildFrame("LTXF", JSON.stringify(header), payload);

    const packet = parseLTXF(frame);
    expect(packet.header).toEqual(header);
    expect(Array.from(packet.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it("throws when the frame is shorter than 8 bytes", () => {
    const tiny = new ArrayBuffer(4);
    expect(() => parseLTXF(tiny)).toThrow(/LTXF frame too small/);
  });

  it("throws on magic mismatch", () => {
    const frame = buildFrame("XXXX", JSON.stringify({ codecs: "x" }), new Uint8Array(0));
    expect(() => parseLTXF(frame)).toThrow(/LTXF magic mismatch/);
  });

  it("throws when header_len exceeds the frame length", () => {
    const payload = new Uint8Array(2);
    const frame = buildFrame("LTXF", "{}", payload, { overrideHeaderLen: 9999 });
    expect(() => parseLTXF(frame)).toThrow(/LTXF header length exceeds frame/);
  });

  it("throws when the header bytes are not valid JSON", () => {
    const frame = buildFrame("LTXF", "{not json", new Uint8Array(0));
    expect(() => parseLTXF(frame)).toThrow(/LTXF header is not valid JSON/);
  });
});

describe("codecsFromHeader", () => {
  it("returns header.codecs when present", () => {
    expect(codecsFromHeader({ codecs: "vp9" } as never)).toBe("vp9");
  });

  it("falls back to the safe avc1.640028 default when codecs is missing", () => {
    expect(codecsFromHeader({} as never)).toBe("avc1.640028");
  });
});
