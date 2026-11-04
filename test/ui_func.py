import json, time
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8766/web/index.html'
M = '/home/claude/ullim/test/media/'
FILES = ['song_cbr_v23.mp3', 'song.flac', 'song.m4a', 'song_euckr.mp3', 'song_vbr_v24.mp3', 'song.opus', 'song.wav']
items = [{'key': '/media?p=' + M + f, 'name': f} for f in FILES]
items.insert(2, {'key': '/media?p=' + M + 'missing.mp3', 'name': 'missing.mp3'})

R = {}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
    pg.goto(BASE)
    pg.wait_for_function('window.__ullim && window.__ullim.engine')
    pg.evaluate(f'__ullim.addItems({json.dumps(items)}, {{play:true}})')
    time.sleep(1.5)
    cur = lambda: pg.evaluate('({i: __ullim.P.index, t: +__ullim.engine.deck.a.currentTime.toFixed(2), paused: __ullim.engine.deck.a.paused, title: document.getElementById("title").textContent})')
    R['start'] = cur()
    pg.click('#btnNext'); time.sleep(1.0); R['next1'] = cur()
    # next goes to the missing file -> should auto skip to the following
    pg.click('#btnNext'); time.sleep(2.5); R['skip_missing'] = cur()
    R['bad_marked'] = pg.evaluate('__ullim.list.filter(t => t.bad).map(t => t.name)')
    pg.click('#btnPrev'); time.sleep(1.0); R['prev_restart_or_back'] = cur()
    # seek near the end, check auto-advance
    pg.evaluate('__ullim.engine.deck.a.currentTime = 22.5'); time.sleep(3.0); R['auto_advance'] = cur()
    # crossfade 3s: seek to 24-5 and observe overlapping decks
    pg.evaluate("__ullim.S.crossfade = 3"); pg.evaluate('__ullim.engine.deck.a.currentTime = 19.5'); time.sleep(1.4)
    R['xf_mid'] = pg.evaluate('({xf: !!__ullim.P.xf, started: __ullim.P.xf && __ullim.P.xf.started, i: __ullim.P.index, d0: !__ullim.engine.decks[0].a.paused, d1: !__ullim.engine.decks[1].a.paused, g0: +__ullim.engine.decks[0].g.gain.value.toFixed(2), g1: +__ullim.engine.decks[1].g.gain.value.toFixed(2)})')
    time.sleep(3.5)
    R['xf_end'] = pg.evaluate('({xf: !!__ullim.P.xf, i: __ullim.P.index, d0: !__ullim.engine.decks[0].a.paused, d1: !__ullim.engine.decks[1].a.paused, g0: __ullim.engine.decks[0].g.gain.value, g1: __ullim.engine.decks[1].g.gain.value, title: document.getElementById("title").textContent})')
    pg.evaluate("__ullim.S.crossfade = 0")
    # repeat one
    pg.evaluate("__ullim.S.repeat = 'one'"); i0 = cur()['i']; pg.evaluate('__ullim.engine.deck.a.currentTime = 22.8'); time.sleep(2.5)
    R['repeat_one'] = {'before': i0, 'after': cur()}
    pg.evaluate("__ullim.S.repeat = 'all'")
    # pause / play via space key
    pg.keyboard.press('Space'); time.sleep(0.3); R['space_pause'] = cur()['paused']
    pg.keyboard.press('Space'); time.sleep(0.5); R['space_play'] = cur()['paused']
    # speed effect
    pg.evaluate("__ullim.engine.setParam('speed','rate',150); __ullim.engine.setEnabled('speed', true)"); time.sleep(0.3)
    R['speed'] = pg.evaluate('({rate: __ullim.engine.deck.a.playbackRate, keep: __ullim.engine.deck.a.preservesPitch})')
    pg.evaluate("__ullim.engine.setEnabled('speed', false)")
    # enable ALL effects at once (stress)
    t_before = cur()['t']
    pg.evaluate("""(async () => { const E = __ullim.engine; const ids = Object.keys(E.state).filter(k => k !== 'speed');
      for (const id of ids) E.state[id].on = true; await E.rebuild(); })()""")
    time.sleep(2.0)
    R['all_fx_chain_len'] = pg.evaluate('__ullim.engine._chain.split(">").length')
    R['all_fx_playing'] = {'t_before': t_before, 'now': cur()}
    # analyser shows signal
    R['analyser_energy'] = pg.evaluate('(() => { const a = __ullim.engine.analyser, b = new Uint8Array(a.frequencyBinCount); a.getByteFrequencyData(b); return b.reduce((s, v) => s + v, 0); })()')
    pg.evaluate("__ullim.applySoundPreset({id:'off', name:'원음', fx:{}, eqOff:true})"); time.sleep(0.5)
    R['after_off_chain'] = pg.evaluate('__ullim.engine._chain')
    # remove current track while playing
    n_before = pg.evaluate('__ullim.list.length'); idx = cur()['i']
    pg.hover(f'.row[data-i="{idx}"]'); pg.click(f'.row[data-i="{idx}"] .x'); pg.click('.menu button:has-text("이 목록에서 빼기")'); time.sleep(1.0)
    R['remove_current'] = {'n_before': n_before, 'n_after': pg.evaluate('__ullim.list.length'), 'now': cur()}
    # sort by title
    pg.click('#btnListMenu'); pg.click('.menu button:has-text("정렬…")'); pg.click('.menu button:has-text("제목 순")'); time.sleep(0.3)
    R['sorted_titles'] = pg.evaluate('__ullim.list.map(t => t.title || t.name)')
    R['cur_after_sort'] = cur()
    # save user preset through the dialog
    pg.evaluate("__ullim.setTab('fx')")
    pg.click('.chip.add'); pg.fill('.dialog input', '테스트 프리셋'); pg.click('.dialog .primary'); time.sleep(0.3)
    R['user_presets'] = pg.evaluate("JSON.parse(localStorage.getItem('ullim.userpresets.v1')).map(p => p.name)")
    # search
    pg.click('#btnSearch'); pg.fill('#searchInput', '노래'); time.sleep(0.4)
    R['search_rows'] = pg.evaluate("[...document.querySelectorAll('.row .t1')].map(e => e.textContent)")
    # reload -> resume
    pg.evaluate('__ullim.engine.deck.a.currentTime = 10'); time.sleep(0.3)
    pg.reload(); pg.wait_for_function('window.__ullim && window.__ullim.engine'); time.sleep(1.5)
    R['after_reload'] = {'list_len': pg.evaluate('__ullim.list.length'), 'cur': cur()}
    R['logs'] = logs[:15]
    b.close()
print(json.dumps(R, ensure_ascii=False, indent=1))
