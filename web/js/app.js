/* 울림 — 화면과 재생 로직 */
import { Engine } from './engine.js';
import { FX, FX_BY_ID, CATEGORIES, EQ_FREQS, defaultParams } from './effects.js';
import { EQ_PRESETS, SOUND_PRESETS } from './presets.js';
import { readTags } from './tags.js';
import { platform } from './platform.js';
import { ICONS, icon } from './icons.js';
import { guessQuery, findOnline, searchList, fromRecord, cacheGet, cachePut, cacheDrop, toLyrics, decodeText, loadOverrides, communityFor, getById, sendFeedback, flushFeedback, REPO, LookupError } from './lyrics.js';

const VERSION = '1.0.2';
const $ = id => document.getElementById(id);
const app = $('app');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const stripExt = n => (n || '').replace(/\.[^.\\/]+$/, '');
const fmtTime = s => {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
document.querySelectorAll('[data-icon]').forEach(n => { n.innerHTML = ICONS[n.dataset.icon] || ''; });
const setIcon = (btn, name) => btn.replaceChildren(icon(name));
const narrow = () => matchMedia('(max-width: 760px)').matches;

/* ======================= 저장 ======================= */
const LS = { set: 'ullim.settings.v1', list: 'ullim.playlist.v1', pre: 'ullim.userpresets.v1' };
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } };
const DEF_EQ = () => ({ on: false, preset: 'flat', p: Object.fromEntries([['preamp', 0], ...EQ_FREQS.map((_, i) => ['b' + i, 0])]) });
const S = Object.assign({
  volume: 0.8, muted: false, repeat: 'all', shuffle: false, crossfade: 0, theme: 'system', accent: 'blue',
  fxOn: true, fx: { limiter: { on: true, p: defaultParams(FX_BY_ID.limiter) } }, eq: DEF_EQ(), preset: null,
  resume: true, lastKey: null, lastPos: 0, tab: 'list', lyrAuto: true, lyrShare: true, lyrSize: 20,
}, load(LS.set, {}));
if (!S.eq || !S.eq.p) S.eq = DEF_EQ();
if (!S.fx) S.fx = {};
const saveSettings = debounce(() => store(LS.set, S), 400);
let userPresets = load(LS.pre, []);

function fxState(id) {
  const def = FX_BY_ID[id];
  if (!S.fx[id]) S.fx[id] = { on: false, p: {} };
  S.fx[id].p = { ...defaultParams(def), ...S.fx[id].p };
  return S.fx[id];
}
FX.forEach(d => fxState(d.id));

/* ======================= 재생목록 ======================= */
let uid = 0;
const mkTrack = o => ({ id: ++uid, key: o.key, name: o.name || o.key, title: o.title || '', artist: o.artist || '', album: o.album || '', duration: o.duration || 0, tagged: !!o.tagged, bad: false });
let list = platform.persistent ? (load(LS.list, []) || []).map(o => mkTrack({ key: o.k, name: o.n, title: o.t, artist: o.a, album: o.al, duration: o.d, tagged: o.g })) : [];
const saveList = debounce(() => {
  if (!platform.persistent) return;
  store(LS.list, list.map(t => ({ k: t.key, n: t.name, t: t.title, a: t.artist, al: t.album, d: Math.round(t.duration * 10) / 10, g: t.tagged ? 1 : 0 })));
}, 600);
const displayTitle = t => (t && (t.title || stripExt(t.name.split(/[\\/]/).pop()))) || '';
const subLine = t => [t.artist, t.album].filter(Boolean).join(' · ') || '알 수 없는 아티스트';

/* ======================= 엔진 ======================= */
const engine = new Engine();
engine.setVolume(S.volume, S.muted);
engine.addEventListener('fxerror', e => toast(`'${(FX_BY_ID[e.detail] || {}).name || e.detail}' 효과를 이 기기에서 쓸 수 없어요`));
const P = { index: -1, xf: null, errors: 0, sleepAt: 0, sleepTimer: 0, sleepFading: false, artUrl: null, dragging: false, lastSave: 0, lastSide: 'fx' };
const isPlaying = () => P.index >= 0 && !engine.deck.a.paused;

engine.decks.forEach(deck => {
  const a = deck.a;
  a.addEventListener('timeupdate', () => { if (deck === engine.deck) onTime(); });
  a.addEventListener('ended', () => {
    if (deck !== engine.deck) return;
    if (P.xf && P.xf.started) return;
    if (P.xf) endCrossfade();
    onEnded();
  });
  a.addEventListener('play', () => { if (deck === engine.deck) onPlayState(); });
  a.addEventListener('playing', () => { if (deck === engine.deck) { P.errors = 0; P.dir = 1; } });
  a.addEventListener('pause', () => { if (deck === engine.deck) onPlayState(); });
  a.addEventListener('loadedmetadata', () => {
    if (deck.pendingSeek > 0) { try { a.currentTime = deck.pendingSeek; } catch (e) { /* noop */ } }
    deck.pendingSeek = 0;
  });
  a.addEventListener('durationchange', () => {
    if (deck !== engine.deck || !deck.track || !isFinite(a.duration)) return;
    if (Math.abs((deck.track.duration || 0) - a.duration) > 1) { deck.track.duration = a.duration; scheduleRows(); saveList(); }
    updateTimeUI();
  });
  a.addEventListener('error', () => onMediaError(deck));
});

/* ======================= 재생 ======================= */
function revokeBlob(deck) { if (deck.blob) { URL.revokeObjectURL(deck.blob); deck.blob = null; } }

async function playIndex(i, { autoplay = true, startAt = 0 } = {}) {
  if (i < 0 || i >= list.length) return;
  endCrossfade();
  const deck = engine.deck, t = list[i];
  engine.resetGain(deck, 1);
  revokeBlob(deck);
  deck.track = t; deck.blobTried = false; deck.pendingSeek = startAt;
  engine.load(deck, platform.mediaUrl(t.key));
  P.index = i;
  S.lastKey = t.key; S.lastPos = startAt; saveSettings();
  onTrackChange();
  if (autoplay) await doPlay(deck);
  else onPlayState();
}

async function doPlay(deck = engine.deck) {
  await engine.resume();
  try { await deck.a.play(); }
  catch (e) {
    if (e && e.name === 'NotAllowedError') toast('재생 버튼을 한 번 눌러 주세요');
  }
}

async function onMediaError(deck) {
  const t = deck.track;
  if (!t || !deck.a.getAttribute('src')) return;
  // 안드로이드: 스트리밍이 막히면 파일을 통째로 읽어 다시 시도
  if (platform.name === 'android' && !deck.blobTried) {
    deck.blobTried = true;
    try {
      const r = await fetch(platform.mediaUrl(t.key));
      if (!r.ok) throw new Error(r.status);
      const u = URL.createObjectURL(await r.blob());
      revokeBlob(deck); deck.blob = u;
      engine.load(deck, u);
      if (deck === engine.deck) await doPlay(deck);
      return;
    } catch (e) { /* fall through */ }
  }
  t.bad = true; scheduleRows();
  if (deck !== engine.deck) { endCrossfade(); return; }
  toast(`재생할 수 없는 파일이에요: ${displayTitle(t)}`);
  P.errors++;
  const n = P.dir < 0 ? prevIndex() : nextIndex(true);
  if (n != null && P.errors < Math.min(list.length, 25)) setTimeout(() => playIndex(n), 500);
  else { P.errors = 0; onPlayState(); }
}

let order = [];
function rebuildOrder() {
  order = list.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  if (P.index >= 0) { const k = order.indexOf(P.index); if (k > 0) { order.splice(k, 1); order.unshift(P.index); } }
}
function nextIndex(auto) {
  const first = nextIndexRaw(auto);
  if (first == null || !list[first].bad) return first;
  const save = P.index; let i = first, guard = list.length;
  while (i != null && list[i].bad && guard-- > 0) { P.index = i; i = nextIndexRaw(auto); }
  P.index = save;
  return i != null && !list[i].bad ? i : null;
}
function prevIndex() {
  const first = prevIndexRaw();
  if (first == null || !list[first].bad) return first;
  const save = P.index; let i = first, guard = list.length;
  while (i != null && list[i].bad && guard-- > 0) { P.index = i; i = prevIndexRaw(); }
  P.index = save;
  return i != null && !list[i].bad ? i : null;
}
function nextIndexRaw(auto) {
  const n = list.length;
  if (!n) return null;
  if (S.shuffle) {
    if (order.length !== n) rebuildOrder();
    const k = order.indexOf(P.index);
    if (k >= 0 && k + 1 < n) return order[k + 1];
    if (auto && S.repeat === 'off') return null;
    rebuildOrder();
    return n > 1 && order[0] === P.index ? order[1] : order[0];
  }
  if (P.index + 1 < n) return P.index + 1;
  return auto && S.repeat === 'off' ? null : 0;
}
function prevIndexRaw() {
  const n = list.length;
  if (!n) return null;
  if (S.shuffle) { if (order.length !== n) rebuildOrder(); const k = order.indexOf(P.index); return k > 0 ? order[k - 1] : order[n - 1]; }
  return P.index > 0 ? P.index - 1 : n - 1;
}

function onEnded() {
  if (S.repeat === 'one') { engine.deck.a.currentTime = 0; doPlay(); return; }
  const n = nextIndex(true);
  if (n == null) { onPlayState(); return; }
  playIndex(n);
}
function togglePlay() {
  if (!list.length) { pickFiles(); return; }
  if (P.index < 0) { playIndex(S.shuffle ? (rebuildOrder(), order[0]) : 0); return; }
  const a = engine.deck.a;
  if (!a.getAttribute('src')) { playIndex(P.index); return; }
  if (a.paused) doPlay(); else { endCrossfade(); a.pause(); }
}
function play() { if (P.index < 0 || engine.deck.a.paused) togglePlay(); }
function pause() { if (isPlaying()) { endCrossfade(); engine.deck.a.pause(); } }
function next() { P.dir = 1; const n = nextIndex(false); if (n != null) playIndex(n); }
function prev() {
  const a = engine.deck.a;
  if (P.index >= 0 && a.currentTime > 3) { endCrossfade(); a.currentTime = 0; return; }
  P.dir = -1; const n = prevIndex(); if (n != null) playIndex(n);
}
function stop() { endCrossfade(); const a = engine.deck.a; a.pause(); try { a.currentTime = 0; } catch (e) { /* noop */ } }
function seekTo(sec) {
  const a = engine.deck.a;
  if (P.index < 0 || !a.getAttribute('src')) return;
  endCrossfade();
  const d = isFinite(a.duration) ? a.duration : 0;
  try { a.currentTime = clamp(sec, 0, d ? d - 0.05 : sec); } catch (e) { /* noop */ }
  updateTimeUI(); pushNowPlaying();
}

