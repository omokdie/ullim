"""안드로이드 연결층(JS 쪽) 시뮬레이션: 가짜 UllimAndroid 를 넣고 폰 화면 크기로 동작 확인"""
import json, time
from playwright.sync_api import sync_playwright

M = '/home/claude/ullim/test/media/'
SCAN = [
    {'key': M + 'song.flac', 'name': 'song.flac', 'title': '무손실 FLAC', 'artist': '플락 아티스트', 'album': 'Lossless', 'duration': 24, 'tagged': True},
    {'key': M + 'song_cbr_v23.mp3', 'name': 'song_cbr_v23.mp3', 'title': '봄날의 노래', 'artist': '울림 테스트', 'album': '샘플 앨범', 'duration': 24, 'tagged': True},
    {'key': M + 'song.m4a', 'name': 'song.m4a', 'title': 'AAC 노래', 'artist': 'M4A 가수', 'album': '', 'duration': 24, 'tagged': True},
]
PICK = [{'key': M + 'song.opus', 'name': 'song.opus'}, {'key': M + 'song_euckr.mp3', 'name': 'song_euckr.mp3'}]
INIT = """
window.__np = []; window.__calls = [];
window.UllimAndroid = {
  call(method, args, id) {
    __calls.push(method);
    setTimeout(() => {
      if (method === 'scanLibrary') window.__ullimResolve(id, JSON.stringify(%s), null);
      else if (method === 'pickFiles') window.__ullimResolve(id, JSON.stringify(%s), null);
      else if (method === 'pickFolder') window.__ullimResolve(id, null, '폴더를 열 수 없어요(테스트)');
    }, 60);
  },
  nowPlaying(json) { __np.push(JSON.parse(json)); },
  setSystemBars(c, l) { window.__bars = [c, l]; },
  ready() { window.__readyCalled = true; },
  exitApp() {},
};
""" % (json.dumps(SCAN, ensure_ascii=False), json.dumps(PICK, ensure_ascii=False))

R = {}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2, bypass_csp=True)
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
    pg.goto('http://127.0.0.1:8766/web/index.html')
    pg.wait_for_function('window.__ullim && window.__readyCalled')
    R['platform_bars'] = pg.evaluate('window.__bars')
    # "기기 음악 불러오기" button
    pg.click('#listTools button:has-text("기기 음악")'); time.sleep(2.5)
    R['after_scan'] = pg.evaluate('({n: __ullim.list.length, i: __ullim.P.index, playing: !__ullim.engine.deck.a.paused, src: __ullim.engine.deck.a.src.slice(0, 70)})')
    time.sleep(1.5)
    np = pg.evaluate('__np')
    R['nowPlaying_count'] = len(np)
    R['nowPlaying_last'] = {k: (v[:40] + '…' if isinstance(v, str) and len(v) > 40 else v) for k, v in np[-1].items()}
    R['nowPlaying_has_art'] = any(isinstance(x.get('art'), str) and x['art'].startswith('data:image/jpeg') for x in np)
    # pick files (adds 2)
    pg.click('#listTools button:has-text("파일 추가")'); time.sleep(1.5)
    R['after_pick'] = pg.evaluate('__ullim.list.map(t => t.title || t.name)')
    # folder error path shows toast
    pg.click('#listTools button:has-text("폴더 추가")'); time.sleep(0.4)
    R['folder_toast'] = pg.evaluate("document.getElementById('toast').textContent")
    # commands from notification / headset
    pg.evaluate("__ullimCommand('pause')"); time.sleep(0.3)
    R['cmd_pause'] = pg.evaluate('__ullim.engine.deck.a.paused')
    pg.evaluate("__ullimCommand('toggle')"); time.sleep(0.5)
    R['cmd_toggle_play'] = pg.evaluate('!__ullim.engine.deck.a.paused')
    pg.evaluate("__ullimCommand('seek', '15000')"); time.sleep(0.4)
    R['cmd_seek'] = pg.evaluate('+__ullim.engine.deck.a.currentTime.toFixed(1)')
    pg.evaluate("__ullimCommand('next')"); time.sleep(1.0)
    R['cmd_next_index'] = pg.evaluate('__ullim.P.index')
    # back button behaviour
    pg.evaluate("__ullim.setTab('fx')")
    R['back_from_fx'] = pg.evaluate('__ullimBack()')
    R['tab_after_back'] = pg.evaluate('__ullim.S.tab')
    R['back_on_list'] = pg.evaluate('__ullimBack()')
    # open-with intent
    pg.evaluate("__ullimOpen(JSON.stringify([{key: '%s', name: 'song.wav'}]))" % (M + 'song.wav')); time.sleep(1.2)
    R['open_with'] = pg.evaluate("document.getElementById('title').textContent")
    # light theme -> status bar color
    pg.evaluate("document.querySelector('.btabs button[data-tab=set]').click()"); time.sleep(0.3)
    pg.click('#paneSet .seg button:has-text("밝게")'); time.sleep(0.3)
    R['bars_light'] = pg.evaluate('window.__bars')
    pg.screenshot(path='/home/claude/ullim/test/shots/android-sim-settings.png')
    pg.evaluate("__ullim.setTab('list')"); time.sleep(0.3)
    pg.screenshot(path='/home/claude/ullim/test/shots/android-sim-list.png')
    R['calls'] = pg.evaluate('__calls')
    R['logs'] = logs[:10]
    b.close()
print(json.dumps(R, ensure_ascii=False, indent=1))
