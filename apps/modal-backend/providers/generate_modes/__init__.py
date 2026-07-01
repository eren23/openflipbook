"""Per-mode SSE stream handlers extracted from generate._event_stream.

Each handler is an async generator that yields the exact same `_sse(...)` frames
the inline branch used to, threading generate.py's stream helpers explicitly so
this package never reaches back into generate.py's module globals.
"""
from providers.generate_modes.edit import stream_edit as stream_edit
from providers.generate_modes.expand import stream_expand as stream_expand
