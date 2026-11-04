// 메모리 측정 (개발자 도구를 붙이지 않은 실제 상태) — Electron 메인 프로세스 안에서 앱을 띄우고 장면마다 /proc 로 잼
//   xvfb-run -a <electron> test/mem_driver.js <앱 폴더> [라이브러리=/tmp/memlib] [--quick] [-- 추가 크로미움 스위치…]
//   Playwright 로 띄우면 개발자 도구(Network)가 받은 내용을 렌더러에 쌓아 두어 실제보다 훨씬 크게 나오므로 이 방법으로 잰다.
//   USS = 그 프로세스만 쓰는 메모리 (윈도우 작업 관리자의 '메모리'와 가장 비슷). 결과는 MEM_JSON 파일로도 저장.
'use strict';
const path = require('path');
const fs = require('fs');
const argv = process.argv.slice(process.argv.findIndex(a => a.endsWith('mem_driver.js')) + 1);
const dd = argv.indexOf('--');
const pos = (dd >= 0 ? argv.slice(0, dd) : argv).filter(a => !a.startsWith('--'));
const APP = path.resolve(pos[0] || 'build/desktop-app');
const LIB = pos[1] || '/tmp/memlib';
const QUICK = argv.includes('--quick');
const GCX = argv.includes('--gc');
const DUMP = argv.includes('--dump');        // 장면마다 크로미움 메모리 덤프(할당자별)를 /tmp/mem/pd_<번호>.pftrace 로 (test 밖 pb_dump.py 로 읽음)          // 장면마다 강제 GC 뒤 값도 (= 쓰레기를 빼면 실제로 붙잡고 있는 양)
const { app, BrowserWindow, contentTracing } = require('electron');
if (GCX) app.commandLine.appendSwitch('js-flags', '--expose-gc');
if (dd >= 0) for (const sw of argv.slice(dd + 1)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(sw); if (m) app.commandLine.appendSwitch(m[1], m[2] || ''); }
require(path.join(APP, 'main.js'));

function tree(root) {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const pp = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]; if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(+d); } catch (e) { /* gone */ }
  }
  const out = [], q = [root];
  while (q.length) { const p = q.shift(); out.push(p); for (const c of kids.get(p) || []) q.push(c); }
  return out;
}
function mem(pid) {
  try {
    const t = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const g = k => +((new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(t) || [0, 0])[1]);
    return { uss: g('Private_Clean') + g('Private_Dirty'), pss: g('Pss') };
  } catch (e) { return null; }
}
function kind(pid) {
  try {
    const c = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/\0| /);
    const t = (c.find(a => a.startsWith('--type=')) || '--type=browser').slice(7);
    const u = c.find(a => a.startsWith('--utility-sub-type='));
    return t === 'utility' && u ? u.slice(19).split('.').pop() : t;
  } catch (e) { return null; }
}
const MB = kb => +(kb / 1024).toFixed(1);
function snapshot() {
  const by = {}; let uss = 0, pss = 0, n = 0;
  for (const pid of tree(process.pid)) {
    const k = kind(pid), m = k && mem(pid);
    if (!m) continue;
    n++; uss += m.uss; pss += m.pss;
    const b = by[k] || (by[k] = { n: 0, uss: 0 }); b.n++; b.uss += m.uss;
  }
  return { uss: MB(uss), pss: MB(pss), n, by: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, MB(v.uss)])) };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R = {};
