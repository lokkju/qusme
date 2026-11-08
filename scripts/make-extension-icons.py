# Renders the extension icons (packages/extension/public/icon/*.png) from the site mark:
# rounded square #1f5f4a with a white Newsreader "q". 128 px follows Chrome: 96 px art, 16 px padding.
# uv run --with fonttools --with brotli --with pillow python -I scripts/make-extension-icons.py \
#   <newsreader-latin-wght-normal.woff2> <output dir>
import sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image, ImageDraw, ImageFont

src, out = Path(sys.argv[1]), Path(sys.argv[2])
f = TTFont(src)
f.flavor = None
if "fvar" in f:
    f = instantiateVariableFont(f, {"wght": 500})
ttf = out.parent / "newsreader-500.ttf"
f.save(ttf)

GREEN, SS = (0x1F, 0x5F, 0x4A, 255), 8

def mark(px: int, pad: int) -> Image.Image:
    S = px * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    p, w = pad * SS, (px - 2 * pad) * SS
    d.rounded_rectangle([p, p, p + w - 1, p + w - 1], radius=int(w * 7 / 32), fill=GREEN)
    font = ImageFont.truetype(str(ttf), int(w * 0.80))
    # centre the glyph's ink box (x-height letter with descender)
    l, t, r, b = d.textbbox((0, 0), "q", font=font)
    x = p + (w - (r - l)) / 2 - l
    y = p + (w - (b - t)) / 2 - t
    d.text((x, y), "q", font=font, fill=(255, 255, 255, 255))
    return img.resize((px, px), Image.LANCZOS)

for px in (16, 32, 48, 96):
    mark(px, 0).save(out / f"{px}.png")
mark(128, 16).save(out / "128.png")       # Chrome: 96px artwork in 16px transparent padding
mark(128, 0).save(out / "store-128.png")  # full-bleed copy for listings if wanted
