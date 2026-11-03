"""가사 서버가 붐빌 때(503 · 429) · 이름이 괄호로 섞여 있을 때 시험 — 실제 LRCLIB 에서 본 상황을 가짜 응답으로 재현.

  python3 test/server.py &
  python3 test/lyrics_retry_test.py
"""
import json
import time
import urllib.parse
from playwright.sync_api import sync_playwright

M = '/home/claude/ullim/test/media/'
TRACKS = [{'key': '/media?p=' + M + n, 'name': n} for n in ['song_cbr_v23.mp3', 'song.opus', 'song.flac', 'song_vbr_v24.mp3']]
SYNCED = "\n".join(f"[00:{i*2:02d}.00]봄날 가사 {i+1}" for i in range(12))
# 실제 LRCLIB 처럼 '영어 (한글)' 이름: 앱 태그는 '울림 테스트 - 봄날의 노래'
REC = {'id': 501, 'trackName': 'Spring Song (봄날의 노래)', 'artistName': 'Ullim Test (울림 테스트)', 'albumName': 'X', 'duration': 24,
       'instrumental': False, 'plainLyrics': '…', 'syncedLyrics': SYNCED}
OTHER = {'id': 502, 'trackName': 'Spring Song', 'artistName': 'Someone Else', 'albumName': 'Y', 'duration': 250,
         'instrumental': False, 'plainLyrics': '…', 'syncedLyrics': '[00:01.00]다른 곡\n[00:02.00]다른 곡\n[00:03.00]다른 곡'}
LOG, MODE = [], {'busy503': 0, 'always503': False, 'rate429': 0}
H = {'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After', 'Content-Type': 'application/json'}


def lrclib(route):
    u = urllib.parse.urlparse(route.request.url)
    q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
    LOG.append((round(time.time(), 2), u.path, q))
    if MODE['always503'] or MODE['busy503'] > 0:
        MODE['busy503'] -= 1
        return route.fulfill(status=503, headers={**H, 'Retry-After': '1'}, body='{"name":"ServerOverloaded","statusCode":503}')
    if MODE['rate429'] > 0:
        MODE['rate429'] -= 1
        return route.fulfill(status=429, headers={**H, 'Retry-After': '1'}, body='{"name":"RateLimitExceeded","statusCode":429}')
    if u.path == '/api/get':
        return route.fulfill(status=404, headers=H, body='{"name":"TrackNotFound","statusCode":404}')
    if u.path == '/api/search':
        # 실제처럼: '제목+가수'(한글 가수)로는 안 나오고, 제목만 · q 로는 나온다
        if q.get('artist_name') == '울림 테스트':
            return route.fulfill(status=200, headers=H, body='[]')
        text = q.get('track_name', '') + ' ' + q.get('q', '')
        if '봄날' in text:
            return route.fulfill(status=200, headers=H, body=json.dumps([OTHER, REC], ensure_ascii=False))
        return route.fulfill(status=200, headers=H, body='[]')
    return route.fulfill(status=404, headers=H, body='{}')