/* ---------- 크로스페이드 ---------- */
function startCrossfade() {
  const n = nextIndex(true);
  if (n == null || n === P.index) return;
  const from = engine.deck, to = engine.other, t = list[n];
  const xf = P.xf = { from, to, started: false, timer: 0 };
  engine.resetGain(to, 0); revokeBlob(to);
  to.track = t; to.blobTried = true; to.pendingSeek = 0;
  engine.load(to, platform.mediaUrl(t.key));
  to.a.play().then(() => {
    if (P.xf !== xf) { engine.unload(to); return; }
    const remain = from.a.duration - from.a.currentTime;
    const dur = clamp(Math.min(S.crossfade, remain), 0.3, 12);
    engine.crossfade(from, to, dur);
    engine.swap(); P.index = n; xf.started = true;
    xf.timer = setTimeout(() => finishCrossfade(xf), dur * 1000 + 120);
    S.lastKey = t.key; saveSettings();
    onTrackChange(); onPlayState();
  }).catch(() => { if (P.xf === xf) { P.xf = null; engine.unload(to); engine.resetGain(to, 1); } });
}
function finishCrossfade(xf) {
  if (P.xf !== xf) return;
  P.xf = null;
  engine.unload(xf.from); engine.resetGain(xf.from, 1); engine.resetGain(xf.to, 1);
}
function endCrossfade() {
  const xf = P.xf;
  if (!xf) return;
  P.xf = null; clearTimeout(xf.timer);
  if (xf.started) { engine.unload(xf.from); engine.resetGain(xf.from, 1); engine.resetGain(xf.to, 1); }
  else { engine.unload(xf.to); engine.resetGain(xf.to, 1); }
}

function onTime() {
  const a = engine.deck.a;
  if (!vizRAF) { updateTimeUI(); syncLyrics(); }
  if (S.crossfade > 0 && !P.xf && !a.paused && S.repeat !== 'one' && isFinite(a.duration) &&
      a.duration > S.crossfade * 2 + 3 && a.duration - a.currentTime <= S.crossfade + 0.3) startCrossfade();
  const now = Date.now();
  if (now - P.lastSave > 5000) { P.lastSave = now; S.lastPos = a.currentTime; saveSettings(); pushNowPlaying(); }
}

/* ---------- 수면 타이머 ---------- */
function setSleep(min) {
  clearInterval(P.sleepTimer); P.sleepAt = 0; P.sleepFading = false; P.sleepMin = min; engine.restoreSleep();
  if (min > 0) { P.sleepAt = Date.now() + min * 60000; P.sleepTimer = setInterval(sleepTick, 1000); toast(`${min}분 뒤에 재생을 멈춰요`); }
  updateSleepBadge();
}
function sleepTick() {
  const left = P.sleepAt - Date.now();
  if (left <= 12000 && !P.sleepFading) { P.sleepFading = true; engine.fadeOutSleep(Math.max(1, left / 1000)); }
  if (left <= 0) {
    clearInterval(P.sleepTimer); P.sleepAt = 0; P.sleepFading = false;
    pause(); setTimeout(() => engine.restoreSleep(), 400);
    toast('수면 타이머로 재생을 멈췄어요');
  }
  updateSleepBadge();
}
function updateSleepBadge() {
  const b = $('sleepBadge');
  if (!P.sleepAt) { if (b) b.remove(); return; }
  const m = Math.max(0, Math.ceil((P.sleepAt - Date.now()) / 60000));
  const node = b || el('span', { class: 'sleepbadge', id: 'sleepBadge' }, icon('moon'), el('span'));
  node.lastChild.textContent = `${m}분`;
  if (!b) $('sub').after(node);
}

/* ======================= 태그 · 앨범아트 ======================= */
const metaQ = [];
let metaRunning = 0;
function queueMeta(tracks) { for (const t of tracks) if (!t.tagged) metaQ.push(t); pumpMeta(); }
function pumpMeta() {
  while (metaRunning < 2 && metaQ.length) {
    const t = metaQ.shift();
    if (t.tagged || t.removed) continue;
    metaRunning++;
    readTags(platform.tagSource(t.key)).then(info => applyTags(t, info)).catch(() => { t.tagged = true; })
      .finally(() => { metaRunning--; scheduleRows(); saveList(); pumpMeta(); });
  }
}
function applyTags(t, info) {
  t.tagged = true;
  if (info.title) t.title = info.title;
  if (info.artist) t.artist = info.artist;
  if (info.album) t.album = info.album;
  if (info.duration > 0 && !(t.duration > 1)) t.duration = info.duration;
  if (t === list[P.index]) renderNowPlaying();
}
const tagMemo = new Map();
function tagInfo(t) {
  if (!tagMemo.has(t.key)) {
    tagMemo.set(t.key, readTags(platform.tagSource(t.key)).catch(() => null));
    if (tagMemo.size > 8) tagMemo.delete(tagMemo.keys().next().value);
  }
  return tagMemo.get(t.key);
}
const artCache = new Map();
async function getArt(t) {
  if (artCache.has(t.key)) return artCache.get(t.key);
  let url = null;
  try {
    const info = await tagInfo(t);
    if (info && !t.tagged) { applyTags(t, info); scheduleRows(); saveList(); }
    if (info && info.picture) url = URL.createObjectURL(new Blob([info.picture.data], { type: info.picture.mime }));
  } catch (e) { /* no art */ }
  artCache.set(t.key, url);
  if (artCache.size > 24) { const [k, v] = artCache.entries().next().value; if (v && v !== P.artUrl) URL.revokeObjectURL(v); artCache.delete(k); }
  return url;
}
let artTok = 0;
async function loadArt(t) {
  const img = $('artImg'), tok = ++artTok;
  if (!t) { img.hidden = true; P.artUrl = null; return; }
  const url = await getArt(t);
  if (tok !== artTok) return;
  P.artUrl = url;
  if (url) { img.src = url; img.hidden = false; } else img.hidden = true;
  updateMediaSession();
  pushNowPlaying(true);
}
async function artDataUrl(url) {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'), s = 320; c.width = c.height = s;
  const g = c.getContext('2d'), r = Math.max(s / img.width, s / img.height);
  g.drawImage(img, (s - img.width * r) / 2, (s - img.height * r) / 2, img.width * r, img.height * r);
  return c.toDataURL('image/jpeg', 0.85);
}

/* ======================= 외부 연동 ======================= */
function pushNowPlaying(withArt) {
  if (!platform.nowPlaying) return;
  const t = list[P.index], a = engine.deck.a;
  const info = t ? {
    hasTrack: true, title: displayTitle(t), artist: t.artist || '', album: t.album || '', playing: !a.paused,
    position: Math.round((a.currentTime || 0) * 1000), duration: Math.round((isFinite(a.duration) ? a.duration : t.duration || 0) * 1000),
  } : { hasTrack: false, playing: false };
  if (withArt && t && platform.name === 'android') {
    if (P.artUrl) artDataUrl(P.artUrl).then(d => platform.nowPlaying({ ...info, art: d })).catch(() => platform.nowPlaying({ ...info, art: '' }));
    else platform.nowPlaying({ ...info, art: '' });
    return;
  }
  platform.nowPlaying(info);
}
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = list[P.index];
  try {
    navigator.mediaSession.metadata = t ? new MediaMetadata({ title: displayTitle(t), artist: t.artist || '', album: t.album || '', artwork: P.artUrl ? [{ src: P.artUrl, sizes: '512x512' }] : [] }) : null;
    navigator.mediaSession.playbackState = isPlaying() ? 'playing' : (t ? 'paused' : 'none');
  } catch (e) { /* noop */ }
}
if ('mediaSession' in navigator) {
  const h = {
    play: () => play(), pause: () => pause(), stop: () => stop(), previoustrack: () => prev(), nexttrack: () => next(),
    seekto: d => seekTo(d.seekTime), seekbackward: () => seekTo(engine.deck.a.currentTime - 10), seekforward: () => seekTo(engine.deck.a.currentTime + 10),
  };
  for (const [k, f] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, f); } catch (e) { /* unsupported */ } }
}
platform.onCommand((c, a) => {
  if (c === 'play') play(); else if (c === 'pause') pause(); else if (c === 'toggle') togglePlay();
  else if (c === 'next') next(); else if (c === 'prev') prev(); else if (c === 'stop') stop();
  else if (c === 'seek') seekTo((+a || 0) / 1000);
});
platform.onOpenFiles(items => addItems(items, { play: true }));

