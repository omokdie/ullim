"""재생 버튼(울림 표시 ↔ 세모) · 밝은/어두운 화면 로고 확인
python3 test/play_glyph_test.py [프레임저장폴더]
"""
import json, sys, time, os
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8766/web/index.html'
M = '/home/claude/ullim/test/media/'
items = [{'key': '/media?p=' + M + f, 'name': f} for f in ['song_cbr_v23.mp3', 'song.flac']]
OUT = sys.argv[1] if len(sys.argv) > 1 else ''
R, bad = {}, []

def check(name, ok, info=''):
    R[name] = ok
    if not ok: bad.append(f'{name} {info}')

STATE = '''() => [...document.querySelectorAll('.pg')].map(g => ({
  id: g.parentNode.id, t: +g.__t.toFixed(3), ul: g.classList.contains('ul'), on: g.classList.contains('on'),
  label: g.parentNode.getAttribute('aria-label'),
  w1: getComputedStyle(g.querySelector('.pgw.w1')).opacity, anim: getComputedStyle(g.querySelector('.w1 svg')).animationName,
  layer: getComputedStyle(g.querySelector('.w1 svg')).willChange }))'''

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error',) else None)
    pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
    pg.goto(BASE)
    pg.wait_for_function('window.__ullim && window.__ullim.engine')
    s0 = pg.evaluate(STATE)
    check('two_glyphs', len(s0) == 2 and {g['id'] for g in s0} == {'btnPlay', 'pPlay'}, s0)
    check('paused_triangle', all(g['t'] == 0 and not g['ul'] for g in s0), s0)
    pg.evaluate(f'__ullim.addItems({json.dumps(items)}, {{play:true}})')
    time.sleep(0.2)
    mid = pg.evaluate(STATE)
    time.sleep(1.0)
    s1 = pg.evaluate(STATE)
    check('playing_ullim', all(g['t'] == 1 and g['ul'] and g['on'] for g in s1), s1)
    check('waves_visible', all(float(g['w1']) > 0.95 for g in s1), s1)
    check('waves_animate', all(g['anim'] == 'pgIn' for g in s1), s1)
    check('label_pause', all(g['label'] == '일시정지' for g in s1), s1)
    R['mid_t'] = [g['t'] for g in mid]
    # 멈춤 → 세모 (모양이 서서히 바뀌는지: 중간 값을 거침)
    pg.click('#btnPlay')
    seen = []
    for _ in range(14):
        time.sleep(0.04); seen.append(pg.evaluate("document.querySelector('#btnPlay .pg').__t"))
    time.sleep(0.5)
    s2 = pg.evaluate(STATE)
    check('paused_back', all(g['t'] == 0 and not g['ul'] and not g['on'] for g in s2), s2)
    check('morph_gradual', any(0.05 < v < 0.95 for v in seen), seen)
    check('label_play', all(g['label'] == '재생' for g in s2), s2)
    # 빠르게 여러 번 눌러도 마지막 상태로 끝나는지
    for _ in range(5): pg.click('#btnPlay'); time.sleep(0.05)
    time.sleep(1.0)
    s3 = pg.evaluate(STATE); playing = not pg.evaluate('__ullim.engine.deck.a.paused')
    check('rapid_toggle_consistent', all(g['t'] == (1 if playing else 0) and g['on'] == playing for g in s3), (playing, s3))
    if not playing: pg.click('#btnPlay'); time.sleep(0.8)
    # 배터리 절약: 물결 멈춤
    pg.evaluate("document.documentElement.classList.add('saving')"); time.sleep(0.1)
    check('saving_stops', pg.evaluate("getComputedStyle(document.querySelector('#btnPlay .w1 svg')).animationName") == 'none')
    pg.evaluate("document.documentElement.classList.remove('saving')")

    # 밝은/어두운 화면 로고
    for th in ('light', 'dark'):
        pg.evaluate(f"__ullim.S.theme = '{th}'; __ullim.applyTheme && __ullim.applyTheme()")
        time.sleep(0.2)
        info = pg.evaluate("""() => ({theme: document.documentElement.dataset.theme,
          img: [...document.querySelectorAll('.brand img')].map(i => i.getAttribute('src')),
          ok: [...document.querySelectorAll('.brand img')].every(i => i.complete && i.naturalWidth > 0),
          fav: document.querySelector('link[rel=icon]').getAttribute('href')})""")
        want = 'img/icon-dark.png' if th == 'dark' else 'img/icon.png'
        check(f'logo_{th}', info['theme'] == th and all(s == want for s in info['img']) and info['fav'] == want and info['ok'], info)
        if OUT:
            os.makedirs(OUT, exist_ok=True)
            pg.screenshot(path=f'{OUT}/desk_{th}.png', clip={'x': 0, 'y': 0, 'width': 1280, 'height': 800})

    # 휴대폰 크기: 미니 플레이어 · 전체 화면 플레이어
    pg.set_viewport_size({'width': 400, 'height': 860}); time.sleep(0.4)
    pg.evaluate("__ullim.S.theme = 'dark'; __ullim.applyTheme && __ullim.applyTheme()")
    vis = pg.evaluate("(() => { const r = document.querySelector('#btnPlay .pg').getBoundingClientRect(); return {w: r.width, h: r.height}; })()")
    check('mini_visible', vis['w'] >= 20, vis)
    pg.evaluate('__ullim.openPlayer()'); time.sleep(0.7)
    big = pg.evaluate("(() => { const r = document.querySelector('#pPlay .pg').getBoundingClientRect(); return {w: r.width, h: r.height}; })()")
    check('big_visible', big['w'] >= 30, big)
    if OUT:
        pg.screenshot(path=f'{OUT}/phone_player.png')
    b.close()

print(json.dumps(R, ensure_ascii=False, indent=1))
print('logs:', logs[:10])
print('FAIL:' if bad else 'ALL PASS', bad)
