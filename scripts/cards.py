# Draws the reel's text overlays as transparent 1080x1920 PNGs: the hook line and the place labels (pin + name).
# usage: python cards.py spec.json   (spec: {"font": path, "font2": path, "style": {...}, "items": [{"kind","text","sub","out"}]})
import json, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1920


def wrap(draw, text, font, maxw):
    lines, cur = [], ''
    for word in text.split():
        t = (cur + ' ' + word).strip()
        if draw.textlength(t, font=font) <= maxw or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def shadowed(img, draw_fn, blur=10, alpha=170):
    sh = Image.new('RGBA', img.size, (0, 0, 0, 0))
    draw_fn(ImageDraw.Draw(sh), (0, 0, 0, alpha), 3)
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(blur)))
    draw_fn(ImageDraw.Draw(img), None, 0)


def pin(draw, x, y, s, color):
    # map pin: circle head + pointed tail + white dot
    r = s * 0.42
    draw.ellipse([x - r, y - r, x + r, y + r], fill=color)
    draw.polygon([(x - r * 0.82, y + r * 0.55), (x + r * 0.82, y + r * 0.55), (x, y + s * 0.95)], fill=color)
    d = r * 0.4
    draw.ellipse([x - d, y - d, x + d, y + d], fill=(255, 255, 255, 255))


def hook_card(it, st, font_path):
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    size = st.get('hook_size', 76)
    font = ImageFont.truetype(font_path, size)
    d = ImageDraw.Draw(img)
    lines = wrap(d, it['text'], font, W - 160)
    lh = int(size * 1.22)
    y0 = int(H * st.get('hook_y', 0.3)) - lh * len(lines) // 2
    color = tuple(st.get('hook_color', [255, 255, 255]))
    if st.get('hook_box'):
        # rounded translucent box behind the lines
        bw = max(d.textlength(l, font=font) for l in lines) + 80
        box = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(box).rounded_rectangle([(W - bw) / 2, y0 - 30, (W + bw) / 2, y0 + lh * len(lines) + 20],
                                              radius=34, fill=(0, 0, 0, 120))
        img.alpha_composite(box)

    def draw_lines(dr, fill, off):
        for i, l in enumerate(lines):
            tw = dr.textlength(l, font=font)
            dr.text(((W - tw) / 2 + off, y0 + i * lh + off), l, font=font, fill=fill or color + (255,),
                    stroke_width=0 if fill else st.get('hook_stroke', 0), stroke_fill=(0, 0, 0, 255))
    shadowed(img, draw_lines)
    return img


def place_card(it, st, font_path, font2_path):
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    size = st.get('label_size', 64)
    font = ImageFont.truetype(font_path, size)
    font2 = ImageFont.truetype(font2_path, int(size * 0.55))
    d = ImageDraw.Draw(img)
    name, sub = it['text'], it.get('sub', '')
    tw = d.textlength(name, font=font)
    sw = d.textlength(sub, font=font2) if sub else 0
    ps = size * 1.05
    total = ps * 0.9 + 18 + max(tw, sw)
    x0 = (W - total) / 2
    yc = int(H * st.get('label_y', 0.5))
    pin_color = tuple(st.get('pin_color', [234, 67, 53])) + (255,)

    def draw_all(dr, fill, off):
        if fill:
            dr.ellipse([x0 - 4, yc - ps * 0.5 + off, x0 + ps * 0.84 + 4, yc + ps * 0.5 + off + 10], fill=fill)
        else:
            pin(dr, x0 + ps * 0.42, yc - ps * 0.12, ps, pin_color)
        tx = x0 + ps * 0.9 + 18 + off
        dr.text((tx, yc - size * 0.72 + off), name, font=font, fill=fill or (255, 255, 255, 255))
        if sub:
            dr.text((tx + 2, yc + size * 0.42 + off), sub, font=font2, fill=fill or (255, 255, 255, 225))
    shadowed(img, draw_all)
    return img


def main():
    spec = json.load(open(sys.argv[1], encoding='utf-8'))
    st = spec.get('style', {})
    for it in spec['items']:
        if it['kind'] == 'hook':
            im = hook_card(it, st, spec['font'])
        else:
            im = place_card(it, st, spec['font'], spec['font2'])
        im.save(it['out'])


if __name__ == '__main__':
    main()
