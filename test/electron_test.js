// Electron 앱(리눅스 빌드)으로 실제 메인 프로세스 + app:// 프로토콜 + IPC 동작 확인
const { _electron: electron } = require('playwright');
const path = require('path');
(async () => {
  const exe = process.argv[2], appDir = process.argv[3];
  const media = '/home/claude/ullim/test/media';
  const app = await electron.launch({ executablePath: exe, args: [appDir, '--no-sandbox', path.join(media, 'song.flac')], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const win = await app.firstWindow();
  const logs = [];
  win.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
  win.on('pageerror', e => logs.push('PAGEERROR ' + e));
  await win.waitForFunction(() => window.__ullim && window.__ullim.engine, null, { timeout: 15000 });
  await win.waitForTimeout(2500);
  const r = {};
  r.url = win.url();
  r.native = await win.evaluate(() => !!window.ullimNative);
  r.startup = await win.evaluate(() => ({ len: __ullim.list.length, i: __ullim.P.index, playing: !__ullim.engine.deck.a.paused, t: __ullim.engine.deck.a.currentTime, src: __ullim.engine.deck.a.src.slice(0, 60), title: document.getElementById('title').textContent }));
  // expand a folder via IPC (same path as drag & drop)
  r.expand = await win.evaluate(async d => (await window.ullimNative.expandPaths([d])).map(p => p.split('/').pop()), media);
  await win.evaluate(async d => { const ps = await window.ullimNative.expandPaths([d]); __ullim.addItems(ps.map(p => ({ key: p, name: p.split('/').pop() }))); }, media);
  await win.waitForTimeout(2500);
  r.list = await win.evaluate(() => __ullim.list.map(t => `${t.title || t.name} | ${t.artist} | ${Math.round(t.duration)}`));
  // seeking through range requests
  await win.evaluate(() => { __ullim.engine.deck.a.currentTime = 15; });
  await win.waitForTimeout(800);
  r.afterSeek = await win.evaluate(() => ({ t: +__ullim.engine.deck.a.currentTime.toFixed(2), paused: __ullim.engine.deck.a.paused }));
  // a preset with worklet effects
  await win.evaluate(() => __ullim.applySoundPreset({ id: 'live', name: '라이브', fx: { reverb: { room: 55, mix: 25 }, wide: { width: 140 }, exciter: { amount: 25 }, crossfeed: {} } }));
  await win.waitForTimeout(800);
  r.chain = await win.evaluate(() => __ullim.engine._chain);
  r.energy = await win.evaluate(() => { const a = __ullim.engine.analyser, b = new Uint8Array(a.frequencyBinCount); a.getByteFrequencyData(b); return b.reduce((s, v) => s + v, 0); });
  // persistence: reload and check the playlist is restored from localStorage
  await win.evaluate(() => { __ullim.engine.deck.a.currentTime = 12; });
  await win.waitForTimeout(300);
  await win.reload();
  await win.waitForFunction(() => window.__ullim && window.__ullim.engine, null, { timeout: 15000 });
  await win.waitForTimeout(1500);
  r.restored = await win.evaluate(() => ({ len: __ullim.list.length, i: __ullim.P.index, t: +__ullim.engine.deck.a.currentTime.toFixed(1), title: document.getElementById('title').textContent, chain: __ullim.engine._chain }));
  await win.screenshot({ path: '/home/claude/ullim/test/shots/electron.png' });
  r.logs = logs.slice(0, 10);
  console.log(JSON.stringify(r, null, 1));
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
