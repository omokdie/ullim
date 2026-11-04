"""한국 노래 가사 찾기 시험 — LRCLIB 에 실제로 있는 모양을 가짜 응답으로 재현.

  영어로 번역된 제목 (봄이 좋냐?? ↔ What The Spring??), 소리 나는 대로 적은 제목 (바운스 ↔ Bounce),
  제목 속 피처링 가수 (내가 바보라서 그래 feat KIXO ↔ because I'm stupid? (feat. KIXO)),
  흔한 낱말만 겹치는 다른 곡은 고르지 않기 (내 사람 ↛ Taboo), 파일 이름에서 가수 · 제목 읽기.

  python3 test/server.py &
  python3 test/lyrics_korean_test.py
"""
import json
import urllib.parse
from playwright.sync_api import sync_playwright

H = {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'}


def rec(i, title, artist, dur, plain, synced=False, album='X'):
    lines = [l for l in plain.split('\n')]
    return {'id': i, 'trackName': title, 'artistName': artist, 'albumName': album, 'duration': dur, 'instrumental': False,
            'plainLyrics': plain, 'syncedLyrics': '\n'.join(f'[00:{k * 3:02d}.00]{l}' for k, l in enumerate(lines)) if synced else None}


SPRING = rec(901, 'What The Spring??', '10cm', 205, '꽃이 언제 피는지\n그딴 게 뭐가 중요한데\n봄이 그렇게도 좋냐 멍청이들아', synced=True)
OTHERS_10CM = [rec(800 + k, f'Song {k}', '10CM', 180 + k, f'가사 {k}\n다른 노래') for k in range(20)]
BOUNCE = rec(902, 'Bounce', 'CHO YONG PIL', 184, 'Bounce bounce\n두근대는 마음\n너를 볼 때마다', synced=True)
OTHER_CYP = rec(903, 'Hello', 'CHO YONG PIL', 220, 'Hello hello')
STUPID = rec(904, "because I'm stupid? (feat. KIXO)", 'CHUU', 124, '내가 바보라서 그래\n너를 못 잊는 건')
TABOO = rec(905, 'Taboo', 'SG Wannabe', 249, '그 사람 내 사람\n사랑하면 안 되는')
LOG = []


def lrclib(route):
    u = urllib.parse.urlparse(route.request.url)
    q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
    LOG.append((u.path, q))
    if u.path == '/api/get':
        return route.fulfill(status=404, headers=H, body='{"name":"TrackNotFound","statusCode":404}')
    text = (q.get('q', '') + ' ' + q.get('track_name', '') + ' ' + q.get('artist_name', '')).lower()
    out = []
    if 'spring' in text and '10cm' in text: out = [SPRING]
    elif text.strip() in ('10cm',): out = OTHERS_10CM            # 많은 곡을 낸 가수: 20개 안에 없음
    elif 'cho yong pil' in text or '조용필' in text: out = [OTHER_CYP, BOUNCE] if 'q' in q else []
    elif 'chuu' in text or 'kixo' in text: out = [STUPID] if 'q' in q else []
    elif 'sg wannabe' in text or 'sg워너비' in text: out = [TABOO] if 'q' in q else []
    return route.fulfill(status=200, headers=H, body=json.dumps(out, ensure_ascii=False))


R = {}
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(bypass_csp=True)
    ctx.route('https://lrclib.net/api/**', lrclib)
    ctx.route('https://raw.githubusercontent.com/**', lambda r: r.fulfill(status=200, headers=H, body='{"version":1,"songs":{}}'))
    ctx.route('https://ntfy.sh/**', lambda r: r.fulfill(status=200, headers=H, body='{}'))
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8766/web/index.html')
    pg.wait_for_function('window.__ullim && window.__ullim.engine')
    find = lambda t, d: pg.evaluate("""async ([t, d]) => { const L = await import('/web/js/lyrics.js');
        const r = await L.findOnline(L.guessQuery({ name: '', tagged: true, ...t }), d, []);
        return r ? `${r.match.title}|${r.match.artist}|${r.synced ? 'S' : 'P'}` : null; }""", [t, d])

    R['translated'] = find({'title': '봄이 좋냐??', 'artist': '10cm', 'album': '4.0'}, 205)
    assert R['translated'] == 'What The Spring??|10cm|S', R
    assert any(q.get('q') == '10cm spring' for _, q in LOG), LOG            # 제목 낱말을 영어로 바꿔 찾음
    R['transliterated'] = find({'title': '바운스', 'artist': '조용필'}, 185)
    assert R['transliterated'] == 'Bounce|CHO YONG PIL|S', R
    R['featuring'] = find({'title': '내가 바보라서 그래 feat KIXO', 'artist': '츄 (CHUU)'}, 124)
    assert R['featuring'] == "because I'm stupid? (feat. KIXO)|CHUU|P", R
    R['common_word_only'] = find({'title': '내 사람', 'artist': 'SG워너비', 'album': 'The 3rd Masterpiece'}, 250)
    assert R['common_word_only'] is None, R
    R['too_far'] = find({'title': '바운스', 'artist': '조용필'}, 200)            # 길이가 2초 넘게 다르면 받아들이지 않음
    assert R['too_far'] is None, R

    R['names'] = pg.evaluate("""async () => { const L = await import('/web/js/lyrics.js');
        const g = n => { const q = L.guessQuery({ key: n, name: n, title: '', artist: '' }); return [q.artist, q.title]; };
        return { a: g('아이유-밤편지.mp3'), b: g('[MV] IU(아이유) _ Through the Night(밤편지).mp3'), c: g('01. 버스커 버스커 - 벚꽃 엔딩.mp3'),
          d: g('방탄소년단 (BTS) – 봄날 (Spring Day) Official MV.mp3') }; }""")
    assert R['names']['a'] == ['아이유', '밤편지'] and R['names']['c'] == ['버스커 버스커', '벚꽃 엔딩'], R['names']
    assert R['names']['d'][0].startswith('방탄소년단') and R['names']['d'][1].startswith('봄날'), R['names']
    R['sound'] = pg.evaluate("""async () => { const L = await import('/web/js/lyrics.js');
        return [L.soundAlike('바운스', 'Bounce'), L.soundAlike('러브 다이브', 'LOVE DIVE'), L.soundAlike('넥스트 레벨', 'Next Level'),
                L.soundAlike('사랑', 'Love'), L.soundAlike('밤편지', 'Through the Night'), L.titleKeywords('봄이 좋냐??'), L.titleKeywords('비와 당신')]; }""")
    assert R['sound'][:5] == [True, True, True, False, False] and R['sound'][5] == ['spring'] and R['sound'][6] == ['rain'], R['sound']
    R['errors'] = errs
    b.close()

print(json.dumps(R, ensure_ascii=False, indent=1))
assert not errs, errs
print('korean lyrics ok')
