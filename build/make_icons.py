"""울림 아이콘 (모든 크기를 코드로 그림)

  python3 build/make_icons.py                         # 그라데이션 스타일(기본 --palette=green, 또는 blue)로 모든 아이콘 다시 만들기
  python3 build/make_icons.py --preview               # 미리 보기만 /tmp/ullim-icons-preview.png (파일은 그대로)
  python3 build/make_icons.py --style=glass           # 1.2.1 의 리퀴드 글라스 아이콘

그라데이션 스타일(1.2.2~): 흰 바탕에 굵고 둥근 '울림' 기호를 여러 색이 물감처럼 부드럽게 섞인 그라데이션으로 칠함
(요즘 앱 아이콘의 흐름 — 특정 회사의 로고 · 색 배치는 따라 하지 않음). 안드로이드 적응형 바탕은 흰색(@color/ic_bg).

그림: 짙은 남색 바탕에 파랑 · 보라 · 청록 빛이 번져 있고, 그 위에 '울림' 기호(가운데 점 + 양쪽 소리 물결 두 겹)가
유리 막대로 놓여 있다. 유리는 뒤 빛을 흐리게 비추고(굴절), 왼쪽 위에서 오는 빛에 가장자리가 반짝이며, 아래로 은은한 그림자와
유리를 지난 빛(색 그림자)이 떨어진다. 바깥 타일도 유리판처럼 테두리가 빛난다.
안드로이드 적응형 아이콘은 바탕(빛) · 앞(유리 기호) · 단색(테마 아이콘)을 따로 만든다.
"""
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = 2048                       # 작업 해상도 (마지막에 줄여서 부드럽게)
yy, xx = np.mgrid[0:W, 0:W].astype(np.float32)
U, V = (xx + 0.5) / W, (yy + 0.5) / W          # 0..1


def hexc(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)


# ---------- 바탕: 짙은 남색 + 번지는 빛 ----------
def backdrop():
    top, bot = hexc('#14245a'), hexc('#090c1f')
    g = (V[..., None] * bot + (1 - V[..., None]) * top)
    def blob(cx, cy, r, col, a):
        d = np.sqrt((U - cx) ** 2 + (V - cy) ** 2) / r
        w = np.clip(1 - d, 0, 1) ** 2 * a
        return w[..., None] * hexc(col)
    light = (blob(0.26, 0.24, 0.62, '#3f7dff', 0.95) + blob(0.80, 0.76, 0.58, '#8f55ff', 0.85)
             + blob(0.86, 0.14, 0.36, '#2fe3d2', 0.55) + blob(0.14, 0.88, 0.40, '#ff5fa8', 0.40))
    out = 1 - (1 - g) * (1 - np.clip(light, 0, 1))             # 화면 겹치기(screen)
    return np.clip(out, 0, 1)


# ---------- '울림' 기호의 거리장 (SDF, 안쪽이 음수) ----------
def symbol_sdf(scale=1.0, bold=False):
    cx = cy = W / 2
    px, py = xx - cx, yy - cy
    r = np.sqrt(px * px + py * py)
    ang = np.arctan2(py, px)
    s = W * scale
    if bold:                                                    # 굵고 둥근 모양 (그라데이션 아이콘)
        dot, rings = 0.098 * s, ((0.212 * s, 0.047 * s, np.radians(47)), (0.338 * s, 0.047 * s, np.radians(50)))
    else:
        dot, rings = 0.085 * s, ((0.195 * s, 0.033 * s, np.radians(46)), (0.312 * s, 0.033 * s, np.radians(50)))
    d = r - dot                                                 # 가운데 점
    for R, half_w, span in rings:
        for c in (0.0, np.pi):                                  # 오른쪽 · 왼쪽 물결
            a = np.angle(np.exp(1j * (ang - c)))                # c 기준 각도 (-pi..pi)
            inside = np.abs(a) <= span
            ring = np.abs(r - R) - half_w
            ex = [(R * np.cos(c + sg * span), R * np.sin(c + sg * span)) for sg in (-1, 1)]
            caps = np.minimum(*[np.sqrt((px - x) ** 2 + (py - y) ** 2) for x, y in ex]) - half_w
            d = np.minimum(d, np.where(inside, ring, caps))
    return d


