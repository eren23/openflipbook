"""Continuity bench (ViStoryBench-lite) for openflipbook.

Scores a multi-hop session for visual style coherence, entity-identity
consistency, and prompt-image alignment. Inspired by ViStoryBench
(arXiv:2505.24862), with three of its twelve metrics implemented for v1
via a VLM judge — keeps the surface tiny and avoids a CLIP install.

A session is a list of pages, each with the image bytes, the prompt the
image was rendered from, and the entity manifest at that point. The
bench accepts pre-recorded sessions; capture is orthogonal (replay from
Mongo, replay from disk, or feed in a freshly-run scripted scenario).
"""