/* ======================= 화면: 재생 영역 ======================= */
const seek = $('seek'), vol = $('vol');
function paintRange(r, center) {
  const min = +r.min, max = +r.max, p = (r.value - min) / (max - min) * 100;
  const c = center != null ? (center - min) / (max - min) * 100 : 0;
  r.style.setProperty('--a', Math.min(c, p) + '%'); r.style.setProperty('--b', Math.max(c, p) + '%');
}
function renderNowPlaying() {
  const t = list[P.index];
  $('title').textContent = t ? displayTitle(t) : (list.length ? '재생할 곡을 고르세요' : '재생할 음악을 추가하세요');
  $('sub').textContent = t ? subLine(t) : (list.length ? `${list.length}곡이 준비되어 있어요` : '파일이나 폴더를 열거나, 창에 끌어다 놓으세요');
  document.title = t ? `${displayTitle(t)} — 울림` : '울림';
  updateSleepBadge();
}
function onTrackChange() {
  renderNowPlaying();
  updateTimeUI();
  scheduleRows();
  scrollToCurrent();
  loadArt(list[P.index]);
  updateMediaSession();
  loadLyrics(list[P.index]);
}
function onPlayState() {
  const playing = isPlaying();
  setIcon($('btnPlay'), playing ? 'pause' : 'play');
  $('btnPlay').setAttribute('aria-label', playing ? '일시정지' : '재생');
  updateMediaSession(); pushNowPlaying(); scheduleRows();
  if (playing) startViz();
}
function updateTimeUI() {
  const a = engine.deck.a, t = list[P.index];
  const d = isFinite(a.duration) && a.duration > 0 ? a.duration : (t ? t.duration : 0);
  const cur = P.index >= 0 ? a.currentTime || 0 : 0;
  if (!P.dragging) { seek.value = d ? Math.round(cur / d * 1000) : 0; paintRange(seek); $('cur').textContent = fmtTime(cur); }
  $('dur').textContent = fmtTime(d);
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && d && isPlaying() && Math.random() < 0.05) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(cur, d), playbackRate: a.playbackRate || 1 }); } catch (e) { /* noop */ }
  }
}
function renderTransport() {
  setIcon($('btnPlay'), 'play'); setIcon($('btnPrev'), 'prev'); setIcon($('btnNext'), 'next'); setIcon($('btnShuffle'), 'shuffle');
  $('btnPlay').onclick = togglePlay; $('btnPrev').onclick = prev; $('btnNext').onclick = next;
  $('btnShuffle').onclick = () => { S.shuffle = !S.shuffle; order = []; saveSettings(); renderModes(); toast(S.shuffle ? '무작위 재생을 켰어요' : '무작위 재생을 껐어요'); };
  $('btnRepeat').onclick = () => {
    S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat] || 'all'; saveSettings(); renderModes();
    toast({ off: '반복 안 함', all: '전체 반복', one: '한 곡 반복' }[S.repeat]);
  };
  $('btnMute').onclick = () => { S.muted = !S.muted; engine.setVolume(S.volume, S.muted); saveSettings(); renderVolume(); };
  vol.oninput = () => { S.volume = vol.value / 100; S.muted = false; engine.setVolume(S.volume, false); saveSettings(); renderVolume(); };
  seek.addEventListener('input', () => {
    P.dragging = true; paintRange(seek);
    const a = engine.deck.a, d = isFinite(a.duration) ? a.duration : 0;
    $('cur').textContent = fmtTime(seek.value / 1000 * d);
  });
  seek.addEventListener('change', () => {
    const a = engine.deck.a, d = isFinite(a.duration) ? a.duration : 0;
    P.dragging = false;
    if (d) seekTo(seek.value / 1000 * d);
  });
  renderModes(); renderVolume();
}
function renderModes() {
  const sh = $('btnShuffle'), rp = $('btnRepeat');
  sh.classList.toggle('on', S.shuffle); sh.setAttribute('aria-pressed', S.shuffle);
  setIcon(rp, S.repeat === 'one' ? 'repeatOne' : 'repeat');
  rp.classList.toggle('on', S.repeat !== 'off');
  const label = { off: '반복 안 함', all: '전체 반복', one: '한 곡 반복' }[S.repeat];
  rp.title = label; rp.setAttribute('aria-label', label);
}
function renderVolume() {
  vol.value = Math.round(S.volume * 100); paintRange(vol);
  setIcon($('btnMute'), S.muted || S.volume === 0 ? 'mute' : 'vol');
  const sv = $('setVol'); if (sv) { sv.value = vol.value; paintRange(sv); sv.nextSibling.textContent = Math.round(S.volume * 100) + '%'; }
}

/* ======================= 화면: 재생목록 (가상 스크롤) ======================= */
const ROW_H = 52;
const vlist = $('vlist'), spacer = $('spacer');
let view = [], query = '';
function refreshView() {
  const q = query.trim().toLowerCase();
  view = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!q || `${displayTitle(t)} ${t.artist} ${t.album} ${t.name}`.toLowerCase().includes(q)) view.push(i);
  }
  spacer.style.height = view.length * ROW_H + 'px';
  const empty = list.length === 0;
  $('empty').hidden = !empty; vlist.hidden = empty;
  if (empty) renderEmpty();
  renderRows();
  updateCount();
  renderNowPlaying();
}
function updateCount() {
  const total = list.reduce((s, t) => s + (t.duration || 0), 0);
  $('listCount').textContent = list.length ? `${list.length}곡 · ${fmtLong(total)}` : '';
}
const fmtLong = s => { const h = Math.floor(s / 3600), m = Math.round(s / 60) % 60; return h ? `${h}시간 ${m}분` : `${Math.max(m, s > 0 ? 1 : 0)}분`; };
let rowsQueued = false;
function scheduleRows() { if (rowsQueued) return; rowsQueued = true; requestAnimationFrame(() => { rowsQueued = false; renderRows(); updateCount(); }); }
function renderRows() {
  if (vlist.hidden) return;
  const top = vlist.scrollTop, h = vlist.clientHeight || 600;
  const first = Math.max(0, Math.floor(top / ROW_H) - 5), last = Math.min(view.length, Math.ceil((top + h) / ROW_H) + 5);
  const frag = document.createDocumentFragment(), playing = isPlaying();
  for (let k = first; k < last; k++) {
    const i = view[k], t = list[i];
    frag.append(el('div', { class: 'row' + (i === P.index ? ' cur' : '') + (t.bad ? ' bad' : ''), style: `top:${k * ROW_H + 4}px`, 'data-i': i, title: t.name },
      el('div', { class: 'no num' }, i === P.index && playing ? icon('vol') : String(i + 1)),
      el('div', { class: 'tx' }, el('div', { class: 't1' }, displayTitle(t)), el('div', { class: 't2' }, subLine(t))),
      el('div', { class: 'd num' }, t.duration ? fmtTime(t.duration) : ''),
      el('button', { class: 'x', title: '목록에서 빼기', 'aria-label': '목록에서 빼기', 'data-act': 'rm' }, icon('close'))));
  }
  spacer.replaceChildren(frag);
}
function scrollToCurrent() {
  const k = view.indexOf(P.index);
  if (k < 0 || vlist.hidden) return;
  const y = k * ROW_H, top = vlist.scrollTop, h = vlist.clientHeight;
  if (y < top || y + ROW_H > top + h) vlist.scrollTop = Math.max(0, y - h / 2 + ROW_H / 2);
}
vlist.addEventListener('scroll', scheduleRows, { passive: true });
spacer.addEventListener('click', e => {
  const r = e.target.closest('.row'); if (!r) return;
  const i = +r.dataset.i;
  if (e.target.closest('[data-act=rm]')) removeTrack(i); else playIndex(i);
});
new ResizeObserver(scheduleRows).observe(vlist);

function addItems(items, { play: playNow = false } = {}) {
  if (!items || !items.length) return;
  const have = new Set(list.map(t => t.key)), add = [];
  for (const it of items) { if (!it || !it.key || have.has(it.key)) continue; have.add(it.key); add.push(mkTrack(it)); }
  const wasEmpty = list.length === 0;
  if (!add.length) {
    toast('이미 목록에 있는 곡이에요');
    if (playNow) { const i = list.findIndex(t => t.key === items[0].key); if (i >= 0) playIndex(i); }
    return;
  }
  const start = list.length;
  list.push(...add); order = [];
  refreshView(); saveList(); queueMeta(add);
  toast(`${add.length}곡을 추가했어요`);
  if (playNow || (wasEmpty && !isPlaying())) playIndex(start);
}
function removeTrack(i) {
  const t = list[i]; if (!t) return;
  t.removed = true;
  if (platform.release) platform.release([t.key]);
  const wasCur = i === P.index, wasPlaying = isPlaying();
  list.splice(i, 1); order = [];
  if (wasCur) {
    endCrossfade(); engine.unload(engine.deck); P.index = -1;
    if (list.length && wasPlaying) playIndex(Math.min(i, list.length - 1));
    else { onTrackChange(); onPlayState(); }
  } else if (i < P.index) P.index--;
  refreshView(); saveList();
}
async function clearList() {
  if (!list.length) return;
  const ok = await dialog({ title: '재생목록을 비울까요?', text: `${list.length}곡이 목록에서 빠져요. 파일은 지워지지 않아요.`, okText: '비우기' });
  if (!ok) return;
  endCrossfade(); engine.unload(engine.deck); engine.unload(engine.other);
  if (platform.release) platform.release(list.map(t => t.key));
  list.forEach(t => { t.removed = true; }); list = []; P.index = -1; order = [];
  refreshView(); saveList(); onTrackChange(); onPlayState();
}
function sortList(kind) {
  const cur = list[P.index];
  const key = t => kind === 'artist' ? `${t.artist}\u0000${t.album}\u0000${displayTitle(t)}` : kind === 'name' ? t.name : displayTitle(t);
  if (kind === 'random') { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } }
  else list.sort((a, b) => key(a).localeCompare(key(b), 'ko', { numeric: true, sensitivity: 'base' }));
  P.index = cur ? list.indexOf(cur) : -1; order = [];
  refreshView(); saveList(); scrollToCurrent();
}

async function pickFiles() { try { addItems(await platform.pickFiles(), {}); } catch (e) { toast(errMsg(e, '파일을 열지 못했어요')); } }
async function pickFolder() {
  try { const items = await platform.pickFolder(); if (items && !items.length) toast('폴더에서 음악 파일을 찾지 못했어요'); addItems(items); }
  catch (e) { toast(errMsg(e, '폴더를 열지 못했어요')); }
}
async function scanLibrary() {
  toast('음악을 찾는 중이에요…');
  try { const items = await platform.scanLibrary(); if (!items.length) toast('음악 파일을 찾지 못했어요'); else addItems(items); }
  catch (e) { toast(errMsg(e, '음악을 불러오지 못했어요')); }
}
const errMsg = (e, d) => (e && e.message && /[가-힣]/.test(e.message)) ? e.message : d;

