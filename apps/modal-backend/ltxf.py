"""LTXF — custom binary frame format Endless Canvas uses over WebSocket.

Layout (matches flipbook.page's reverse-engineered protocol):

    [0..3]   ASCII "LTXF"
    [4..7]   uint32 big-endian header length n
    [8..8+n] UTF-8 JSON header {media_type, sequence, is_init_segment?, final?}
    [rest]   binary payload (fMP4 init or media segment)

The browser parses this in `apps/web/lib/ltxf-parser.ts` and feeds the payload
into a MediaSource SourceBuffer.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Any

LTXF_MAGIC = b"LTXF"


@dataclass
class LTXFPacket:
    header: dict[str, Any]
    payload: bytes


def encode(header: dict[str, Any], payload: bytes) -> bytes:
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return LTXF_MAGIC + struct.pack(">I", len(header_bytes)) + header_bytes + payload


def decode(buffer: bytes) -> LTXFPacket:
    if len(buffer) < 8 or buffer[:4] != LTXF_MAGIC:
        raise ValueError("not an LTXF packet")
    (header_len,) = struct.unpack(">I", buffer[4:8])
    header_end = 8 + header_len
    if header_end > len(buffer):
        raise ValueError("LTXF header length exceeds buffer")
    header = json.loads(buffer[8:header_end].decode("utf-8"))
    return LTXFPacket(header=header, payload=buffer[header_end:])


def split_fmp4(fmp4_bytes: bytes) -> tuple[bytes, bytes]:
    """Split a fragmented MP4 blob into (init_segment, media_segment).

    Init segment = ftyp + moov. Media segment = everything after (moof + mdat
    pairs). Assumes input is produced with movflags `frag_keyframe+empty_moov+
    default_base_moof` so there is exactly one moov at the start.
    """
    offset = 0
    moov_end: int | None = None
    size = len(fmp4_bytes)
    while offset + 8 <= size:
        box_size_raw = fmp4_bytes[offset : offset + 4]
        (box_size,) = struct.unpack(">I", box_size_raw)
        box_type = fmp4_bytes[offset + 4 : offset + 8]
        if box_size == 1:
            (large,) = struct.unpack(">Q", fmp4_bytes[offset + 8 : offset + 16])
            box_size = large
        if box_size == 0:
            box_size = size - offset
        if box_type == b"moov":
            moov_end = offset + box_size
            break
        offset += box_size
    if moov_end is None:
        raise ValueError("no moov box found in fMP4 bytes")
    return fmp4_bytes[:moov_end], fmp4_bytes[moov_end:]
