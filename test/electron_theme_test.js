// 밝은/어두운 화면에 맞춰 창 아이콘(흰 바탕 · 검정 바탕)과 창 바탕색이 바뀌는지
// xvfb-run -a node test/electron_theme_test.js <electron> build/desktop-app
const { _electron: electron } = require('playwright');
(async () => {
  const exe = process.argv[2], appDir = process.argv[3];
  const app = await electron.launch({ executablePath: exe, args: [appDir, '--no-sandbox'], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const win = await app.firstWindow();
  const errs = [];
  win.on('pageerror', e => errs.push(String(e)));
  await win.waitForFunction(() => window.__ullim && window.__ullim.engine, null, { timeout: 15000 });
  await win.waitForTimeout(800);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]; global.__icons = [];
    const o = w.setIcon.bind(w); w.setIcon = p => { global.__icons.push(String(p)); return o(p); };
  });
  const r = {}, bad = [];
  const cur = await win.evaluate(() => document.documentElement.dataset.theme), other = cur === 'dark' ? 'light' : 'dark';
  for (const th of [other, cur, other]) {           // 매번 실제로 바뀌는 순서 (같은 테마면 아이콘을 다시 넣지 않음)
    await win.evaluate(t => { __ullim.S.theme = t; __ullim.applyTheme(); }, th);
    await win.waitForTimeout(300);
    const m = await app.evaluate(({ BrowserWindow }) => ({ icon: global.__icons[global.__icons.length - 1] || '', bg: BrowserWindow.getAllWindows()[0].getBackgroundColor() }));
    const brand = await win.evaluate(() => [...document.querySelectorAll('.brand img')].map(i => i.getAttribute('src') + ':' + (i.complete && i.naturalWidth > 0)));
    r[th + (r[th] ? '2' : '')] = { ...m, brand };
    const wantIcon = th === 'dark' ? /icon-dark\.png$|ullim-dark\.ico$/ : /(web\/img\/icon\.png|assets\/ullim\.ico)$/;
    if (!wantIcon.test(m.icon)) bad.push(`${th}: icon ${m.icon}`);
    if (!brand.every(s => s.startsWith(th === 'dark' ? 'img/icon-dark.png:true' : 'img/icon.png:true'))) bad.push(`${th}: brand ${brand}`);
    const lum = parseInt(m.bg.slice(1, 3), 16);
    if (th === 'dark' ? lum > 0x40 : lum < 0xc0) bad.push(`${th}: bg ${m.bg}`);
  }
  if (errs.length) bad.push('page errors: ' + errs.join(' | '));
  console.log(JSON.stringify(r, null, 1));
  console.log(bad.length ? 'FAIL ' + bad.join('; ') : 'theme icons ok');
  await app.close();
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
