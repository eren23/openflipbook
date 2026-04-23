import { LTXF_MAGIC, type LTXFHeader } from "@openflipbook/config";

export interface LTXFPacket {
  header: LTXFHeader & { codecs?: string; session_id?: string };
  payload: Uint8Array;
}

const textDecoder = new TextDecoder();

/**
 * Parse a single binary WebSocket frame that carries exactly one LTXF packet.
 * Format: "LTXF" [uint32 BE header_len] [UTF-8 JSON header] [payload bytes].
 */
export function parseLTXF(frame: ArrayBuffer): LTXFPacket {
  const bytes = new Uint8Array(frame);
  if (bytes.byteLength < 8) {
    throw new Error(`LTXF frame too small: ${bytes.byteLength}`);
  }
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== LTXF_MAGIC) {
    throw new Error(`LTXF magic mismatch: ${magic}`);
  }
  const headerLen =
    ((bytes[4]! << 24) |
      (bytes[5]! << 16) |
      (bytes[6]! << 8) |
      bytes[7]!) >>>
    0;
  const headerEnd = 8 + headerLen;
  if (headerEnd > bytes.byteLength) {
    throw new Error("LTXF header length exceeds frame");
  }
  const headerText = textDecoder.decode(bytes.subarray(8, headerEnd));
  let header: LTXFPacket["header"];
  try {
    header = JSON.parse(headerText);
  } catch {
    throw new Error("LTXF header is not valid JSON");
  }
  return { header, payload: bytes.subarray(headerEnd) };
}

export function codecsFromHeader(header: LTXFPacket["header"]): string {
  if (header.codecs) return header.codecs;
  return "avc1.640028"; // H.264 High @ L4.0 — safe default for 1080p.
}