R = {}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}, bypass_csp=True)   # wait_for_function 용 (CSP 확인은 lyrics_share_test)
    ctx.route('https://lrclib.net/api/**', lrclib)
    ctx.route('https://raw.githubusercontent.com/**', lambda r: r.fulfill(status=200, headers=H, body='{"version":1,"songs":{}}'))
    ctx.route('https://ntfy.sh/**', lambda r: r.fulfill(status=200, headers=H, body='{}'))
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8766/web/index.html')
    pg.wait_for_function('window.__ullim && window.__ullim.engine')
    pg.evaluate("window.__L = import('/web/js/lyrics.js')")
    pg.evaluate(f'__ullim.addItems({json.dumps(TRACKS)})')
    pg.evaluate("__ullim.setTab('lyr')")
    pg.wait_for_timeout(1200)
    st = lambda: pg.evaluate("""() => ({ sub: document.querySelector('.lysub')?.textContent || '', state: document.querySelector('.lystate')?.textContent || '',
        first: document.querySelector('#lyBody .ly:not(.gap)')?.textContent || '' })""")
    cached = lambda i: pg.evaluate(f"async () => {{ const L = await window.__L; return L.cacheGet(__ullim.list[{i}].key); }}")

    # 1) 이름 맞추기 (순수 함수)
    R['names'] = pg.evaluate("""async () => { const L = await window.__L;
        return { iu: L.names('IU (아이유)', true), title: L.names('Through the Night (밤편지)'), apt: L.names('ROSÉ, Bruno Mars', true),
                 s1: L.score({ trackName: 'Through the Night (밤편지)', artistName: 'IU (아이유)', duration: 283, syncedLyrics: 'x' }, { title: '밤편지', artist: '아이유' }, 283),
                 s2: L.score({ trackName: 'Through the Night (밤편지)', artistName: 'IU (아이유)', duration: 283, syncedLyrics: 'x' }, { title: '밤편지', artist: '아이유' }, 0),
                 s3: L.score({ trackName: 'Supernova', artistName: 'Wim', duration: 234, syncedLyrics: 'x' }, { title: 'Supernova', artist: 'aespa' }, 179),
                 s4: L.score({ trackName: 'APT.', artistName: 'ROSÉ, Bruno Mars', duration: 169, syncedLyrics: 'x' }, { title: 'APT.', artist: 'ROSÉ & Bruno Mars' }, 170) }; }""")
    n = R['names']
    assert '아이유' in n['iu'] and 'iu' in n['iu'] and '밤편지' in n['title'] and 'throughthenight' in n['title'] and 'rosé' in n['apt'], n
    assert n['s1'] >= 8 and n['s2'] > 2.5 and n['s3'] < 2.5 and n['s4'] >= 8, n
    # 실제 LRCLIB 에서 본 경우들: 받아들일지 규칙 · 가수 별칭 (아이유 ↔ IU)
    R['accept'] = pg.evaluate("""async () => { const L = await window.__L; const S = 'x';
        const swap = { title: '아이유', artist: '밤편지' }; Object.defineProperty(swap, 'swap', { value: true });
        return {
          wrongGoodDay: L.rate({ trackName: '이렇게 좋은 날', artistName: 'Han Seo Yoon', duration: 218, syncedLyrics: S }, { title: '좋은 날', artist: '아이유' }, 233).ok,
          wrongDuet: L.rate({ trackName: '언제쯤이면 (DUET.아이유)', artistName: '윤현상', duration: 259, syncedLyrics: S }, { title: '아이유', artist: '밤편지' }, 253).ok,
          goodDay: L.rate({ trackName: 'Good day (좋은 날)', artistName: 'IU', duration: 235.56, syncedLyrics: S }, { title: '좋은 날', artist: '아이유' }, 233).ok,
          live: L.rate({ trackName: 'Through the Night (밤편지)', artistName: 'IU (아이유)', duration: 282.9, syncedLyrics: S }, { title: '밤편지', artist: '아이유' }, 253),
          aliasIU: L.names('아이유', true).includes('iu'), aliasBTS: L.names('방탄소년단', true).includes('bts'),
          otherArtistSameTitle: L.rate({ trackName: 'Dynamite', artistName: 'Taio Cruz', duration: 202, syncedLyrics: S }, { title: 'Dynamite', artist: 'BTS' }, 199).ok,
        }; }""")
    a = R['accept']
    assert a['wrongGoodDay'] is False and a['wrongDuet'] is False and a['goodDay'] is True and a['aliasIU'] and a['aliasBTS'], a
    assert a['live']['ok'] is True and a['live']['plainOnly'] is True and a['otherArtistSameTitle'] is False, a

    # 2) 서버가 처음 4번 붐빔(503) → 기다렸다 다시 → '영어 (한글)' 이름 곡을 찾음
    pg.evaluate('__ullim.playIndex(1)'); pg.wait_for_timeout(300)
    pg.evaluate(f"async () => {{ (await window.__L).cacheDrop(__ullim.list[0].key); }}")
    MODE['busy503'] = 4
    LOG.clear()
    t0 = time.time()
    pg.evaluate('__ullim.playIndex(0)')
    pg.wait_for_function("(document.querySelector('.lystate')?.textContent || '').includes('조금 오래 걸리고')", timeout=10000)
    pg.wait_for_function("document.querySelector('#lyBody .ly')", timeout=20000)
    R['2_busy_then_found'] = {**st(), 'secs': round(time.time() - t0, 1), 'requests': len(LOG)}
    assert R['2_busy_then_found']['first'] == '봄날 가사 1' and 'LRCLIB 자동 검색' in R['2_busy_then_found']['sub'], R['2_busy_then_found']
    gaps = [round(LOG[i + 1][0] - LOG[i][0], 2) for i in range(min(4, len(LOG) - 1))]
    R['2_retry_gaps'] = gaps
    assert R['2_busy_then_found']['requests'] >= 6 and all(g >= 0.9 for g in gaps[:3]), (gaps, LOG[:8])   # Retry-After: 1 을 지킴

    # 3) 요청이 많음(429) 도 같은 식으로 기다렸다 다시
    pg.evaluate(f"async () => {{ (await window.__L).cacheDrop(__ullim.list[0].key); }}")
    MODE['rate429'] = 2
    pg.evaluate('__ullim.playIndex(1)'); pg.wait_for_timeout(300)
    pg.evaluate('__ullim.playIndex(0)')
    pg.wait_for_function("document.querySelector('#lyBody .ly')", timeout=20000)
    R['3_429_then_found'] = st()
    assert R['3_429_then_found']['first'] == '봄날 가사 1', R['3_429_then_found']

    # 4) 서버가 계속 붐빔 → '서버가 붐벼요' (인터넷 끊김이라고 하지 않음) · '없음'으로 기억하지 않음
    MODE['always503'] = True
    pg.evaluate('__ullim.playIndex(2)')
    pg.wait_for_timeout(500)
    pg.evaluate('__ullim.engine.deck.a.pause()')          # 24초짜리 시험 곡이 끝나 다음 곡으로 넘어가지 않게
    pg.wait_for_function("(document.querySelector('.lystate')?.textContent || '').includes('가져오지 못했어요')", timeout=60000)
    R['4_busy'] = {**st(), 'cache': cached(2)}
    assert '가사 서버(LRCLIB)가 지금 붐벼서' in R['4_busy']['state'] and '인터넷' not in R['4_busy']['state'] and R['4_busy']['cache'] is None, R['4_busy']
    MODE['always503'] = False

    # 5) 서버가 다시 괜찮아지면 30초 뒤 자동으로 다시 찾음 (가짜 시계 대신 직접 기다림 — 결과 '없음'이 와야 함)
    pg.wait_for_function("(document.querySelector('.lystate')?.textContent || '').includes('찾지 못했어요')", timeout=45000)
    R['5_auto_retry'] = {**st(), 'cache': cached(2)}
    assert R['5_auto_retry']['cache'] == {'none': True}, R['5_auto_retry']     # 끝까지 찾았을 때만 '없음' 기억

    # 6) 인터넷이 정말 끊겼을 때 → '인터넷에 연결되어 있지 않아요'
    ctx.unroute('https://lrclib.net/api/**')
    ctx.route('https://lrclib.net/api/**', lambda r: r.abort('internetdisconnected'))
    pg.evaluate(f"async () => {{ (await window.__L).cacheDrop(__ullim.list[3].key); }}")
    pg.evaluate('__ullim.playIndex(3)')
    pg.wait_for_function("(document.querySelector('.lystate')?.textContent || '').includes('인터넷')", timeout=20000)
    R['6_offline'] = st()
    assert '인터넷에 연결되어 있지 않아요' in R['6_offline']['state'], R['6_offline']

    R['errors'] = errs
    b.close()

print(json.dumps(R, ensure_ascii=False, indent=1))
assert not errs, errs
print('lyrics retry ok')
