"""안드로이드 자동 업데이트 (JS 쪽): 가짜 UllimAndroid 로 정보 파일 → 받기 → [설치] → '이 출처 허용' → 설치 결과 · 뒤로 가기 때 조용히 설치 · 끄면 지우기
python3 test/server.py /home/claude/ullim 8766 & 를 먼저 띄워 두세요."""
import json, time, sys
from playwright.sync_api import sync_playwright

SHA = 'ab' * 32
def manifest(ver, vc):
    return json.dumps({'version': ver, 'notes': '시험', 'android': {'url': f'https://github.com/omokdie/ullim/releases/download/v{ver}/Ullim-{ver}.apk', 'sha256': SHA, 'size': 1234567, 'versionCode': vc},
                       'windows': {'url': f'https://github.com/omokdie/ullim/releases/download/v{ver}/Ullim-Setup-{ver}.exe', 'sha256': SHA, 'size': 99, }})
INIT = """
window.__calls = []; window.__perm = false; window.__manifest = %s;
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
      else if (method === 'updateDownload') ok({ ready: true });
      else if (method === 'updateInstall') ok(a[0] ? (__perm ? 'started' : 'skip') : (__perm ? 'started' : 'need-permission'));
      else if (method === 'updateDiscard') ok(true);
      else err('not in test');
    }, 40);
  },
  versionCode() { return 5; },
  nowPlaying() {}, setSystemBars() {}, ready() { window.__readyCalled = true; }, release() {}, exitApp() {}, openUrl() {},
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
    check('download → ready with 설치 banner', s['s'] == 'ready' and s['v'] == '1.1.1' and s['bar'] and '설치' in s['text'], s)
    dl = [c for c in pg.evaluate('__calls') if c[0] == 'updateDownload']
    check('download args (url · sha · size · version)', dl and dl[-1][1] == ['https://github.com/omokdie/ullim/releases/download/v1.1.1/Ullim-1.1.1.apk', SHA, 1234567, '1.1.1'], dl)

    pg.click('#updBar .btn.primary'); time.sleep(0.4)
    s = st()
    check('first 설치 → permission screen message', s['s'] == 'ready' and '이 출처 허용' in s['toast'], s)
    pg.evaluate('window.__perm = true; window.__ullimUpdatePermission(true)'); time.sleep(0.4)
    s = st()
    check('back from settings → install continues', s['s'] == 'installing' and s['btn'] is True and '알림' in s['text'], s)
    pg.evaluate('__ullimUpdateResult(3)'); time.sleep(0.2)
    s = st()
    check('user cancel → ready again, no error toast', s['s'] == 'ready' and '못했어요' not in s['toast'], s)
    pg.click('#updBar .btn.primary'); time.sleep(0.4)
    pg.evaluate('__ullimUpdateResult(1)'); time.sleep(0.2)
    s = st()
    check('install failure → toast', s['s'] == 'ready' and '설치하지 못했어요' in s['toast'], s)
    pg.evaluate("document.getElementById('toast').textContent = ''")
    pg.click('#updBar .btn.primary'); time.sleep(0.4)
    pg.evaluate('__ullimUpdateResult(-1)'); time.sleep(0.2)
    s = st()
    check('deferred (-1) → ready silently', s['s'] == 'ready' and s['toast'] == '', s)

    # 뒤로 가기로 나갈 때: 재생 중이 아니면 조용한 설치 시도
    n0 = len(pg.evaluate('__calls'))
    r = pg.evaluate('window.__ullimBack()'); time.sleep(0.3)
    q = [c for c in pg.evaluate('__calls')[n0:] if c[0] == 'updateInstall']
    check('back exit while idle → quiet install', r is False and q and q[0][1] == [True] and st()['s'] == 'installing', (r, q, st()['s']))
    pg.evaluate('__ullimUpdateResult(-1)'); time.sleep(0.2)
    pg.evaluate("window.__perm = false"); n0 = len(pg.evaluate('__calls'))
    pg.evaluate('window.__ullimBack()'); time.sleep(0.3)
    check("quiet install skipped without permission → stays ready", st()['s'] == 'ready', st()['s'])

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
    check('settings hint shows ready', '1.1.1' in hint and '설치' in hint, hint)
    n0 = len(pg.evaluate('__calls'))
    pg.click('button.sw[aria-label="자동 업데이트"]'); time.sleep(0.4)
    d = [c for c in pg.evaluate('__calls')[n0:] if c[0] == 'updateDiscard']
    s = st()
    check('switch off → discard + idle + no banner', d and s['s'] == 'idle' and not s['bar'], (d, s))
    pg.screenshot(path='/tmp/upd_settings.png')
    check('no page errors', not errs, errs)
    b.close()
sys.exit(1 if fails else 0)
