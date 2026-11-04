'use strict';
/* 울림 — Windows/데스크톱 메인 프로세스 (Electron) */
const { app, BrowserWindow, protocol, ipcMain, dialog, Menu, nativeImage, shell, screen, net, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const { spawn } = require('child_process');

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

/** 창 · 작업 표시줄 아이콘: 밝은 화면은 흰 바탕, 어두운 화면은 검은 바탕 (앱의 테마를 따름, 처음엔 윈도우 설정) */
const windowIcon = light => path.join(ASSETS, process.platform === 'win32' ? (light ? 'ullim.ico' : 'ullim-dark.ico') : (light ? 'icon.png' : 'icon-dark.png'));
let themeLight = null;
ipcMain.on('set-theme', (e, bg, light) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  light = !!light;
  if (/^#[0-9a-f]{6}$/i.test(bg)) win.setBackgroundColor(bg);
  if (light === themeLight) return;
  themeLight = light;
  try { if (fs.existsSync(windowIcon(light))) win.setIcon(windowIcon(light)); } catch (err) { /* noop */ }
});

function createWindow() {
  const b = loadBounds() || {};
  win = new BrowserWindow({
    width: b.width || 1180, height: b.height || 760, x: b.x, y: b.y,
    minWidth: 380, minHeight: 560,
    title: '울림', backgroundColor: nativeTheme.shouldUseDarkColors ? '#07080a' : '#f3f4f7', autoHideMenuBar: true, show: false,
    icon: windowIcon(!nativeTheme.shouldUseDarkColors),
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
/* ---------- 플레이리스트 파일 (M3U · M3U8 · PLS) ---------- */
const PL_TEST_DIR = process.env.ULLIM_PLAYLIST_TEST_DIR || '';   // 시험용: 대화상자 없이 이 폴더에 저장 · 이 폴더에서 읽기
ipcMain.handle('save-playlist', async (_e, name, text) => {
  if (typeof text !== 'string' || text.length > 20e6) return null;
  const safe = String(name || '플레이리스트').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 80) || '플레이리스트';
  let file;
  if (PL_TEST_DIR) file = path.join(PL_TEST_DIR, safe + '.m3u8');
  else {
    const r = await dialog.showSaveDialog(win, {
      title: '플레이리스트 내보내기', defaultPath: path.join(app.getPath('music'), safe + '.m3u8'),
      filters: [{ name: 'M3U8 플레이리스트 (UTF-8)', extensions: ['m3u8'] }, { name: 'M3U 플레이리스트', extensions: ['m3u'] }],
    });
    if (r.canceled || !r.filePath) return null;
    file = r.filePath;
  }
  // .m3u 는 프로그램마다 글자 인코딩을 다르게 짐작하므로 UTF-8 표시(BOM)를 붙인다
  await fsp.writeFile(file, (/\.m3u$/i.test(file) ? '\ufeff' : '') + text, 'utf8');
  return file;
});
function decodePlaylist(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { /* 한국어 윈도우의 옛 .m3u (CP949) */ }
  try { return new TextDecoder('euc-kr').decode(buf); } catch (e) { return buf.toString('latin1'); }
}
/* 다른 컴퓨터의 공유 폴더(\\서버\...) 중 인터넷 쪽 주소는 열지 않는다
   (내려받은 재생목록이 낯선 서버에 접속하게 만들어 윈도우 로그인 정보를 보내게 하는 것을 막음).
   집 · 회사 안의 NAS(이름 하나짜리, 192.168.x.x 같은 내부 주소, .local 등)는 그대로 쓴다 */
function remoteShareHost(p) {
  const m = /^(?:\\\\|\/\/)([^\\/]+)/.exec(p);
  if (!m || /^[?.]$/.test(m[1])) return null;          // \\?\C:\... · \\.\ 는 이 컴퓨터
  return m[1].toLowerCase();
}
function localNetworkHost(h) {
  if (!h.includes('.') && !h.includes(':')) return true;                       // NAS · DISKSTATION 처럼 이름 하나
  if (/^(10|127)\.\d+\.\d+\.\d+$/.test(h) || /^192\.168\.\d+\.\d+$/.test(h) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h) || /^169\.254\.\d+\.\d+$/.test(h)) return true;
  return /\.(local|lan|home|internal|localdomain)$/.test(h) || h === 'localhost';
}
async function readPlaylistFile(f) {
  const st = await fsp.stat(f);
  if (!st.isFile() || st.size > 20e6) throw new Error('too big');
  const text = decodePlaylist(await fsp.readFile(f));
  const lines = text.split(/\r\n|\n|\r/).map(l => l.trim());
  const entries = /\.pls$/i.test(f)
    ? lines.map(l => /^File\d+\s*=\s*(.+)$/i.exec(l)).filter(Boolean).map(m => m[1].trim())
    : lines.filter(l => l && !l.startsWith('#'));
  const dir = path.dirname(f), paths = [], seen = new Set();
  let missing = 0;
  for (let p of entries) {
    if (/^file:\/\//i.test(p)) { try { p = require('url').fileURLToPath(p); } catch (e) { continue; } }
    else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) continue;              // 인터넷 주소(라디오 등)는 건너뜀
    const abs = path.resolve(dir, p);
    if (seen.has(abs) || !isAudio(abs)) continue;
    seen.add(abs);
    const host = remoteShareHost(abs);
    if (host && !localNetworkHost(host)) continue;
    try { if ((await fsp.stat(abs)).isFile()) paths.push(abs); else missing++; } catch (e) { missing++; }   // 이 컴퓨터에 없는 음악 파일만 '못 찾음'
  }
  const name = (/^#PLAYLIST:(.+)$/m.exec(text) || [])[1];
  return { name: (name || path.basename(f).replace(/\.(m3u8?|pls)$/i, '')).trim().slice(0, 60), paths, missing };
}
ipcMain.handle('open-playlists', async () => {
  let files;
  if (PL_TEST_DIR) files = (await fsp.readdir(PL_TEST_DIR)).filter(n => /\.(m3u8?|pls)$/i.test(n)).sort().map(n => path.join(PL_TEST_DIR, n));
  else {
    const r = await dialog.showOpenDialog(win, {
      title: '플레이리스트 가져오기', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '플레이리스트 (M3U · M3U8 · PLS)', extensions: ['m3u8', 'm3u', 'pls'] }],
    });
    if (r.canceled) return { lists: [], failed: 0 };
    files = r.filePaths;
  }
  const lists = [];
  let failed = 0;
  for (const f of files) { try { lists.push(await readPlaylistFile(f)); } catch (e) { failed++; } }   // 읽을 수 없는 파일
  return { lists, failed };
});
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: '음악 폴더 추가', properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? [] : expand(r.filePaths);
});
ipcMain.handle('scan-music', async () => expand([app.getPath('music')]));
ipcMain.handle('expand-paths', async (_e, paths) => expand(Array.isArray(paths) ? paths : []));
ipcMain.handle('startup-files', () => { const f = pendingOpen; pendingOpen = []; return f; });
ipcMain.on('now-playing', (_e, info) => updateThumbar(info || {}));

