"""앨범아트 작은 그림: 같은 그림은 한 번만 저장되는지 + 1.2.2 까지의 곡별 기록이 하나로 합쳐지는지
   (test/server.py 가 8766 에서 돌고, test/make_library.py 로 /tmp/ullim-lib 를 만든 뒤)
   python3 test/thumbs_dedupe_test.py"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8766/web/index.html'
LIB = '/tmp/ullim-lib'
names = sorted(n for n in os.listdir(LIB) if not n.endswith('.json'))
keys = ['/media?p=' + os.path.join(LIB, n) for n in names]

# 같은 그림 묶음: make_library.py 는 앨범마다 같은 그림을 mp3 · m4a 에는 JPEG 로, flac 에는 PNG 로 넣고 opus 에는 넣지 않음
#  → (앨범, JPEG|PNG) 이 같으면 들어 있는 그림 바이트가 똑같다
_ALB = ['밤의 정원', '밤의 정원', '봄날의 기록', '봄날의 기록', 'Afterglow', 'Afterglow', 'SPARK', 'Cruise', 'Cruise', 'Grey Area',
        '섬', '섬', 'Steel', 'Steel', '트로트 메들리', 'Lo-fi Days', 'Rainy', None]
assert len(_ALB) == len(keys), (len(_ALB), len(keys))
ALBUM = [None if a is None or n.endswith('.opus') else (a, 'png' if n.endswith('.flac') else 'jpg') for a, n in zip(_ALB, names)]

DUMP = """async () => {
  const d = await new Promise((res, rej) => { const r = indexedDB.open('ullim-art', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const rows = await new Promise(res => { const out = []; const tx = d.transaction('thumbs'); const rq = tx.objectStore('thumbs').openCursor();
    rq.onsuccess = () => { const c = rq.result; if (c) { const v = c.value; out.push([c.key, v === 'none' ? 'none' : v.ref ? { ref: v.ref, color: v.color } : { blob: v.blob ? v.blob.size : -1, color: v.color }]); c.continue(); } };
    tx.oncomplete = () => res(out); });
  d.close();
  return rows;
}"""
SHOW = """async (keys) => {
  const T = await import('/web/js/thumbs.js');
  const out = [];
  for (const k of keys) {
    const v = await T.thumb(k);
    if (!v) { out.push(null); continue; }
    const b = await (await fetch(v.url)).blob();
    const bmp = await createImageBitmap(b);
    out.push({ w: bmp.width, h: bmp.height, color: v.color }); bmp.close();
  }
  return out;
}"""

fails, R = [], {}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 800})
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE)
    pg.wait_for_function('window.__ullim && window.__ullim.engine')

    # 1) 새로 만들기: 앨범마다 그림 하나
    t0 = time.time()
    shown = pg.evaluate(SHOW, keys)
    R['make_s'] = round(time.time() - t0, 2)
    rows = dict(pg.evaluate(DUMP))
    arts = {k: v for k, v in rows.items() if k.startswith('#art#')}
    per = {k: rows.get(k) for k in keys}
    R['fresh'] = {'arts': len(arts), 'albums': len({a for a in ALBUM if a})}
    if len(arts) != len({a for a in ALBUM if a}): fails.append(f'fresh: {len(arts)} art records for {len({a for a in ALBUM if a})} albums')
    for k, a, s in zip(keys, ALBUM, shown):
        v = per[k]
        if a is None:
            if v != 'none' or s is not None: fails.append(f'no-art track: {v} {s}')
            continue
        if not isinstance(v, dict) or 'ref' not in v or v['ref'] not in arts: fails.append(f'{k}: not a ref {v}'); continue
        if not s or s['w'] != 160 or s['h'] != 160 or not s['color']: fails.append(f'{k}: shown {s}')
    by_album = {}
    for k, a in zip(keys, ALBUM):
        if a: by_album.setdefault(a, set()).add(per[k]['ref'] if isinstance(per[k], dict) else None)
    for a, refs in by_album.items():
        if len(refs) != 1: fails.append(f'album {a}: {len(refs)} different refs')

    # 2) 1.2.2 처럼 곡마다 그림을 따로 둔 기록으로 되돌린 뒤 → 합치기
    pg.evaluate("""async () => {
      const d = await new Promise(res => { const r = indexedDB.open('ullim-art', 1); r.onsuccess = () => res(r.result); });
      const rows = await new Promise(res => { const out = []; const tx = d.transaction('thumbs'); const rq = tx.objectStore('thumbs').openCursor();
        rq.onsuccess = () => { const c = rq.result; if (c) { out.push([c.key, c.value]); c.continue(); } }; tx.oncomplete = () => res(out); });
      const art = new Map(rows.filter(([k]) => k.startsWith('#art#')));
      await new Promise(res => { const tx = d.transaction('thumbs', 'readwrite'), st = tx.objectStore('thumbs');
        for (const [k, v] of rows) {
          if (k.startsWith('#art#')) st.delete(k);
          else if (v && v.ref) st.put({ blob: art.get(v.ref).blob, color: v.color }, k);   // 예전 모양: 곡마다 그림 통째로
        }
        tx.oncomplete = res; });
      d.close();
      localStorage.removeItem('ullim.thumbs.merged');
    }""")
    old = dict(pg.evaluate(DUMP))
    R['legacy'] = {'arts': sum(1 for k in old if k.startswith('#art#')), 'blobs': sum(1 for v in old.values() if isinstance(v, dict) and 'blob' in v)}
    if R['legacy']['arts'] or R['legacy']['blobs'] != len([a for a in ALBUM if a]): fails.append(f"legacy setup {R['legacy']}")
    pg.reload()
    pg.wait_for_function('window.__ullim && window.__ullim.engine')
    shown_old = pg.evaluate(SHOW, keys)                       # 예전 기록도 그대로 보여야 함 (합치기 전)
    if shown_old != shown: fails.append('legacy records shown differently')
    pg.evaluate("async () => { const T = await import('/web/js/thumbs.js'); await T._mergeNow(); }")
    pg.wait_for_function("localStorage.getItem('ullim.thumbs.merged') === '1'", timeout=20000)
    rows2 = dict(pg.evaluate(DUMP))
    arts2 = {k for k in rows2 if k.startswith('#art#')}
    R['merged'] = {'arts': len(arts2), 'blobs_left': sum(1 for k, v in rows2.items() if not k.startswith('#art#') and isinstance(v, dict) and 'blob' in v)}
    if len(arts2) != len({a for a in ALBUM if a}) or R['merged']['blobs_left']: fails.append(f"merged {R['merged']}")
    for a in {a for a in ALBUM if a}:
        refs = {rows2[k]['ref'] for k, aa in zip(keys, ALBUM) if aa == a and isinstance(rows2.get(k), dict)}
        if len(refs) != 1: fails.append(f'merged album {a}: {refs}')
    pg.reload()
    pg.wait_for_function('window.__ullim && window.__ullim.engine')
    shown2 = pg.evaluate(SHOW, keys)
    if shown2 != shown: fails.append('after merge shown differently')
    # 3) 돌려 쓰는 캔버스: 빨간 그림 다음에 투명한 PNG(가운데 초록 점)를 줄여도 빨강이 비치면 안 됨 (투명 → 검정, 예전과 같음)
    A = '/tmp/ullim-alpha'
    if not os.path.exists(A + '/clear.flac'):
        import subprocess
        from PIL import Image, ImageDraw
        os.makedirs(A, exist_ok=True)
        Image.new('RGB', (300, 300), (255, 0, 0)).save(A + '/red.png')
        im = Image.new('RGBA', (300, 300), (0, 0, 0, 0)); ImageDraw.Draw(im).ellipse((120, 120, 180, 180), fill=(0, 255, 0, 255)); im.save(A + '/clear.png')
        for n in ('red', 'clear'):
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-i', f'{A}/{n}.png',
                            '-map', '0:a', '-map', '1:v', '-disposition:v', 'attached_pic', '-c:v', 'png', '-c:a', 'flac', f'{A}/{n}.flac'], check=True)
    px = pg.evaluate("""async (keys) => {
      const T = await import('/web/js/thumbs.js');
      const out = [];
      for (const k of keys) {
        const v = await T.thumb(k);
        const bmp = await createImageBitmap(await (await fetch(v.url)).blob());
        const c = new OffscreenCanvas(160, 160), g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
        out.push([...g.getImageData(10, 10, 1, 1).data.slice(0, 3), ...g.getImageData(80, 80, 1, 1).data.slice(0, 3)]);
      }
      return out;
    }""", ['/media?p=' + A + '/red.flac', '/media?p=' + A + '/clear.flac'])
    R['alpha'] = px
    red, clear = px
    if not (red[0] > 200 and red[1] < 40): fails.append(f'red thumb {red}')
    if clear[0] > 40 or clear[4] < 150: fails.append(f'transparent thumb shows previous image {clear}')
    if errs: fails.append('page errors: ' + '; '.join(errs[:3]))
    b.close()

print(json.dumps(R, ensure_ascii=False))
print('FAIL ' + ' | '.join(fails) if fails else 'thumbs dedupe ok')
sys.exit(1 if fails else 0)
