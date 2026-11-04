"""가사: 백그라운드에서는 찾지 않기 · 모바일 데이터에서는 (설정을 켜지 않으면) 찾지 않기 · 와이파이가 되면 찾기
   + 알림의 무작위 · 반복 (가짜 UllimAndroid 로 휴대폰처럼, LRCLIB 는 가짜 응답)
   python3 test/lyrics_data_test.py"""
import json, time, urllib.parse
from playwright.sync_api import sync_playwright

M = '/home/claude/ullim/test/media/'
SCAN = [
    {'key': M + 'song_cbr_v23.mp3', 'name': 'song_cbr_v23.mp3', 'title': '봄날의 노래', 'artist': '울림 테스트', 'album': '샘플 앨범', 'duration': 24, 'tagged': True},
    {'key': M + 'song.flac', 'name': 'song.flac', 'title': '무손실 FLAC', 'artist': '플락 아티스트', 'album': 'Lossless', 'duration': 24, 'tagged': True},
    {'key': M + 'song.m4a', 'name': 'song.m4a', 'title': 'AAC 노래', 'artist': 'M4A 가수', 'album': '', 'duration': 24, 'tagged': True},
]
INIT = """
window.__np = []; window.__net = 'cellular'; window.__hid = false;
Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return !!window.__hid; } });
Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__hid ? 'hidden' : 'visible'; } });
window.UllimAndroid = {
  call(method, args, id) {
    const a = JSON.parse(args || '[]');
    if (method === 'scanLibrary') setTimeout(() => window.__ullimResolve(id, JSON.stringify(%s), null), 30);
    else if (method === 'httpGet') fetch(a[0]).then(r => r.text().then(body => window.__ullimResolve(id, JSON.stringify({ status: r.status, body }), null)))
      .catch(e => window.__ullimResolve(id, null, 'offline'));
    else if (method === 'httpPost') window.__ullimResolve(id, JSON.stringify({ status: 200, body: '' }), null);
    else setTimeout(() => window.__ullimResolve(id, null, 'no'), 10);
  },
  nowPlaying(json) { __np.push(JSON.parse(json)); },
  net() { return window.__net; },
  setSystemBars() {}, ready() { window.__readyCalled = true; }, exitApp() {}, powerSave() { return false; },
};
""" % json.dumps([dict(x, key=x['key']) for x in SCAN], ensure_ascii=False)
SYNCED = "\n".join(f"[00:{i*2:02d}.00]온라인 예시 가사 {i+1}" for i in range(12))
CALLS = []

