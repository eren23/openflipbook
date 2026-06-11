"""Reconstruction bench — regenerate each ground-truth corpus map from its
authored description, extract what actually got drawn, and score it against
the ground truth (presence, position raw + aligned, size, heights) plus VLM
judges (style vs the reference scan, plausibility, prompt alignment). Plugs
the corpus scenarios into the matrix chassis (tests/matrix_bench)."""
