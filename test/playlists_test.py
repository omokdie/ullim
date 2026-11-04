"""플레이리스트 여러 개 만들기 · 관리 시험 — 가짜 안드로이드 연결층(저장됨 · 파일 권한 돌려주기)으로.

  python3 test/server.py /home/claude/ullim 8766 &
  python3 test/playlists_test.py
"""
import json
from playwright.sync_api import sync_playwright

M = '/home/claude/ullim/test/media/'
FILES = ['song_cbr_v23.mp3', 'song.flac', 'song.m4a', 'song_euckr.mp3', 'song_vbr_v24.mp3']
OLD = [{'k': M + f, 'n': f} for f in FILES]          # 1.0.x 형식: 재생목록 하나
INIT = """
if (!sessionStorage.getItem('seeded')) {
  sessionStorage.setItem('seeded', '1');
  localStorage.clear();
  localStorage.setItem('ullim.playlist.v1', JSON.stringify(%s));
}
window.__released = [];
window.UllimAndroid = {
  call(method, args, id) { setTimeout(() => window.__ullimResolve(id, null, 'not in test'), 10); },
  nowPlaying() {}, setSystemBars() {}, ready() { window.__readyCalled = true; }, exitApp() {},
  release(json) { window.__released.push(...JSON.parse(json)); },
};
""" % json.dumps(OLD)

