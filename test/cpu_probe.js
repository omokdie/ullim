// CPU 사용량 재기 (발열 · 배터리 비교용) — 재생 중 화면을 볼 때 / 창을 내렸을 때(백그라운드)
//   xvfb-run -a <electron> test/cpu_probe.js <앱 폴더> [phone|desktop] [초=20]
//   프로세스마다 /proc/<pid>/stat 의 사용 시간 증가량 ÷ 지난 시간 (100% = 코어 하나를 다 씀). 리눅스 xvfb 는 화면을 CPU 로 그리므로
//   그리기(애니메이션 · 유리 효과)의 비용이 그대로 보인다.
'use strict';
const path = require('path');
const fs = require('fs');
const argv = process.argv.slice(process.argv.findIndex(a => a.endsWith('cpu_probe.js')) + 1);
const APP = path.resolve(argv[0] || 'build/desktop-app'), MODE = argv[1] || 'phone', SEC = +(argv[2] || 20);
const { app, BrowserWindow } = require('electron');
require(path.join(APP, 'main.js'));
const HZ = 100;
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
function ticks() {
  const o = {};
  for (const pid of tree(process.pid)) {
    try {
      const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').slice(0);
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      const c = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/\0| /);
      const t = (c.find(a => a.startsWith('--type=')) || '--type=browser').slice(7);
      o[pid] = { k: t, t: +f[11] + +f[12] };
    } catch (e) { /* gone */ }
  }
  return o;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function measure(label, sec) {
  const a = ticks(), t0 = Date.now();
  await sleep(sec * 1000);
  const b = ticks(), dt = (Date.now() - t0) / 1000;
  const by = {}; let tot = 0;
  for (const [pid, v] of Object.entries(b)) { const d = (v.t - ((a[pid] && a[pid].t) || 0)) / HZ / dt * 100; by[v.k] = (by[v.k] || 0) + d; tot += d; }
  console.log(`${label.padEnd(18)} CPU ${tot.toFixed(1).padStart(5)}%  ` + Object.entries(by).filter(([, v]) => v >= 0.3).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(' '));
  return tot;
}
app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; if (!win) await sleep(100); }
  if (MODE === 'phone') win.setSize(400, 860); else win.setSize(1280, 800);
  const js = c => win.webContents.executeJavaScript(c, true);
  for (let i = 0; i < 200; i++) { if (await js('!!(window.__ullim && window.__ullim.engine)').catch(() => false)) break; await sleep(100); }
  const L = '/tmp/ullim-lib';
  const items = fs.readdirSync(L).filter(f => !f.startsWith('.')).sort().map(f => ({ key: path.join(L, f), name: f }));
  items.unshift({ key: '/tmp/memlib/long/02_Avercage_-_Embers.mp3', name: 'long.mp3' });
  await js(`__ullim.addItems(${JSON.stringify(items)}, { play: false }); 0`);
  await sleep(6000);
  await js(`__ullim.playIndex(0); __ullim.go('home'); 0`);
  if (process.env.EXP_JS) await js(process.env.EXP_JS);       // 실험: 무엇이 CPU 를 쓰는지 하나씩 끄고 재기
  await sleep(5000);
  console.log('보임', await js('document.visibilityState'), 'glass', await js('document.documentElement.dataset.glass'));
  await measure(`${MODE} 재생 · 홈`, SEC);
  await js(`__ullim.openPlayer(); 0`);
  await sleep(2000);
  await measure(`${MODE} 재생 · 재생 화면`, SEC);
  await js(`__ullim.closePlayer(); 0`);
  win.minimize();
  await sleep(4000);
  console.log('내린 뒤 보임', await js('document.visibilityState'));
  await measure(`${MODE} 재생 · 창 내림`, SEC);
  const st = await js(`({ paused: __ullim.engine.deck.a.paused, t: +__ullim.engine.deck.a.currentTime.toFixed(1) })`);
  console.log('재생 상태', JSON.stringify(st));
  app.exit(0);
});
