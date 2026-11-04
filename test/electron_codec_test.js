// Electron(리눅스 빌드)에서 코덱 엔진: app:// 로 DSF · WavPack · ALAC 재생 — node test/electron_codec_test.js <electron> build/desktop-app (먼저 test/codec_test.py 처럼 /tmp/codec 에 시험 파일)
const { _electron: electron } = require('playwright');
(async () => {
  const exe = process.argv[2], appDir = process.argv[3];
  const app = await electron.launch({ executablePath: exe, args: [appDir, '--no-sandbox'], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const win = await app.firstWindow();
  const logs = [];
  win.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
  win.on('pageerror', e => logs.push('PAGEERROR ' + e));
  await win.waitForFunction(() => window.__ullim && window.__ullim.engine, null, { timeout: 15000 });
  const files = ['/tmp/codec/a.dsf', '/tmp/codec/a.wv', '/tmp/codec/a_alac.m4a'];
  const out = [];
  for (const f of files) {
    await win.evaluate(f => window.__ullim.addItems([{ key: f, name: f.split('/').pop() }], { play: true }), f);
    await new Promise(r => setTimeout(r, 2500));
    out.push(await win.evaluate(() => { const d = window.__ullim.engine.deck; return { name: d.track && d.track.name, ct: +d.a.currentTime.toFixed(2), dur: d.a.duration, codec: !!d.codec, jspi: d.codec && d.codec.job && d.codec.job.jspi, fmt: d.fmt, err: d.a.error && d.a.error.code, sr: window.__ullim.engine.ctx.sampleRate, sink: typeof window.__ullim.engine.ctx.setSinkId }; }));
  }
  console.log(JSON.stringify(out, null, 1));
  console.log('logs', logs.filter(l => !/lrclib|ERR_|net::/.test(l)).slice(0, 8));
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