function toolButtons() {
  return [
    el('button', { class: 'btn', onclick: pickFiles }, icon('file'), '파일 추가'),
    el('button', { class: 'btn', onclick: pickFolder }, icon('folder'), '폴더 추가'),
    platform.canScan ? el('button', { class: 'btn', onclick: scanLibrary }, icon('note'), platform.scanLabel + ' 불러오기') : null,
  ];
}
function renderListTools() {
  $('listTools').replaceChildren(...toolButtons().filter(Boolean));
  setIcon($('btnSearch'), 'search'); setIcon($('btnListMenu'), 'more');
  $('btnSearch').onclick = () => {
    const box = $('searchBox'); box.hidden = !box.hidden;
    if (!box.hidden) $('searchInput').focus(); else { query = ''; $('searchInput').value = ''; refreshView(); }
  };
  $('searchInput').addEventListener('input', debounce(e => { query = e.target.value; refreshView(); vlist.scrollTop = 0; }, 120));
  $('btnListMenu').onclick = e => openMenu(e.currentTarget, [
    ['sort', '제목 순으로 정렬', () => sortList('title')],
    ['sort', '아티스트 순으로 정렬', () => sortList('artist')],
    ['sort', '파일 이름 순으로 정렬', () => sortList('name')],
    ['shuffle', '목록 섞기', () => sortList('random')],
    null,
    ['trash', '목록 비우기', clearList],
  ]);
}
function renderEmpty() {
  $('empty').replaceChildren(
    el('div', { class: 'big' }, icon('note')),
    el('b', {}, '재생목록이 비어 있어요'),
    el('div', {}, platform.name === 'electron' ? '음악 파일이나 폴더를 추가하거나 창에 끌어다 놓으세요' : '음악 파일이나 폴더를 추가하세요'),
    el('div', { class: 'tools' }, ...toolButtons()));
}

