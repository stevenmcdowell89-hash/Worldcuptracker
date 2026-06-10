# Regenerates the PWA icons (web/icon-512.png, web/icon-192.png) as a flat monogram
# that matches the in-app wordmark: "WC" in white over "26" in light blue, on the
# brand indigo. No gloss, no bevel, no clip-art — quiet and modern.
#
# One-off tooling (not part of the node build):
#   pip install pillow
#   curl -sL -o /tmp/bricolage.ttf "https://github.com/google/fonts/raw/main/ofl/bricolagegrotesque/BricolageGrotesque%5Bopsz,wdth,wght%5D.ttf"
#   python3 scripts/gen-icon.py
#
# Full-bleed square, no transparency (apple-touch-icon turns transparent corners
# black); the monogram sits inside the centre ~60% so circle/squircle launcher
# masks (purpose "any maskable") never clip it.

from PIL import Image, ImageDraw, ImageFont

BRAND = (75, 69, 224)        # --brand #4B45E0
LIGHT = (175, 214, 255)      # #AFD6FF — the wordmark's light-blue accent
WHITE = (255, 255, 255)
FONT = "/tmp/bricolage.ttf"
S = 1024                     # render large, downscale for crisp edges


def text_layer(text, px, colour):
    f = ImageFont.truetype(FONT, px)
    f.set_variation_by_axes([96, 800, 100])  # axes order: opsz 96, wght ExtraBold, wdth 100
    l, t, r, b = f.getbbox(text)
    img = Image.new("RGBA", (r - l, b - t), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((-l, -t), text, font=f, fill=colour)
    return img


img = Image.new("RGB", (S, S), BRAND)
wc = text_layer("WC", 300, WHITE)
yr = text_layer("26", 300, LIGHT)

gap = 26
block_h = wc.height + gap + yr.height
y = (S - block_h) // 2
img.paste(wc, ((S - wc.width) // 2, y), wc)
img.paste(yr, ((S - yr.width) // 2, y + wc.height + gap), yr)

for size, name in [(512, "icon-512.png"), (192, "icon-192.png")]:
    img.resize((size, size), Image.LANCZOS).save(f"web/{name}", optimize=True)
    print(f"wrote web/{name}")
