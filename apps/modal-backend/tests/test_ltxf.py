"""ltxf.py — the LTXF WebSocket envelope and the fMP4 init/media splitter,
exercised on tiny synthetic byte sequences (pure logic, no I/O)."""

from __future__ import annotations

import json
import struct

import pytest

import ltxf

# ── encode / decode ─────────────────────────────────────────────────────────


def test_encode_decode_round_trip() -> None:
    header = {"media_type": "video/mp4", "sequence": 3, "is_init_segment": True}
    payload = b"\x00\x01\x02fmp4-bytes"
    buf = ltxf.encode(header, payload)

    # wire layout: magic + uint32 BE header length + compact JSON + payload
    assert buf[:4] == b"LTXF"
    (header_len,) = struct.unpack(">I", buf[4:8])
    assert buf[8 : 8 + header_len] == json.dumps(header, separators=(",", ":")).encode()
    assert buf[8 + header_len :] == payload

    assert ltxf.decode(buf) == ltxf.LTXFPacket(header=header, payload=payload)


def test_decode_empty_payload() -> None:
    assert ltxf.decode(ltxf.encode({"final": True}, b"")).payload == b""


@pytest.mark.parametrize(
    "buf",
    [b"", b"LTX", b"NOPE" + struct.pack(">I", 0)],
    ids=["empty", "short", "wrong-magic"],
)
def test_decode_rejects_short_or_wrong_magic(buf: bytes) -> None:
    with pytest.raises(ValueError, match="not an LTXF packet"):
        ltxf.decode(buf)


def test_decode_rejects_truncated_header() -> None:
    buf = b"LTXF" + struct.pack(">I", 99) + b'{"a":1}'
    with pytest.raises(ValueError, match="header length exceeds"):
        ltxf.decode(buf)


# ── split_fmp4 ──────────────────────────────────────────────────────────────


def _box(box_type: bytes, payload: bytes = b"") -> bytes:
    return struct.pack(">I", 8 + len(payload)) + box_type + payload


def test_split_init_from_media_segments() -> None:
    ftyp = _box(b"ftyp", b"isom")
    moov = _box(b"moov", b"\x00" * 12)
    moof = _box(b"moof", b"\x01" * 4)
    mdat = _box(b"mdat", b"\x02" * 9)
    init, media = ltxf.split_fmp4(ftyp + moov + moof + mdat)
    assert init == ftyp + moov
    assert media == moof + mdat


def test_split_handles_64bit_box_size() -> None:
    # size field 1 -> real size lives in the 8-byte largesize after the type
    ftyp = _box(b"ftyp")
    payload = b"\x00" * 5
    large_moov = struct.pack(">I", 1) + b"moov" + struct.pack(">Q", 16 + len(payload)) + payload
    moof = _box(b"moof")
    init, media = ltxf.split_fmp4(ftyp + large_moov + moof)
    assert init == ftyp + large_moov
    assert media == moof


def test_split_size_zero_extends_to_end() -> None:
    ftyp = _box(b"ftyp")
    open_moov = struct.pack(">I", 0) + b"moov" + b"rest of file"
    init, media = ltxf.split_fmp4(ftyp + open_moov)
    assert init == ftyp + open_moov
    assert media == b""


def test_split_without_moov_raises() -> None:
    with pytest.raises(ValueError, match="no moov"):
        ltxf.split_fmp4(_box(b"ftyp") + _box(b"free"))
