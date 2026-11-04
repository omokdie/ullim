"""안드로이드 업데이트 알림 (JS 쪽): 가짜 UllimAndroid 로 정보 파일 → 새 버전 알림 → [받기] 는 브라우저로 APK 주소 열기 · 숨기기 · 끄기 (앱이 직접 받거나 설치하지 않음)
python3 test/server.py /home/claude/ullim 8766 & 를 먼저 띄워 두세요."""
import json, time, sys
from playwright.sync_api import sync_playwright

SHA = 'ab' * 32
def manifest(ver, vc):
    return json.dumps({'version': ver, 'notes': '시험', 'android': {'url': f'https://github.com/omokdie/ullim/releases/download/v{ver}/Ullim-{ver}.apk', 'sha256': SHA, 'size': 1234567, 'versionCode': vc},
                       'windows': {'url': f'https://github.com/omokdie/ullim/releases/download/v{ver}/Ullim-Setup-{ver}.exe', 'sha256': SHA, 'size': 99, }})
INIT = """
window.__calls = []; window.__opened = []; window.__manifest = %s;
window.UllimAndroid = {
  call(method, args, id) {
    const a = JSON.parse(args || '[]');
    __calls.push([method, a]);
    setTimeout(() => {
      const ok = v => window.__ullimResolve(id, JSON.stringify(v), null), err = m => window.__ullimResolve(id, null, m);
      if (method === 'httpGet') {
        if (a[0].startsWith('https://raw.githubusercontent.com/omokdie/ullim/main/update/latest.json')) ok({ status: 200, body: window.__manifest });
        else ok({ status: 404, body: '' });
      }
      else err('not in test');
    }, 40);
  },
  versionCode() { return 5; },
  nowPlaying() {}, setSystemBars() {}, ready() { window.__readyCalled = true; }, release() {}, exitApp() {}, openUrl(u) { __opened.push(u); },
};
"""
R, fails = {}, []
def check(name, cond, info=''):
    print(('ok - ' if cond else 'FAIL: ') + name + (f'  {info}' if info else ''))
    if not cond: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, bypass_csp=True)
    ctx.add_init_script(INIT % json.dumps(manifest('1.1.1', 6)))
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8766/web/index.html')
    pg.wait_for_function('window.__ullim && window.__readyCalled')
    st = lambda: pg.evaluate("({s: __ullim.UPD.state, v: __ullim.UPD.version, bar: !document.getElementById('updBar').hidden, text: document.getElementById('updBar').textContent, btn: (document.querySelector('#updBar .btn') || {}).disabled, toast: document.getElementById('toast').textContent})")

    pg.evaluate('__ullim.checkUpdate({ manual: true })'); time.sleep(0.5)
    s = st()
    check('new version → available banner with 받기 (no in-app download)', s['s'] == 'available' and s['v'] == '1.1.1' and s['bar'] and '받기' in s['text'], s)
    calls = [c[0] for c in pg.evaluate('__calls')]
    check('no download/install bridge calls', not any(c.startswith('update') for c in calls), calls)
    pg.click('#updBar .btn.primary'); time.sleep(0.3)
    check('받기 opens the APK release URL in the browser', pg.evaluate('__opened') == ['https://github.com/omokdie/ullim/releases/download/v1.1.1/Ullim-1.1.1.apk'], pg.evaluate('__opened'))
    check('toast explains how to install', '받은 파일을 눌러 설치' in st()['toast'], st()['toast'])
    pg.click('#updBar .ib'); time.sleep(0.2)
    check('X hides the banner for this version', not st()['bar'] and pg.evaluate('__ullim.S.updHidden') == '1.1.1', st())
    pg.evaluate("__ullim.UPD.state = 'idle'"); pg.evaluate('__ullim.checkUpdate()'); time.sleep(0.4)
    check('automatic check keeps it hidden', not st()['bar'], st())
    pg.evaluate("__ullim.UPD.state = 'idle'"); pg.evaluate('__ullim.checkUpdate({ manual: true })'); time.sleep(0.4)
    check('manual check shows it again', st()['bar'] and pg.evaluate('__ullim.S.updHidden') is None, st())
    r = pg.evaluate('window.__ullimBack()')
    check('back does not try to install', r is False and not any(c[0].startswith('update') for c in pg.evaluate('__calls')))

    # 같은 버전 번호면 최신
    pg.evaluate("window.__manifest = %s; __ullim.UPD.state = 'idle'" % json.dumps(manifest('1.1.0', 5)))
    pg.evaluate('__ullim.checkUpdate({ manual: true })'); time.sleep(0.4)
    s = st()
    check('same versionCode → latest', s['s'] == 'latest' and not s['bar'], s)

    # 설정에서 자동 업데이트 끄기 → 받아 둔 파일 지우기
    pg.evaluate("window.__manifest = %s; __ullim.UPD.state = 'idle'" % json.dumps(manifest('1.1.1', 6)))
    pg.evaluate('__ullim.checkUpdate({ manual: true })'); time.sleep(0.4)
    pg.evaluate("__ullim.setTab('set')"); time.sleep(0.3)
    grp = pg.evaluate("[...document.querySelectorAll('#paneSet .sgroup h3')].map(h => h.textContent)")
    check('settings has 업데이트 group', '업데이트' in grp, grp)
    hint = pg.evaluate("document.getElementById('updCheckBtn').closest('.srow').querySelector('small').textContent")
    check('settings hint shows new version', '1.1.1' in hint and '받기' in hint, hint)
    pg.click('button.sw[aria-label="자동 업데이트"]'); time.sleep(0.4)
    s = st()
    check('switch off → idle + no banner', s['s'] == 'idle' and not s['bar'], s)
    pg.screenshot(path='/tmp/upd_settings.png')
    check('no page errors', not errs, errs)
    b.close()
sys.exit(1 if fails else 0)