def smooth_mask(d, aa=1.2):
    return np.clip(0.5 - d / aa, 0, 1)


def blur(a, sigma):
    if a.ndim == 3:
        return np.stack([ndimage.gaussian_filter(a[..., k], sigma) for k in range(a.shape[2])], -1)
    return ndimage.gaussian_filter(a, sigma)


def shift(a, dx, dy):
    return ndimage.shift(a, (dy, dx) + ((0,) if a.ndim == 3 else ()), order=1, mode='nearest')


# ---------- 유리 기호 그리기 ----------
def glass(bg, d, *, refract=46.0, bevel=None):
    """bg 위에 거리장 d 모양의 유리를 얹은 (색, 알파, 그림자 · 빛) 를 돌려줌"""
    m = smooth_mask(d)
    bev = bevel or 0.033 * W
    t = np.clip(-d / bev, 0, 1)
    h = np.sqrt(1 - (1 - t) ** 2)                               # 둥근 막대 모양 높이
    gy, gx = np.gradient(ndimage.gaussian_filter(h, 2.0))
    k = bev * 0.9
    n = np.stack([-gx * k, -gy * k, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    # 굴절: 가장자리일수록 뒤 화면을 바깥쪽에서 끌어옴 + 젖빛(흐림)
    frost = blur(bg, 14)
    sx = np.clip(xx + n[..., 0] * refract, 0, W - 1)
    sy = np.clip(yy + n[..., 1] * refract, 0, W - 1)
    ref = np.stack([ndimage.map_coordinates(frost[..., c], [sy, sx], order=1) for c in range(3)], -1)
    lum = ref.mean(-1, keepdims=True)
    ref = np.clip(lum + (ref - lum) * 1.55, 0, 1)               # 유리를 지나며 색이 조금 진해짐
    body = ref * 0.76 + 0.26                                     # 유리 자체의 흰 기운 (뒤 빛이 비쳐 보이게)
    L = np.array([-0.55, -0.72, 0.42], np.float32); L /= np.linalg.norm(L)
    H = L + np.array([0, 0, 1], np.float32); H /= np.linalg.norm(H)
    diff = (n @ L)
    spec = np.clip(n @ H, 0, 1) ** 70 * 1.1                      # 왼쪽 위 반짝임
    rim = (1 - np.clip(n[..., 2], 0, 1)) ** 2.2 * 0.55           # 가장자리 빛 (프레넬)
    edge = np.clip(1 - np.abs(d) / 3.0, 0, 1) * np.clip(-gy * 6 - gx * 4 + 0.35, 0, 1) * 0.6   # 위 왼쪽 가는 테두리
    col = body * (0.88 + 0.12 * np.clip(diff, -1, 1))[..., None]
    col = col + (spec + rim + edge)[..., None] * np.array([1.0, 1.0, 1.0], np.float32)
    col = np.clip(col, 0, 1)
    # 그림자 · 유리를 지난 색 빛
    sh = shift(blur(m, 26), 0, 0.012 * W)
    glow = shift(blur(m, 40), 0.008 * W, 0.022 * W)
    return col, m, sh, glow


def compose(bg, d, **kw):
    col, m, sh, glow = glass(bg, d, **kw)
    base = bg * (1 - 0.42 * sh[..., None])
    base = 1 - (1 - base) * (1 - glow[..., None] * hexc('#7fb2ff') * 0.42)
    return base * (1 - m[..., None]) + col * m[..., None]


# ---------- 바깥 타일 (둥근 네모, 유리판 테두리) ----------
def tile_mask(n=5.6, margin=0.0):
    a = (1 - 2 * margin) / 2
    fx, fy = np.abs(U - 0.5) / a, np.abs(V - 0.5) / a
    f = (fx ** n + fy ** n) ** (1 / n)
    px = 1 / (a * W)
    m = np.clip((1 - f) / px * 0.5 + 0.5, 0, 1)
    dist = (1 - f) * a * W                                      # 가장자리에서 안쪽까지 (대략, 픽셀)
    return m, dist


def tile(img, margin=0.0):
    m, dist = tile_mask(margin=margin)
    gy, gx = np.gradient(np.clip(dist, 0, 40))
    band = np.exp(-np.clip(dist, 0, None) / (0.006 * W))         # 가장자리 띠
    light = np.clip((gx * 0.7 + gy * 0.9) * 2.0, -1, 1)          # 위 · 왼쪽 가장자리일수록 +
    out = img + (band * np.clip(light, 0, 1) * 0.55)[..., None]
    out = out * (1 - (band * np.clip(-light, 0, 1) * 0.25)[..., None])
    sheen = np.clip(1 - V / 0.55, 0, 1) ** 2 * 0.06              # 위쪽 은은한 광택
    out = np.clip(out + sheen[..., None], 0, 1)
    return np.concatenate([out, m[..., None]], -1)


def to_img(a, size):
    a = np.clip(a, 0, 1)
    mode = 'RGBA' if a.shape[-1] == 4 else 'RGB'
    if mode == 'RGBA':                                           # 줄일 때 가장자리가 어둡지 않게 (알파 곱해서 줄이고 되돌림)
        rgb = a[..., :3] * a[..., 3:]
        big = np.concatenate([rgb, a[..., 3:]], -1)
        im = Image.fromarray((big * 255 + 0.5).astype(np.uint8), 'RGBA').resize((size, size), Image.LANCZOS)
        arr = np.asarray(im).astype(np.float32) / 255
        al = arr[..., 3:]
        arr[..., :3] = np.where(al > 0, arr[..., :3] / np.maximum(al, 1e-4), 0)
        return Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA')
    return Image.fromarray((a * 255 + 0.5).astype(np.uint8), mode).resize((size, size), Image.LANCZOS)


# ---------- 그라데이션 스타일 (흰 바탕 + 부드럽게 섞이는 여러 색, 굵고 둥근 기호) ----------
PALETTES = {
    # 파랑 위주 (하늘색 → 파랑 → 보라, 한쪽에 분홍 기운)
    'blue': [((0.20, 0.22), '#53c8ff', 0.30), ((0.28, 0.80), '#2563ff', 0.30), ((0.55, 0.48), '#3b74ff', 0.22),
             ((0.82, 0.24), '#7c5cff', 0.28), ((0.84, 0.82), '#ff5f9e', 0.24)],
    # 초록 · 노랑 · 파랑이 섞임
    # 초록 · 노랑 · 파랑 (노랑과 파랑 사이에는 청록을 두어 중간색이 탁해지지 않게)
    'green': [((0.14, 0.70), '#0fb46a', 0.27), ((0.30, 0.16), '#2fd89f', 0.22), ((0.70, 0.10), '#ffc21a', 0.24),
              ((0.93, 0.34), '#ffb000', 0.16), ((0.98, 0.55), '#3cc96a', 0.12), ((0.90, 0.72), '#12b5e8', 0.12),
              ((0.78, 0.90), '#2f6bff', 0.22), ((0.50, 0.52), '#20a4f3', 0.15)],
}


def _lin(c): return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def _gam(c): return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - 0.055)
def to_oklab(rgb):
    r, g, b = [_lin(rgb[..., i]) for i in range(3)]
    l = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s_ = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return np.stack([0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s_,
                     1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s_,
                     0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s_], -1)
def from_oklab(lab):
    L, A, B = lab[..., 0], lab[..., 1], lab[..., 2]
    l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
    m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
    s_ = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s_
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s_
    b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s_
    return np.clip(np.stack([_gam(r), _gam(g), _gam(b)], -1), 0, 1)


def mesh(points):
    """여러 색 점을 부드럽게 섞은 판 (물감이 번진 듯한 그라데이션). 색은 OKLab 에서 섞어 중간색이 탁해지지 않게"""
    # 밝기 · 채도는 평균, 색상(hue)은 원 위에서 평균 → 노랑과 파랑 사이가 회색이 아니라 초록 · 청록으로 이어짐
    L = np.zeros((W, W), np.float32); C = np.zeros((W, W), np.float32)
    hx = np.zeros((W, W), np.float32); hy = np.zeros((W, W), np.float32); wsum = np.zeros((W, W), np.float32)
    for (cx, cy), col, r in points:
        w = np.exp(-(((U - cx) ** 2 + (V - cy) ** 2) / (2 * r * r)))
        lab = to_oklab(hexc(col)); c = float(np.hypot(lab[1], lab[2])); h = float(np.arctan2(lab[2], lab[1]))
        L += w * lab[0]; C += w * c; hx += w * np.cos(h); hy += w * np.sin(h); wsum += w
    wsum = np.maximum(wsum, 1e-6)
    L, C, H = L / wsum, C / wsum * 1.04, np.arctan2(hy, hx)
    return from_oklab(np.stack([L, C * np.cos(H), C * np.sin(H)], -1)).astype(np.float32)


def gradient_glyph(d, palette):
    """색 · 알파: 그라데이션으로 칠한 기호 + 아주 옅은 입체감(위 밝게 · 아래 조금 진하게)"""
    m = smooth_mask(d)
    col = mesh(PALETTES[palette])
    bev = 0.047 * W
    t = np.clip(-d / bev, 0, 1)
    h = np.sqrt(1 - (1 - t) ** 2)
    gy, gx = np.gradient(ndimage.gaussian_filter(h, 2.0))
    lit = np.clip(-(gx * 0.6 + gy * 1.0) * bev * 0.9, -1, 1)          # 위 · 왼쪽을 향한 면 +
    col = np.clip(col + 0.10 * np.clip(lit, 0, 1)[..., None] - 0.07 * np.clip(-lit, 0, 1)[..., None], 0, 1)
    sheen = np.clip(1 - V / 0.6, 0, 1) * 0.06                          # 위쪽이 조금 더 밝게
    col = np.clip(col + sheen[..., None], 0, 1)
    return col, m


def white_tile(img_rgb, margin=0.0, dark=False):
    m, dist = tile_mask(margin=margin)
    border = np.exp(-np.clip(dist, 0, None) / (0.0035 * W)) * (0.22 if dark else 0.10)   # 같은 색 화면에서도 보이게 아주 옅은 테두리
    out = img_rgb * (1 - border[..., None]) + border[..., None] * hexc('#3a3f4b' if dark else '#c9d2e3')
    return np.concatenate([np.clip(out, 0, 1), m[..., None]], -1)


DARK_BG = '#0c0d10'


def gradient_master(palette, scale=0.98, dark=False):
    """흰 타일(밝은 화면용) 또는 검은 타일(어두운 화면용)"""
    d = symbol_sdf(scale, bold=True)
    col, m = gradient_glyph(d, palette)
    if dark:
        base = np.ones((W, W, 3), np.float32) * hexc(DARK_BG) * (1 + 0.6 * (1 - V[..., None]))   # 위가 아주 조금 밝은 검정
        glow = blur(col * m[..., None], 34)                                  # 어두운 바탕에서는 그림자 대신 은은한 색 빛
        base = np.clip(base + glow * 0.22, 0, 1)
    else:
        base = np.ones((W, W, 3), np.float32) * (1 - 0.035 * V[..., None])  # 흰 바탕 (아래로 아주 조금 회색)
        sh = shift(blur(m, 22), 0, 0.012 * W)
        base = base * (1 - 0.10 * sh[..., None]) * (1 - 0.06 * shift(blur(m, 6), 0, 0.004 * W)[..., None])
    return white_tile(base * (1 - m[..., None]) + col * m[..., None], dark=dark), d


def gradient_fg(palette, scale=0.80):
    d = symbol_sdf(scale, bold=True)
    col, m = gradient_glyph(d, palette)
    sh = np.clip(shift(blur(m, 18), 0, 0.010 * W) * 0.12 * (1 - m), 0, 1)
    a = np.clip(m + sh, 0, 1)
    rgb = col * m[..., None] / np.maximum(a, 1e-4)[..., None]          # 그림자는 검정 (알파만)
    return np.concatenate([np.clip(rgb, 0, 1), a[..., None]], -1), d


def preview_gradient(palettes, path):
    from PIL import ImageDraw, ImageFont
    cols = []
    for pal in palettes:
        master, _ = gradient_master(pal)
        fg, _ = gradient_fg(pal)
        cols.append((pal, to_img(master, 300), to_img(fg, 200)))
        dk, _ = gradient_master(pal, dark=True)
        to_img(dk, 300).save('/tmp/ullim-icon-dark-preview.png')
    Wd, Hd = 40 + len(cols) * 740, 560
    c = Image.new('RGBA', (Wd, Hd), (24, 26, 32, 255))
    d = ImageDraw.Draw(c)
    try:
        f = ImageFont.truetype('/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', 22)
    except Exception:
        f = ImageFont.load_default()
    for i, (pal, big, fg) in enumerate(cols):
        x0 = 40 + i * 740
        d.rectangle((x0 + 340, 0, x0 + 700, Hd), fill=(240, 242, 246, 255))
        c.alpha_composite(big, (x0, 40))
        ad = Image.new('RGBA', (200, 200), (255, 255, 255, 255)); ad.alpha_composite(fg)
        mk = Image.new('L', (200, 200), 0); ImageDraw.Draw(mk).ellipse((10, 10, 190, 190), fill=255); ad.putalpha(mk)
        c.alpha_composite(ad, (x0 + 420, 40))
        x = x0 + 370
        for s in (96, 48, 32):
            im = big.resize((s, s), Image.LANCZOS); c.alpha_composite(im, (x, 300 - s // 2)); x += s + 30
        x = x0 + 20
        for s in (96, 48, 32):
            im = big.resize((s, s), Image.LANCZOS); c.alpha_composite(im, (x, 420 - s // 2)); x += s + 30
        d.text((x0 + 10, 490), {'blue': 'A · 파랑 위주', 'green': 'B · 초록 · 노랑 · 파랑'}[pal], fill=(230, 232, 238), font=f)
    c.convert('RGB').save(path)
    print('preview ->', path)


def arg(name, default):
    for x in sys.argv[1:]:
        if x.startswith(f'--{name}='):
            return x.split('=', 1)[1]
    return default


def main():
    preview = '--preview' in sys.argv
    style, palette = arg('style', 'gradient'), arg('palette', 'green')
    if style == 'gradient':
        if preview:
            preview_gradient(arg('palettes', 'blue,green').split(','), '/tmp/ullim-icons-preview.png')
            return
        master, _ = gradient_master(palette)
        master_dark, _ = gradient_master(palette, dark=True)
        fg, d_fg = gradient_fg(palette)
        mono = np.concatenate([np.ones((W, W, 3), np.float32), smooth_mask(d_fg)[..., None]], -1)
        write_all(master, fg, mono, bg_full=None)
        # 어두운 화면용: 앱 안 로고 · PC 창 아이콘 (안드로이드는 values-night 의 ic_bg 로 바탕만 바뀜)
        A = os.path.join(ROOT, 'assets')
        to_img(master_dark, 512).save(os.path.join(ROOT, 'web', 'img', 'icon-dark.png'))
        to_img(master_dark, 1024).save(os.path.join(A, 'icon-dark-1024.png'))
        to_img(master_dark, 256).save(os.path.join(A, 'ullim-dark.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
        print('dark icons written')
        return
    bg = backdrop()
    master = tile(compose(bg, symbol_sdf(0.96)))                 # 타일 아이콘 (PC · 웹 · 옛 안드로이드)
    # 안드로이드 적응형: 108dp 판 중 가운데 66dp 안에 기호가 들어가게 작게
    d_fg = symbol_sdf(0.80)
    col, m, sh, glow = glass(bg, d_fg)
    fg_rgb = col * m[..., None]
    shadow_a = np.clip(sh * 0.42 * (1 - m), 0, 1)
    glow_a = np.clip(glow * 0.30 * (1 - m), 0, 1)
    glow_c = hexc('#7fb2ff')
    a = np.clip(m + shadow_a + glow_a, 0, 1)
    rgb = (fg_rgb + glow_c * glow_a[..., None]) / np.maximum(a, 1e-4)[..., None]
    fg = np.concatenate([np.clip(rgb, 0, 1), a[..., None]], -1)
    mono = np.concatenate([np.ones((W, W, 3), np.float32), smooth_mask(d_fg)[..., None]], -1)

    if preview:
        prev = Image.new('RGBA', (1024 + 512 + 60, 1024), (40, 40, 44, 255))
        prev.paste(to_img(master, 1024), (0, 0))
        ad = to_img(np.concatenate([bg, np.ones((W, W, 1), np.float32)], -1), 432)
        f = to_img(fg, 432)
        ad.alpha_composite(f)
        circ = Image.new('L', (432, 432), 0)
        from PIL import ImageDraw
        ImageDraw.Draw(circ).ellipse((24, 24, 408, 408), fill=255)
        ad.putalpha(circ)
        prev.paste(ad, (1060, 40), ad)
        for i, s in enumerate((256, 48, 32, 16)):
            im = to_img(master, s)
            prev.paste(im, (1060 + sum((256, 48, 32, 16)[:i]) + i * 12, 520), im)
        prev.save('/tmp/ullim-icons-preview.png')
        print('preview -> /tmp/ullim-icons-preview.png')
        return

    write_all(master, fg, mono, bg_full=np.concatenate([bg, np.ones((W, W, 1), np.float32)], -1))


def write_all(master, fg, mono, bg_full=None):
    """bg_full 이 없으면 적응형 아이콘 바탕은 흰색(@color/ic_bg)"""
    A = os.path.join(ROOT, 'assets')
    to_img(master, 1024).save(os.path.join(A, 'icon-1024.png'))
    to_img(master, 256).save(os.path.join(A, 'icon-256.png'))
    to_img(master, 512).save(os.path.join(ROOT, 'web', 'img', 'icon.png'))
    for s in (16, 32, 48, 256):
        to_img(master, s).save(os.path.join(A, f'exe_{s}.png'))
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    to_img(master, 256).save(os.path.join(A, 'ullim.ico'), sizes=ico_sizes)
    dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
    res = os.path.join(ROOT, 'android', 'res')
    for name, k in dens.items():
        os.makedirs(os.path.join(res, f'drawable-{name}'), exist_ok=True)
        to_img(fg, int(108 * k)).save(os.path.join(res, f'drawable-{name}', 'ic_launcher_fg.png'))
        bgp = os.path.join(res, f'drawable-{name}', 'ic_launcher_bg.png')
        if bg_full is not None: to_img(bg_full, int(108 * k)).convert('RGB').save(bgp)
        elif os.path.exists(bgp): os.remove(bgp)
        to_img(mono, int(108 * k)).save(os.path.join(res, f'drawable-{name}', 'ic_launcher_mono.png'))
        to_img(master, int(48 * k)).save(os.path.join(res, f'mipmap-{name}', 'ic_launcher.png'))
        to_img(master, int(48 * k)).save(os.path.join(A, f'ic_launcher_{name}.png'))
    xml = os.path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml')
    bg_ref = '@drawable/ic_launcher_bg' if bg_full is not None else '@color/ic_bg'
    with open(xml, 'w', encoding='utf-8') as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                f'    <background android:drawable="{bg_ref}" />\n    <foreground android:drawable="@drawable/ic_launcher_fg" />\n'
                '    <monochrome android:drawable="@drawable/ic_launcher_mono" />\n</adaptive-icon>\n')
    print('icons written')


if __name__ == '__main__':
    main()