/* ---------- 가사: LRCLIB · 커뮤니티 가사 목록 · 업데이트 정보 요청 (이 주소들만 허용) · 같은 이름의 .lrc 파일 ---------- */
const LRCLIB = 'https://lrclib.net/api/';
const OVERRIDES = 'https://raw.githubusercontent.com/omokdie/ullim/main/lyrics/';
const LRCLIB_TEST = process.env.ULLIM_LYRICS_BASE || '';   // 테스트용 대체 주소
const OVERRIDES_TEST = process.env.ULLIM_OVERRIDES_BASE || '';
ipcMain.handle('http-get', async (_e, url) => {
  if (typeof url !== 'string') return { status: 400, body: '' };
  let target;
  if (url.startsWith(LRCLIB)) target = LRCLIB_TEST ? LRCLIB_TEST + url.slice(LRCLIB.length) : url;
  else if (url.startsWith(OVERRIDES)) target = OVERRIDES_TEST ? OVERRIDES_TEST + url.slice(OVERRIDES.length) : url;
  else if (url.startsWith(UPDATE_MANIFEST)) target = UPDATE_TEST ? UPDATE_TEST + 'manifest/' + url.slice(UPDATE_MANIFEST.length) : url;
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

/* ---------- 자동 업데이트 (설치 프로그램으로 설치한 Windows 앱만) ----------
 * 화면(web/js/update.js)이 GitHub 의 update/latest.json 을 읽어 새 버전이 있으면 받기를 부탁한다.
 * 여기서는 이 저장소 릴리스의 'v<버전>/Ullim-Setup-<버전>.exe' 만, 지금보다 새 버전일 때만 받고,
 * 크기 · SHA-256 이 맞을 때만 '준비됨' 으로 둔다. 앱을 닫을 때 조용히(/S) 설치하고,
 * '지금 다시 시작' 이면 설치가 끝난 뒤 새 버전을 다시 연다(/RELAUNCH).
 */
const UPDATE_MANIFEST = 'https://raw.githubusercontent.com/omokdie/ullim/main/update/';
const UPDATE_DL = 'https://github.com/omokdie/ullim/releases/download/';
const UPDATE_TEST = process.env.ULLIM_UPDATE_TEST || '';   // 시험용: 받는 주소를 이 서버로 바꾸고, 설치 프로그램은 실행하지 않고 기록만 남김
const UPDATE_RE = /^https:\/\/github\.com\/omokdie\/ullim\/releases\/download\/v(\d+\.\d+\.\d+)\/Ullim-Setup-(\d+\.\d+\.\d+)\.exe$/;
const updateDir = () => path.join(app.getPath('userData'), 'update');
const updateSupported = () => !!UPDATE_TEST
  || (process.platform === 'win32' && app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall.exe')));
let pendingUpdate = null;      // { file, version } — 받아서 확인까지 끝난 설치 파일
let updateJob = null;          // 받는 중인 작업 (같은 부탁이 겹치면 함께 기다림)
let sessionEnding = false;     // 윈도우 종료 · 로그오프 중에는 설치하지 않음

function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), new Transform({ transform(c, _e, cb) { h.update(c); cb(); } }));
  return h.digest('hex');
}
async function downloadUpdate(url, sha256, size, version) {
  const dir = updateDir();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `Ullim-Setup-${version}.exe`);
  // 지난번에 받아 둔 같은 파일이 있으면 다시 받지 않는다
  try { const st = await fsp.stat(file); if (st.size === size && await sha256File(file) === sha256) return file; } catch (e) { /* 없음 */ }
  const part = file + '.part';
  const target = UPDATE_TEST ? UPDATE_TEST + url.slice(UPDATE_DL.length) : url;
  const r = await net.fetch(target, { headers: { 'User-Agent': `Ullim/${app.getVersion()} (Windows music player)` }, signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (r.status !== 200 || !r.body) throw new Error('download http ' + r.status);
  const len = Number(r.headers.get('content-length') || 0);
  if (len && len !== size) throw new Error('download size');
  const h = crypto.createHash('sha256');
  let got = 0;
  try {
    await pipeline(Readable.fromWeb(r.body), new Transform({
      transform(c, _e, cb) { got += c.length; if (got > size) return cb(new Error('download size')); h.update(c); cb(null, c); },
    }), fs.createWriteStream(part));
    if (got !== size) throw new Error('download size');
    if (h.digest('hex') !== sha256) throw new Error('download sha256');
    await fsp.rename(part, file);
  } catch (e) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw e;
  }
  return file;
}
/* 지금 버전 이하의 설치 파일 · 받다 만 파일 지우기 (업데이트가 끝난 뒤 시작할 때) */
async function cleanupUpdates() {
  let names = [];
  try { names = await fsp.readdir(updateDir()); } catch (e) { return; }
  for (const n of names) {
    const m = /^Ullim-Setup-(\d+\.\d+\.\d+)\.exe$/.exec(n);
    if (m && newerVersion(m[1], app.getVersion()) && !n.endsWith('.part')) continue;
    if (n === 'ran.json') continue;
    await fsp.rm(path.join(updateDir(), n), { force: true, recursive: true }).catch(() => {});
  }
}
function runInstaller(relaunch) {
  const u = pendingUpdate;
  pendingUpdate = null;
  if (!u || !fs.existsSync(u.file)) return false;
  const args = relaunch ? ['/S', '/RELAUNCH'] : ['/S'];
  if (UPDATE_TEST) {
    try { fs.writeFileSync(path.join(updateDir(), 'ran.json'), JSON.stringify({ file: path.basename(u.file), version: u.version, args })); } catch (e) { /* noop */ }
    return true;
  }
  try {
    // 앱이 완전히 닫힌 뒤에도 설치가 이어지도록 따로 떨어진 프로세스로 실행
    const c = spawn(u.file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => {});
    c.unref();
    return true;
  } catch (e) { return false; }
}
ipcMain.on('update-supported', e => { e.returnValue = updateSupported(); });
ipcMain.handle('update-download', async (_e, url, sha256, size, version) => {
  if (!updateSupported()) throw new Error('update unsupported');
  const m = typeof url === 'string' ? UPDATE_RE.exec(url) : null;
  size = Number(size);
  if (!m || m[1] !== version || m[2] !== version || !newerVersion(version, app.getVersion())
    || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || !(size > 0 && size < 400e6)) throw new Error('bad update');
  if (pendingUpdate && pendingUpdate.version === version) return { ready: true };
  if (!updateJob) {
    updateJob = downloadUpdate(url, sha256, size, version)
      .then(file => { pendingUpdate = { file, version }; return { ready: true }; })
      .finally(() => { updateJob = null; });
  }
  return updateJob;
});
ipcMain.handle('update-discard', async () => {
  pendingUpdate = null;
  try { await fsp.rm(updateDir(), { recursive: true, force: true }); } catch (e) { /* noop */ }
  return true;
});
ipcMain.on('update-restart', () => {
  if (pendingUpdate && runInstaller(true)) app.quit();
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
    if (win) win.on('session-end', () => { sessionEnding = true; });
    setTimeout(() => cleanupUpdates().catch(() => {}), 5000);
  });
  app.on('window-all-closed', () => app.quit());
  // 받아 둔 새 버전은 앱을 닫을 때 조용히 설치 (윈도우 종료 · 로그오프 중이면 다음에)
  app.on('quit', () => { if (pendingUpdate && !sessionEnding) runInstaller(false); });
}
