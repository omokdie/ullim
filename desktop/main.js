'use strict';
/* 울림 — Windows/데스크톱 메인 프로세스 (Electron) */
const { app, BrowserWindow, protocol, ipcMain, dialog, Menu, nativeImage, shell, screen, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Readable } = require('stream');

const WEB = path.join(__dirname, 'web');
const ASSETS = path.join(__dirname, 'assets');
const AUDIO_EXT = new Set(['mp3', 'm4a', 'm4b', 'mp4', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'wave', 'webm', 'weba', 'mka']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.wave': 'audio/wav',
  '.webm': 'audio/webm', '.weba': 'audio/webm', '.mka': 'audio/x-matroska',
};
const isAudio = p => AUDIO_EXT.has(path.extname(p).slice(1).toLowerCase());

app.setName('Ullim');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (process.platform === 'win32') app.setAppUserModelId('kr.ullim.player');

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true },
}]);

let win = null;
let pendingOpen = [];

function filesFromArgv(argv, cwd) {
  const out = [];
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-') || a === '.' || /electron(\.exe)?$/i.test(a) || /main\.js$/i.test(a)) continue;
    const p = path.resolve(cwd || process.cwd(), a);
    try { if (fs.statSync(p).isFile() && isAudio(p)) out.push(p); } catch (e) { /* noop */ }
  }
  return out;
}

/* ---------- app:// 프로토콜 : 화면 파일 + 로컬 음악 스트리밍(Range 지원) ---------- */
async function serveMedia(p, req) {
  let st;
  try { st = await fsp.stat(p); if (!st.isFile()) throw new Error('not file'); } catch (e) { return new Response('not found', { status: 404 }); }
  const size = st.size, type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  if (size === 0) return new Response(new Uint8Array(0), { status: 200, headers: { ...base, 'Content-Length': '0' } });
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1] === '' && m[2] !== '') start = Math.max(0, size - Number(m[2]));
      else { start = Number(m[1]) || 0; if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
      status = 206;
    }
  }
  const stream = fs.createReadStream(p, { start, end, highWaterMark: 256 * 1024 });
  const headers = { ...base, 'Content-Length': String(end - start + 1) };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(Readable.toWeb(stream), { status, headers });
}

async function handleApp(req) {
  const u = new URL(req.url);
  if (u.pathname === '/media') return serveMedia(u.searchParams.get('p') || '', req);
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB + path.sep)) return new Response('forbidden', { status: 403 });
  try {
    const data = await fsp.readFile(file);
    return new Response(data, { headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
  } catch (e) {
    return new Response('not found', { status: 404 });
  }
}

/* ---------- 폴더 탐색 ---------- */
const SKIP = new Set(['system volume information', '$recycle.bin', 'node_modules', 'windows', 'program files', 'program files (x86)', 'programdata', 'appdata']);
async function walk(dir, out, depth) {
  if (depth > 16 || out.length >= 30000) return;
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  ents.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' }));
  for (const e of ents) {
    if (e.name.startsWith('.') || SKIP.has(e.name.toLowerCase())) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, depth + 1);
    else if (e.isFile() && isAudio(e.name)) out.push(p);
    if (out.length >= 30000) return;
  }
}
async function expand(paths) {
  const out = [];
  for (const p of paths || []) {
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) await walk(p, out, 0);
      else if (st.isFile() && isAudio(p)) out.push(p);
    } catch (e) { /* noop */ }
  }
  return out;
}

/* ---------- 작업 표시줄 미리보기 버튼 ---------- */
const tbIcon = n => { try { return nativeImage.createFromPath(path.join(ASSETS, `tb_${n}.png`)); } catch (e) { return nativeImage.createEmpty(); } };
let tbState = '';
function send(cmd, arg) { if (win && !win.isDestroyed()) win.webContents.send('command', cmd, arg); }
function updateThumbar(info) {
  if (process.platform !== 'win32' || !win) return;
  const key = `${!!info.hasTrack}:${!!info.playing}`;
  if (key === tbState) return;
  tbState = key;
  if (!info.hasTrack) { win.setThumbarButtons([]); return; }
  win.setThumbarButtons([
    { tooltip: '이전 곡', icon: tbIcon('prev'), click: () => send('prev') },
    { tooltip: info.playing ? '일시정지' : '재생', icon: tbIcon(info.playing ? 'pause' : 'play'), click: () => send('toggle') },
    { tooltip: '다음 곡', icon: tbIcon('next'), click: () => send('next') },
  ]);
}

/* ---------- 창 위치 기억 ---------- */
const boundsFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    const visible = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return b.x + 80 > a.x && b.y + 40 > a.y && b.x < a.x + a.width - 80 && b.y < a.y + a.height - 40;
    });
    return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
  } catch (e) { return null; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch (e) { /* noop */ }
}