def lrclib(route):
    u = urllib.parse.urlparse(route.request.url); q = urllib.parse.parse_qs(u.query)
    CALLS.append(q.get('track_name', q.get('q', ['?']))[0])
    hdr = {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'}
    if u.path == '/api/get':
        name = q.get('track_name', [''])[0]
        body = {'id': 1 + len(name), 'trackName': name, 'artistName': q.get('artist_name', [''])[0], 'albumName': '', 'duration': 24, 'instrumental': False, 'plainLyrics': '…', 'syncedLyrics': SYNCED}
        return route.fulfill(status=200, headers=hdr, body=json.dumps(body, ensure_ascii=False))
    return route.fulfill(status=200, headers=hdr, body='[]')

R, bad = {}, []
def check(name, ok, info=''):
    R[name] = bool(ok)
    if not ok: bad.append(f'{name} {info}')

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2, bypass_csp=True)
    ctx.add_init_script(INIT)
    ctx.route('https://lrclib.net/api/**', lrclib)
    ctx.route('https://raw.githubusercontent.com/**', lambda r: r.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*'}, body='{"songs":{}}'))
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8766/web/index.html')
    pg.wait_for_function('window.__ullim && window.__readyCalled')
    # /media?u= 를 테스트 서버의 /media?p= 로
    pg.route('**/media?u=*', lambda r: r.continue_(url=r.request.url.replace('/media?u=', '/media?p=')))
    pg.evaluate(f"__ullim.addItems({json.dumps(SCAN, ensure_ascii=False)}, {{ play: true }})")
    time.sleep(1.2)
    pg.evaluate("__ullim.openPlayer(); __ullim.setPlayerTab('lyr')")
    pg.wait_for_function("__ullim.LY.state !== 'loading'", timeout=15000)
    state = lambda: pg.evaluate("(document.querySelector('#paneLyr .lystate') || {}).textContent || (document.querySelector('#lyBody') ? 'lyrics:' + document.querySelectorAll('#lyBody .ly:not(.gap)').length : '')")
    s1 = state()
    check('cellular_no_fetch', not CALLS, CALLS)
    check('cellular_message', '모바일 데이터' in s1, (s1, pg.evaluate("__ullim.LY.state")))
    # 와이파이로 바뀌면 찾기
    t0 = time.time()
    pg.evaluate("window.__net = 'wifi'; window.__ullimNet('wifi')")
    try: pg.wait_for_function("__ullim.LY.state !== 'loading' && __ullim.LY.state !== 'data'", timeout=20000)
    except Exception as e: pass
    R['wifi_ms'] = int((time.time() - t0) * 1000)
    s2 = state()
    check('wifi_fetches', len(CALLS) >= 1 and s2.startswith('lyrics:'), (CALLS, s2))
    # 다시 데이터 · 설정 켬 → 다음 곡도 찾음
    n0 = len(CALLS)
    pg.evaluate("window.__net = 'cellular'; window.__ullimNet('cellular'); __ullim.S.lyrOnData = true; __ullim.playIndex(1)")
    pg.wait_for_function("__ullim.LY.key === __ullim.list[1].key && __ullim.LY.state !== 'loading'", timeout=20000)
    check('setting_on_fetches', len(CALLS) > n0, CALLS)
    # 설정 끔 + 다음 곡: [지금 찾기] 는 언제든
    pg.evaluate("__ullim.S.lyrOnData = false; __ullim.playIndex(2)")
    pg.wait_for_function("__ullim.LY.key === __ullim.list[2].key && __ullim.LY.state !== 'loading'", timeout=20000)
    n1 = len(CALLS)
    s3 = state()
    check('off_again_blocks', '모바일 데이터' in s3, (s3, pg.evaluate("({ st: __ullim.LY.state, key: __ullim.LY.key, cur: __ullim.list[__ullim.P.index].title, i: __ullim.P.index, n: __ullim.list.length })")))
    if '모바일 데이터' in s3:
        pg.click('#paneLyr .lystate button')
        pg.wait_for_function("__ullim.LY.state !== 'loading' && __ullim.LY.state !== 'data'", timeout=20000)
    check('manual_find_ok', len(CALLS) > n1 and state().startswith('lyrics:'), (CALLS[n1:], state()))
    # 백그라운드: 곡이 바뀌어도 찾지 않고, 다시 보이면 찾음
    pg.evaluate("window.__net = 'wifi'; window.__ullimNet('wifi'); window.__hid = true; document.dispatchEvent(new Event('visibilitychange')); __ullim.playIndex(0)"); time.sleep(1.5)
    n2 = len(CALLS)
    key_hidden = pg.evaluate("__ullim.LY.key")
    check('hidden_deferred', key_hidden is None, key_hidden)
    time.sleep(1.0)
    check('hidden_no_fetch', len(CALLS) == n2, CALLS[n2:])
    pg.evaluate("window.__hid = false; document.dispatchEvent(new Event('visibilitychange'))")
    pg.wait_for_function("__ullim.LY.key === __ullim.list[__ullim.P.index].key && __ullim.LY.state !== 'loading'", timeout=20000)
    check('visible_loads', pg.evaluate("__ullim.LY.key === __ullim.list[__ullim.P.index].key") and state().startswith('lyrics:'), state())
    # 알림: 무작위 · 반복 상태가 실리고, 알림에서 누르면 바뀜
    last = pg.evaluate("__np[__np.length - 1]")
    check('np_has_modes', 'shuffle' in last and last.get('repeat') in ('off', 'all', 'one'), last)
    sh0, rp0 = pg.evaluate("__ullim.S.shuffle"), pg.evaluate("__ullim.S.repeat")
    pg.evaluate("__ullimCommand('shuffle')"); pg.evaluate("__ullimCommand('repeat')"); time.sleep(0.3)
    last = pg.evaluate("__np[__np.length - 1]")
    check('cmd_shuffle', pg.evaluate("__ullim.S.shuffle") == (not sh0) and last['shuffle'] == (not sh0), last)
    check('cmd_repeat', pg.evaluate("__ullim.S.repeat") != rp0 and last['repeat'] == pg.evaluate("__ullim.S.repeat"), last)
    # 설정 화면에 스위치
    pg.evaluate("__ullim.closePlayer(); __ullim.go('set')"); time.sleep(0.5)
    check('setting_row', pg.evaluate("[...document.querySelectorAll('#paneSet .srow')].some(r => r.textContent.includes('모바일 데이터에서 가사 불러오기'))"))
    check('no_page_errors', not errs, errs)
    b.close()

print(json.dumps(R, ensure_ascii=False, indent=1))
print('FAIL:' if bad else 'lyrics data ok', bad)