function log(label, s) {
  R[label] = s;
  const by = Object.entries(s.by).filter(([, v]) => v >= 1).map(([k, v]) => `${k.replace('-process', '')}=${v}`).join(' ');
  console.log(`${label.padEnd(20)} USS ${String(s.uss).padStart(6)} MB (${s.n})  ${by}${s.peak ? '  [최고]' : ''}${s.note ? '  ' + s.note : ''}`);
}

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; if (!win) await sleep(100); }
  const wc = win.webContents;
  const js = code => wc.executeJavaScript(code, true);
  for (let i = 0; i < 200; i++) { if (await js('!!(window.__ullim && window.__ullim.engine)').catch(() => false)) break; await sleep(100); }
  const shot = async (label, wait) => {
    if (wait) await sleep(wait);
    const s = snapshot();
    if (GCX) { await js('gc(), gc(), 0'); await sleep(1200); const g = snapshot(); s.note = `GC 뒤 ${g.uss} MB (렌더러 ${g.by.renderer})`; s.afterGC = g; }
    if (process.env.SHOT) { try { const img = await wc.capturePage(); fs.writeFileSync(`/tmp/mem/shot_${label.split(' ')[0]}.png`, img.toPNG()); } catch (e) { /* noop */ } }
    if (process.env.PRESSURE) {                     // 실험: 메모리 압박 알림(개발자 도구 없이 debugger 로)으로 캐시를 비우면
      try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Memory.simulatePressureNotification', { level: process.env.PRESSURE }); } catch (e) { s.note = (s.note || '') + ' pressure err ' + e.message; }
      await sleep(2500); const g = snapshot(); s.note = (s.note || '') + `  압박 뒤 ${g.uss} MB (렌더러 ${g.by.renderer}, gpu ${g.by['gpu-process']}, browser ${g.by.browser})`;
    }
    log(label, s);
    if (DUMP) {
      await contentTracing.startRecording({ included_categories: ['disabled-by-default-memory-infra'], excluded_categories: ['*'], memory_dump_config: { triggers: [{ mode: 'detailed', periodic_interval_ms: 1000 }] } });
      await sleep(2300);
      await contentTracing.stopRecording(`/tmp/mem/pd_${label.split(' ')[0]}.pftrace`);
    }
  };
  const peak = async (label, code) => {
    let best = null, run = true;
    const loop = (async () => { while (run) { const s = snapshot(); if (!best || s.uss > best.uss) best = s; await sleep(120); } })();
    let res; try { res = await js(code); } finally { run = false; await loop; }
    log(label, { ...best, peak: true, note: res ? JSON.stringify(res).slice(0, 120) : '' });
  };
  const errs = [];
  wc.on('console-message', (...a) => { const e = a[0] && a[0].level !== undefined ? a[0] : { level: a[1], message: a[2] }; if ((e.level === 'error' || e.level === 3) && !/net::|ERR_|Failed to load/.test(e.message)) errs.push(String(e.message).slice(0, 200)); });

  if (process.env.GLASS) { await js(`__ullim.S.glass = ${JSON.stringify(process.env.GLASS)}; __ullim.setGlassMode && __ullim.setGlassMode(); 0`); }
  await shot('1 시작', 6000);
  const longs = fs.readdirSync(path.join(LIB, 'long')).sort().map(f => path.join(LIB, 'long', f));
  const shorts = fs.readdirSync(path.join(LIB, 'short')).sort().map(f => path.join(LIB, 'short', f));
  const items = [...longs, ...shorts].map(p => ({ key: p, name: path.basename(p) }));
  await js(`__ullim.addItems(${JSON.stringify(items)}, { play: false }); 0`);
  await shot('2 곡 322개 추가', QUICK ? 15000 : 25000);
  await js(`__ullim.go('home'); 0`);
  await shot('3 홈', 5000);
  await js(`__ullim.playIndex(2); 0`);
  await shot('4 재생 (MP3)', 8000);
  await js(`__ullim.openPlayer(); 0`);
  await shot('5 재생 화면', 5000);
  await js(`__ullim.closePlayer(); 0`);
  for (const [i, label] of (QUICK ? [[2, 'MP3']] : [[2, 'MP3'], [8, 'FLAC'], [12, 'M4A'], [16, 'OGG'], [20, 'WAV']])) {
    await peak(`6 자동 맞춤 ${label}`, `(async () => {
      const m = await import('./js/autosync.js');
      const t = __ullim.list[${i}], t0 = performance.now();
      const lines = Array.from({ length: 36 }, (_, k) => (k % 9 === 8 ? '' : '가사 줄 ' + k + ' 오늘도 노래를 불러요 라라라'));
      const r = await m.autoSync({ key: 'probe|' + t.key + '|' + Date.now(), url: 'app://ullim/media?p=' + encodeURIComponent(t.key), lines, duration: t.duration || 240 });
      return { m: r.method, ms: Math.round(performance.now() - t0), c: +(r.confidence || 0).toFixed(2), t1: r.times.find(x => x != null) };
    })()`);
  }
  await shot('7 맞춤 뒤 5초', 5000);
  await js(`__ullim.S.crossfade = 2; 0`);
  for (let k = 0; k < (QUICK ? 6 : 14); k++) { await js(`__ullim.playIndex((__ullim.P.index + 1) % 22); 0`); await sleep(1300); }
  await shot('8 곡 여러 번 바꿈', 4000);
  if (!QUICK) {
    await js(`(async () => { const E = __ullim.engine; for (const id of Object.keys(E.state)) if (id !== 'speed') E.state[id].on = true; await E.rebuild(); return 0; })()`);
    await shot('9 효과 모두 켬', 4000);
    await js(`__ullim.applySoundPreset({ id: 'off', name: '원음', fx: {}, eqOff: true }); 0`);
    await shot('10 효과 끔', 4000);
    win.minimize();
    await shot('11 최소화 20초', 20000);
    win.restore();
    await shot('12 다시 열기', 4000);
  }
  const st = await js(`({ paused: __ullim.engine.deck.a.paused, t: +__ullim.engine.deck.a.currentTime.toFixed(1), i: __ullim.P.index })`);
  console.log('재생 상태', JSON.stringify(st), '오류', JSON.stringify(errs.slice(0, 5)));
  if (process.env.MEM_JSON) fs.writeFileSync(process.env.MEM_JSON, JSON.stringify({ R, st, errs }, null, 1));
  app.exit(0);
});
