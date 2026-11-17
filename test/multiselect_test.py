"""여러 곡 고르기 시험 — 새 플레이리스트 만들기 · 다른 플레이리스트로 이동 · 모든 곡에서 골라 넣기 · 파일을 골라 새 플레이리스트로.
가짜 안드로이드 연결층(저장됨 · 파일 권한 돌려주기 · 진동)으로.

  python3 test/server.py /home/claude/ullim 8766 &
  python3 test/multiselect_test.py
"""
import json
from playwright.sync_api import sync_playwright

M = '/home/claude/ullim/test/media/'
FILES = ['song_cbr_v23.mp3', 'song.flac', 'song.m4a', 'song_euckr.mp3', 'song_vbr_v24.mp3']
OLD = [{'k': M + f, 'n': f} for f in FILES]          # 1.0.x 형식: 재생목록 하나
PICK = [{'key': M + f, 'name': f} for f in ('song.opus', 'song.wav')]
INIT = """
if (!sessionStorage.getItem('seeded')) {
  sessionStorage.setItem('seeded', '1');
  localStorage.clear();
  localStorage.setItem('ullim.playlist.v1', JSON.stringify(%s));
}
window.__released = []; window.__haptic = 0; window.__pickFolder = null;
window.UllimAndroid = {
  call(method, args, id) {
    setTimeout(() => {
      if (method === 'pickFiles') window.__ullimResolve(id, JSON.stringify(%s), null);
      else if (method === 'pickFolder') window.__ullimResolve(id, window.__pickFolder, null);    // null = 고르지 않고 닫음
      else window.__ullimResolve(id, null, 'not in test');
    }, 10);
  },
  nowPlaying() {}, setSystemBars() {}, ready() { window.__readyCalled = true; }, exitApp() {},
  release(json) { window.__released.push(...JSON.parse(json)); },
  haptic() { window.__haptic++; },
};
""" % (json.dumps(OLD), json.dumps(PICK))