R = {}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}, bypass_csp=True)
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(f'PAGEERROR: {e}'))
    pg.goto('http://127.0.0.1:8766/web/index.html')
    pg.wait_for_function('window.__ullim && window.__readyCalled')
    pg.wait_for_timeout(800)
    S = lambda: pg.evaluate("""() => { const U = __ullim; return {
        pls: U.pls.map(p => `${p.name}:${p.tracks.length}`), shown: U.shown.name, playing: U.playPl.name, idx: U.P.index,
        cur: U.list[U.P.index] ? U.list[U.P.index].name : null, same: U.list === U.playPl.tracks,
        view: __ullim.NAV.view, head: (document.querySelector('#plHero .hname') || {}).textContent || '', now: document.getElementById('plNow').hidden ? '' : document.getElementById('plNow').textContent,
        rows: [...document.querySelectorAll('#spacer .row')].map(r => (r.classList.contains('cur') ? '*' : '') + r.querySelector('.t1').textContent) }; }""")
    menu = lambda text: pg.click(f'.menu button:has-text("{text}")')
    # 왼쪽 메뉴의 플레이리스트 (이름이 정확히 같은 것)
    openpl = lambda name: (pg.click(f'.spl:has(.nm:text-is("{name}"))'), pg.wait_for_timeout(250))

    # 0) 처음에는 홈: 플레이리스트 타일 · 왼쪽 목록
    R['0_home'] = pg.evaluate("({view: __ullim.NAV.view, tiles: [...document.querySelectorAll('#viewHome .ptile .nm')].map(e => e.textContent), side: [...document.querySelectorAll('.spl .nm')].map(e => e.textContent)})")
    assert R['0_home'] == {'view': 'home', 'tiles': ['재생목록', '새 플레이리스트'], 'side': ['재생목록']}, R['0_home']
    pg.click('#viewHome .ptile[data-pl]'); pg.wait_for_timeout(300)

    # 1) 1.0.x 재생목록 → '재생목록' 플레이리스트로 옮겨짐
    R['1_migrated'] = S()
    assert R['1_migrated']['pls'] == ['재생목록:5'] and R['1_migrated']['head'] == '재생목록', R['1_migrated']

    # 2) 곡 재생 → 새 플레이리스트 만들기 (위 이름 단추 메뉴)
    pg.click('#spacer .row[data-i="0"]'); pg.wait_for_timeout(700)
    pg.click('#sideNew')
    pg.fill('.dialog input', '출퇴근'); pg.click('.dialog .primary'); pg.wait_for_timeout(300)
    R['2_created'] = {**S(), 'empty': pg.text_content('#empty')}
    s2 = R['2_created']
    assert s2['shown'] == '출퇴근' and s2['playing'] == '재생목록' and '출퇴근' in s2['empty'] and "'재생목록'에서 재생 중" in s2['now'], s2

    # 3) '그 목록 보기' → 재생 중인 목록으로
    pg.click('#plNow .link'); pg.wait_for_timeout(200)
    assert S()['shown'] == '재생목록' and S()['rows'][0].startswith('*'), S()

    # 4) 곡 메뉴(⋯) → 다른 플레이리스트에 넣기
    pg.hover('#spacer .row[data-i="1"]'); pg.click('#spacer .row[data-i="1"] .x')
    menu('다른 플레이리스트에 넣기'); menu('출퇴근'); pg.wait_for_timeout(200)
    R['4_added_one'] = S()['pls']
    assert R['4_added_one'] == ['재생목록:5', '출퇴근:1'], R['4_added_one']

    # 5) 편집: 여러 곡 골라 넣기 (이미 있는 곡은 건너뜀)
    pg.click('#plMenu'); menu('편집')
    for i in (1, 2, 3): pg.click(f'#spacer .row[data-i="{i}"]')
    R['5_editbar'] = pg.text_content('#editBar')
    pg.click('#editBar button:has-text("플레이리스트에 넣기")'); menu('출퇴근'); pg.wait_for_timeout(200)
    R['5_toast'] = pg.text_content('#toast')
    assert '3곡 선택' in R['5_editbar'] and S()['pls'] == ['재생목록:5', '출퇴근:3'] and "2곡" in R['5_toast'], (R['5_editbar'], S(), R['5_toast'])

    # 6) 끌어서 순서 바꾸기: 재생 중인 0번 곡을 3번 자리로 → 재생 위치가 따라감
    playing_key = pg.evaluate('__ullim.list[__ullim.P.index].key')
    g = pg.locator('#spacer .row[data-i="0"] .grip').bounding_box()
    t = pg.locator('#spacer .row[data-i="3"]').bounding_box()
    pg.mouse.move(g['x'] + g['width'] / 2, g['y'] + g['height'] / 2); pg.mouse.down()
    for k in range(1, 11): pg.mouse.move(g['x'] + g['width'] / 2, g['y'] + g['height'] / 2 + (t['y'] + t['height'] / 2 - g['y'] - g['height'] / 2) * k / 10); pg.wait_for_timeout(30)
    pg.wait_for_timeout(150); pg.mouse.up(); pg.wait_for_timeout(300)
    R['6_dragged'] = {**S(), 'order': pg.evaluate('__ullim.shown.tracks.map(t => t.name)')}
    assert R['6_dragged']['idx'] == 3 and pg.evaluate('__ullim.list[__ullim.P.index].key') == playing_key and R['6_dragged']['order'][3] == FILES[0], R['6_dragged']
    pg.click('#editBar button:has-text("완료")'); pg.wait_for_timeout(100)
    assert pg.evaluate("document.getElementById('editBar').hidden")

    # 7) 다른 목록을 보다가 거기서 곡을 누르면 재생 목록이 그쪽으로 바뀜
    openpl('출퇴근')
    assert all(not r.startswith('*') for r in S()['rows']), S()
    pg.click('#spacer .row[data-i="0"]'); pg.wait_for_timeout(700)
    R['7_switched'] = S()
    assert R['7_switched']['playing'] == '출퇴근' and R['7_switched']['same'] and R['7_switched']['rows'][0].startswith('*') and R['7_switched']['now'] == '', R['7_switched']

    # 8) 안드로이드 파일 권한: 다른 목록에도 있는 곡은 빼도 권한을 돌려주지 않음
    pg.click('#plMenu'); menu('편집'); pg.click('#editBar button:has-text("모두 선택")'); pg.click('#editBar button:has-text("빼기")'); pg.wait_for_timeout(500)
    R['8_removed_all'] = {**S(), 'released': pg.evaluate('__released.slice()')}
    assert R['8_removed_all']['pls'] == ['재생목록:5', '출퇴근:0'] and R['8_removed_all']['released'] == [] and R['8_removed_all']['idx'] == -1, R['8_removed_all']
    openpl('재생목록')
    pg.hover('#spacer .row[data-i="4"]'); pg.click('#spacer .row[data-i="4"] .x'); menu('이 목록에서 빼기'); pg.wait_for_timeout(200)
    R['8_released_only_here'] = pg.evaluate('__released.slice()')
    assert len(R['8_released_only_here']) == 1 and R['8_released_only_here'][0].endswith(FILES[4]), R['8_released_only_here']

    # 9) 이름 바꾸기 · 복사
    openpl('출퇴근')
    pg.click('#plMenu'); menu('이름 바꾸기'); pg.fill('.dialog input', '출근길'); pg.click('.dialog .primary'); pg.wait_for_timeout(200)
    assert pg.text_content('#plHero .hname') == '출근길' and pg.text_content('#tbTitle') == '출근길'
    openpl('재생목록')
    pg.click('#plMenu'); menu('복사해서 새 플레이리스트로'); pg.wait_for_timeout(200)
    R['9_renamed_copied'] = S()
    assert R['9_renamed_copied']['pls'] == ['재생목록:4', '재생목록 복사본:4', '출근길:0'] and R['9_renamed_copied']['shown'] == '재생목록 복사본', R['9_renamed_copied']

    # 10) 관리 창: 위로 옮기기 · 지우기
    pg.click('#plMenu'); menu('플레이리스트 관리'); pg.wait_for_timeout(200)
    R['10_rows'] = pg.eval_on_selector_all('.plrow .nm', 'e => e.map(x => x.textContent)')
    pg.click('.plrow:nth-child(3) button[title="위로"]'); pg.wait_for_timeout(100)
    R['10_after_up'] = pg.eval_on_selector_all('.plrow .nm', 'e => e.map(x => x.textContent)')
    pg.click('.plrow:has-text("재생목록 복사본") button[title="지우기"]'); pg.click('.dialog .primary:has-text("지우기")'); pg.wait_for_timeout(200)
    R['10_after_delete'] = pg.eval_on_selector_all('.plrow .nm', 'e => e.map(x => x.textContent)')
    pg.screenshot(path='/home/claude/ullim/test/shots/playlists-manage.png')
    pg.click('.plmgr .primary:has-text("닫기")'); pg.wait_for_timeout(100)
    assert R['10_after_up'] == ['재생목록', '출근길', '재생목록 복사본'] and R['10_after_delete'] == ['재생목록', '출근길'], R
    assert pg.evaluate('__released.length') == 1          # 복사본 곡은 원래 목록에도 있으니 권한 유지

    # 11) 다시 열어도 그대로 (이름 · 순서 · 곡 · 보던 목록 · 재생하던 목록)
    openpl('재생목록')
    pg.click('#spacer .row[data-i="1"]'); pg.wait_for_timeout(600)
    openpl('출근길'); pg.wait_for_timeout(100)
    before = S()
    pg.reload(); pg.wait_for_function('window.__ullim && window.__readyCalled'); pg.wait_for_timeout(800)
    assert pg.evaluate('__ullim.NAV.view') == 'home'
    pg.evaluate("__ullim.setTab('list')"); pg.wait_for_timeout(300)        # 마지막으로 보던 목록
    R['11_reloaded'] = {'before': before, 'after': S()}
    a = R['11_reloaded']['after']
    assert a['pls'] == before['pls'] and a['shown'] == '출근길' and a['playing'] == '재생목록' and a['cur'] == before['cur'] and "'재생목록'에서 재생 중" in a['now'], R['11_reloaded']
    assert pg.evaluate("JSON.parse(localStorage.getItem('ullim.playlists.v2')).v") == 2

    # 12) 재생 중인 플레이리스트를 지우면 멈추고 다른 목록으로
    openpl('재생목록')
    pg.click('#plMenu'); menu('이 플레이리스트 삭제'); pg.click('.dialog .primary'); pg.wait_for_timeout(300)
    assert pg.evaluate('__ullim.NAV.view') == 'home'                       # 보던 목록을 지우면 홈으로
    openpl('출근길')
    R['12_deleted_playing'] = {**S(), 'released': pg.evaluate('__released.length')}
    d = R['12_deleted_playing']
    assert d['pls'] == ['출근길:0'] and d['idx'] == -1 and d['playing'] == '출근길' and d['shown'] == '출근길' and d['released'] == 4 and d['rows'] == [], d   # 다시 열어서 셈이 새로 시작됨: 지운 목록의 4곡
    # 마지막 하나는 지울 수 없음
    pg.click('#plMenu')
    R['12_menu_last'] = pg.eval_on_selector_all('.menu button', 'e => e.map(x => x.textContent)')
    assert not any('삭제' in x for x in R['12_menu_last']), R['12_menu_last']
    pg.keyboard.press('Escape'); pg.wait_for_timeout(100)

    # 13) M3U 만들기
    pg.evaluate(f"__ullim.addItems({json.dumps([{'key': M + f, 'name': f} for f in FILES[:2]])})"); pg.wait_for_timeout(1200)
    R['13_m3u'] = pg.evaluate('__ullim.toM3U(__ullim.shown)')
    lines = R['13_m3u'].split('\r\n')
    assert lines[0] == '#EXTM3U' and lines[1] == '#PLAYLIST:출근길' and lines[2].startswith('#EXTINF:24,') and lines[3] == M + FILES[0], lines

    # 14) 휴대폰 화면: 이름 단추 · 편집 막대
    pg.set_viewport_size({'width': 390, 'height': 844}); pg.wait_for_timeout(500)   # 화면 크기가 바뀐 뒤 자리 잡을 때까지
    pg.evaluate("__ullim.setTab('list')"); pg.wait_for_timeout(300)
    pg.click('#plMenu')
    menu('편집'); pg.click('#spacer .row[data-i="0"]'); pg.wait_for_timeout(200)
    pg.screenshot(path='/home/claude/ullim/test/shots/playlists-mobile-edit.png')
    pg.click('#editBar button:has-text("완료")')
    pg.click('#btnBack'); pg.wait_for_timeout(300)
    R['14_back_home'] = pg.evaluate('__ullim.NAV.view')
    assert R['14_back_home'] == 'home'
    pg.screenshot(path='/home/claude/ullim/test/shots/playlists-mobile-home.png')
    R['errors'] = errs
    b.close()

print(json.dumps(R, ensure_ascii=False, indent=1)[:3000])
assert not errs, errs
print('playlists ok')
