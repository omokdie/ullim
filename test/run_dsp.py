import json, subprocess, sys, time, os
from playwright.sync_api import sync_playwright

ROOT = '/home/claude/ullim'
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '--bind', '127.0.0.1'], cwd=ROOT,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        pg = b.new_page()
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
        pg.goto('http://127.0.0.1:8765/test/dsp-test.html')
        pg.wait_for_function('window.__ready === true', timeout=20000)
        res = pg.evaluate('runTests()')
        print(json.dumps(res, ensure_ascii=False, indent=1))
        if logs:
            print('LOGS:', *logs[:30], sep='\n  ')
        b.close()
finally:
    srv.terminate()