/* ======================= 공통 컨트롤 ======================= */
function switchEl(on, onChange, label) {
  const b = el('button', { class: 'sw', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label || '' });
  b.addEventListener('click', e => { e.stopPropagation(); const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onChange(v); });
  return b;
}
function segmented(options, value, onChange) {
  const box = el('div', { class: 'seg' });
  for (const [v, label] of options) {
    box.append(el('button', { 'aria-pressed': String(v === value), onclick: () => { box.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', 'false')); box.querySelector(`[data-v="${CSS.escape(String(v))}"]`).setAttribute('aria-pressed', 'true'); onChange(v); }, 'data-v': String(v) }, label));
  }
  return box;
}
function selectEl(options, value, onChange) {
  const s = el('select', { class: 'sel' });
  for (const [v, label] of options) s.append(el('option', { value: String(v), selected: String(v) === String(value) }, label));
  s.onchange = () => { const o = options.find(([v]) => String(v) === s.value); onChange(o ? o[0] : s.value); };
  return s;
}
function rangeEl({ min, max, step, value, center, label, onInput, onReset }) {
  const r = el('input', { type: 'range', min, max, step, value, 'aria-label': label });
  r.value = value;
  r.addEventListener('input', () => { paintRange(r, center); onInput(+r.value); });
  if (onReset) r.addEventListener('dblclick', () => { r.value = onReset(); paintRange(r, center); onInput(+r.value); });
  paintRange(r, center);
  return r;
}

/* ======================= 화면: 음장 효과 ======================= */
function fmtParam(p, v) {
  if (p.fmt) return p.fmt(v);
  const u = p.unit;
  if (p.k === 'semitones') return v === 0 ? '0' : (v > 0 ? '+' : '') + v;
  if (u === 'Hz') return v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + ' kHz' : v < 10 ? (+v).toFixed(2) + ' Hz' : Math.round(v) + ' Hz';
  if (u === 'dB') return (v > 0 ? '+' : '') + (+v).toFixed(1) + ' dB';
  if (u === '%') return Math.round(v) + '%';
  if (u === ':1') return (+v) + ':1';
  if (u === '°' || u === '×') return v + u;
  if (u === 'ms') return Math.round(v) + ' ms';
  if (u === '초') return v + '초';
  return v + (u ? ' ' + u : '');
}
function activeFxCount() { return FX.filter(f => f.id !== 'limiter' && S.fx[f.id] && S.fx[f.id].on).length; }
function updateBadges() {
  const n = S.fxOn ? activeFxCount() : 0;
  for (const id of ['fxBadge', 'fxBadgeM']) { const b = $(id); b.textContent = n; b.hidden = !n; }
}
function renderFx() {
  const pane = $('paneFx'), st0 = pane.scrollTop;
  const top = el('div', { class: 'fxtop' },
    el('div', {}, el('div', { class: 'label' }, '음장 효과'), el('div', { class: 'hint' }, S.fxOn ? `켜진 효과 ${activeFxCount()}개` : '꺼짐 — 원음으로 듣는 중')),
    el('span', { class: 'sp' }),
    activeFxCount() ? el('button', { class: 'link', onclick: () => applySoundPreset(SOUND_PRESETS[0]) }, '모두 끄기') : null,
    switchEl(S.fxOn, v => { S.fxOn = v; engine.setBypass(!v); saveSettings(); renderFx(); renderEq(); updateBadges(); toast(v ? '음장 효과를 켰어요' : '원음으로 들어요'); }, '음장 효과 전체 사용'));
  const chips = el('div', { class: 'chips', id: 'presetChips' });
  for (const pr of SOUND_PRESETS) chips.append(el('button', { class: 'chip', 'aria-pressed': String(S.preset === pr.id), onclick: () => applySoundPreset(pr) }, pr.name));
  for (const up of userPresets) {
    chips.append(el('button', { class: 'chip user', 'aria-pressed': String(S.preset === up.id), onclick: () => applyUserPreset(up) }, up.name,
      el('span', { class: 'del', title: '삭제', onclick: e => { e.stopPropagation(); deleteUserPreset(up); } }, icon('close'))));
  }
  chips.append(el('button', { class: 'chip add', onclick: saveUserPreset }, icon('plus'), '지금 설정 저장'));
  const listEl = el('div', { class: 'fxlist' + (S.fxOn ? '' : ' off') });
  for (const cat of CATEGORIES) {
    const defs = FX.filter(f => f.cat === cat.id);
    if (!defs.length) continue;
    listEl.append(el('div', { class: 'cat' }, cat.name));
    for (const def of defs) listEl.append(fxCard(def));
  }
  pane.replaceChildren(top, chips, listEl);
  pane.scrollTop = st0;
}
function fxCard(def) {
  const st = fxState(def.id);
  const card = el('div', { class: 'fx' + (st.on ? ' on' : ''), 'data-id': def.id });
  const sw = switchEl(st.on, v => {
    st.on = v; S.preset = null;
    if (v && !S.fxOn) { S.fxOn = true; engine.setBypass(false); }
    engine.setEnabled(def.id, v); saveSettings();
    card.replaceWith(fxCard(def)); refreshFxHeader();
  }, def.name);
  card.append(el('div', { class: 'fx-head', onclick: () => sw.click() },
    el('div', { class: 'tt' }, el('div', { class: 'fx-name' }, def.name), el('div', { class: 'fx-desc' }, def.desc)), sw));
  if (st.on && def.params.length) card.append(fxBody(def));
  return card;
}
function fxBody(def) {
  const st = fxState(def.id), body = el('div', { class: 'fx-body' });
  for (const p of def.params) {
    const out = el('output', {}, p.type ? '' : fmtParam(p, st.p[p.k]));
    const setP = v => { st.p[p.k] = v; engine.setParam(def.id, p.k, v); if (S.preset) { S.preset = null; refreshPresetChips(); } saveSettings(); };
    let ctl;
    if (p.type === 'select') ctl = p.options.length <= 4 ? segmented(p.options, st.p[p.k], setP) : selectEl(p.options, st.p[p.k], setP);
    else if (p.type === 'toggle') ctl = switchEl(!!st.p[p.k], setP, p.label);
    else ctl = rangeEl({ min: p.min, max: p.max, step: p.step, value: st.p[p.k], center: p.center, label: p.label, onInput: v => { setP(v); out.textContent = fmtParam(p, v); }, onReset: () => p.def });
    body.append(el('div', { class: 'prm' }, el('label', {}, p.label), el('div', { class: 'ctl' }, ctl), out));
  }
  body.append(el('div', { class: 'fx-foot' }, el('button', {
    class: 'link', onclick: () => {
      st.p = defaultParams(def);
      for (const [k, v] of Object.entries(st.p)) engine.setParam(def.id, k, v);
      saveSettings(); body.replaceWith(fxBody(def));
    },
  }, '기본값으로')));
  return body;
}
function refreshPresetChips() {
  document.querySelectorAll('#presetChips .chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
}
function refreshFxHeader() {
  const pane = $('paneFx'), old = pane.querySelector('.fxtop'), oldChips = pane.querySelector('.chips');
  const st0 = pane.scrollTop;
  renderFx(); pane.scrollTop = st0;
  void old; void oldChips;
  updateBadges();
}
function applySoundPreset(pr) {
  for (const def of FX) if (def.id !== 'limiter') fxState(def.id).on = false;
  for (const [id, p] of Object.entries(pr.fx)) { const st = fxState(id); st.on = true; st.p = { ...defaultParams(FX_BY_ID[id]), ...p }; }
  if (pr.eqOff) S.eq.on = false;
  S.fxOn = true; S.preset = pr.id;
  engine.applyAll(S.fx, S.eq, false);
  saveSettings(); renderFx(); renderEq(); updateBadges();
  toast(pr.id === 'off' ? '모든 음장 효과를 껐어요' : `음장 프리셋 '${pr.name}'`);
}
async function saveUserPreset() {
  const name = await dialog({ title: '지금 설정 저장', text: '켜 둔 음장 효과와 이퀄라이저를 프리셋으로 저장해요.', input: '내 프리셋 ' + (userPresets.length + 1), okText: '저장' });
  if (!name) return;
  const up = { id: 'u' + Date.now(), name: String(name).slice(0, 20), fx: JSON.parse(JSON.stringify(S.fx)), eq: JSON.parse(JSON.stringify(S.eq)) };
  userPresets.push(up); store(LS.pre, userPresets);
  S.preset = up.id; saveSettings(); renderFx();
  toast(`'${up.name}' 저장했어요`);
}
function applyUserPreset(up) {
  S.fx = JSON.parse(JSON.stringify(up.fx)); S.eq = JSON.parse(JSON.stringify(up.eq));
  FX.forEach(d => fxState(d.id));
  S.fxOn = true; S.preset = up.id;
  engine.applyAll(S.fx, S.eq, false);
  saveSettings(); renderFx(); renderEq(); updateBadges();
  toast(`'${up.name}' 적용`);
}
async function deleteUserPreset(up) {
  const ok = await dialog({ title: '프리셋 삭제', text: `'${up.name}'을(를) 삭제할까요?`, okText: '삭제' });
  if (!ok) return;
  userPresets = userPresets.filter(x => x !== up); store(LS.pre, userPresets);
  if (S.preset === up.id) S.preset = null;
  saveSettings(); renderFx();
}

/* ======================= 화면: 이퀄라이저 ======================= */
function biquadDb(type, f0, gainDb, f, sr) {
  const A = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peaking') { const al = sw / (2 * 1.1); b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
  else {
    const al = sw / 2 * Math.SQRT2, s = 2 * Math.sqrt(A) * al;
    if (type === 'lowshelf') { b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s); a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; }
    else { b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s); a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; }
  }
  const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
function drawCurve() {
  const c = $('eqCurve'); if (!c || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue('--accent').trim(), line = cs.getPropertyValue('--line2').trim(), faint = cs.getPropertyValue('--faint').trim();
  const sr = 48000, N = Math.max(80, Math.floor(w / 3)), R = 15;
  const xOf = f => Math.log(f / 20) / Math.log(1000) * w, yOf = db => h / 2 - db / R * (h / 2 - 8);
  g.strokeStyle = line; g.lineWidth = 1; g.font = '10px system-ui'; g.fillStyle = faint;
  for (const f of [100, 1000, 10000]) { const x = Math.round(xOf(f)) + .5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 3, h - 4); }
  for (const d of [-12, -6, 0, 6, 12]) { const y = Math.round(yOf(d)) + .5; g.globalAlpha = d === 0 ? 1 : .45; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  g.globalAlpha = 1;
  const pts = [];
  for (let k = 0; k < N; k++) {
    const f = 20 * Math.pow(1000, k / (N - 1));
    let db = S.eq.p.preamp || 0;
    EQ_FREQS.forEach((f0, i) => {
      const type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      db += biquadDb(type, i === 0 ? 45 : i === EQ_FREQS.length - 1 ? 12000 : f0, S.eq.p['b' + i] || 0, f, sr);
    });
    pts.push([xOf(f), yOf(clamp(db, -R, R))]);
  }
  g.beginPath(); g.moveTo(0, yOf(0)); pts.forEach(([x, y]) => g.lineTo(x, y)); g.lineTo(w, yOf(0)); g.closePath();
  g.fillStyle = accent; g.globalAlpha = .14; g.fill(); g.globalAlpha = 1;
  g.beginPath(); pts.forEach(([x, y], k) => k ? g.lineTo(x, y) : g.moveTo(x, y));
  g.strokeStyle = accent; g.lineWidth = 2; g.stroke();
}
function vSlider({ min, max, step, value, label, onInput }) {
  const root = el('div', { class: 'vs', tabindex: '0', role: 'slider', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max, 'aria-orientation': 'vertical' });
  const fill = el('div', { class: 'fill' }), th = el('div', { class: 'th' });
  root.append(el('div', { class: 'tr' }), el('div', { class: 'zero' }), fill, th);
  let v = value;
  const pos = p => `calc(9px + ${p} * (100% - 18px))`;
  const paint = () => {
    const p = (v - min) / (max - min), z = (0 - min) / (max - min);
    th.style.top = pos(1 - p);
    fill.style.top = pos(1 - Math.max(p, z)); fill.style.bottom = pos(Math.min(p, z));
    root.setAttribute('aria-valuenow', v); root.setAttribute('aria-valuetext', (v > 0 ? '+' : '') + v + ' dB');
  };
  const set = nv => { nv = clamp(Math.round(nv / step) * step, min, max); if (nv === v) return; v = nv; paint(); onInput(v); };
  const fromY = y => { const r = root.getBoundingClientRect(); return min + clamp(1 - (y - r.top - 9) / (r.height - 18), 0, 1) * (max - min); };
  root.addEventListener('pointerdown', e => { root.setPointerCapture(e.pointerId); set(fromY(e.clientY)); e.preventDefault(); root.focus({ preventScroll: true }); });
  root.addEventListener('pointermove', e => { if (root.hasPointerCapture(e.pointerId)) set(fromY(e.clientY)); });
  root.addEventListener('keydown', e => {
    const k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowRight') set(v + step); else if (k === 'ArrowDown' || k === 'ArrowLeft') set(v - step);
    else if (k === 'PageUp') set(v + 3); else if (k === 'PageDown') set(v - 3); else if (k === 'Home') set(max); else if (k === 'End') set(min);
    else return;
    e.preventDefault();
  });
  root.addEventListener('dblclick', () => set(0));
  paint();
  return root;
}
const fmtDb = v => (v > 0 ? '+' : '') + (+v).toFixed(1);
function eqTouch() { if (!S.eq.on) { S.eq.on = true; engine.setEnabled('eq', true); const sw = $('eqSwitch'); if (sw) sw.setAttribute('aria-checked', 'true'); $('paneEq').classList.remove('eqoff'); } }
function applyEqPreset(id) {
  const pr = EQ_PRESETS.find(p => p[0] === id); if (!pr) return;
  pr[2].forEach((v, i) => { S.eq.p['b' + i] = v; engine.setParam('eq', 'b' + i, v); });
  S.eq.preset = id; if (S.preset) S.preset = null;
  eqTouch(); saveSettings(); renderEq();
}
function renderEq() {
  const pane = $('paneEq');
  pane.classList.toggle('eqoff', !S.eq.on);
  const sw = switchEl(S.eq.on, v => { S.eq.on = v; engine.setEnabled('eq', v); pane.classList.toggle('eqoff', !v); saveSettings(); }, '이퀄라이저 사용');
  sw.id = 'eqSwitch';
  const opts = EQ_PRESETS.map(([id, name]) => [id, name]);
  if (S.eq.preset === 'custom') opts.push(['custom', '사용자 설정']);
  const bands = el('div', { class: 'eqbands' });
  EQ_FREQS.forEach((f, i) => {
    const out = el('output', {}, fmtDb(S.eq.p['b' + i]));
    bands.append(el('div', { class: 'band' }, out,
      vSlider({ min: -12, max: 12, step: 0.5, value: S.eq.p['b' + i], label: `${f >= 1000 ? f / 1000 + 'k' : f}Hz`, onInput: v => {
        S.eq.p['b' + i] = v; engine.setParam('eq', 'b' + i, v); out.textContent = fmtDb(v);
        if (S.eq.preset !== 'custom') { S.eq.preset = 'custom'; const sel = pane.querySelector('select'); if (sel && !sel.querySelector('[value=custom]')) sel.append(el('option', { value: 'custom' }, '사용자 설정')); if (sel) sel.value = 'custom'; }
        eqTouch(); saveSettings(); drawCurve();
      } }),
      el('label', {}, f >= 1000 ? f / 1000 + 'k' : String(f))));
  });
  const preOut = el('output', {}, fmtDb(S.eq.p.preamp) + ' dB');
  pane.replaceChildren(
    el('div', { class: 'eqtop' }, el('span', { class: 'label' }, '10밴드 이퀄라이저'), el('span', { class: 'sp' }), sw),
    el('div', { class: 'eqtop' }, selectEl(opts, S.eq.preset, id => { if (id !== 'custom') applyEqPreset(id); }), el('span', { class: 'sp' }),
      el('button', { class: 'btn ghost', onclick: () => applyEqPreset('flat') }, '초기화')),
    el('canvas', { class: 'eqcurve', id: 'eqCurve' }),
    bands,
    el('div', { class: 'row2' }, el('label', {}, '프리앰프'),
      rangeEl({ min: -12, max: 12, step: 0.5, value: S.eq.p.preamp, center: 0, label: '프리앰프', onReset: () => 0, onInput: v => { S.eq.p.preamp = v; engine.setParam('eq', 'preamp', v); preOut.textContent = fmtDb(v) + ' dB'; eqTouch(); saveSettings(); drawCurve(); } }),
      preOut),
    el('p', { class: 'about', style: 'margin-top:14px' }, '막대를 두 번 누르면 0 dB로 돌아가요. 크게 올릴 때는 프리앰프를 조금 낮추면 소리가 찌그러지지 않아요.'));
  requestAnimationFrame(drawCurve);
}
new ResizeObserver(() => drawCurve()).observe($('paneEq'));

/* ======================= 화면: 설정 ======================= */
function srow(title, hint, ...ctl) { return el('div', { class: 'srow' }, el('div', { class: 'tt' }, title, hint ? el('small', {}, hint) : null), ...ctl); }
function renderSettings() {
  const pane = $('paneSet');
  const cfOut = el('output', {}, S.crossfade ? S.crossfade + '초' : '끔');
  const volOut = el('output', {}, Math.round(S.volume * 100) + '%');
  const setVol = rangeEl({ min: 0, max: 100, step: 1, value: Math.round(S.volume * 100), label: '볼륨', onInput: v => { S.volume = v / 100; S.muted = false; engine.setVolume(S.volume, false); saveSettings(); renderVolume(); } });
  setVol.id = 'setVol';
  const sleepVal = P.sleepAt ? P.sleepMin : 0;
  pane.replaceChildren(
    el('div', { class: 'sgroup' }, el('h3', {}, '재생'),
      srow('볼륨', '앱 안에서의 음량', setVol, volOut),
      srow('크로스페이드', '곡이 바뀔 때 앞뒤 곡을 겹쳐서 자연스럽게', rangeEl({ min: 0, max: 12, step: 1, value: S.crossfade, label: '크로스페이드', onInput: v => { S.crossfade = v; cfOut.textContent = v ? v + '초' : '끔'; saveSettings(); } }), cfOut),
      srow('수면 타이머', P.sleepAt ? `${new Date(P.sleepAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}에 멈춰요` : '정해진 시간 뒤에 서서히 멈춤',
        segmented([[0, '끔'], [15, '15분'], [30, '30분'], [60, '1시간'], [90, '1시간 30분']], sleepVal, v => { setSleep(v); renderSettings(); })),
      srow('이어 듣기', '다시 열면 마지막 곡의 그 위치부터', switchEl(S.resume, v => { S.resume = v; saveSettings(); }, '이어 듣기'))),
    el('div', { class: 'sgroup' }, el('h3', {}, '가사'),
      srow('인터넷에서 가사 자동으로 찾기', '곡이 바뀌면 제목 · 가수 · 앨범 · 길이로 LRCLIB(lrclib.net)와 다른 사용자들이 고른 가사 목록에서 찾아요', switchEl(S.lyrAuto, v => { S.lyrAuto = v; saveSettings(); }, '가사 자동으로 찾기')),
      srow('내가 고른 가사를 다른 사용자와 나누기', '직접 고르거나 틀렸다고 한 가사를 자동으로 알려, 여러 사람이 고른 가사가 모두의 앱에 나와요. 곡 제목 · 가수 · 길이와 가사 번호만 익명으로 보내요.', switchEl(S.lyrShare, v => { S.lyrShare = v; saveSettings(); if (v) flushFeedback().catch(() => {}); }, '고른 가사 나누기'))),
    el('div', { class: 'sgroup' }, el('h3', {}, '화면'),
      srow('테마', null, segmented([['system', '시스템'], ['dark', '어둡게'], ['light', '밝게']], S.theme, v => { S.theme = v; saveSettings(); applyTheme(); })),
      srow('강조 색', null, el('div', { class: 'swatches' }, ...[['blue', '#4c9dff'], ['mint', '#1fc8a0'], ['coral', '#ff7158'], ['violet', '#8f7dff'], ['amber', '#f2b33d']].map(([id, c]) =>
        el('button', { class: 'swatch', style: `background:${c}`, 'aria-pressed': String(S.accent === id), 'aria-label': id, onclick: () => { S.accent = id; saveSettings(); applyTheme(); renderSettings(); } }))))),
    el('div', { class: 'sgroup' }, el('h3', {}, '초기화'),
      srow('음장 효과 · 이퀄라이저 초기화', '모든 효과를 끄고 기본값으로', el('button', { class: 'btn', onclick: resetSound }, '초기화')),
      srow('모든 설정 초기화', '재생목록은 그대로 두고 설정만', el('button', { class: 'btn', onclick: resetAll }, '초기화'))),
    el('div', { class: 'sgroup' }, el('h3', {}, '정보'),
      el('div', { class: 'srow about' }, el('div', {},
        el('b', {}, `울림 ${VERSION}`), el('br'),
        '무료로 공개된 음장 기법만 사용했어요: Freeverb 리버브(Jezar, 퍼블릭 도메인), bs2b 헤드폰 크로스피드 공식(MIT), RBJ 오디오 EQ 필터 공식, 브라우저 엔진 내장 HRTF 입체음향, 크로스-코릴레이션 피치 시프트, 가상 저음 · 초저음, 크리스탈라이저 등.', el('br'),
        '가사는 LRCLIB(lrclib.net) — 사용자들이 함께 만드는 무료 공개 가사 데이터베이스에서 가져오고, 음악 파일에 들어 있는 가사와 같은 이름의 .lrc 파일도 읽어요.', el('br'),
        el('button', { class: 'link', onclick: () => openExternal(`https://github.com/${REPO}`) }, `github.com/${REPO}`), el('br'),
        `${platform.name === 'android' ? 'Android System WebView' : platform.name === 'electron' ? 'Electron · Chromium' : '브라우저'} 위에서 Web Audio API로 동작해요.`))));
}
async function resetSound() {
  const ok = await dialog({ title: '음장 효과를 초기화할까요?', text: '모든 효과와 이퀄라이저가 기본값으로 돌아가요.', okText: '초기화' });
  if (!ok) return;
  S.fx = { limiter: { on: true, p: defaultParams(FX_BY_ID.limiter) } }; FX.forEach(d => fxState(d.id));
  S.eq = DEF_EQ(); S.fxOn = true; S.preset = null;
  engine.applyAll(S.fx, S.eq, false); saveSettings(); renderFx(); renderEq(); updateBadges();
  toast('초기화했어요');
}
async function resetAll() {
  const ok = await dialog({ title: '모든 설정을 초기화할까요?', text: '재생목록은 그대로 남아요.', okText: '초기화' });
  if (!ok) return;
  localStorage.removeItem(LS.set);
  location.reload();
}

/* ======================= 화면: 가사 ======================= */
const LY = { key: null, state: 'idle', data: null, idx: -1, tok: 0, userScroll: 0, form: false, fix: null, prev: null };
async function localLyrics(t) {
  if (platform.findLrc) {
    try { const b = await platform.findLrc(t.key); if (b && b.length) { const l = toLyrics(decodeText(b), 'lrc'); if (l.lines.length) return l; } } catch (e) { /* none */ }
  }
  const info = await tagInfo(t);
  if (info && info.lyrics) { const l = toLyrics(info.lyrics, 'tag'); if (l.lines.length) return l; }
  return null;
}
async function loadLyrics(t, { force = false, retry = false } = {}) {
  if (lyRetry) lyRetry();
  const tok = ++LY.tok;
  LY.key = t ? t.key : null; LY.data = null; LY.idx = -1; LY.form = false; LY.fix = null; LY.prev = null; LY.slow = false;
  if (!t) { LY.state = 'idle'; renderLyrics(); return; }
  LY.state = 'loading'; renderLyrics();
  const show = (data, state) => { if (tok !== LY.tok) return; LY.data = data; LY.state = state || (!data ? 'none' : data.instrumental ? 'instrumental' : 'ok'); renderLyrics(); };
  const c = force ? null : cacheGet(t.key);
  // 1) 내가 고른 가사 → 2) 파일 속 가사 · 같은 이름의 .lrc
  if (c && !c.none && c.source === 'manual') return show(c);
  if (!force) { const local = await localLyrics(t); if (tok !== LY.tok) return; if (local) return show(local); }
  if (!S.lyrAuto && !force) return c && !c.none ? show(c) : show(null, c && c.none && c.manual ? 'none' : 'manual');
  const q = guessQuery(t);
  const a = engine.deck.a;
  const dur = engine.deck.track === t && isFinite(a.duration) && a.duration > 0 ? a.duration : (t.duration || 0);
  const mine = c && c.none && c.manual ? c : null;   // 내가 '틀렸다'고만 알린 곡
  const stale = () => tok !== LY.tok;
  // 가사 화면을 안 보고 있으면 곡을 빨리 넘길 때 요청이 쌓이지 않게 잠깐 기다렸다가 찾는다
  if (!force && (!$('paneLyr') || $('paneLyr').hidden)) { await new Promise(r => setTimeout(r, 2500)); if (stale()) return; }
  try {
    // 3) 다른 사용자들이 고른 가사 (GitHub 의 공용 목록, 6시간마다 새로 받음)
    await loadOverrides();
    if (tok !== LY.tok) return;
    const com = communityFor(q);
    if (com && com.pick === 0 && !mine) return show({ instrumental: true, synced: false, lines: [], raw: '', source: 'community' });
    if (com && com.pick && !(mine && mine.wrong === com.pick)) {
      if (c && !c.none && c.match && Number(c.match.id) === com.pick) return show({ ...c, source: 'community' });
      const l = await getById(com.pick, { stale });
      if (tok !== LY.tok) return;
      if (l) { l.source = 'community'; if (!mine) cachePut(t.key, l); return show(l); }
    }
    if (mine) return show(null, 'none');
    // 4) 전에 자동으로 찾은 가사 — 다른 사용자들이 틀렸다고 한 것은 버리고 다시 찾는다
    const wrong = com ? com.wrong : [];
    if (c && !c.none && !(c.match && wrong.includes(Number(c.match.id)))) return show(c);
    if (c && c.none) return show(null, 'none');
    // 5) 자동 검색
    const res = await findOnline(q, dur, wrong, { stale, onBusy: () => { if (!stale() && LY.state === 'loading') { LY.slow = true; renderLyrics(); } } });
    if (tok !== LY.tok) return;
    cachePut(t.key, res);          // 끝까지 찾았을 때만 여기 온다 (없으면 '없음'으로 하루 기억)
    show(res);
  } catch (e) {
    if (tok !== LY.tok || (e instanceof LookupError && e.kind === 'stale')) return;
    const kind = e instanceof LookupError ? e.kind : 'busy';
    show(null, kind === 'offline' || navigator.onLine === false ? 'offline' : 'busy');
    retryLyricsLater(t, tok, LY.state);
  }
}
/** 서버가 붐비면 잠시 뒤, 인터넷이 끊겼으면 다시 연결될 때 같은 곡이면 자동으로 다시 찾는다 */
let lyRetry = null;
function retryLyricsLater(t, tok, state) {
  if (lyRetry) lyRetry();
  const again = () => { cancel(); if (tok === LY.tok && list[P.index] === t) loadLyrics(t, { retry: true }); };
  const timer = setTimeout(again, state === 'offline' ? 60000 : 30000);
  const onOnline = () => setTimeout(again, 1500);
  window.addEventListener('online', onOnline);
  const cancel = () => { clearTimeout(timer); window.removeEventListener('online', onOnline); lyRetry = null; };
  lyRetry = cancel;
}
const fmtSrc = d => !d ? '' : d.source === 'lrc' ? '.lrc 파일' : d.source === 'tag' ? '음악 파일에 들어 있는 가사'
  : d.source === 'community' ? '다른 사용자들이 고른 가사' + (d.synced ? ' · 싱크' : '') : d.source === 'manual' ? '내가 고른 가사' + (d.synced ? ' · 싱크' : '')
  : d.source === 'lrclib' ? 'LRCLIB 자동 검색' + (d.synced ? ' · 싱크' : '') : '';
const ONLINE = ['lrclib', 'manual', 'community'];
function renderLyrics() {
  const pane = $('paneLyr');
  if (!pane || pane.hidden) return;
  const t = list[P.index];
  pane.style.setProperty('--ly-size', S.lyrSize + 'px');
  const size = d => { S.lyrSize = clamp(S.lyrSize + d, 14, 34); saveSettings(); pane.style.setProperty('--ly-size', S.lyrSize + 'px'); LY.idx = -2; syncLyrics(true); };
  const head = el('div', { class: 'lyhead' },
    el('div', { class: 'tt' }, el('div', { class: 'lytitle' }, t ? displayTitle(t) : '가사'), el('div', { class: 'lysub' }, t ? [t.artist, fmtSrc(LY.data)].filter(Boolean).join(' · ') : '')),
    el('button', { class: 'ib', title: '글자 작게', 'aria-label': '글자 작게', onclick: () => size(-2) }, el('span', { class: 'aa' }, '가-')),
    el('button', { class: 'ib', title: '글자 크게', 'aria-label': '글자 크게', onclick: () => size(2) }, el('span', { class: 'aa' }, '가+')),
    t ? el('button', { class: 'ib' + (LY.form ? ' on' : ''), title: '직접 검색', 'aria-label': '가사 직접 검색', onclick: () => LY.form ? closeLyricsForm() : openLyricsForm(null) }, icon('search')) : null);
  const kids = [head];
  if (LY.form && t) kids.push(lyricsForm(t));
  const msg = (text, ...extra) => el('div', { class: 'lystate' }, el('div', {}, text), ...extra);
  const online = LY.data && ONLINE.includes(LY.data.source);
  if (!t) kids.push(msg('재생 중인 곡이 없어요'));
  else if (LY.state === 'loading') kids.push(LY.slow ? msg('가사 서버(LRCLIB)가 붐벼서 조금 오래 걸리고 있어요…', el('div', { class: 'hint' }, '잠깐씩 기다렸다가 다시 물어보는 중이에요')) : msg('가사를 찾는 중이에요…'));
  else if (LY.state === 'manual') kids.push(msg('저장된 가사가 없어요', el('button', { class: 'btn', onclick: () => loadLyrics(t, { force: true }) }, icon('search'), '인터넷에서 찾기')));
  else if (LY.state === 'none') kids.push(msg('가사를 찾지 못했어요', el('div', { class: 'hint' }, '제목이나 가수 이름을 바꿔서 직접 검색해 보세요.' + (S.lyrShare ? ' 맞는 가사를 고르면 다른 사용자들에게도 그 가사가 나와요.' : '')),
    el('div', { class: 'tools' }, el('button', { class: 'btn', onclick: () => openLyricsForm(null) }, icon('search'), '직접 검색'), el('button', { class: 'btn ghost', onclick: () => { cacheDrop(t.key); loadLyrics(t, { force: true }); } }, '다시 찾기'))));
  else if (LY.state === 'offline') kids.push(msg('인터넷에 연결되어 있지 않아요', el('div', { class: 'hint' }, '연결되면 자동으로 다시 찾아요'),
    el('button', { class: 'btn', onclick: () => loadLyrics(t, { force: true }) }, '다시 시도')));
  else if (LY.state === 'busy') kids.push(msg('가사 서버(LRCLIB)가 지금 붐벼서 가사를 가져오지 못했어요', el('div', { class: 'hint' }, '30초 뒤 자동으로 다시 찾아볼게요'),
    el('button', { class: 'btn', onclick: () => loadLyrics(t, { force: true }) }, '지금 다시 시도')));
  else if (LY.state === 'instrumental') {
    kids.push(msg(LY.data && LY.data.match ? '연주곡이에요 — 가사가 없어요' : '가사가 없는 곡이에요'));
    if (online) kids.push(lyricsFooter());
  } else if (LY.data) {
    const body = el('div', { class: 'lybody' + (LY.data.synced ? ' synced' : ' plain'), id: 'lyBody' });
    LY.data.lines.forEach((l, i) => {
      if (!l.text) { body.append(el('p', { class: 'ly gap', 'data-i': i })); return; }
      body.append(el('p', { class: 'ly', 'data-i': i }, l.text));
    });
    if (LY.data.synced) body.addEventListener('click', e => { const p = e.target.closest('.ly'); if (!p) return; const l = LY.data.lines[+p.dataset.i]; if (l && l.t != null) { seekTo(l.t); LY.userScroll = 0; } });
    kids.push(body);
    if (online) kids.push(lyricsFooter());
  }
  pane.replaceChildren(...kids);
  pane.scrollTop = 0;
  LY.idx = -2;
  syncLyrics(true);
}
function lyricsFooter() {
  return el('div', { class: 'credit' }, '가사 제공: LRCLIB (lrclib.net) · ',
    el('button', { class: 'link', onclick: () => openLyricsForm({ wrongId: LY.data && LY.data.match ? Number(LY.data.match.id) || null : null }) }, '틀린 가사 제보'));
}
function openLyricsForm(fix) {
  LY.form = true; LY.fix = fix;
  LY.prev = LY.data ? { source: LY.data.source, id: LY.data.match ? Number(LY.data.match.id) || null : null } : { source: 'none', id: null };
  renderLyrics();
}
function closeLyricsForm() { LY.form = false; LY.fix = null; renderLyrics(); }
function openExternal(url) { if (platform.openExternal) platform.openExternal(url); else window.open(url, '_blank', 'noopener'); }
/** 내가 고른 가사를 다른 사용자에게 자동으로 알린다 (설정에서 끌 수 있음). correct: LRCLIB 번호 · 0(가사 없음) · null(모름) */
function shareChoice(t, wrongId, correct) {
  if (!S.lyrShare || (correct != null && correct === wrongId)) return false;
  const com = communityFor(guessQuery(t));
  if (correct != null && !wrongId && com && com.pick === correct) return false;   // 이미 모두가 쓰고 있는 가사
  const a = engine.deck.a, dur = engine.deck.track === t && isFinite(a.duration) && a.duration > 0 ? a.duration : t.duration;
  sendFeedback(guessQuery(t), dur, wrongId, correct, VERSION).catch(() => {});
  return true;
}
function setLyricsLocal(t, l, state) {
  cachePut(t.key, l);
  if (list[P.index] !== t) return;
  LY.data = l; LY.state = state || (!l ? 'none' : l.instrumental ? 'instrumental' : 'ok'); LY.form = false; LY.fix = null;
  renderLyrics();
}
function fixActions(t) {
  if (!LY.fix) return null;
  const wrongId = LY.fix.wrongId;
  return el('div', { class: 'fixbar' },
    el('div', { class: 'hint' }, '아래 검색 결과에서 맞는 가사를 골라 주세요. 맞는 가사가 없다면:'),
    el('div', { class: 'tools' },
      el('button', { class: 'btn', onclick: () => {
        setLyricsLocal(t, { instrumental: true, synced: false, lines: [], raw: '', source: 'manual' });
        toast(shareChoice(t, wrongId, 0) ? '가사 없는 곡으로 정했어요 · 다른 사용자에게도 알렸어요' : '이 곡은 가사 없이 표시할게요');
      } }, '가사가 없는 곡이에요'),
      wrongId ? el('button', { class: 'btn ghost', onclick: () => {
        cachePut(t.key, null, { manual: true, wrong: wrongId });
        if (list[P.index] === t) { LY.data = null; LY.state = 'none'; LY.form = false; LY.fix = null; renderLyrics(); }
        toast(shareChoice(t, wrongId, null) ? '이 가사는 빼고, 다른 사용자에게도 알렸어요' : '이 가사는 더 이상 보여 주지 않을게요');
      } }, '틀렸다고만 알리기') : null));
}
function lyricsForm(t) {
  const q = guessQuery(t);
  const ti = el('input', { type: 'text', value: q.title, placeholder: '노래 제목', 'aria-label': '노래 제목' });
  const ar = el('input', { type: 'text', value: q.artist, placeholder: '가수 (선택)', 'aria-label': '가수' });
  const res = el('div', { class: 'lyres' });
  const go = async () => {
    const qq = { title: ti.value.trim(), artist: ar.value.trim() };
    if (!qq.title) { ti.focus(); return; }
    res.replaceChildren(el('div', { class: 'hint' }, '검색 중…'));
    let arr;
    try { arr = await searchList(qq); } catch (e) {
      res.replaceChildren(el('div', { class: 'hint' }, e instanceof LookupError && e.kind === 'offline' ? '인터넷에 연결되어 있지 않아요' : '가사 서버(LRCLIB)가 지금 붐벼요. 잠시 후 다시 눌러 주세요'));
      return;
    }
    if (!arr.length) { res.replaceChildren(el('div', { class: 'hint' }, '검색 결과가 없어요')); return; }
    const wrongIds = new Set([...(communityFor(q) || { wrong: [] }).wrong, ...(LY.fix && LY.fix.wrongId ? [LY.fix.wrongId] : [])]);
    arr = [...arr.filter(r => !wrongIds.has(r.id)), ...arr.filter(r => wrongIds.has(r.id))];   // 틀렸다고 한 가사는 맨 아래로
    res.replaceChildren(...arr.slice(0, 12).map(r => el('button', {
      class: 'lyr' + (wrongIds.has(r.id) ? ' bad' : ''), onclick: () => {
        const fix = LY.fix, prev = LY.prev || {};
        const l = fromRecord(r); l.source = 'manual';
        setLyricsLocal(t, l);
        const same = !fix && prev.id === r.id;                // 원래 보이던 가사를 다시 고름 → 알릴 것 없음
        const wrongId = fix ? fix.wrongId : (prev.source === 'lrclib' || prev.source === 'community' ? prev.id : null);
        toast(!same && shareChoice(t, wrongId, r.id) ? '이 곡의 가사로 정했어요 · 다른 사용자에게도 알렸어요' : '이 곡의 가사로 저장했어요');
      },
    }, el('div', { class: 'tt' }, el('div', { class: 't1' }, r.trackName || ''), el('div', { class: 't2' }, [r.artistName, r.albumName].filter(Boolean).join(' · '))),
      el('span', { class: 'd num' }, r.duration ? fmtTime(r.duration) : ''),
      el('span', { class: 'tag' }, wrongIds.has(r.id) ? '틀림 제보' : r.syncedLyrics ? '싱크' : r.plainLyrics ? '일반' : '연주곡'))));
  };
  [ti, ar].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }));
  if (LY.fix) setTimeout(go, 0); else setTimeout(() => ti.focus(), 30);
  return el('div', { class: 'lyform' }, fixActions(t), el('div', { class: 'lyrow' }, ti, ar, el('button', { class: 'btn primary', onclick: go }, '찾기')), res);
}
function syncLyrics(force) {
  const d = LY.data, pane = $('paneLyr');
  if (!d || !d.synced || !pane || pane.hidden || LY.key !== (list[P.index] || {}).key) return;
  const lines = d.lines, now = (engine.deck.a.currentTime || 0) + 0.25;
  let lo = 0, hi = lines.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (lines[m].t <= now) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx === LY.idx && !force) return;
  LY.idx = idx;
  const body = $('lyBody'); if (!body) return;
  const old = body.querySelector('.ly.on'); if (old) old.classList.remove('on');
  const cur = idx >= 0 ? body.children[idx] : null;
  if (cur) cur.classList.add('on');
  if (LY.form || Date.now() - LY.userScroll < 4000) return;   // 검색 · 제보 화면을 연 동안은 따라 내려가지 않음
  const target = cur ? cur.offsetTop - pane.clientHeight * 0.42 : 0;
  pane.scrollTo({ top: Math.max(0, target), behavior: force ? 'auto' : 'smooth' });
}
['wheel', 'touchmove'].forEach(ev => $('paneLyr').addEventListener(ev, () => { LY.userScroll = Date.now(); }, { passive: true }));

/* ======================= 테마 · 탭 ======================= */
const mqDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const theme = S.theme === 'system' ? (mqDark.matches ? 'dark' : 'light') : S.theme;
  const root = document.documentElement;
  root.dataset.theme = theme; root.dataset.accent = S.accent;
  if (platform.setTheme) platform.setTheme(getComputedStyle(root).getPropertyValue('--panel').trim(), theme === 'light');
  drawCurve();
}
mqDark.addEventListener('change', () => { if (S.theme === 'system') applyTheme(); });
function setTab(tab) {
  if (!['list', 'fx', 'eq', 'lyr', 'set'].includes(tab)) tab = 'list';
  S.tab = tab; app.dataset.tab = tab;
  if (tab !== 'list') P.lastSide = tab;
  const side = tab === 'list' ? P.lastSide : tab;
  $('paneFx').hidden = side !== 'fx'; $('paneEq').hidden = side !== 'eq'; $('paneSet').hidden = side !== 'set'; $('paneLyr').hidden = side !== 'lyr';
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === side)));
  document.querySelectorAll('.btabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (side === 'eq') requestAnimationFrame(drawCurve);
  if (side === 'set') renderSettings();
  if (side === 'lyr') { const t = list[P.index]; if (t && LY.key !== t.key) loadLyrics(t); else { renderLyrics(); LY.idx = -2; syncLyrics(true); } }
  scheduleRows(); saveSettings();
}
document.querySelectorAll('.tab, .btabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

/* ======================= 비주얼라이저 ======================= */
const viz = $('viz'), vg = viz.getContext('2d');
const fbuf = new Uint8Array(engine.analyser.frequencyBinCount);
let bars = new Float32Array(64), vizRAF = 0, vizW = 0, vizH = 0;
function sizeViz() {
  const dpr = window.devicePixelRatio || 1;
  vizW = viz.clientWidth; vizH = viz.clientHeight;
  viz.width = Math.round(vizW * dpr); viz.height = Math.round(vizH * dpr);
  vg.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawViz(true);
}
new ResizeObserver(sizeViz).observe(viz);
function drawViz(idle) {
  if (!vizW) return;
  const n = clamp(Math.floor(vizW / 6), 12, 64), gap = 2, bw = (vizW - gap * (n - 1)) / n;
  const sr = engine.ctx.sampleRate, bins = fbuf.length, binHz = sr / 2 / bins;
  if (!idle) engine.analyser.getByteFrequencyData(fbuf);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (!idle) {
      const f0 = 40 * Math.pow(400, i / n), f1 = 40 * Math.pow(400, (i + 1) / n);
      const b0 = Math.floor(f0 / binHz), b1 = Math.max(b0 + 1, Math.floor(f1 / binHz));
      for (let b = b0; b < b1 && b < bins; b++) v = Math.max(v, fbuf[b]);
      v /= 255;
    }
    bars[i] = Math.max(v, bars[i] * 0.86);
    energy += bars[i];
  }
  vg.clearRect(0, 0, vizW, vizH);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  vg.fillStyle = accent;
  for (let i = 0; i < n; i++) {
    const v = bars[i], hgt = Math.max(2, v * vizH);
    vg.globalAlpha = 0.35 + 0.65 * v;
    vg.fillRect(i * (bw + gap), vizH - hgt, bw, hgt);
  }
  vg.globalAlpha = 1;
  return energy;
}
function vizLoop() {
  const playing = isPlaying();
  updateTimeUI();
  syncLyrics();
  const e = drawViz(!playing);
  if (!playing && e < 0.05) { vizRAF = 0; drawViz(true); return; }
  vizRAF = requestAnimationFrame(vizLoop);
}
function startViz() { if (!vizRAF && !document.hidden) vizRAF = requestAnimationFrame(vizLoop); }
document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(vizRAF); vizRAF = 0; } else if (isPlaying()) startViz(); });

