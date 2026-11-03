import json, sys, time
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8766/web/index.html'
M = '/home/claude/ullim/test/media/'
FILES = ['song_cbr_v23.mp3', 'song.flac', 'song.m4a', 'song_euckr.mp3', 'song_vbr_v24.mp3', 'song.opus', 'song.wav', 'song_alac.m4a']
OUT = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/ullim/test/shots'
DSF = int(sys.argv[2]) if len(sys.argv) > 2 else 1
import os; os.makedirs(OUT, exist_ok=True)

items = json.dumps([{'key': '/media?p=' + M + f, 'name': f} for f in FILES])

def run(pg, logs):
    pg.goto(BASE)
    pg.wait_for_function('window.__ullim && window.__ullim.engine')
    time.sleep(0.5)
    pg.evaluate(f'__ullim.addItems({items}, {{play:true}})')
    time.sleep(2.5)
    return pg.evaluate('''() => { const a = __ullim.engine.deck.a; return { t: a.currentTime, paused: a.paused, src: a.src.slice(-40), list: __ullim.list.map(t => [t.title, t.artist, Math.round(t.duration)]), ctx: __ullim.engine.ctx.state, worklet: __ullim.engine.workletOK }; }''')

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    for name, vp in [('desktop', {'width': 1280, 'height': 800}), ('mobile', {'width': 390, 'height': 844})]:
        ctx = b.new_context(viewport=vp, device_scale_factor=DSF, is_mobile=(name == 'mobile'), has_touch=(name == 'mobile'), color_scheme='dark')
        pg = ctx.new_page()
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        st = run(pg, logs)
        print(name, json.dumps(st, ensure_ascii=False))
        # apply a sound preset and show effects
        pg.evaluate("__ullim.applySoundPreset({id:'hall', name:'콘서트홀', fx:{hall:{space:'hall', size:110, mix:30}, wide:{width:130}}})")
        time.sleep(1.2)
        if name == 'desktop':
            pg.screenshot(path=f'{OUT}/{name}-fx.png')
            pg.evaluate("__ullim.setTab('eq')"); time.sleep(0.4)
            pg.evaluate("document.querySelector('#paneEq select').value='rock'; document.querySelector('#paneEq select').dispatchEvent(new Event('change'))"); time.sleep(0.5)
            pg.screenshot(path=f'{OUT}/{name}-eq.png')
            pg.evaluate("__ullim.setTab('set')"); time.sleep(0.4)
            pg.screenshot(path=f'{OUT}/{name}-set.png')
            pg.evaluate("__ullim.S.theme='light'; document.documentElement.dataset.theme='light'; __ullim.setTab('fx')"); time.sleep(0.6)
            pg.screenshot(path=f'{OUT}/{name}-light.png')
        else:
            pg.screenshot(path=f'{OUT}/{name}-list.png')
            pg.evaluate("__ullim.setTab('fx')"); time.sleep(0.5)
            pg.screenshot(path=f'{OUT}/{name}-fx.png')
            pg.evaluate("__ullim.setTab('eq')"); time.sleep(0.5)
            pg.screenshot(path=f'{OUT}/{name}-eq.png')
        state = pg.evaluate('''() => { const a = __ullim.engine.deck.a; return { t: +a.currentTime.toFixed(2), paused: a.paused, chain: __ullim.engine._chain }; }''')
        print(name, 'after', json.dumps(state, ensure_ascii=False))
        for l in logs[:20]: print('  ', l)
        ctx.close()
    b.close()
