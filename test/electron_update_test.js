// Electron 자동 업데이트: 가짜 GitHub(로컬 서버)로 정보 파일 읽기 → 받기 · SHA-256 확인 → 닫을 때 /S 설치 · '지금 다시 시작' /S /RELAUNCH
// node test/electron_update_test.js <electron> <app 폴더>
const { _electron: electron } = require('playwright');
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os');

const EXE = crypto.randomBytes(300 * 1024);
const SHA = crypto.createHash('sha256').update(EXE).digest('hex');
let manifestVersion = '9.9.9';
const hits = { manifest: 0, exe: 0 };
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/manifest/latest.json')) {
    hits.manifest++;
    const v = manifestVersion;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(JSON.stringify({
      version: v, notes: '시험',
      windows: { url: `https://github.com/omokdie/ullim/releases/download/v${v}/Ullim-Setup-${v}.exe`, sha256: SHA, size: EXE.length },
      android: { url: `https://github.com/omokdie/ullim/releases/download/v${v}/Ullim-${v}.apk`, sha256: SHA, size: EXE.length, versionCode: 99 },
    }));
    return;
  }
  const m = /^\/v(\d+\.\d+\.\d+)\/Ullim-Setup-(\d+\.\d+\.\d+)\.exe$/.exec(req.url);
  if (m) { hits.exe++; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': EXE.length }); res.end(EXE); return; }
  res.writeHead(404); res.end();
});