R = {}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}, bypass_csp=True)
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    pg.set_default_timeout(10000)
    errs = []
    pg.on('pageerror', lambda e: errs.append(f'PAGEERROR: {e}'))
    pg.goto('http://127.0.0.1:8766/web/index.html')
    pg.wait_for_function('window.__ullim && window.__readyCalled')
    pg.wait_for_timeout(800)
    ev = pg.evaluate
    S = lambda: ev("""() => { const U = __ullim; return {
        pls: U.pls.map(p => `${p.name}:${p.tracks.length}`), shown: U.shown.name, playing: U.playPl.name, idx: U.P.index,
        cur: U.list[U.P.index] ? U.list[U.P.index].name : null, same: U.list === U.playPl.tracks,
        edit: U.EDIT.on, sel: U.EDIT.sel.size, bar: document.getElementById('editBar').hidden ? '' : document.getElementById('editBar').textContent,
        rows: [...document.querySelectorAll('#spacer .row')].map(r => (r.classList.contains('sel') ? '+' : '') + (r.classList.contains('have') ? '=' : '') + r.querySelector('.t1').textContent) }; }""")
    menu = lambda text: pg.click(f'.menu button:has-text("{text}")')
    names = lambda pl: ev(f"__ullim.pls.find(p => p.name === {json.dumps(pl)}).tracks.map(t => t.name)")
    openpl = lambda name: (pg.click(f'.spl:has(.nm:text-is("{name}"))'), pg.wait_for_timeout(250))
    row = lambda i: f'#spacer .row[data-i="{i}"]'
    bar = lambda text: pg.click(f'#editBar button:has-text("{text}")')
    toast = lambda: pg.text_content('#toast')

    pg.click('#viewHome .ptile[data-pl]'); pg.wait_for_timeout(1500)            # 태그를 읽을 시간
    R['tags'] = ev("__ullim.shown.tracks.map(t => [t.name, t.title, t.artist, t.album])")

    # 1) PC: Ctrl + 클릭 → 고르기 시작, Shift + 클릭 → 사이의 곡 모두
    pg.click(row(0)); pg.wait_for_timeout(700)                                   # 0번 곡 재생
    pg.click(row(1), modifiers=['Control']); pg.wait_for_timeout(100)
    s1 = S(); assert s1['edit'] and s1['sel'] == 1 and s1['idx'] == 0 and '1곡 선택' in s1['bar'], s1
    pg.click(row(3), modifiers=['Shift']); pg.wait_for_timeout(100)
    s1 = S(); assert s1['sel'] == 3 and [r.startswith('+') for r in s1['rows']] == [False, True, True, True, False], s1
    assert ev("document.getElementById('plSelect').classList.contains('on')")
    R['1_bar_pc'] = s1['bar']
    pg.screenshot(path='/home/claude/ullim/test/shots/multiselect-pc.png')

    # 2) 새 플레이리스트로: 이름을 정하면 고른 곡을 복사해 만들고, 고르기는 끝남. 알림의 '보기' 로 그 목록으로
    bar('새 플레이리스트로'); pg.wait_for_timeout(150)
    R['2_suggest'] = ev("document.querySelector('.dialog input').value")
    pg.fill('.dialog input', '선곡'); pg.click('.dialog .primary'); pg.wait_for_timeout(200)
    s2 = S(); R['2_toast'] = toast()
    assert s2['pls'] == ['재생목록:5', '선곡:3'] and not s2['edit'] and s2['shown'] == '재생목록', s2
    assert "'선곡'을 만들고 3곡을 넣었어요" in R['2_toast'] and R['2_toast'].endswith('보기'), R['2_toast']
    assert names('선곡') == FILES[1:4], names('선곡')
    pg.click('#toast .link'); pg.wait_for_timeout(250)
    assert S()['shown'] == '선곡'

    # 3) 다른 플레이리스트로 이동: 지금 듣는 곡을 옮기면 끊기지 않고, 재생 목록도 따라감
    openpl('재생목록')
    pg.wait_for_timeout(1200)
    t0 = ev('__ullim.engine.deck.a.currentTime'); src0 = ev("__ullim.engine.deck.a.getAttribute('src')")
    pg.click('#plSelect'); pg.click(row(0)); pg.click(row(4)); pg.wait_for_timeout(100)
    bar('플레이리스트로 이동'); pg.wait_for_timeout(100)
    R['3_menu'] = pg.eval_on_selector_all('.menu button', 'e => e.map(x => x.textContent)')
    assert R['3_menu'][0].startswith('선곡') and '새 플레이리스트 만들어 이동' in R['3_menu'][-1] and not any('재생목록' in x for x in R['3_menu']), R['3_menu']
    menu('선곡'); pg.wait_for_timeout(400)
    s3 = S(); R['3_toast'] = toast()
    assert s3['pls'] == ['재생목록:3', '선곡:5'] and s3['playing'] == '선곡' and s3['same'] and s3['cur'] == FILES[0] and not s3['edit'], s3
    assert names('선곡') == FILES[1:4] + [FILES[0], FILES[4]] and names('재생목록') == FILES[1:4], (names('선곡'), names('재생목록'))
    assert "'선곡'으로 2곡을 이동했어요" in R['3_toast'], R['3_toast']
    a = ev("({ src: __ullim.engine.deck.a.getAttribute('src'), t: __ullim.engine.deck.a.currentTime, paused: __ullim.engine.deck.a.paused })")
    assert a['src'] == src0 and not a['paused'] and a['t'] >= t0, (a, t0)                  # 같은 곡이 처음부터 다시 시작하지 않음
    assert "'선곡'에서 재생 중" in pg.text_content('#plNow'), pg.text_content('#plNow')
    pg.wait_for_timeout(300)
    assert ev("[...document.querySelectorAll('.spl.playing .nm')].map(e => e.textContent)") == ['선곡']
    pg.click('#btnNext'); pg.wait_for_timeout(600)                                 # 다음 곡은 옮겨 간 목록에서
    assert S()['cur'] == FILES[4] and S()['playing'] == '선곡', S()

    # 4) 이미 있는 곡을 옮기면 하나만 남김 · 목록이 비면 고르기 끝남 · 빈 목록에서 '모든 곡에서 골라 넣기'
    pg.click('#plSelect'); bar('모두 선택'); bar('플레이리스트로 이동'); menu('선곡'); pg.wait_for_timeout(300)
    s4 = S(); R['4_toast'] = toast()
    assert s4['pls'] == ['재생목록:0', '선곡:5'] and not s4['edit'] and '3곡은 이미 있었어요' in R['4_toast'], (s4, R['4_toast'])
    assert names('선곡') == FILES[1:4] + [FILES[0], FILES[4]]
    R['4_empty'] = pg.text_content('#empty')
    assert '모든 곡에서 골라 넣기' in R['4_empty'], R['4_empty']

    # 5) 모든 곡에서 골라 넣기 → 모든 곡이 고르기 화면으로 열리고, 넣으면 원래 목록으로 돌아감
    pg.click('#empty button:has-text("모든 곡에서 골라 넣기")'); pg.wait_for_timeout(250)
    s5 = S(); assert s5['shown'] == '모든 곡' and s5['edit'] and "'재생목록'에 넣을 곡을 골라요" in s5['bar'], s5
    assert ev("document.querySelectorAll('#spacer .row .grip').length") == 0          # 모든 곡: 순서 바꾸기 없음
    pg.click(row(0)); pg.click(row(1)); pg.wait_for_timeout(100)
    first2 = ev("[0, 1].map(i => __ullim.shown.tracks[i].key)")
    assert "'재생목록'에 2곡 넣기" in S()['bar'], S()['bar']
    pg.click('#editBar .ea .primary'); pg.wait_for_timeout(300)
    s5 = S(); assert s5['shown'] == '재생목록' and s5['pls'] == ['재생목록:2', '선곡:5'] and not s5['edit'], s5
    assert ev("__ullim.shown.tracks.map(t => t.key)") == first2
    # 이미 넣은 곡은 고를 수 없음 ('이미 있어요') · 모두 선택은 나머지만
    pg.click('#plAdd'); menu('모든 곡에서 골라 넣기'); pg.wait_for_timeout(250)
    s5b = S(); R['5_have_rows'] = s5b['rows']
    assert sum(r.startswith('=') for r in s5b['rows']) == 2, s5b
    pg.click(row(0)); pg.wait_for_timeout(100)
    assert S()['sel'] == 0                                                         # 이미 있는 곡은 눌러도 안 골라짐
    bar('모두 선택'); pg.wait_for_timeout(100)
    assert S()['sel'] == 3, S()
    pg.click('#editBar .ea .primary'); pg.wait_for_timeout(300)
    assert S()['pls'] == ['재생목록:5', '선곡:5'] and S()['shown'] == '재생목록', S()
    # 취소(Esc)해도 원래 목록으로
    ev("__ullim.pickInto(__ullim.pls[1])"); pg.wait_for_timeout(200)
    assert S()['shown'] == '모든 곡' and S()['edit']
    pg.keyboard.press('Escape'); pg.wait_for_timeout(250)
    assert S()['shown'] == '선곡' and not S()['edit'], S()

    # 6) 모든 곡 (가상 목록): 찾기로 거른 곡만 '모두 선택' → 새 플레이리스트로. 이동 · 빼기는 없음
    ev("__ullim.showPlaylist(__ullim.allSongsPl())"); pg.wait_for_timeout(250)
    pg.keyboard.press('Control+f'); pg.fill('#searchInput', 'flac'); pg.wait_for_timeout(250)
    vis = len(S()['rows'])
    pg.click('#plMenu'); menu('여러 곡 선택'); pg.wait_for_timeout(100)
    R['6_bar_virtual'] = S()['bar']
    assert '이동' not in R['6_bar_virtual'] and '빼기' not in R['6_bar_virtual'] and '새 플레이리스트로' in R['6_bar_virtual'], R['6_bar_virtual']
    bar('모두 선택'); pg.wait_for_timeout(100)
    assert S()['sel'] == vis and 0 < vis < 5 and not ev("document.getElementById('searchBox').hidden"), (S(), vis)
    bar('새 플레이리스트로'); pg.wait_for_timeout(150)
    R['6_suggest'] = ev("document.querySelector('.dialog input').value")
    pg.click('.dialog .primary'); pg.wait_for_timeout(200)
    assert S()['pls'][-1].endswith(f':{vis}') and S()['shown'] == '모든 곡', S()
    pg.keyboard.press('Escape'); pg.wait_for_timeout(150)                           # 찾기 닫기

    # 7) PC: 고르는 중 오른쪽 클릭 → 고른 곡 메뉴, Ctrl+A → 모두, Delete 는 가상 목록에서 아무것도 안 뺌
    pg.keyboard.press('Control+a'); pg.wait_for_timeout(100)
    n_all = ev('__ullim.shown.tracks.length')
    assert S()['edit'] and S()['sel'] == n_all, S()
    pg.click(row(0), button='right'); pg.wait_for_timeout(100)
    R['7_selmenu'] = pg.eval_on_selector_all('.menu button', 'e => e.map(x => x.textContent)')
    assert R['7_selmenu'][0].startswith(f'{n_all}곡으로 새 플레이리스트') and not any('이동' in x or '빼기' in x for x in R['7_selmenu']), R['7_selmenu']
    pg.keyboard.press('Escape'); pg.keyboard.press('Delete'); pg.wait_for_timeout(100)
    assert ev('__ullim.shown.tracks.length') == n_all
    pg.keyboard.press('Escape'); pg.wait_for_timeout(100)
    assert not S()['edit']

    # 8) 곡 메뉴: 다른 플레이리스트로 이동 · 새 플레이리스트 만들어 이동 (지금 듣는 곡이 아니면 재생은 그대로)
    openpl('재생목록')
    before = S()
    pg.hover(row(2)); pg.click(row(2) + ' .x'); menu('다른 플레이리스트로 이동'); menu('새 플레이리스트 만들어 이동'); pg.wait_for_timeout(150)
    R['8_dialog'] = pg.text_content('.dialog h3')
    pg.fill('.dialog input', '옮긴 곡'); pg.click('.dialog .primary'); pg.wait_for_timeout(250)
    s8 = S(); R['8_toast'] = toast()
    assert R['8_dialog'] == '새 플레이리스트로 이동' and s8['pls'][0] == '재생목록:4' and s8['pls'][-1] == '옮긴 곡:1', s8
    assert s8['playing'] == before['playing'] and s8['cur'] == before['cur'], (before, s8)
    assert "'옮긴 곡'을 만들고 1곡을 이동했어요" in R['8_toast'], R['8_toast']

    # 9) + → 파일을 골라 새 플레이리스트로 (이름은 파일이 든 폴더), 폴더 고르기를 닫으면 아무 일 없음
    n_before = len(S()['pls'])
    pg.click('#btnAdd'); menu('파일을 골라 새 플레이리스트로'); pg.wait_for_timeout(200)
    R['9_suggest'] = ev("document.querySelector('.dialog input').value")
    assert R['9_suggest'] == 'media', R['9_suggest']
    pg.click('.dialog .primary'); pg.wait_for_timeout(400)
    s9 = S(); assert s9['pls'][-1] == 'media:2' and s9['shown'] == 'media' and len(s9['pls']) == n_before + 1, s9
    pg.click('#btnAdd'); menu('폴더를 골라 새 플레이리스트로'); pg.wait_for_timeout(300)
    assert not ev("!!document.querySelector('.dialog')") and len(S()['pls']) == n_before + 1
    assert not ev("document.getElementById('toast').classList.contains('show')") or '찾지 못했' not in toast()
    # 이름 정하기를 취소하면 받아 둔 파일 권한을 돌려줌 (다른 목록에 없는 파일만)
    rel0 = ev('__released.length')
    ev("() => { __ullim.pickToNew('files'); }"); pg.wait_for_timeout(200)          # 기다리지 않음 (이름 정하기 창이 떠 있음)
    pg.click('.dialog .ghost'); pg.wait_for_timeout(100)
    assert ev('__released.length') == rel0 and len(S()['pls']) == n_before + 1      # 두 파일 모두 'media' 목록에 있으니 그대로
    # 폴더 이름 권하기: PC 경로 · 안드로이드 문서 주소 · 폴더를 모르는 주소
    R['9_names'] = ev("""[
      __ullim.folderName([{ key: 'C:\\\\Music\\\\여름\\\\a.mp3' }, { key: 'C:\\\\Music\\\\여름\\\\CD2\\\\b.flac' }]),
      __ullim.folderName([{ key: 'content://com.android.externalstorage.documents/tree/primary%3AMusic/document/primary%3AMusic%2F%EA%B0%80%EC%9D%84%2F1.flac' },
                          { key: 'content://com.android.externalstorage.documents/tree/primary%3AMusic/document/primary%3AMusic%2F%EA%B0%80%EC%9D%84%2F2.flac' }]),
      __ullim.folderName([{ key: 'content://com.android.providers.media.documents/document/audio%3A1234' }]),
      __ullim.folderName([{ key: 'C:\\\\a.mp3' }]),
      __ullim.folderName([{ key: '/home/u/Music/A/x.mp3' }, { key: '/home/u/Video/y.mp3' }]),
      __ullim.josa('출퇴근', '으로', '로'), __ullim.josa('드라이브', '으로', '로'), __ullim.josa('서울', '으로', '로'), __ullim.josa('Mix 3', '으로', '로'), __ullim.josa('Chill', '으로', '로'),
      __ullim.suggestName([{ album: 'X', artist: 'A' }, { album: 'X', artist: 'B' }]), __ullim.suggestName([{ album: 'X', artist: 'A' }, { album: 'Y', artist: 'A' }]),
      __ullim.suggestName([{ album: 'X', artist: 'A' }]), __ullim.suggestName([{ album: 'X' }, { album: 'Y' }], '발라드'),
    ]""")
    assert R['9_names'] == ['여름', '가을', '새 플레이리스트', '새 플레이리스트', 'u', '으로', '로', '로', '으로', '(으)로', 'X', 'A', '새 플레이리스트', '발라드'], R['9_names']

    # 10) 휴대폰: 길게 누르면 고르기 시작 (진동), 한 번 더 길게 누르면 그 곡도. 막대 · 가상 목록 · 모든 곡에서 고르기 모양
    pg.set_viewport_size({'width': 390, 'height': 844}); pg.wait_for_timeout(500)
    openpl_m = lambda: (ev("__ullim.showPlaylist(__ullim.pls[0])"), pg.wait_for_timeout(300))
    openpl_m()
    # 길게 누르기: 손가락 누름 → contextmenu(touch) → (기기에 따라) 뗄 때 클릭 — 뒤따르는 클릭이 방금 고른 곡을 풀면 안 됨
    longpress = lambda i: ev(f"""(() => {{ const n = document.querySelector('{row(i)}'), r = n.getBoundingClientRect(), o = {{ bubbles: true, cancelable: true, pointerType: 'touch', clientX: r.left + 80, clientY: r.top + 20 }};
        n.dispatchEvent(new PointerEvent('pointerdown', o)); n.dispatchEvent(new PointerEvent('contextmenu', o));
        document.querySelector('{row(i)}').dispatchEvent(new MouseEvent('click', o)); }})()""")      # 줄은 다시 그려졌으니 새 줄에
    hidden_before = ev(f"document.querySelector('{row(1)}').getBoundingClientRect().bottom") > 560     # 막대가 나타나면 가려질 자리
    longpress(1); pg.wait_for_timeout(600)
    s10 = S(); assert s10['edit'] and s10['sel'] == 1 and ev('__haptic') == 1 and not ev("!!document.querySelector('.menu')"), s10
    gap = ev(f"document.getElementById('editBar').getBoundingClientRect().top - document.querySelector('{row(1)}').getBoundingClientRect().bottom")
    assert hidden_before and gap >= 0, (hidden_before, gap)                       # 길게 누른 곡이 막대 위로 올라옴
    longpress(2); pg.wait_for_timeout(150)
    assert S()['sel'] == 2 and ev('__haptic') == 2
    pg.screenshot(path='/home/claude/ullim/test/shots/multiselect-mobile.png')
    R['10_bar_btns'] = pg.eval_on_selector_all('#editBar .ea .btn', 'e => e.map(x => x.textContent)')
    assert R['10_bar_btns'] == ['새 플레이리스트로새 목록', '플레이리스트에 넣기넣기', '플레이리스트로 이동이동', '빼기빼기'], R['10_bar_btns']
    # 막대가 미니 플레이어 · 아래 메뉴를 가리지 않음, 버튼 네 개가 한 줄
    box = ev("""(() => { const e = document.getElementById('editBar').getBoundingClientRect(), p = document.getElementById('pbar').getBoundingClientRect();
        const bs = [...document.querySelectorAll('#editBar .ea .btn')].map(b => b.getBoundingClientRect());
        return { gap: p.top - e.bottom, oneRow: new Set(bs.map(b => Math.round(b.top))).size === 1, inside: bs.every(b => b.left >= e.left && b.right <= e.right) }; })()""")
    assert box['gap'] >= 4 and box['oneRow'] and box['inside'], box
    bar('완료'); pg.wait_for_timeout(100)
    ev("__ullim.pickInto(__ullim.pls[__ullim.pls.length - 1])"); pg.wait_for_timeout(300)
    pg.click(row(0)); pg.wait_for_timeout(100)
    pg.screenshot(path='/home/claude/ullim/test/shots/multiselect-mobile-pick.png')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(250)
    ev("__ullim.showPlaylist(__ullim.genrePl ? __ullim.allSongsPl() : null)"); pg.wait_for_timeout(250)
    longpress(0); pg.wait_for_timeout(150)
    R['10_virtual_btns'] = pg.eval_on_selector_all('#editBar .ea .btn', 'e => e.map(x => x.textContent)')
    assert len(R['10_virtual_btns']) == 2, R['10_virtual_btns']
    pg.screenshot(path='/home/claude/ullim/test/shots/multiselect-mobile-all.png')
    # 안드로이드 뒤로 가기: 고르기부터 끝냄
    assert ev('window.__ullimBack()') is True and not S()['edit']

    # 11) 다시 열어도 그대로 (이동 · 새로 만든 목록이 저장됨)
    before = S()['pls']
    pg.reload(); pg.wait_for_function('window.__ullim && window.__readyCalled'); pg.wait_for_timeout(800)
    assert S()['pls'] == before, (S()['pls'], before)
    R['errors'] = errs
    b.close()

print(json.dumps(R, ensure_ascii=False, indent=1)[:4000])
assert not errs, errs
print('multiselect ok')
