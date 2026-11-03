// Electron IPC: 가사 의견 POST (허용 주소만) · 공용 목록 GET 이 테스트 서버로 가는지
const { _electron: electron } = require('playwright');
const http = require('http');
(async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, ua: req.headers['user-agent'], body });
      if (req.url.startsWith('/ovr/overrides.json')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('{"version":1,"songs":{"a|b":{"pick":5}}}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"x"}');
    });
  }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const app = await electron.launch({ executablePath: process.argv[2], args: [process.argv[3], '--no-sandbox'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ULLIM_FEEDBACK_URL: base + '/feed', ULLIM_OVERRIDES_BASE: base + '/ovr/' } });
  const win = await app.firstWindow();
  await win.waitForFunction(() => window.__ullim && window.__ullim.engine, null, { timeout: 15000 });
  const r = await win.evaluate(async () => {
    const N = window.ullimNative, out = {};
    out.post = await N.httpPost('https://ntfy.sh/ullim-lyrics-259gyx3gfnw7', JSON.stringify({ v: 1, s: '시험 곡', a: '가수', c: 7, w: null, u: 'abcdef0123456789abcd', d: 100 }));
    out.postOther = await N.httpPost('https://ntfy.sh/other-topic', 'x');
    out.postBig = await N.httpPost('https://ntfy.sh/ullim-lyrics-259gyx3gfnw7', 'x'.repeat(5000));
    out.get = await N.httpGet('https://raw.githubusercontent.com/omokdie/ullim/main/lyrics/overrides.json?t=1');
    out.getOther = await N.httpGet('https://raw.githubusercontent.com/someone/else/main/x.json');
    const L = await import('./js/lyrics.js');
    localStorage.removeItem('ullim.lyrovr.v1');
    out.ovr = await L.loadOverrides(true);
    out.send = await L.sendFeedback({ title: '앱에서 보낸 곡', artist: '가수' }, 200, 3, 4, '1.0.1');
    return out;
  });
  r.server = got.map(g => ({ m: g.method, u: g.url, ua: g.ua, body: g.body.slice(0, 120) }));
  console.log(JSON.stringify(r, null, 1));
  await app.close(); srv.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