const userData = path.join(os.homedir(), '.config', 'Ullim');
const updDir = path.join(userData, 'update');
const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch(base) {
  const app = await electron.launch({ executablePath: process.argv[2], args: [process.argv[3], '--no-sandbox'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ULLIM_UPDATE_TEST: base + '/' } });
  const win = await app.firstWindow();
  await win.waitForFunction(() => window.__ullim && window.__ullim.engine, null, { timeout: 15000 });
  return { app, win };
}
async function waitClosed(app, ms = 8000) {
  const proc = app.process();
  if (proc.exitCode != null) return true;
  return Promise.race([new Promise(r => proc.once('exit', () => r(true))), sleep(ms).then(() => false)]);
}

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  fs.rmSync(updDir, { recursive: true, force: true });
  fs.mkdirSync(updDir, { recursive: true });
  fs.writeFileSync(path.join(updDir, 'Ullim-Setup-1.0.0.exe'), 'old');          // 지난 버전 → 시작 5초 뒤 지워져야 함
  fs.writeFileSync(path.join(updDir, 'Ullim-Setup-9.9.9.exe.part'), 'partial');  // 받다 만 파일 → 지워져야 함

  /* 1) 확인 → 받기 → 준비됨 · 배너 */
  let { app, win } = await launch(base);
  ok(await win.evaluate(() => window.ullimNative.updateSupported === true && !!window.__ullim.UPD), 'updateSupported in test mode');
  const g = await win.evaluate(() => window.ullimNative.httpGet('https://raw.githubusercontent.com/omokdie/ullim/main/update/latest.json?t=1'));
  ok(g.status === 200 && JSON.parse(g.body).version === '9.9.9', 'http-get allows the update manifest');
  await win.evaluate(() => window.__ullim.checkUpdate({ manual: true }));
  let st = await win.evaluate(() => ({ s: __ullim.UPD.state, v: __ullim.UPD.version, bar: !document.getElementById('updBar').hidden, text: document.getElementById('updBar').textContent }));
  ok(st.s === 'ready' && st.v === '9.9.9', `state ready 9.9.9 (${st.s})`);
  ok(st.bar && /새 버전 9\.9\.9/.test(st.text) && /지금 다시 시작/.test(st.text), `banner shown: ${st.text}`);
  const f = path.join(updDir, 'Ullim-Setup-9.9.9.exe');
  ok(fs.existsSync(f) && crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') === SHA, 'installer saved with matching SHA-256');
  ok(hits.exe === 1, `downloaded once (${hits.exe})`);

  /* 2) 잘못된 부탁은 거절 */
  const bad = await win.evaluate(async sha => {
    const N = window.ullimNative, out = {};
    const t = async (k, ...a) => { try { await N.updateDownload(...a); out[k] = 'accepted'; } catch (e) { out[k] = 'rejected'; } };
    await t('otherRepo', 'https://github.com/someone/ullim/releases/download/v9.9.8/Ullim-Setup-9.9.8.exe', sha, 307200, '9.9.8');
    await t('mismatch', 'https://github.com/omokdie/ullim/releases/download/v9.9.8/Ullim-Setup-9.9.7.exe', sha, 307200, '9.9.8');
    await t('older', 'https://github.com/omokdie/ullim/releases/download/v1.0.0/Ullim-Setup-1.0.0.exe', sha, 307200, '1.0.0');
    await t('badSha', 'https://github.com/omokdie/ullim/releases/download/v9.9.8/Ullim-Setup-9.9.8.exe', '0'.repeat(64), 307200, '9.9.8');
    await t('badSize', 'https://github.com/omokdie/ullim/releases/download/v9.9.7/Ullim-Setup-9.9.7.exe', sha, 1000, '9.9.7');
    await t('notHex', 'https://github.com/omokdie/ullim/releases/download/v9.9.8/Ullim-Setup-9.9.8.exe', 'xyz', 307200, '9.9.8');
    return out;
  }, SHA);
  ok(Object.values(bad).every(v => v === 'rejected'), 'bad requests rejected ' + JSON.stringify(bad));
  ok(!fs.existsSync(path.join(updDir, 'Ullim-Setup-9.9.8.exe')) && !fs.existsSync(path.join(updDir, 'Ullim-Setup-9.9.8.exe.part')), 'failed downloads leave no files');
  await sleep(4500);
  ok(!fs.existsSync(path.join(updDir, 'Ullim-Setup-1.0.0.exe')) && !fs.existsSync(path.join(updDir, 'Ullim-Setup-9.9.9.exe.part')) && fs.existsSync(f), 'startup cleanup removed old + partial files, kept the new one');

  /* 3) 닫을 때 조용히 설치 (/S) */
  await app.close();
  await sleep(300);
  let ran = JSON.parse(fs.readFileSync(path.join(updDir, 'ran.json'), 'utf8'));
  ok(ran.version === '9.9.9' && JSON.stringify(ran.args) === '["/S"]', 'quit runs installer with /S ' + JSON.stringify(ran));
  fs.rmSync(path.join(updDir, 'ran.json'));

  /* 4) 다시 열면: 받아 둔 파일을 다시 받지 않음 → '지금 다시 시작' → /S /RELAUNCH 로 실행하고 앱이 닫힘 */
  const exeBefore = hits.exe;   // (위의 잘못된 부탁 중 주소가 맞는 두 개는 받다가 크기 · SHA 에서 거절됨)
  ({ app, win } = await launch(base));
  await win.evaluate(() => window.__ullim.checkUpdate({ manual: true }));
  st = await win.evaluate(() => __ullim.UPD.state);
  ok(st === 'ready' && hits.exe === exeBefore, `reuses verified file (state ${st}, new downloads ${hits.exe - exeBefore})`);
  await win.click('#updBar .btn.primary');
  ok(await waitClosed(app), 'app quits after 지금 다시 시작');
  ran = JSON.parse(fs.readFileSync(path.join(updDir, 'ran.json'), 'utf8'));
  ok(JSON.stringify(ran.args) === '["/S","/RELAUNCH"]', 'restart runs installer with /S /RELAUNCH ' + JSON.stringify(ran));
  fs.rmSync(path.join(updDir, 'ran.json'));

  /* 5) 최신이면 '최신 버전' · 자동 업데이트 끄면 받아 둔 것도 지움 · 끈 뒤에는 닫아도 설치 안 함 */
  manifestVersion = '1.1.0';
  ({ app, win } = await launch(base));
  await win.evaluate(() => window.__ullim.checkUpdate({ manual: true }));
  st = await win.evaluate(() => ({ s: __ullim.UPD.state, toast: document.getElementById('toast').textContent, bar: !document.getElementById('updBar').hidden }));
  ok(st.s === 'latest' && /최신/.test(st.toast) && !st.bar, 'latest → no banner ' + JSON.stringify(st));
  manifestVersion = '9.9.9';
  await win.evaluate(() => { __ullim.UPD.state = 'idle'; return window.__ullim.checkUpdate({ manual: true }); });
  ok(await win.evaluate(() => __ullim.UPD.state) === 'ready', 'ready again');
  // 설정 화면의 자동 업데이트 스위치 끄기
  await win.evaluate(() => window.__ullim.setTab('set'));
  await sleep(400);
  const sw = await win.evaluate(() => { const b = document.querySelector('button.sw[aria-label="자동 업데이트"]'); if (!b) return 'none'; b.click(); return b.getAttribute('aria-checked'); });
  await sleep(500);
  ok(sw === 'false', 'auto-update switch turned off (' + sw + ')');
  ok(!fs.existsSync(updDir) || !fs.readdirSync(updDir).some(n => n.endsWith('.exe')), 'turning off discards the downloaded installer');
  await app.close();
  await sleep(300);
  ok(!fs.existsSync(path.join(updDir, 'ran.json')), 'no install on quit after discard');

  /* 6) 자동 업데이트를 꺼 두면 시작해도 확인하지 않음 */
  const before = hits.manifest;
  ({ app, win } = await launch(base));
  await sleep(13500);
  ok(hits.manifest === before, `no automatic check when off (manifest hits ${hits.manifest - before})`);
  await win.evaluate(() => { __ullim.S.autoUpdate = true; __ullim.setTab('list'); });
  await app.close();
  srv.close();
  fs.rmSync(updDir, { recursive: true, force: true });
})().catch(e => { console.error('FAIL', e); process.exit(1); });
