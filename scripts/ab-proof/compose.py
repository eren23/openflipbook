from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


def font(sz):
    return ImageFont.truetype(FONT, sz)


def labeled(path, caption, barcolor, w=600, h=600, barh=64):
    im = Image.open(path).convert("RGB").resize((w, h))
    canvas = Image.new("RGB", (w, h + barh), barcolor)
    canvas.paste(im, (0, 0))
    d = ImageDraw.Draw(canvas)
    f = font(26)
    tw = d.textlength(caption, font=f)
    d.text(((w - tw) // 2, h + (barh - 30) // 2), caption, font=f, fill="white")
    return canvas


def sbs(left, right, title, out, titleh=72):
    gap = 12
    W = left.width + right.width + gap
    H = max(left.height, right.height) + titleh
    canvas = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(canvas)
    f = font(22)
    tw = d.textlength(title, font=f)
    d.text(((W - tw) // 2, (titleh - 26) // 2), title, font=f, fill="black")
    canvas.paste(left, (0, titleh))
    canvas.paste(right, (left.width + gap, titleh))
    # even dims for h264
    if canvas.width % 2 or canvas.height % 2:
        canvas = canvas.crop((0, 0, canvas.width - canvas.width % 2, canvas.height - canvas.height % 2))
    canvas.save(out)
    print("wrote", out, canvas.size)


# Edit A/B — the dramatic, code-isolated proof
lb = labeled("/tmp/ab_edit_before.jpg", "BEFORE - pre-fix: edit drops the style", "#B00020")
rb = labeled("/tmp/ab_edit_after.jpg", "AFTER - fix: medium locked", "#0B7A33")
sbs(
    lb, rb,
    "openflipbook  -  edit 'add a clockwork dragon'  -  same request + Gemini & nano-banana-pro, only the CODE differs",
    "/tmp/ab_edit_sbs.png",
)

# Tap A/B — both hold engraving under corrected env (honest framing)
lt = labeled("/tmp/ab_before.jpg", "pre-fix backend (corrected env)", "#555555", 600, 338, 56)
rt = labeled("/tmp/ab_after.jpg", "fix backend", "#0B7A33", 600, 338, 56)
sbs(
    lt, rt,
    "go-inside tap  -  both hold the engraving under corrected env (the screenshot's hard drift was the qwen env, not code)",
    "/tmp/ab_tap_sbs.png",
)