function createWindow() {
  const b = loadBounds() || {};
  win = new BrowserWindow({
    width: b.width || 1180, height: b.height || 760, x: b.x, y: b.y,
    minWidth: 380, minHeight: 560,
    title: '울림', backgroundColor: '#0f1114', autoHideMenuBar: true, show: false,
    icon: path.join(ASSETS, process.platform === 'win32' ? 'ullim.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, spellcheck: false,
    },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveBounds);
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://ullim/')) e.preventDefault(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.loadURL('app://ullim/index.html');
}

/* ---------- IPC ---------- */
ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '음악 파일 추가', properties: ['openFile', 'multiSelections'],
    filters: [{ name: '오디오 파일', extensions: [...AUDIO_EXT] }, { name: '모든 파일', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths.filter(isAudio);
});
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: '음악 폴더 추가', properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? [] : expand(r.filePaths);
});
ipcMain.handle('scan-music', async () => expand([app.getPath('music')]));
ipcMain.handle('expand-paths', async (_e, paths) => expand(Array.isArray(paths) ? paths : []));
ipcMain.handle('startup-files', () => { const f = pendingOpen; pendingOpen = []; return f; });
ipcMain.on('now-playing', (_e, info) => updateThumbar(info || {}));

/* ---------- 가사: LRCLIB · 커뮤니티 가사 목록 요청 (이 두 주소만 허용) · 같은 이름의 .lrc 파일 ---------- */
const LRCLIB = 'https://lrclib.net/api/';
const OVERRIDES = 'https://raw.githubusercontent.com/omokdie/ullim/main/lyrics/';
const LRCLIB_TEST = process.env.ULLIM_LYRICS_BASE || '';   // 테스트용 대체 주소
const OVERRIDES_TEST = process.env.ULLIM_OVERRIDES_BASE || '';
ipcMain.handle('http-get', async (_e, url) => {
  if (typeof url !== 'string') return { status: 400, body: '' };
  let target;
  if (url.startsWith(LRCLIB)) target = LRCLIB_TEST ? LRCLIB_TEST + url.slice(LRCLIB.length) : url;
  else if (url.startsWith(OVERRIDES)) target = OVERRIDES_TEST ? OVERRIDES_TEST + url.slice(OVERRIDES.length) : url;
  else return { status: 400, body: '' };
  try {
    const r = await net.fetch(target, {
      // LRCLIB 요청 규칙: 앱 이름 · 버전 · 프로젝트 주소
      headers: { 'User-Agent': `Ullim v${app.getVersion()} (https://github.com/omokdie/ullim)`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.text();
    return { status: r.status, body: body.length > 4e6 ? '' : body, retryAfter: r.headers.get('retry-after') };
  } catch (e) {
    // 시간 초과(서버가 느림)와 연결 안 됨(인터넷 끊김)을 구분해 알려 준다
    const m = String((e && (e.name + ' ' + e.message)) || '');
    const error = /Timeout|Abort/i.test(m) ? 'timeout'
      : /INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED/i.test(m) ? 'offline' : 'network';
    return { status: 0, body: '', error };
  }
});
/* 고른 가사 알리기: 이 메시지함 주소에만, 작은 글만 보낸다 (web/js/lyrics.js 의 FEEDBACK_URL) */
const FEEDBACK = 'https://ntfy.sh/ullim-lyrics-259gyx3gfnw7';
const FEEDBACK_TEST = process.env.ULLIM_FEEDBACK_URL || '';
ipcMain.handle('http-post', async (_e, url, body) => {
  if (url !== FEEDBACK || typeof body !== 'string' || Buffer.byteLength(body) > 4000) return { status: 400 };
  try {
    const r = await net.fetch(FEEDBACK_TEST || FEEDBACK, {
      method: 'POST', body,
      headers: { 'User-Agent': `Ullim/${app.getVersion()} (Windows music player)`, 'Content-Type': 'text/plain; charset=utf-8' },
      signal: AbortSignal.timeout(12000),
    });
    await r.arrayBuffer().catch(() => null);
    return { status: r.status };
  } catch (e) {
    return { status: 0 };
  }
});
/* GitHub · LRCLIB 페이지만 기본 브라우저로 연다 */
ipcMain.on('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\/(github\.com|lrclib\.net)\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('find-lrc', async (_e, p) => {
  if (typeof p !== 'string' || !isAudio(p)) return null;
  const base = p.slice(0, p.length - path.extname(p).length);
  for (const c of [base + '.lrc', base + '.LRC', base + '.Lrc']) {
    try { const st = await fsp.stat(c); if (st.isFile() && st.size < 2e6) return new Uint8Array(await fsp.readFile(c)); } catch (e) { /* none */ }
  }
  return null;
});

/* ---------- 시작 ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingOpen = filesFromArgv(process.argv);
  app.on('second-instance', (_e, argv, cwd) => {
    const files = filesFromArgv(argv, cwd);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
      if (files.length) win.webContents.send('open-files', files);
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    protocol.handle('app', handleApp);
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
