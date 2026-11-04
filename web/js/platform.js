/*
 * 울림 — 플랫폼 연결층
 *   electron : window.ullimNative (preload)
 *   android  : window.UllimAndroid (JavascriptInterface)
 *   web      : 브라우저 (개발 · 미리보기용)
 */
export const AUDIO_EXT = ['mp3', 'm4a', 'm4b', 'mp4', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'wave', 'webm', 'weba', 'mka'];
export const isAudioName = n => AUDIO_EXT.includes((n.split('.').pop() || '').toLowerCase());
const baseName = p => p.split(/[\\/]/).pop();

const W = window;
const cmdHandlers = [], openHandlers = [];
const emitCmd = (c, a) => cmdHandlers.forEach(f => f(c, a));
const emitOpen = items => openHandlers.forEach(f => f(items));

function webPlatform() {
  const blobs = new Map();
  const pick = (opts) => new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    if (opts.dir) inp.webkitdirectory = true; else inp.accept = 'audio/*,' + AUDIO_EXT.map(e => '.' + e).join(',');
    inp.onchange = () => resolve(fromFiles([...inp.files]));
    inp.click();
  });
  const fromFiles = files => files.filter(f => isAudioName(f.name) || /^audio\//.test(f.type))
    .sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'ko', { numeric: true }))
    .map(f => { const u = URL.createObjectURL(f); blobs.set(u, f); return { key: u, name: f.name, temp: true }; });
  return {
    name: 'web', canScan: false, persistent: false,
    mediaUrl: key => key,
    tagSource: key => blobs.get(key) || key,
    pickFiles: () => pick({}),
    pickFolder: () => pick({ dir: true }),
    fromDrop: async dt => fromFiles([...(dt.files || [])]),
  };
}

function electronPlatform() {
  const N = W.ullimNative;
  const items = paths => (paths || []).map(p => ({ key: p, name: baseName(p) }));
  N.onCommand((c, a) => emitCmd(c, a));
  N.onOpenFiles(paths => emitOpen(items(paths)));
  return {
    name: 'electron', canScan: true, scanLabel: '음악 폴더', persistent: true,
    mediaUrl: key => 'app://ullim/media?p=' + encodeURIComponent(key),
    tagSource: key => 'app://ullim/media?p=' + encodeURIComponent(key),
    pickFiles: async () => items(await N.pickFiles()),
    pickFolder: async () => items(await N.pickFolder()),
    scanLibrary: async () => items(await N.scanMusic()),
    fromDrop: async dt => {
      const paths = [...(dt.files || [])].map(f => N.pathForFile(f)).filter(Boolean);
      return items(await N.expandPaths(paths));
    },
    startupFiles: async () => items(await N.startupFiles()),
    nowPlaying: info => N.nowPlaying(info),
    httpGet: url => N.httpGet(url),
    httpPost: (url, body) => N.httpPost(url, body),
    savePlaylist: (name, text) => N.savePlaylist(name, text),
    openPlaylists: () => N.openPlaylists(),
    findLrc: key => N.findLrc(key),
    openExternal: url => N.openExternal(url),
    setTheme: () => {},
    // 자동 업데이트: 설치 프로그램으로 설치한 앱에서만 (압축 파일 · 개발 실행은 제외)
    update: N.updateSupported ? {
      download: (url, sha256, size, version) => N.updateDownload(url, sha256, size, version),
      discard: () => N.updateDiscard(),
      restartNow: () => N.updateRestart(),
    } : null,
  };
}

function androidPlatform() {
  const A = W.UllimAndroid;
  let seq = 0;
  const pending = new Map();
  W.__ullimResolve = (id, json, err) => {
    const p = pending.get(id); if (!p) return;
    pending.delete(id);
    if (err) p.reject(new Error(err)); else { try { p.resolve(json ? JSON.parse(json) : null); } catch (e) { p.reject(e); } }
  };
  W.__ullimCommand = (c, a) => emitCmd(c, a);
  W.__ullimOpen = json => { try { emitOpen(JSON.parse(json)); } catch (e) { /* noop */ } };
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = 'r' + (++seq);
    pending.set(id, { resolve, reject });
    try { A.call(method, JSON.stringify(args), id); } catch (e) { pending.delete(id); reject(e); }
  });
  const origin = location.origin;
  return {
    name: 'android', canScan: true, scanLabel: '기기 음악', persistent: true,
    mediaUrl: key => origin + '/media?u=' + encodeURIComponent(key),
    tagSource: key => origin + '/media?u=' + encodeURIComponent(key),
    pickFiles: () => call('pickFiles'),
    pickFolder: () => call('pickFolder'),
    scanLibrary: () => call('scanLibrary'),
    httpGet: url => call('httpGet', url),
    httpPost: (url, body) => call('httpPost', url, body),
    openExternal: url => { try { A.openUrl(url); } catch (e) { /* noop */ } },
    fromDrop: async () => [],
    nowPlaying: info => { try { A.nowPlaying(JSON.stringify(info)); } catch (e) { /* noop */ } },
    setTheme: (bg, light) => { try { A.setSystemBars(bg, !!light); } catch (e) { /* noop */ } },
    release: keys => { try { A.release(JSON.stringify(keys)); } catch (e) { /* noop */ } },
    exit: () => { try { A.exitApp(); } catch (e) { /* noop */ } },
    ready: () => { try { A.ready(); } catch (e) { /* noop */ } },
    // 새 버전 알림만 (받기 · 설치는 브라우저 → 안드로이드 설치 화면)
    update: {
      versionCode: () => { try { return Number(A.versionCode()) || 0; } catch (e) { return 0; } },
    },
  };
}

export const platform = W.ullimNative ? electronPlatform() : W.UllimAndroid ? androidPlatform() : webPlatform();
platform.onCommand = f => cmdHandlers.push(f);
platform.onOpenFiles = f => openHandlers.push(f);
