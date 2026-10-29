# Draws the reel's text overlays as transparent 1080x1920 PNGs.
#   title: big yellow-gradient place name with a dark outline + white line with an arrow ("MUNNAR / In next 3 months")
#   item:  numbered spot like "1 / ERAVIKULAM NATIONAL PARK" in white caps with a black outline and a red pin under it
#   end:   closing line ("MORE BEAUTIFUL PLACES" + pin, or "FOLLOW FOR MORE")
# usage: python cards.py spec.json   (spec: {"fonts": {...}, "style": {...}, "items": [{"kind", "text", "sub", "num", "out"}]})
import json, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1920


def wrap(draw, text, font, maxw, stroke=0):
    lines, cur = [], ''
    for word in text.split():
        t = (cur + ' ' + word).strip()
        if draw.textlength(t, font=font) + 2 * stroke <= maxw or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def fit(draw, text, path, size, maxw, max_lines, stroke_ratio=0.0):
    # shrink until the text fits in max_lines lines
    while size > 30:
        f = ImageFont.truetype(path, size)
        lines = wrap(draw, text, f, maxw, int(size * stroke_ratio))
        if len(lines) <= max_lines:
            return f, lines, size
        size -= 6
    f = ImageFont.truetype(path, size)
    return f, wrap(draw, text, f, maxw), size


def shadow(img, mask, blur=14, alpha=150, off=(0, 6)):
    sh = Image.new('RGBA', img.size, (0, 0, 0, 0))
    sh.putalpha(mask.point(lambda v: v * alpha // 255))
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    img.alpha_composite(sh, off)


def pin(draw, x, y, s, color):
    r = s * 0.42
    draw.ellipse([x - r, y - r, x + r, y + r], fill=color)
    draw.polygon([(x - r * 0.82, y + r * 0.55), (x + r * 0.82, y + r * 0.55), (x, y + s * 0.95)], fill=color)
    d = r * 0.38
    draw.ellipse([x - d, y - d, x + d, y + d], fill=(255, 255, 255, 255))


def text_block(lines, font, y0, lh, fill_img=None, fill=(255, 255, 255, 255), stroke=0, stroke_fill=(0, 0, 0, 255), pin_after=None):
    """Centred lines with outline + soft shadow. fill_img (RGBA) paints the letters, e.g. a gradient."""
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    mask = Image.new('L', (W, H), 0)
    out = Image.new('L', (W, H), 0)
    md, od = ImageDraw.Draw(mask), ImageDraw.Draw(out)
    for i, l in enumerate(lines):
        tw = md.textlength(l, font=font)
        x, y = (W - tw) / 2, y0 + i * lh
        od.text((x, y), l, font=font, fill=255, stroke_width=stroke, stroke_fill=255)
        md.text((x, y), l, font=font, fill=255)
    shadow(img, out)
    if stroke:
        st = Image.new('RGBA', (W, H), stroke_fill)
        st.putalpha(out)
        img.alpha_composite(st)
    face = fill_img.copy() if fill_img is not None else Image.new('RGBA', (W, H), fill)
    face.putalpha(mask)
    img.alpha_composite(face)
    return img


def gradient(top, bottom, y0, y1):
    g = Image.new('RGBA', (W, H))
    d = ImageDraw.Draw(g)
    for y in range(H):
        t = min(1, max(0, (y - y0) / max(1, y1 - y0)))
        d.line([(0, y), (W, y)], fill=tuple(int(top[k] + (bottom[k] - top[k]) * t) for k in range(3)) + (255,))
    return g


def title_card(it, st, fonts):
    d = ImageDraw.Draw(Image.new('RGBA', (W, H)))
    name = it['text'].upper()
    font, lines, size = fit(d, name, fonts['title'], st.get('title_size', 190), W - 120, 2, 0.06)
    lh = int(size * 1.0)
    yc = int(H * st.get('title_y', 0.40))
    y0 = yc - lh * len(lines)
    top, bottom = st.get('grad', [[255, 236, 64], [255, 170, 20]])
    img = text_block(lines, font, y0, lh, fill_img=gradient(top, bottom, y0 + size * 0.2, y0 + lh * len(lines)),
                     stroke=max(6, int(size * 0.05)), stroke_fill=(40, 22, 0, 255))
    sub = it.get('sub', '').strip()
    if sub:
        sfont = ImageFont.truetype(fonts['sub'], st.get('sub_size', 58))
        sd = ImageDraw.Draw(img)
        tw = sd.textlength(sub, font=sfont)
        arrow = 130
        x0 = (W - (tw + arrow + 26)) / 2
        y = yc + 30
        layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        cy = y + st.get('sub_size', 58) * 0.62
        ld.line([(x0 + 14, cy), (x0 + arrow, cy)], fill=(255, 255, 255, 255), width=5)
        ld.polygon([(x0, cy), (x0 + 22, cy - 11), (x0 + 22, cy + 11)], fill=(255, 255, 255, 255))
        ld.text((x0 + arrow + 26, y), sub, font=sfont, fill=(255, 255, 255, 255))
        m = layer.getchannel('A')
        shadow(img, m, blur=10, alpha=170, off=(0, 4))
        img.alpha_composite(layer)
    return img


def item_card(it, st, fonts):
    d = ImageDraw.Draw(Image.new('RGBA', (W, H)))
    name = it['text'].upper()
    font, lines, size = fit(d, name, fonts['item'], st.get('item_size', 86), W - 140, 3, 0.08)
    lh = int(size * 1.08)
    if it.get('num'):
        lines = [str(it['num'])] + lines
    y0 = int(H * st.get('item_y', 0.30))
    stroke = max(5, int(size * 0.08))
    img = text_block(lines, font, y0, lh, stroke=stroke)
    pd = ImageDraw.Draw(img)
    ps = 70
    py = y0 + lh * len(lines) + 30
    pin(pd, W / 2 + 2, py + 4, ps, (0, 0, 0, 120))  # pin shadow
    pin(pd, W / 2, py, ps, tuple(st.get('pin_color', [230, 40, 40])) + (255,))
    return img


def end_card(it, st, fonts):
    d = ImageDraw.Draw(Image.new('RGBA', (W, H)))
    font, lines, size = fit(d, it['text'].upper(), fonts['item'], st.get('item_size', 86), W - 140, 3, 0.08)
    lh = int(size * 1.08)
    y0 = int(H * 0.5) - lh * len(lines) // 2
    img = text_block(lines, font, y0, lh, stroke=max(5, int(size * 0.08)))
    if it.get('pin', True):
        pin(ImageDraw.Draw(img), W / 2, y0 + lh * len(lines) + 34, 70, tuple(st.get('pin_color', [230, 40, 40])) + (255,))
    return img


def main():
    spec = json.load(open(sys.argv[1], encoding='utf-8-sig'))
    st, fonts = spec.get('style', {}), spec['fonts']
    for it in spec['items']:
        im = {'title': title_card, 'item': item_card, 'end': end_card}[it['kind']](it, st, fonts)
        im.save(it['out'])


if __name__ == '__main__':
    main()