/* ======================= 토스트 · 대화상자 · 메뉴 ======================= */
let toastT = 0;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}
let openModal = null;
function dialog({ title, text, input, okText = '확인', cancelText = '취소' }) {
  return new Promise(resolve => {
    const inp = input != null ? el('input', { type: 'text', value: input, maxlength: '20' }) : null;
    const close = v => { m.remove(); openModal = null; resolve(v); };
    const ok = () => close(inp ? inp.value.trim() || null : true);
    const m = el('div', { class: 'modal', onclick: e => { if (e.target === m) close(null); } },
      el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, el('h3', {}, title), text ? el('p', {}, text) : null, inp,
        el('div', { class: 'acts' }, el('button', { class: 'btn ghost', onclick: () => close(null) }, cancelText), el('button', { class: 'btn primary', onclick: ok }, okText))));
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    m.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
    document.body.append(m); openModal = () => close(null);
    setTimeout(() => (inp || m.querySelector('.primary')).focus(), 30);
    if (inp) inp.select();
  });
}
let openMenuClose = null;
function openMenu(anchor, items) {
  if (openMenuClose) openMenuClose();
  const menu = el('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) { menu.append(el('hr')); continue; }
    const [ic, label, fn] = it;
    menu.append(el('button', { role: 'menuitem', onclick: () => { close(); fn(); } }, icon(ic), label));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = clamp(r.right - mw, 8, innerWidth - mw - 8) + 'px';
  menu.style.top = (r.bottom + 6 + mh > innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6) + 'px';
  const onDoc = e => { if (!menu.contains(e.target)) close(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  function close() { menu.remove(); document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey); openMenuClose = null; }
  setTimeout(() => { document.addEventListener('pointerdown', onDoc, true); document.addEventListener('keydown', onKey); }, 0);
  openMenuClose = close;
}

/* ======================= 키보드 · 끌어놓기 · 뒤로가기 ======================= */
document.addEventListener('keydown', e => {
  if (openModal || e.defaultPrevented) return;
  const tg = e.target;
  if (tg.closest && (tg.closest('input[type=text], select, .vs, .menu') || (tg.matches('input[type=range]') && e.key.startsWith('Arrow')))) return;
  if (e.key === 'Enter' && tg.closest && tg.closest('button')) return;
  const a = engine.deck.a, ctrl = e.ctrlKey || e.metaKey;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight' && ctrl) { e.preventDefault(); next(); }
  else if (e.key === 'ArrowLeft' && ctrl) { e.preventDefault(); prev(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(a.currentTime + 5); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(a.currentTime - 5); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); S.volume = clamp(S.volume + 0.05, 0, 1); S.muted = false; engine.setVolume(S.volume, false); renderVolume(); saveSettings(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); S.volume = clamp(S.volume - 0.05, 0, 1); engine.setVolume(S.volume, S.muted); renderVolume(); saveSettings(); }
  else if (e.key.toLowerCase() === 'm' && !ctrl) { S.muted = !S.muted; engine.setVolume(S.volume, S.muted); renderVolume(); saveSettings(); }
  else if (e.key.toLowerCase() === 'o' && ctrl) { e.preventDefault(); pickFiles(); }
  else if (e.key.toLowerCase() === 'f' && ctrl) { e.preventDefault(); const box = $('searchBox'); box.hidden = false; $('searchInput').focus(); }
});
// 버튼에 포커스가 있어도 스페이스는 '재생/일시정지'로만 동작하게
document.addEventListener('keyup', e => { if (e.key === ' ' && !openModal && e.target.closest && e.target.closest('button') && !e.target.closest('.menu')) e.preventDefault(); }, true);
const dropEl = el('div', { class: 'drop', hidden: true }, '여기에 놓으면 재생목록에 추가돼요');
document.body.append(dropEl);
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropEl.hidden = false; });
window.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropEl.hidden = true; } });
window.addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; dropEl.hidden = true;
  try { addItems(await platform.fromDrop(e.dataTransfer), { play: !isPlaying() }); } catch (err) { toast('파일을 추가하지 못했어요'); }
});
window.__ullimBack = () => {
  if (openModal) { openModal(); return true; }
  if (openMenuClose) { openMenuClose(); return true; }
  if (!$('searchBox').hidden) { $('btnSearch').click(); return true; }
  if (narrow() && S.tab !== 'list') { setTab('list'); return true; }
  return false;
};
const flush = () => { S.lastPos = P.index >= 0 ? engine.deck.a.currentTime || 0 : 0; store(LS.set, S); if (platform.persistent) store(LS.list, list.map(t => ({ k: t.key, n: t.name, t: t.title, a: t.artist, al: t.album, d: Math.round(t.duration * 10) / 10, g: t.tagged ? 1 : 0 }))); };
window.addEventListener('pagehide', flush);
window.addEventListener('beforeunload', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
// 첫 터치/클릭에 오디오 엔진 깨우기 (브라우저 정책)
const wake = () => { engine.resume(); };
window.addEventListener('pointerdown', wake, { once: true, capture: true });
window.addEventListener('keydown', wake, { once: true, capture: true });

/* ======================= 시작 ======================= */
async function init() {
  const resumeKey = S.resume ? S.lastKey : null, resumePos = S.lastPos || 0;   // 시작 전에 기억해 둔다
  applyTheme();
  renderTransport(); renderListTools(); refreshView(); renderFx(); renderEq(); renderSettings();
  setTab(narrow() ? (S.tab || 'list') : (S.tab === 'list' ? 'fx' : S.tab));
  updateBadges();
  await engine.applyAll(S.fx, S.eq, !S.fxOn);
  if (!engine.workletOK) toast('이 기기에서는 일부 음장 효과를 쓸 수 없어요');
  if (resumeKey && P.index < 0) {   // 그사이 사용자가 다른 곡을 틀었으면 건드리지 않음
    const i = list.findIndex(t => t.key === resumeKey);
    if (i >= 0) await playIndex(i, { autoplay: false, startAt: resumePos });
  }
  queueMeta(list.filter(t => !t.tagged));
  if (platform.startupFiles) { try { const items = await platform.startupFiles(); if (items.length) addItems(items, { play: true }); } catch (e) { /* noop */ } }
  if (platform.ready) platform.ready();
  drawViz(true);
  if (S.lyrShare) setTimeout(() => flushFeedback().catch(() => {}), 15000);   // 인터넷이 끊겨 못 보낸 가사 의견 다시 보내기
}
init();

// 개발 · 테스트용
window.__ullim = { engine, S, get list() { return list; }, addItems, playIndex, applySoundPreset, setTab, P };
