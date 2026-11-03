"""가사 기능 테스트 — LRCLIB 응답은 가짜(placeholder)로 대신한다"""
import json, time, urllib.parse
from playwright.sync_api import sync_playwright

M = '/home/claude/ullim/test/media/'
TRACKS = [
    {'key': '/media?p=' + M + 'song_cbr_v23.mp3', 'name': 'song_cbr_v23.mp3'},          # online synced (mock /api/get)
    {'key': '/media?p=' + M + 'song_lyrics_tag.mp3', 'name': 'song_lyrics_tag.mp3'},    # embedded USLT with timestamps
    {'key': '/media?p=' + M + 'song_lyrics_plain.flac', 'name': 'song_lyrics_plain.flac'},  # embedded plain LYRICS
    {'key': '/media?p=' + M + 'song.opus', 'name': 'song.opus'},                         # nothing anywhere -> none
    {'key': '/media?p=' + M + 'song.wav', 'name': 'song.wav'},                           # network error
]
SYNCED = "\n".join(f"[00:{i*2:02d}.00]온라인 예시 가사 {i+1}" for i in range(12))
CALLS = []
MODE = {'fail': False}

def handle(route):
    url = route.request.url
    u = urllib.parse.urlparse(url); q = urllib.parse.parse_qs(u.query)
    CALLS.append(u.path + ' ' + json.dumps({k: v[0] for k, v in q.items()}, ensure_ascii=False))
    if MODE['fail']:
        return route.abort('internetdisconnected')
    hdr = {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'}
    if u.path == '/api/get' and q.get('track_name', [''])[0] == '봄날의 노래':
        body = {'id': 1, 'trackName': '봄날의 노래', 'artistName': '울림 테스트', 'albumName': '샘플 앨범', 'duration': 24, 'instrumental': False, 'plainLyrics': '…', 'syncedLyrics': SYNCED}
        return route.fulfill(status=200, headers=hdr, body=json.dumps(body, ensure_ascii=False))
    if u.path == '/api/search' and ('Opus' in q.get('track_name', [''])[0] + q.get('q', [''])[0]) and '직접' not in url:
        return route.fulfill(status=200, headers=hdr, body='[]')
    if u.path == '/api/search':
        res = [{'id': 7, 'trackName': '직접 찾은 곡', 'artistName': '검색 가수', 'albumName': '앨범', 'duration': 24, 'instrumental': False,
                'plainLyrics': '선택한 가사 줄 하나\n선택한 가사 줄 둘', 'syncedLyrics': None},
               {'id': 8, 'trackName': '다른 곡', 'artistName': '다른 가수', 'albumName': '', 'duration': 200, 'instrumental': True, 'plainLyrics': None, 'syncedLyrics': None}]
        return route.fulfill(status=200, headers=hdr, body=json.dumps(res, ensure_ascii=False))
    return route.fulfill(status=404, headers=hdr, body='{"code":404,"name":"TrackNotFound"}')

R = {}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}, bypass_csp=False, color_scheme='dark')
    ctx.route('https://lrclib.net/api/**', handle)
    pg = ctx.new_page()
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error',) else None)
    pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
    pg.goto('http://127.0.0.1:8766/web/index.html')
    pg.wait_for_function('window.__ullim && window.__ullim.engine')
    pg.evaluate(f'__ullim.addItems({json.dumps(TRACKS)}, {{play:true}})')
    pg.evaluate("__ullim.setTab('lyr')")
    pg.wait_for_timeout(2500)
    st = lambda: pg.evaluate("""() => ({ sub: document.querySelector('.lysub')?.textContent, state: document.querySelector('.lystate')?.textContent || '',
        lines: document.querySelectorAll('#lyBody .ly:not(.gap)').length, on: document.querySelector('#lyBody .ly.on')?.textContent || '', synced: !!document.querySelector('#lyBody.synced'),
        t: +__ullim.engine.deck.a.currentTime.toFixed(1) })""")
    R['1_online_synced'] = st()
    pg.wait_for_timeout(3000); R['1_after_3s'] = st()
    # click a line to seek
    pg.click('#lyBody .ly >> nth=8'); pg.wait_for_timeout(600); R['1_click_seek'] = st()
    pg.screenshot(path='/home/claude/ullim/test/shots/lyrics-desktop.png')
    # 2: embedded USLT (timed)
    pg.evaluate('__ullim.playIndex(1)'); pg.wait_for_timeout(2000); R['2_tag_synced'] = st()
    # 3: embedded plain
    pg.evaluate('__ullim.playIndex(2)'); pg.wait_for_timeout(2000); R['3_tag_plain'] = st()
    # 4: nothing -> none, then manual search + pick
    pg.evaluate('__ullim.playIndex(3)'); pg.wait_for_timeout(2000); R['4_none'] = st()
    pg.click('.lystate button:has-text("직접 검색")'); pg.wait_for_timeout(300)
    pg.fill('.lyform input >> nth=0', '직접 찾은 곡'); pg.click('.lyform .btn.primary'); pg.wait_for_timeout(1000)
    R['4_results'] = pg.evaluate("[...document.querySelectorAll('.lyr .t1')].map(e => e.textContent)")
    pg.click('.lyr >> nth=0'); pg.wait_for_timeout(500); R['4_picked'] = st()
    # cache: replaying the track uses the saved pick without a new request
    n_calls = len(CALLS)
    pg.evaluate('__ullim.playIndex(0)'); pg.wait_for_timeout(1000); pg.evaluate('__ullim.playIndex(3)'); pg.wait_for_timeout(1500)
    R['4_cached'] = {**st(), 'new_requests': len(CALLS) - n_calls}
    # 5: network failure
    MODE['fail'] = True
    pg.evaluate('__ullim.playIndex(4)'); pg.wait_for_timeout(2000); R['5_error'] = st()
    MODE['fail'] = False
    # mobile layout screenshot of the lyrics tab
    mp = ctx.new_page(); mp.set_viewport_size({'width': 390, 'height': 844})
    mp.goto('http://127.0.0.1:8766/web/index.html'); mp.wait_for_function('window.__ullim && window.__ullim.engine')
    mp.evaluate(f'__ullim.addItems({json.dumps(TRACKS[:1])}, {{play:true}})'); mp.evaluate("__ullim.setTab('lyr')"); mp.wait_for_timeout(5000)
    mp.screenshot(path='/home/claude/ullim/test/shots/lyrics-mobile.png')
    R['calls'] = CALLS
    R['logs'] = logs[:12]
    b.close()
print(json.dumps(R, ensure_ascii=False, indent=1))
