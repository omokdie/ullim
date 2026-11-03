"""고른 가사 나누기 · 공용 가사 목록 시험 — LRCLIB · GitHub 공용 목록 · ntfy 메시지함을 가짜로 대신한다.

  python3 test/server.py &   (포트 8766)
  python3 test/lyrics_share_test.py
"""
import json
import urllib.parse
from playwright.sync_api import sync_playwright

M = '/home/claude/ullim/test/media/'
TRACKS = [{'key': '/media?p=' + M + n, 'name': n} for n in
          ['song_cbr_v23.mp3', 'song.opus', 'song.flac', 'song_vbr_v24.mp3']]
K = ['울림테스트|봄날의노래', '오푸스|opus곡', '플락아티스트|무손실flac', 'artistfour|vbr테스트곡']
FEED = 'https://ntfy.sh/ullim-lyrics-259gyx3gfnw7'
SYNCED = "\n".join(f"[00:{i*2:02d}.00]자동으로 찾은 가사 {i+1}" for i in range(12))
COMM = "\n".join(f"[00:{i*2:02d}.00]사람들이 고른 가사 {i+1}" for i in range(12))
REC = {
    1: {'id': 1, 'trackName': '봄날의 노래', 'artistName': '울림 테스트', 'albumName': '샘플 앨범', 'duration': 24, 'instrumental': False, 'plainLyrics': '…', 'syncedLyrics': SYNCED},
    7: {'id': 7, 'trackName': '직접 찾은 곡', 'artistName': '검색 가수', 'albumName': '앨범', 'duration': 24, 'instrumental': False, 'plainLyrics': '선택한 가사 줄 하나\n선택한 가사 줄 둘', 'syncedLyrics': None},
    8: {'id': 8, 'trackName': '연주곡', 'artistName': '다른 가수', 'albumName': '', 'duration': 200, 'instrumental': True, 'plainLyrics': None, 'syncedLyrics': None},
    9: {'id': 9, 'trackName': 'VBR 테스트 곡', 'artistName': 'Artist Four', 'albumName': '', 'duration': 24, 'instrumental': False, 'plainLyrics': '…', 'syncedLyrics': COMM},
}
OVR = {'version': 1, 'songs': {}}
POSTS, CALLS = [], []
MODE = {'feed_fail': False}
H = {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'}


def lrclib(route):
    u = urllib.parse.urlparse(route.request.url)
    q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
    CALLS.append(u.path + ' ' + json.dumps(q, ensure_ascii=False))
    if u.path.startswith('/api/get/'):
        i = int(u.path.rsplit('/', 1)[1])
        return route.fulfill(status=200 if i in REC else 404, headers=H, body=json.dumps(REC.get(i, {}), ensure_ascii=False))
    if u.path == '/api/get' and q.get('track_name') == '봄날의 노래':
        return route.fulfill(status=200, headers=H, body=json.dumps(REC[1], ensure_ascii=False))
    if u.path == '/api/search':
        text = q.get('track_name', '') + q.get('q', '')
        if any(w in text for w in ('Opus', 'VBR', '무손실')):
            return route.fulfill(status=200, headers=H, body='[]')
        return route.fulfill(status=200, headers=H, body=json.dumps([REC[7], REC[8], REC[1]], ensure_ascii=False))
    return route.fulfill(status=404, headers=H, body='{"code":404}')


def overrides(route):
    CALLS.append('OVR ' + route.request.url.split('?')[0])
    route.fulfill(status=200, headers={**H, 'Content-Type': 'text/plain; charset=utf-8'}, body=json.dumps(OVR, ensure_ascii=False))


def feed(route):
    if MODE['feed_fail']:
        return route.abort('internetdisconnected')
    req = route.request
    assert req.method == 'POST', req.method
    POSTS.append(json.loads(req.post_data))
    route.fulfill(status=200, headers=H, body='{"id":"abc","time":1,"event":"message"}')


R = {}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}, color_scheme='dark')   # CSP 그대로 (connect-src 확인)
    ctx.route('https://lrclib.net/api/**', lrclib)
    ctx.route('https://raw.githubusercontent.com/**', overrides)
    ctx.route(FEED, feed)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(f'PAGEERROR: {e}'))
    pg.on('console', lambda m: errs.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
    pg.goto('http://127.0.0.1:8766/web/index.html')
    pg.wait_for_function('window.__ullim && window.__ullim.engine')
    pg.evaluate("window.__L = import('/web/js/lyrics.js')")
    st = lambda: pg.evaluate("""() => ({ sub: document.querySelector('.lysub')?.textContent || '', state: document.querySelector('.lystate')?.textContent || '',
        first: document.querySelector('#lyBody .ly:not(.gap)')?.textContent || '', lines: document.querySelectorAll('#lyBody .ly:not(.gap)').length,
        credit: document.querySelector('.credit')?.textContent || '', toast: document.getElementById('toast')?.textContent || '' })""")

    def fresh(i, ovr):
        """공용 목록 · 곡 기억을 비우고 i 번째 곡을 새로 튼다"""
        OVR['songs'] = ovr
        pg.evaluate(f"""async () => {{ const L = await window.__L; localStorage.removeItem('ullim.lyrovr.v1');
            L.cacheDrop(__ullim.list[{i}].key); }}""")
        pg.evaluate(f'__ullim.playIndex({i})')
        pg.wait_for_timeout(1800)

    pg.evaluate(f'__ullim.addItems({json.dumps(TRACKS)})')
    pg.evaluate("__ullim.setTab('lyr')")
    pg.wait_for_timeout(1500)

    # 1) 공용 목록에서 고른 가사 (자동 검색 대신)
    fresh(3, {K[3]: {'title': 'VBR 테스트 곡', 'artist': 'Artist Four', 'pick': 9, 'avoid': []}})
    R['1_community_pick'] = st()
    assert '다른 사용자들이 고른 가사' in R['1_community_pick']['sub'] and '사람들이 고른 가사 1' == R['1_community_pick']['first'], R['1_community_pick']
    assert any(c.startswith('/api/get/9') for c in CALLS), CALLS

    # 2) 공용 목록: '가사 없는 곡'
    fresh(2, {K[2]: {'pick': 0, 'avoid': []}})
    R['2_community_none'] = st()
    assert '가사가 없는 곡' in R['2_community_none']['state'], R['2_community_none']

    # 3) 공용 목록: 틀렸다고 모인 번호(avoid)는 자동 찾기에서 건너뜀 → 못 찾음
    fresh(0, {K[0]: {'avoid': [1]}})
    R['3_avoid'] = st()
    assert '가사를 찾지 못했어요' in R['3_avoid']['state'], R['3_avoid']

    # 4) 가사가 없던 곡 → 직접 검색해서 고르면 자동으로 지정 + 의견 보냄
    n0 = len(POSTS)
    pg.click('.lystate button:has-text("직접 검색")')
    pg.click('.lyform .btn.primary')
    pg.wait_for_timeout(800)
    R['4_results'] = pg.evaluate("[...document.querySelectorAll('.lyr')].map(e => e.textContent)")
    pg.click('.lyr >> nth=0')
    pg.wait_for_timeout(800)
    R['4_picked'] = st()
    assert '다른 사용자에게도 알렸어요' in R['4_picked']['toast'] and R['4_picked']['first'] == '선택한 가사 줄 하나', R['4_picked']
    assert len(POSTS) == n0 + 1, POSTS
    m = POSTS[-1]
    R['4_post'] = m
    assert m['v'] == 1 and m['s'] == '봄날의 노래' and m['a'] == '울림 테스트' and m['c'] == 7 and m['w'] is None and m['d'] == 24 and m['app'], m
    voter = m['u']
    assert len(voter) >= 16, voter

    # 5) 자동으로 찾은 가사가 틀림 → '틀린 가사 제보' → 맞는 가사 고르기 → {틀림: 1, 맞음: 7}
    fresh(0, {})
    R['5_auto'] = st()
    assert 'LRCLIB 자동 검색' in R['5_auto']['sub'] and '틀린 가사 제보' in R['5_auto']['credit'], R['5_auto']
    pg.click('.credit button:has-text("틀린 가사 제보")')
    pg.wait_for_timeout(900)
    R['5_fix_results'] = pg.evaluate("[...document.querySelectorAll('.lyr')].map(e => [e.className, e.textContent])")
    assert any('bad' in c and '봄날의 노래' in t and '틀림' in t for c, t in R['5_fix_results']), R['5_fix_results']
    pg.click('.lyr >> nth=0')
    pg.wait_for_timeout(800)
    m = POSTS[-1]
    R['5_post'] = m
    assert m['w'] == 1 and m['c'] == 7 and m['u'] == voter, m

    # 6) '가사가 없는 곡이에요' → {틀림: 1, 맞음: 0}
    fresh(0, {})
    pg.click('.credit button:has-text("틀린 가사 제보")')
    pg.wait_for_timeout(500)
    pg.click('.fixbar button:has-text("가사가 없는 곡이에요")')
    pg.wait_for_timeout(600)
    R['6_none'] = {**st(), 'post': POSTS[-1]}
    assert POSTS[-1]['w'] == 1 and POSTS[-1]['c'] == 0 and '가사가 없는 곡' in R['6_none']['state'], R['6_none']

    # 7) '틀렸다고만 알리기' → {틀림: 1, 맞음: 없음}, 다시 틀어도 그 가사를 다시 가져오지 않음
    fresh(0, {})
    pg.click('.credit button:has-text("틀린 가사 제보")')
    pg.wait_for_timeout(500)
    pg.click('.fixbar button:has-text("틀렸다고만 알리기")')
    pg.wait_for_timeout(600)
    R['7_wrong_only'] = {**st(), 'post': POSTS[-1]}
    assert POSTS[-1]['w'] == 1 and POSTS[-1]['c'] is None and '찾지 못했어요' in R['7_wrong_only']['state'], R['7_wrong_only']
    n_calls = len(CALLS)
    pg.evaluate('__ullim.playIndex(1)'); pg.wait_for_timeout(1200)
    pg.evaluate('__ullim.playIndex(0)'); pg.wait_for_timeout(1500)
    R['7_replay'] = {**st(), 'lrclib_get_calls': [c for c in CALLS[n_calls:] if c.startswith('/api/get') and ('봄날' in c or c.startswith('/api/get/1'))]}
    assert '찾지 못했어요' in R['7_replay']['state'] and not R['7_replay']['lrclib_get_calls'], R['7_replay']

    # 8) 인터넷이 끊겼을 때 → 보낼 상자에 남았다가 다시 연결되면 보냄
    MODE['feed_fail'] = True
    n0 = len(POSTS)
    fresh(1, {})
    pg.click('.lystate button:has-text("직접 검색")')
    pg.fill('.lyform input >> nth=0', '직접 찾은 곡')
    pg.click('.lyform .btn.primary')
    pg.wait_for_timeout(800)
    pg.click('.lyr >> nth=0')
    pg.wait_for_timeout(800)
    out = pg.evaluate("JSON.parse(localStorage.getItem('ullim.lyrout.v1') || '[]').length")
    MODE['feed_fail'] = False
    res = pg.evaluate("async () => (await window.__L).flushFeedback()")
    R['8_outbox'] = {'queued_while_offline': out, 'flush': res, 'posted': POSTS[n0:]}
    assert out == 1 and res == {'sent': 1, 'queued': 0} and len(POSTS) == n0 + 1 and POSTS[-1]['s'] == 'Opus 곡' and POSTS[-1]['c'] == 7, R['8_outbox']

    # 9) 설정에서 끄면 보내지 않음
    pg.evaluate("__ullim.S.lyrShare = false")
    n0 = len(POSTS)
    fresh(0, {})
    pg.click('.credit button:has-text("틀린 가사 제보")')
    pg.wait_for_timeout(800)
    pg.click('.lyr >> nth=0')
    pg.wait_for_timeout(800)
    R['9_off'] = {**st(), 'new_posts': len(POSTS) - n0}
    assert R['9_off']['new_posts'] == 0 and '알렸어요' not in R['9_off']['toast'], R['9_off']
    pg.evaluate("__ullim.S.lyrShare = true")

    # 설정 화면에 스위치가 있는지
    pg.evaluate("__ullim.setTab('set')")
    pg.wait_for_timeout(300)
    R['settings'] = pg.evaluate("[...document.querySelectorAll('.srow .tt')].map(e => e.textContent).filter(t => t.includes('가사'))")
    assert any('다른 사용자와 나누기' in t for t in R['settings']), R['settings']
    pg.evaluate("__ullim.setTab('lyr')")
    fresh(3, {K[3]: {'pick': 9}})
    pg.screenshot(path='/home/claude/ullim/test/shots/lyrics-community.png')
    pg.click('.credit button:has-text("틀린 가사 제보")')
    pg.wait_for_timeout(900)
    pg.screenshot(path='/home/claude/ullim/test/shots/lyrics-fix.png')

    R['errors'] = errs
    b.close()

print(json.dumps(R, ensure_ascii=False, indent=1))
assert not [e for e in errs if 'PAGEERROR' in e or 'Content Security Policy' in e], errs
print('lyrics share ok')
