"""Lossless source placement for same-plane OUTWARD outpainting."""

from __future__ import annotations

import io
import math
from dataclasses import dataclass

from PIL import Image, ImageOps


@dataclass(frozen=True)
class OutwardCanvas:
    source_png: bytes
    source_size: tuple[int, int]
    canvas_size: tuple[int, int]
    location: tuple[int, int]

    @classmethod
    def prepare(cls, source_bytes: bytes, factor: float) -> OutwardCanvas:
        if not math.isfinite(factor) or not 1.5 <= factor <= 4:
            raise ValueError("OUTWARD zoom factor must be between 1.5 and 4")
        with Image.open(io.BytesIO(source_bytes)) as raw:
            # Reject oversized canvases before decoding/allocating their pixels.
            # BRIA's documented canvas area limit is strictly below 5000x5000.
            if int(raw.width * factor) * int(raw.height * factor) >= 25_000_000:
                raise ValueError("Source is too large for lossless OUTWARD expansion")
            source = ImageOps.exif_transpose(raw).convert("RGBA")
        w, h = source.size
        cw, ch = int(w * factor), int(h * factor)
        buf = io.BytesIO()
        source.save(buf, "PNG")
        return cls(buf.getvalue(), (w, h), (cw, ch), ((cw - w) // 2, (ch - h) // 2))

    def composite(self, generated_bytes: bytes) -> bytes:
        with Image.open(io.BytesIO(generated_bytes)) as raw:
            if raw.size != self.canvas_size:
                # Never stretch a mismatched provider result: the seam would no
                # longer line up with the source placement sent to the provider.
                raise ValueError("OUTWARD provider returned the wrong canvas dimensions")
            canvas = raw.convert("RGBA")
        with Image.open(io.BytesIO(self.source_png)) as source:
            # No mask/feathering: every source pixel, including alpha, survives.
            canvas.paste(source, self.location)
        buf = io.BytesIO()
        canvas.save(buf, "PNG")
        return buf.getvalue()
