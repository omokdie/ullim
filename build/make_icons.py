"""울림 아이콘 — 리퀴드 글라스 (모든 크기를 코드로 그림)

  python3 build/make_icons.py            # assets/ · web/img/ · android/res/ 아이콘을 다시 만듦
  python3 build/make_icons.py --preview  # /tmp/ullim-icons-preview.png 만 (파일은 그대로)

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
def symbol_sdf(scale=1.0):
    cx = cy = W / 2
    px, py = xx - cx, yy - cy
    r = np.sqrt(px * px + py * py)
    ang = np.arctan2(py, px)
    s = W * scale
    d = r - 0.085 * s                                           # 가운데 점
    for R, half_w, span in ((0.195 * s, 0.033 * s, np.radians(46)), (0.312 * s, 0.033 * s, np.radians(50))):
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


def main():
    preview = '--preview' in sys.argv
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
    bg_full = np.concatenate([bg, np.ones((W, W, 1), np.float32)], -1)
    for name, k in dens.items():
        os.makedirs(os.path.join(res, f'drawable-{name}'), exist_ok=True)
        to_img(fg, int(108 * k)).save(os.path.join(res, f'drawable-{name}', 'ic_launcher_fg.png'))
        to_img(bg_full, int(108 * k)).convert('RGB').save(os.path.join(res, f'drawable-{name}', 'ic_launcher_bg.png'))
        to_img(mono, int(108 * k)).save(os.path.join(res, f'drawable-{name}', 'ic_launcher_mono.png'))
        to_img(master, int(48 * k)).save(os.path.join(res, f'mipmap-{name}', 'ic_launcher.png'))
        to_img(master, int(48 * k)).save(os.path.join(A, f'ic_launcher_{name}.png'))
    print('icons written')


if __name__ == '__main__':
    main()
