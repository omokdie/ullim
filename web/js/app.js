/* 울림 — 화면과 재생 로직 */
import { Engine } from './engine.js';
import { FX, FX_BY_ID, CATEGORIES, EQ_FREQS, MACROS, defaultParams } from './effects.js';
import { knob } from './knob.js';
import { EQ_PRESETS, SOUND_PRESETS } from './presets.js';
import { readTags, setTagFallback } from './tags.js';
import { needsCodec, CodecSource, supported as codecSupported, probe as codecProbe } from './codec.js';
import { platform } from './platform.js';
import { ICONS, icon } from './icons.js';
import { fetchLatest, isNewer } from './update.js';
import { lens, setGlass, watchPower, isSaving } from './glass.js';
import { thumb, peek, setSource as setThumbSource, setTagSink, forgetPending, fallbackStyle, bigArt, setIdleHook } from './thumbs.js';
import { autoSync, saveAnchors, applyAnchors } from './autosync.js';
import { guessQuery, findOnline, searchList, fromRecord, cacheGet, cachePut, cacheDrop, toLyrics, decodeText, loadOverrides, communityFor, getById, sendFeedback, flushFeedback, REPO, LookupError, cacheShrink } from './lyrics.js';

const VERSION = '1.3.0';
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
const PHONE_MQ = matchMedia('(max-width: 899px)');
const narrow = () => PHONE_MQ.matches;          // 휴대폰 배치 (아래 메뉴 · 미니 플레이어)

/* ======================= 저장 ======================= */
const LS = { set: 'ullim.settings.v1', list: 'ullim.playlist.v1', pls: 'ullim.playlists.v2', pre: 'ullim.userpresets.v1' };
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn(e); return false; } };
const DEF_EQ = () => ({ on: false, preset: 'flat', p: Object.fromEntries([['preamp', 0], ...EQ_FREQS.map((_, i) => ['b' + i, 0])]) });
const S = Object.assign({
  volume: 0.8, muted: false, repeat: 'all', shuffle: false, crossfade: 0, theme: 'system', accent: 'blue',
  fxOn: true, fx: { limiter: { on: true, p: defaultParams(FX_BY_ID.limiter) } }, eq: DEF_EQ(), preset: null,
  resume: true, lastKey: null, lastPos: 0, lyrAuto: true, lyrShare: true, lyrSync: true, lyrOnData: false, lyrSize: 22, autoUpdate: true, lastVersion: null, updHidden: null, glass: 'auto',
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

/* ======================= 플레이리스트 (여러 개) =======================
   shown  = 왼쪽 목록에 보이는 플레이리스트, playPl = 지금 재생하는 플레이리스트 (둘은 다를 수 있다)
   list   = playPl.tracks — 재생 · 다음 곡 · 가사 등 재생 쪽 코드는 모두 list 를 쓴다
   같은 음악 파일이 여러 플레이리스트에 들어갈 수 있고, 곡 객체는 플레이리스트마다 따로 둔다 */
let uid = 0;
// genre: 읽은 장르 ('' = 장르 없음), undefined = 아직 안 읽음 (1.1.x 에서 옮겨 온 곡 → 조금씩 다시 읽음)
const mkTrack = o => ({ id: ++uid, key: o.key, name: o.name || o.key, title: o.title || '', artist: o.artist || '', album: o.album || '', duration: o.duration || 0, tagged: !!o.tagged, genre: o.genre, bad: false });
// 저장: 곡 정보는 한 번만(tracks), 플레이리스트에는 그 번호만 → 같은 곡이 여러 목록에 있어도 저장 공간을 거의 안 씀
const packRow = t => [t.key, t.name, t.title, t.artist, t.album, Math.round(t.duration * 10) / 10, t.tagged ? 1 : 0, t.genre == null ? null : t.genre];
const str = v => v == null ? '' : String(v);
const unpackRow = r => mkTrack({ key: String(r[0]), name: str(r[1]), title: str(r[2]), artist: str(r[3]), album: str(r[4]), duration: Number(r[5]) || 0, tagged: !!r[6], genre: r[7] == null ? undefined : str(r[7]) });
const unpackTrack = o => mkTrack({ key: String(o.k), name: str(o.n), title: str(o.t), artist: str(o.a), album: str(o.al), duration: Number(o.d) || 0, tagged: !!o.g });   // 1.0.x 형식
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const mkPl = (name, tracks = [], id = newId()) => ({ id, name, tracks });
function loadPlaylists() {
  if (!platform.persistent) return { pls: [mkPl('재생목록', [], 'main')] };
  try {
    const v2 = load(LS.pls, null);
    if (v2 && Array.isArray(v2.lists) && Array.isArray(v2.tracks)) {
      const rows = v2.tracks, ids = new Set();
      const pls = v2.lists.filter(p => p && typeof p === 'object').map(p => {
        let id = str(p.id) || newId();
        if (ids.has(id)) id = newId();    // 망가진 저장 내용: 같은 번호가 둘이면 새 번호
        ids.add(id);
        const items = (Array.isArray(p.items) ? p.items : []).map(i => rows[i]).filter(r => Array.isArray(r) && r[0] != null && r[0] !== '');
        return mkPl(str(p.name).trim().slice(0, 60) || '재생목록', items.map(unpackRow), id);
      });
      if (pls.length) return { pls, play: str(v2.play), shown: str(v2.shown) };
    }
  } catch (e) { console.warn('플레이리스트 불러오기 실패', e); }
  try {
    const old = load(LS.list, []);   // 1.0.x: 재생목록 하나 → '재생목록' 플레이리스트로 옮김
    return { pls: [mkPl('재생목록', (Array.isArray(old) ? old : []).filter(o => o && o.k != null && o.k !== '').map(unpackTrack), 'main')] };
  } catch (e) { return { pls: [mkPl('재생목록', [], 'main')] }; }
}
const loaded = loadPlaylists();
let pls = loaded.pls;
let playPl = pls.find(p => p.id === loaded.play) || pls[0];
let shown = pls.find(p => p.id === loaded.shown) || playPl;
let list = playPl.tracks;
function savePlaylists() {
  if (!platform.persistent) return;
  const at = new Map(), rows = [];
  const ref = t => {
    let i = at.get(t.key);
    if (i == null) { i = rows.length; at.set(t.key, i); rows.push(packRow(t)); }
    else if ((t.tagged && !rows[i][6]) || (t.genre != null && rows[i][7] == null)) rows[i] = packRow(t);      // 태그 · 장르를 읽은 쪽 정보로
    return i;
  };
  const lists = pls.map(p => ({ id: p.id, name: p.name, items: p.tracks.map(ref) }));
  const real = p => (p && !p.virtual ? p : P.lastReal && pls.includes(P.lastReal) ? P.lastReal : pls[0]);
  const data = { v: 2, play: real(playPl).id, shown: real(shown).id, tracks: rows, lists };
  let ok = store(LS.pls, data);
  if (!ok) {
    // 저장 공간 부족: 가사 임시 저장을 줄이고, 옛(1.0.x) 형식 목록을 비운 뒤 한 번 더 (그래도 안 되면 옛 목록은 되돌림)
    cacheShrink();
    let old = null;
    try { old = localStorage.getItem(LS.list); localStorage.removeItem(LS.list); } catch (e) { /* noop */ }
    ok = store(LS.pls, data);
    if (!ok && old != null) { try { localStorage.setItem(LS.list, old); } catch (e) { /* noop */ } }
  }
  if (ok && !v1Cleared) { v1Cleared = true; try { localStorage.removeItem(LS.list); } catch (e) { /* noop */ } }   // 옮겨 왔으니 두 번 저장하지 않음
  if (!ok && !saveWarned) { saveWarned = true; toast('저장 공간이 모자라 플레이리스트를 저장하지 못했어요. 쓰지 않는 플레이리스트나 곡을 지워 주세요'); }
  if (ok) saveWarned = false;
}
let v1Cleared = false, saveWarned = false;
const saveListSoon = debounce(savePlaylists, 600);
const saveList = () => { saveListSoon(); homeDirty(); };   // 저장하면서 홈 · 왼쪽 목록도 (잠시 뒤 한 번) 새로
/** 안드로이드: 어느 플레이리스트에도 남지 않은 파일만 읽기 권한을 돌려준다 */
function releaseUnused(keys) {
  if (!platform.release || !keys.length) return;
  const used = new Set();
  for (const p of pls) for (const t of p.tracks) used.add(t.key);
  for (const p of [playPl, shown]) if (p && p.virtual) for (const t of p.tracks) used.add(t.key);
  const gone = [...new Set(keys)].filter(k => !used.has(k));
  if (gone.length) platform.release(gone);
}
const displayTitle = t => (t && (t.title || stripExt(t.name.split(/[\\/]/).pop()))) || '';

/* ======================= 라이브러리 · 장르 · 최근에 들은 곡 =======================
   가상 목록(최근에 들은 곡 · 장르 · 모든 곡)은 저장하지 않는 읽기 전용 목록. 재생은 보통 플레이리스트처럼 된다 */
function library() {           // 모든 플레이리스트의 곡, 같은 파일은 한 번 (태그를 읽은 쪽 우선)
  const m = new Map();
  for (const p of pls) for (const t of p.tracks) { const o = m.get(t.key); if (!o || (!o.tagged && t.tagged) || (o.genre == null && t.genre != null)) m.set(t.key, t); }
  return m;
}
const GENRE_MAP = [
  [/^(ballad|power ballad|발라드)$/, '발라드'], [/^(dance|eurodance|disco|댄스)$/, '댄스'],
  [/^(k-?pop|kpop|korean pop|가요|케이팝|아이돌|국내\s*가요)$/, 'K-POP'], [/^(hip-?hop|rap|gangsta|랩|힙합|랩\/힙합|국내\s*랩\/힙합)$/, '랩/힙합'],
  [/^(r&b|rnb|r&b\/soul|soul|알앤비|알앤비\/소울|r&b\/소울)$/, 'R&B/소울'], [/^(rock|록|락|록\/메탈|rock\/metal|metal|heavy metal|hard rock|alternative|alternative rock|punk|punk rock)$/, '록/메탈'],
  [/^(pop|팝|j-?pop|synthpop)$/, '팝'], [/^(indie|인디|인디음악|국내\s*인디)$/, '인디'], [/^(trot|트로트|성인가요|성인가요\/트로트)$/, '트로트'],
  [/^(electronic|electronica|edm|house|techno|trance|일렉트로니카)$/, '일렉트로니카'], [/^(folk|blues|포크|블루스|포크\/블루스)$/, '포크/블루스'],
  [/^(jazz|acid jazz|재즈)$/, '재즈'], [/^(classical|classic|클래식)$/, '클래식'], [/^(soundtrack|ost|국내드라마|드라마|영화|애니메이션|게임)$/, 'OST'],
  [/^(lo-?fi|lofi|로파이)$/, '로파이'], [/^(ccm|gospel|christian|contemporary christian)$/, 'CCM'], [/^(children|동요|키즈)$/, '동요'],
];
function genreLabel(g) {
  const s = String(g || '').trim();
  if (!s) return '';
  const k = s.toLowerCase().replace(/\s+/g, ' ');
  for (const [re, name] of GENRE_MAP) if (re.test(k)) return name;
  return s.length > 18 ? s.slice(0, 18) : s;
}
const RECENT_KEY = 'ullim.recent.v1';
let recent = (() => { const a = load(RECENT_KEY, []); return Array.isArray(a) ? a.filter(x => x && typeof x.k === 'string').slice(0, 150) : []; })();
const saveRecent = debounce(() => store(RECENT_KEY, recent), 1500);
function noteRecent(t) {
  if (!t) return;
  recent = [{ k: t.key, at: Date.now() }, ...recent.filter(r => r.k !== t.key)].slice(0, 150);
  saveRecent(); homeDirty();
}
function virtualPl(id, name, tracks, kind) { return { id, name, kind, virtual: true, tracks: tracks.slice() }; }   // 곡 객체는 진짜 목록과 함께 씀
const byTitle = (a, b) => displayTitle(a).localeCompare(displayTitle(b), 'ko', { numeric: true, sensitivity: 'base' });
function recentPl() { const lib = library(); return virtualPl('v:recent', '최근에 들은 곡', recent.map(r => lib.get(r.k)).filter(Boolean), 'recent'); }
function genreGroups(lib = library()) {
  const g = new Map();
  for (const t of lib.values()) { if (t.genre == null) continue; const k = genreLabel(t.genre) || '장르 없음'; if (!g.has(k)) g.set(k, []); g.get(k).push(t); }
  return [...g.entries()].sort((a, b) => (a[0] === '장르 없음') - (b[0] === '장르 없음') || b[1].length - a[1].length || a[0].localeCompare(b[0], 'ko'))
    .map(([name, tracks]) => ({ name, tracks: tracks.sort(byTitle) }));
}
function genrePl(name) { const grp = genreGroups().find(x => x.name === name); return virtualPl('v:genre:' + name, name, grp ? grp.tracks : [], 'genre'); }
function allSongsPl() { return virtualPl('v:all', '모든 곡', [...library().values()].sort(byTitle), 'all'); }
const KIND_LABEL = { recent: '최근에 들은 곡', genre: '장르', all: '모든 곡' };
const subLine = t => [t.artist, t.album].filter(Boolean).join(' · ') || '알 수 없는 아티스트';

/* ======================= 엔진 ======================= */
const engine = new Engine({ light: platform.name === 'android',   // 휴대폰: 잔향 길이 · 키 조절 계산량을 줄임
  sinkId: platform.audioOut && platform.audioOut.pickSink && S.sink && S.sink.id || '' });   // PC: 고른 출력 장치(USB DAC)의 샘플레이트로 열기
engine.setVolume(S.volume, S.muted);
engine.addEventListener('fxerror', e => toast(`'${(FX_BY_ID[e.detail] || {}).name || e.detail}' 효과를 이 기기에서 쓸 수 없어요`));
/* 메모리: 큰 일(곡 추가 · 그림 · 자동 맞춤 · 효과 바꿈 · 곡 바뀜)을 마치고 한가할 때 정리.
   PC(Electron): 쓰레기를 바로 치우고(gc) 메인 프로세스에 캐시 비우기를 부탁 — 안 그러면 풀어 둔 그림 · 지난 곡 데이터 ·
   GC 를 기다리는 큰 배열이 수십~수백 MB 씩 남는다. 15초에 한 번까지, 쉬는 시간에만. (안드로이드는 시스템이 알아서) */
let gcT = 0, gcLast = 0;
function memHint() {
  if ((typeof globalThis.gc !== 'function' && !platform.trimMemory) || gcT) return;
  const wait = Math.max(2500, 15000 - (Date.now() - gcLast));
  gcT = setTimeout(() => {
    const run = () => {
      gcT = 0; gcLast = Date.now();
      try { if (typeof globalThis.gc === 'function') globalThis.gc(); } catch (e) { /* noop */ }
      if (platform.trimMemory) platform.trimMemory();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 }); else run();
  }, wait);
}
engine.addEventListener('chain', () => { memHint(); renderOutput(); });
const P = { index: -1, xf: null, errors: 0, sleepAt: 0, sleepTimer: 0, sleepFading: false, artUrl: null, artBlob: null, dragging: false, pDragging: false, lastSave: 0, lastReal: null, noted: null, seekAt: 0 };
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
/** 덱에 곡 넣기: 브라우저 엔진이 못 푸는 형식(DSD · APE · WavPack · AIFF · WMA …)은 코덱 엔진(FFmpeg)으로 */
function loadDeck(deck, t) {
  deck.fmt = null; deck.codecTried = false;
  const url = platform.mediaUrl(t.key);
  if (needsCodec(t.name || t.key) && codecSupported()) startCodec(deck, t, url);
  else engine.load(deck, url);
}
function startCodec(deck, t, url) {
  deck.codecTried = true;
  const cs = new CodecSource(url, {
    maxRate: platform.name === 'android' ? 96000 : 0,        // 휴대폰: DSD128↑ 도 88.2kHz 로 (출력이 48kHz 라 더 높여도 똑같고 계산만 늘어남)
    onerror: () => { if (deck.codec === cs) { deck.codecFailed = true; onMediaError(deck, true); } },
    oninfo: info => {
      deck.fmt = codecFmt(info);
      if (!t.tagged || !t.title) applyTagsAll(t.key, { title: info.title || '', artist: info.artist || '', album: info.album || '', genre: info.genre || '', duration: info.dur || 0 });
      if (deck === engine.deck) renderOutput();
    },
  });
  engine.load(deck, cs.attach(deck.a));
  deck.codec = cs;
}

async function playIndex(i, { autoplay = true, startAt = 0 } = {}) {
  if (i < 0 || i >= list.length) return;
  endCrossfade();
  const deck = engine.deck, t = list[i];
  engine.resetGain(deck, 1);
  revokeBlob(deck);
  deck.track = t; deck.blobTried = false; deck.codecFailed = false; deck.pendingSeek = startAt;
  loadDeck(deck, t);
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

async function onMediaError(deck, fromCodec = false) {
  const t = deck.track;
  if (!t || (!fromCodec && !deck.a.getAttribute('src'))) return;
  const code = deck.a.error ? deck.a.error.code : 0;
  // 브라우저 엔진이 못 푸는 형식(ALAC 가 든 m4a · ADPCM WAV · AC3 가 든 mka …) → 코덱 엔진으로 한 번 더
  if (!fromCodec && !deck.codec && !deck.codecTried && codecSupported() && (code === 3 || code === 4)) {
    startCodec(deck, t, platform.mediaUrl(t.key));
    if (deck === engine.deck) await doPlay(deck);
    return;
  }
  // 안드로이드: 스트리밍이 막히면 파일을 통째로 읽어 다시 시도
  if (platform.name === 'android' && !deck.blobTried && !deck.codec && !fromCodec) {
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
  if (P.index < 0) {
    adoptShown();                                 // 아직 아무 곡도 안 틀었으면 보고 있는 플레이리스트를 재생
    if (!list.length) { pickFiles(); return; }
    playIndex(S.shuffle ? (rebuildOrder(), order[0]) : 0); return;
  }
  const a = engine.deck.a;
  if (!a.getAttribute('src')) { playIndex(P.index); return; }
  if (a.paused) doPlay(); else { endCrossfade(); a.pause(); }
}
function play() { if (P.index < 0 || engine.deck.a.paused) togglePlay(); }
function pause() { if (isPlaying()) { endCrossfade(); engine.deck.a.pause(); } }
function next() { if (P.index < 0) adoptShown(); P.dir = 1; const n = nextIndex(false); if (n != null) playIndex(n); }
function prev() {
  if (P.index < 0) adoptShown();   // 아직 아무 곡도 안 틀었으면 보고 있는 플레이리스트에서
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
  to.track = t; to.blobTried = true; to.codecFailed = false; to.pendingSeek = 0;
  loadDeck(to, t);
  to.a.play().then(() => {
    if (P.xf !== xf) { engine.unload(to); return; }
    const j = list.indexOf(t);   // 기다리는 사이 목록이 바뀌었을 수 있다 (정렬 · 옮기기 · 빼기) → 그 곡의 지금 자리
    if (j < 0) { P.xf = null; engine.unload(to); engine.resetGain(to, 1); return; }
    const remain = from.a.duration - from.a.currentTime;
    const dur = clamp(Math.min(S.crossfade, remain), 0.3, 12);
    engine.crossfade(from, to, dur);
    engine.swap(); P.index = j; xf.started = true;
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
  if (!vizRAF && !document.hidden) { updateTimeUI(); syncLyrics(); }      // 화면이 꺼져 있으면(백그라운드 재생) 화면 일은 하지 않음 — 다시 보일 때 한 번에
  if (!P.noted && a.currentTime > 5 && list[P.index]) { P.noted = true; noteRecent(list[P.index]); }
  if (S.crossfade > 0 && !P.xf && !a.paused && S.repeat !== 'one' && isFinite(a.duration) &&
      a.duration > S.crossfade * 2 + 3 && a.duration - a.currentTime <= S.crossfade + 0.3) startCrossfade();
  const now = Date.now();
  if (now - P.lastSave > 5000) { P.lastSave = now; S.lastPos = a.currentTime; saveSettings(); }
  // 알림 · 잠금 화면의 위치는 시스템이 재생 속도로 알아서 흘려보냄 → 재생 · 멈춤 · 이동 · 곡 바뀜 때만 알리고, 어긋남 보정은 가끔만
  if (now - (P.lastPush || 0) > 30000) { P.lastPush = now; pushNowPlaying(); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && P.index >= 0) { updateTimeUI(true); syncLyrics(); } });

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
    readTags(platform.tagSource(t.key), { picture: false }).then(info => applyTagsAll(t.key, info)).catch(() => { t.tagged = true; if (t.genre == null) t.genre = ''; })
      .finally(() => { metaRunning--; scheduleRows(); saveList(); pumpMeta(); if (!metaRunning && !metaQ.length) memHint(); });
  }
}
function applyTags(t, info) {
  t.tagged = true;
  if (info.title) t.title = info.title;
  if (info.artist) t.artist = info.artist;
  if (info.album) t.album = info.album;
  t.genre = info.genre || '';
  if (info.duration > 0 && !(t.duration > 1)) t.duration = info.duration;
  if (t === list[P.index]) renderNowPlaying();
  homeDirty();
}
setIdleHook(() => memHint());
// 태그 파서가 모르는 형식(APE · WavPack · DSD · WMA …): 코덱 엔진(FFmpeg)이 읽은 태그 · 앨범아트
setTagFallback(async (src, { picture }) => {
  if (!codecSupported()) return null;
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  try {
    const { info: x, pic } = await codecProbe(url, { picture });
    return { title: x.title, artist: x.artist, album: x.album, albumArtist: x.albumArtist, genre: x.genre, track: x.track, lyrics: x.lyrics,
      duration: x.dur, picture: pic, fmt: codecFmt(x) };
  } finally { if (typeof src !== 'string') URL.revokeObjectURL(url); }
});
/** 코덱 엔진 정보 → 화면에 보일 형식 { codec, rate, bits, ch, lossless, dsd, kbps } */
function codecFmt(x) {
  const names = { wavpack: 'WavPack', ape: 'APE', alac: 'ALAC', tta: 'TTA', tak: 'TAK', shorten: 'Shorten', flac: 'FLAC', wmav1: 'WMA', wmav2: 'WMA', wmapro: 'WMA Pro',
    wmalossless: 'WMA 무손실', ac3: 'AC-3', eac3: 'E-AC-3', dca: 'DTS', truehd: 'TrueHD', mlp: 'MLP', mp1: 'MP1', mp2: 'MP2', mp3: 'MP3', mpc7: 'Musepack', mpc8: 'Musepack' };
  let codec = names[x.codec] || (x.dsd ? 'DSD' : /^pcm_/.test(x.codec) ? ({ aiff: 'AIFF', caf: 'CAF', w64: 'Wave64' }[x.format] || 'PCM') : String(x.codec || '').toUpperCase());
  if (x.dsd) codec = 'DSD' + Math.round(x.rate / 44100);
  return { codec, rate: x.rate, bits: x.bits || 0, ch: x.ch, lossless: !!x.lossless, dsd: !!x.dsd, kbps: x.lossless ? 0 : x.kbps };
}
setTagSink((key, info) => {
  for (const p of pls) for (const t of p.tracks) if (t.key === key) { if (!t.tagged || t.genre == null) { applyTagsAll(key, info); saveList(); } return; }
});
const tagMemo = new Map();
/** 곡의 태그 (가사 · 제목 …). 그림 바이트는 큰 그림을 만들 때 한 번 쓰고 버림 → 여기 남지 않음 */
function tagInfo(t) {
  if (!tagMemo.has(t.key)) {
    tagMemo.set(t.key, readTags(platform.tagSource(t.key)).catch(() => null));
    if (tagMemo.size > 4) tagMemo.delete(tagMemo.keys().next().value);
  }
  return tagMemo.get(t.key);
}
/** 큰 그림 { url, blob } — 원본 대신 768px 로 줄인 것 (3000px 그림을 통째로 풀면 36MB) */
async function getArt(t) {
  let pic = null;
  try {
    const info = await tagInfo(t);
    if (info && (!t.tagged || t.genre == null)) { applyTagsAll(t.key, info); scheduleRows(); saveList(); }
    if (info) { pic = info.picture; info.picture = null; }
  } catch (e) { /* no art */ }
  return bigArt(t.key, pic || undefined);
}
let artTok = 0;
async function loadArt(t) {
  const img = $('artImg'), tok = ++artTok;
  if (!t) { img.hidden = true; P.artUrl = null; P.artBlob = null; renderPlayerArt(); setAmbient(null); return; }
  const art = await getArt(t);
  if (tok !== artTok) return;
  const url = art ? art.url : null;
  P.artUrl = url; P.artBlob = art ? art.blob : null;
  if (url) { img.src = url; img.hidden = false; } else img.hidden = true;
  renderPlayerArt();
  thumb(t.key).then(v => { if (tok === artTok) setAmbient(v && v.color); });
  updateMediaSession();
  pushNowPlaying(true);
  memHint();
}
/** 알림용: 이미 줄인 큰 그림(JPEG)을 그대로 data URL 로 (다시 풀지 않음) */
function artDataUrl(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}

/* ======================= 외부 연동 ======================= */
function pushNowPlaying(withArt) {
  if (!platform.nowPlaying) return;
  const t = list[P.index], a = engine.deck.a;
  const info = t ? {
    hasTrack: true, title: displayTitle(t), artist: t.artist || '', album: t.album || '', playing: !a.paused, rate: a.playbackRate || 1, shuffle: !!S.shuffle, repeat: S.repeat || 'all',
    position: Math.round((a.currentTime || 0) * 1000), duration: Math.round((isFinite(a.duration) ? a.duration : t.duration || 0) * 1000),
  } : { hasTrack: false, playing: false };
  if (withArt && t && platform.name === 'android') {
    if (P.artBlob) artDataUrl(P.artBlob).then(d => platform.nowPlaying({ ...info, art: d })).catch(() => platform.nowPlaying({ ...info, art: '' }));
    else platform.nowPlaying({ ...info, art: '' });
    return;
  }
  platform.nowPlaying(info);
}
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = list[P.index];
  try {
    navigator.mediaSession.metadata = t ? new MediaMetadata({ title: displayTitle(t), artist: t.artist || '', album: t.album || '', artwork: P.artUrl ? [{ src: P.artUrl, sizes: '768x768', type: 'image/jpeg' }] : [] }) : null;
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
  else if (c === 'shuffle') toggleShuffle();
  else if (c === 'repeat') cycleRepeat();
});
platform.onOpenFiles(items => addItems(items, { play: true }));

/* ======================= 재생 버튼: 울림 표시 ↔ 세모 =======================
   재생 중 = 울림 표시(가운데 점 + 양쪽 물결), 물결이 퍼지듯 움직임. 멈추면 물결이 안으로 접히며 점이 세모로 바뀜 (모션 그래픽).
   점 ↔ 세모는 가운데에서 본 각도마다 거리(r)를 섞어 그린다 (두 모양 모두 가운데에서 보이는 '별 모양'이라 자연스럽게 이어짐) */
const PG_N = 72, PG_C = 12;
const PG_DOT = 2.7;
const PG_TRI = (() => {                       // 둥근 세모 (재생 표시) — 가운데에서 각 방향으로 가장자리까지의 거리
  const A = [8.9, 6.4], B = [8.9, 17.6], C = [18.6, 12], rc = 1.25;
  const cx = (A[0] + B[0] + C[0]) / 3, cy = (A[1] + B[1] + C[1]) / 3;
  const shrink = v => [cx + (v[0] - cx) * 0.82, cy + (v[1] - cy) * 0.82];      // 모서리를 둥글게 하려고 조금 작게 → rc 만큼 부풀림
  const [a, b, c] = [A, B, C].map(shrink);
  const sdSeg = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - x1 - dx * t, py - y1 - dy * t);
  };
  const inside = (px, py) => { const s1 = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]), s2 = (c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0]), s3 = (a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0]); return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0); };
  const sd = (px, py) => { const d = Math.min(sdSeg(px, py, ...a, ...b), sdSeg(px, py, ...b, ...c), sdSeg(px, py, ...c, ...a)); return (inside(px, py) ? -d : d) - rc; };
  const r = new Float32Array(PG_N);
  for (let i = 0; i < PG_N; i++) {
    const ph = i / PG_N * Math.PI * 2, ux = Math.cos(ph), uy = Math.sin(ph);
    let lo = 0, hi = 12;
    for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (sd(PG_C + ux * mid, PG_C + uy * mid) < 0) lo = mid; else hi = mid; }
    r[i] = lo;
  }
  return r;
})();
function pgPath(t) {                          // t: 0 = 세모, 1 = 점
  let d = '';
  for (let i = 0; i < PG_N; i++) {
    const ph = i / PG_N * Math.PI * 2, r = PG_TRI[i] + (PG_DOT - PG_TRI[i]) * t;
    d += (i ? 'L' : 'M') + (PG_C + Math.cos(ph) * r).toFixed(2) + ' ' + (PG_C + Math.sin(ph) * r).toFixed(2);
  }
  return d + 'Z';
}
/** 가운데 모양(점 ↔ 세모)과 물결 두 겹을 각각 따로 겹친 그림으로: 물결의 움직임은 합성기(GPU)가 투명도 · 크기만 바꿔
    재생 막대(유리)를 다시 그리지 않음 — SVG 안에서 움직이면 막대 전체를 초당 수십 번 다시 그려 배터리 · 발열 */
function playGlyph() {
  const box = document.createElement('span');
  box.className = 'pg'; box.setAttribute('aria-hidden', 'true');
  const wave = (cls, d1, d2) => `<span class="pgw ${cls}"><svg viewBox="0 0 24 24"><path d="${d1}"/><path d="${d2}"/></svg></span>`;
  box.innerHTML = `<svg class="pgc" viewBox="0 0 24 24"><path d="${pgPath(0)}"/></svg>`
    + wave('w1', 'M8.25 8.25A5.3 5.3 0 0 0 8.25 15.75', 'M15.75 8.25A5.3 5.3 0 0 1 15.75 15.75')
    + wave('w2', 'M6.25 5.61A8.6 8.6 0 0 0 6.25 18.39', 'M17.75 5.61A8.6 8.6 0 0 1 17.75 18.39');
  box.__t = 0; box.__core = box.querySelector('.pgc path');
  return box;
}
const PG = { state: null, raf: 0, timer: 0 };
const easeIO = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
/** 재생 중이면 울림 표시(물결 움직임), 아니면 세모. animate: 바뀌는 모습을 보여 줄지 */
function setPlayGlyph(playing, animate = true) {
  const glyphs = [...document.querySelectorAll('.pg')];
  if (PG.state === playing) return;
  PG.state = playing;
  cancelAnimationFrame(PG.raf); clearTimeout(PG.timer);
  const reduce = !animate || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const from = glyphs.length ? glyphs[0].__t : 0, to = playing ? 1 : 0;
  for (const g of glyphs) g.classList.toggle('ul', playing);
  // 재생: 물결이 다 펼쳐진 뒤 움직이기 시작 · 멈춤: 접히는 동안은 그대로 움직이다가 멈춤 (중간에 번쩍이지 않게)
  const done = () => glyphs.forEach(g => g.classList.toggle('on', playing));
  if (reduce) { for (const g of glyphs) { g.__t = to; g.__core.setAttribute('d', pgPath(to)); } done(); return; }
  const t0 = performance.now(), delay = playing ? 0 : 70, dur = 360;
  const step = now => {
    const k = Math.min(1, Math.max(0, (now - t0 - delay) / dur)), t = from + (to - from) * easeIO(k);
    for (const g of glyphs) { g.__t = t; g.__core.setAttribute('d', pgPath(t)); }
    if (k < 1) PG.raf = requestAnimationFrame(step);
  };
  PG.raf = requestAnimationFrame(step);
  PG.timer = setTimeout(done, playing ? 520 : 260);
}

/* ======================= 화면: 재생 막대 (PC) · 미니 플레이어 (휴대폰) ======================= */
const seek = $('seek'), vol = $('vol'), pSeek = $('pSeek'), scroller = $('scroller');
function paintRange(r, center) {
  const min = +r.min, max = +r.max, p = (r.value - min) / (max - min) * 100;
  const c = center != null ? (center - min) / (max - min) * 100 : 0;
  r.style.setProperty('--a', Math.min(c, p) + '%'); r.style.setProperty('--b', Math.max(c, p) + '%');
}
function renderNowPlaying() {
  const t = list[P.index];
  const title = t ? displayTitle(t) : (list.length ? '재생할 곡을 고르세요' : '재생할 음악을 추가하세요');
  const sub = t ? subLine(t) : (list.length ? `${list.length}곡이 준비되어 있어요` : platform.name === 'electron' ? '파일이나 폴더를 열거나, 창에 끌어다 놓으세요' : '파일이나 폴더를 열어 주세요');
  $('title').textContent = title; $('sub').textContent = sub;
  $('pTitle').textContent = title; $('pSub').textContent = t ? subLine(t) : '';
  $('pFrom').replaceChildren(el('small', {}, '재생 중인 목록'), el('b', {}, playPl ? playPl.name : ''));
  document.title = t ? `${displayTitle(t)} — 울림` : '울림';
  updateSleepBadge();
}
function onTrackChange() {
  setTimeout(renderOutput, 0);
  renderNowPlaying();
  renderPlHead();
  updateTimeUI(true);
  scheduleRows();
  scrollToCurrent();
  loadArt(list[P.index]);
  updateMediaSession();
  loadLyrics(list[P.index]);
  P.noted = null;
  markPlaying();
  if (PL.open && PL.tab === 'queue') renderQueue();
}
function onPlayState() {
  const playing = isPlaying();
  for (const id of ['btnPlay', 'pPlay']) $(id).setAttribute('aria-label', playing ? '일시정지' : '재생');
  setPlayGlyph(playing);
  document.body.classList.toggle('playing', playing);
  const qn = PL.open && document.querySelector('#pQueue .qrow.cur .nowp');
  if (qn) qn.replaceChildren(icon(playing ? 'vol' : 'pause'));
  updateMediaSession(); pushNowPlaying(); scheduleRows(); markPlaying();
  if (playing) startViz();
}
let progAt = 0;
const setText = (n, v) => { if (n.textContent !== v) n.textContent = v; };
function updateTimeUI(force) {
  const a = engine.deck.a, t = list[P.index];
  const d = isFinite(a.duration) && a.duration > 0 ? a.duration : (t ? t.duration : 0);
  const cur = P.index >= 0 ? a.currentTime || 0 : 0, frac = d ? clamp(cur / d, 0, 1) : 0;
  const now = performance.now();
  // 유리 막대 안의 것이 바뀔 때마다 유리(흐림 · 굴절)를 다시 그려야 하니 자주 바꾸지 않음: 진행 막대 1초에 4번, 시간 글자는 초가 바뀔 때만
  if (!narrow() && (force || P.dragging || now - P.seekAt > 250)) {
    P.seekAt = now;
    if (!P.dragging) { const v = Math.round(frac * 1000); if (+seek.value !== v) { seek.value = v; paintRange(seek); } setText($('cur'), fmtTime(cur)); }
    setText($('dur'), fmtTime(d));
  }
  if (force || now - progAt > (narrow() ? 1000 : 500)) { progAt = now; $('pprogFill').style.transform = `scaleX(${frac})`; }   // 휴대폰 미니 플레이어 선: 1초에 한 번
  if (PL.open && !P.pDragging) { pSeek.value = Math.round(frac * 1000); paintRange(pSeek); setText($('pCur'), fmtTime(cur)); setText($('pDur'), fmtTime(d)); }
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && d && isPlaying() && Math.random() < 0.05) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(cur, d), playbackRate: a.playbackRate || 1 }); } catch (e) { /* noop */ }
  }
}
function toggleShuffle() { S.shuffle = !S.shuffle; order = []; saveSettings(); renderModes(); pushNowPlaying(); toast(S.shuffle ? '무작위 재생을 켰어요' : '무작위 재생을 껐어요'); if (PL.open && PL.tab === 'queue') renderQueue(); }
function cycleRepeat() {
  S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat] || 'all'; saveSettings(); renderModes(); pushNowPlaying();
  toast({ off: '반복 안 함', all: '전체 반복', one: '한 곡 반복' }[S.repeat]);
}
function bindSeek(r, dragKey, curId) {
  r.addEventListener('input', () => {
    P[dragKey] = true; paintRange(r);
    const a = engine.deck.a, d = isFinite(a.duration) ? a.duration : 0;
    $(curId).textContent = fmtTime(r.value / 1000 * d);
  });
  r.addEventListener('change', () => {
    const a = engine.deck.a, d = isFinite(a.duration) ? a.duration : 0;
    P[dragKey] = false;
    if (d) seekTo(r.value / 1000 * d);
  });
}
function renderTransport() {
  for (const id of ['btnPlay', 'pPlay']) $(id).replaceChildren(playGlyph());
  for (const [id, ic] of [['btnPrev', 'prev'], ['btnNext', 'next'], ['btnShuffle', 'shuffle'], ['pPrev', 'prev'], ['pNext', 'next'], ['pShuffle', 'shuffle'],
    ['btnLyr', 'lyrics'], ['btnExpand', 'up'], ['pClose', 'chevDown'], ['pMore', 'more'], ['btnBack', 'back'], ['btnAdd', 'plus'], ['btnFind', 'search'], ['sideNew', 'plus']]) setIcon($(id), ic);
  $('btnPlay').onclick = $('pPlay').onclick = togglePlay;
  $('btnPrev').onclick = $('pPrev').onclick = prev;
  $('btnNext').onclick = $('pNext').onclick = next;
  $('btnShuffle').onclick = $('pShuffle').onclick = toggleShuffle;
  $('btnRepeat').onclick = $('pRepeat').onclick = cycleRepeat;
  $('btnMute').onclick = () => { S.muted = !S.muted; engine.setVolume(S.volume, S.muted); saveSettings(); renderVolume(); };
  vol.oninput = () => { S.volume = vol.value / 100; S.muted = false; engine.setVolume(S.volume, false); saveSettings(); renderVolume(); };
  bindSeek(seek, 'dragging', 'cur'); bindSeek(pSeek, 'pDragging', 'pCur');
  $('pinfo').onclick = () => (narrow() ? openPlayer() : togglePlayer());
  $('btnExpand').onclick = togglePlayer;
  $('btnLyr').onclick = () => {
    if (NAV.view === 'lyr' && !PL.open) { const b = NAV.beforeLyr || 'home'; go(b, { push: false }); return; }
    if (PL.open) closePlayer();
    if (NAV.view !== 'lyr') NAV.beforeLyr = NAV.view;
    go('lyr');
  };
  $('pClose').onclick = closePlayer;
  $('pFrom').onclick = () => { if (playPl) { closePlayer(); showPlaylist(playPl); } };
  $('pMore').onclick = e => playerMenu(rectOf(e.currentTarget));
  $('pSpeed').onclick = e => speedPopover(e.currentTarget);
  $('pFx').onclick = () => { go('fx'); scroller.scrollTop = 0; };
  $('pFx').replaceChildren(icon('fx'), el('b', {}, '음장'));
  renderSpeed();
  document.querySelectorAll('[data-ptab]').forEach(b => b.addEventListener('click', () => setPlayerTab(PL.tab === b.dataset.ptab && narrow() ? null : b.dataset.ptab)));
  document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
    const from = TABS.indexOf(NAV.view === 'list' ? 'home' : NAV.view), to = TABS.indexOf(b.dataset.go);
    go(b.dataset.go);
    if (narrow() && from >= 0 && to >= 0 && from !== to) slideIn(to > from ? 1 : -1);   // 아래 메뉴로 옮길 때도 밀기와 같은 방향으로
  }));
  $('btnBack').onclick = () => back();
  $('btnAdd').onclick = e => addMenu(rectOf(e.currentTarget), target(), { create: NAV.view !== 'list' });
  $('btnFind').onclick = () => toggleSearch();
  $('sideNew').onclick = () => createPlaylist();
  $('searchInput').addEventListener('input', debounce(e => { query = e.target.value; refreshView(); scroller.scrollTop = Math.min(scroller.scrollTop, Math.max(0, listTop - 120)); }, 120));
  renderModes(); renderVolume();
}
function renderModes() {
  for (const id of ['btnShuffle', 'pShuffle']) { const b = $(id); b.classList.toggle('on', S.shuffle); b.setAttribute('aria-pressed', S.shuffle); }
  const label = { off: '반복 안 함', all: '전체 반복', one: '한 곡 반복' }[S.repeat];
  for (const id of ['btnRepeat', 'pRepeat']) {
    const rp = $(id); setIcon(rp, S.repeat === 'one' ? 'repeatOne' : 'repeat');
    rp.classList.toggle('on', S.repeat !== 'off'); rp.title = label; rp.setAttribute('aria-label', label);
  }
}
function renderVolume() {
  vol.value = Math.round(S.volume * 100); paintRange(vol);
  setIcon($('btnMute'), S.muted || S.volume === 0 ? 'mute' : 'vol');
  const sv = $('setVol'); if (sv) { sv.value = vol.value; paintRange(sv); sv.nextSibling.textContent = Math.round(S.volume * 100) + '%'; }
}

/* ======================= 앨범아트 작은 그림 =======================
   목록 줄 · 홈 타일 · 재생 화면에 쓰는 160px 그림 (thumbs.js 가 만들고 저장).
   화면에 보일 때만 부탁하고(IntersectionObserver), 이미 아는 그림은 바로 넣는다 */
setThumbSource(key => platform.tagSource(key));
const artIO = 'IntersectionObserver' in window ? new IntersectionObserver(es => {
  for (const e of es) {
    if (!e.isIntersecting) continue;
    artIO.unobserve(e.target);
    const f = e.target.__art; e.target.__art = null;
    if (f) f();
  }
}, { rootMargin: '240px' }) : null;
function whenVisible(node, fn) { if (!artIO) { fn(); return; } node.__art = fn; artIO.observe(node); }
/** 곡 하나의 작은 그림. lazy: 화면에 보일 때 만들기 (긴 홈 화면) */
function thumbEl(key, { lazy = false, extra = null, cancelable = false } = {}) {
  const v = peek(key), img = el('img', { alt: '', hidden: !(v && v.url) });
  if (v && v.url) img.src = v.url;
  const box = el('span', { class: 'th', 'data-k': key }, icon('note'), img, extra);
  if (v === undefined) {
    const ask = () => thumb(key, { cancelable }).then(r => { if (r && r.url) fillThumbs(key, r.url); });
    if (lazy) whenVisible(box, ask); else ask();
  }
  return box;
}
function fillThumbs(key, url) {
  for (const b of document.querySelectorAll('.th[data-k]')) {
    if (b.dataset.k !== key) continue;
    const im = b.querySelector('img');
    if (im && im.hidden) { im.src = url; im.hidden = false; }
  }
}
/** 플레이리스트 그림: 서로 다른 앨범의 그림 4개 (모자라면 1개, 없으면 이름으로 정한 색) */
function mosaic(tracks, seed, cls = '') {
  const box = el('span', { class: 'mosaic ' + cls }, el('span', { class: 'fb', style: fallbackStyle(seed) }, icon('note')));
  const keys = [], albums = new Set(), rest = [];
  for (const t of tracks.slice(0, 40)) {
    const al = (t.album || '').trim().toLowerCase() || t.key;
    if (!albums.has(al)) { albums.add(al); keys.push(t.key); } else rest.push(t.key);
    if (keys.length >= 6) break;
  }
  for (const k of rest) { if (keys.length >= 6) break; if (!keys.includes(k)) keys.push(k); }
  if (!keys.length) return box;
  const urls = [];
  let known = true;
  for (const k of keys) { const v = peek(k); if (v === undefined) { known = false; break; } if (v && v.url) urls.push(v.url); if (urls.length >= 4) break; }
  if (known || urls.length >= 4) putMosaic(box, urls);
  else whenVisible(box, () => fillMosaic(box, keys));
  return box;
}
function putMosaic(box, urls) {
  if (!urls.length) return;
  const use = urls.length >= 4 ? urls.slice(0, 4) : urls.slice(0, 1);
  box.append(el('span', { class: 'mz n' + use.length }, ...use.map(u => el('img', { src: u, alt: '' }))));
}
async function fillMosaic(box, keys) {
  const urls = [];
  for (const k of keys) {
    const known = peek(k), v = known !== undefined ? known : await thumb(k);
    if (v === undefined) break;                        // 화면에서 사라져 만들지 않기로 함
    if (v && v.url) urls.push(v.url);
    if (urls.length >= 4) break;
  }
  if (box.isConnected && !box.querySelector('.mz')) putMosaic(box, urls);
}
/** 재생 화면 · 배경 색: 지금 곡 그림의 대표 색 */
function setAmbient(color) { document.documentElement.style.setProperty('--amb', color || 'var(--accent)'); }

/* ======================= 화면 이동 =======================
   홈 · 음장 · EQ · 가사(PC) · 설정 = 메뉴로 가는 화면, list = 홈 등에서 들어가는 플레이리스트 화면 */
const VIEWS = { home: 'viewHome', list: 'viewList', fx: 'viewFx', eq: 'viewEq', lyr: 'viewLyr', set: 'viewSet' };
const TITLES = { home: '홈', fx: '음장 효과', eq: '이퀄라이저', lyr: '가사', set: '설정' };
const NAV = { view: 'home', stack: [], scroll: {}, lastRoot: 'home' };
const scrollKey = v => (v === 'list' ? 'list:' + shown.id : v);
function go(viewName, { pl = null, push = true } = {}) {
  let v = VIEWS[viewName] ? viewName : 'home';
  if (v === 'lyr' && narrow()) { openPlayer('lyr'); return; }          // 휴대폰: 가사는 재생 화면에서
  if (openMenuClose) openMenuClose();
  if (PL.open) closePlayer();
  const from = NAV.view;
  NAV.scroll[scrollKey(from)] = scroller.scrollTop;
  if (v === 'list') { if (push && from !== 'list') NAV.stack.push(from); }
  else { NAV.stack = []; NAV.lastRoot = v; }
  if (pl) setShown(pl);
  if (EDIT.on && v !== 'list') exitEdit();
  if (v !== 'list' && !$('searchBox').hidden) { query = ''; $('searchInput').value = ''; $('searchBox').hidden = true; }
  NAV.view = v; app.dataset.view = v;
  for (const [k, id] of Object.entries(VIEWS)) $(id).hidden = k !== v;
  const navOn = v === 'list' ? (narrow() ? 'home' : '') : v;
  document.querySelectorAll('[data-go]').forEach(b => { b.classList.toggle('on', b.dataset.go === navOn); b.setAttribute('aria-current', b.dataset.go === navOn ? 'page' : 'false'); });
  renderTopbar();
  if (v === 'home') renderHome();
  else if (v === 'list') refreshView();
  else if (v === 'eq') requestAnimationFrame(drawCurve);
  else if (v === 'set') renderSettings();
  hostLyrics();
  markSide();
  scroller.scrollTop = NAV.scroll[scrollKey(v)] || 0;
  if (v === 'list') { measureList(); renderRows(); }
  onScroll();
}
/* 휴대폰: 좌우로 밀어 아래 메뉴 화면(홈 · 음장 · EQ · 설정) 사이를 옮기기.
   옆으로 밀리는 줄(플레이리스트 타일 · 장르 카드 · 칩) · 슬라이더 · 순서 바꾸기 손잡이 위에서는 하지 않음, 화면 가장자리는 안드로이드 뒤로 가기 몸짓 */
const TABS = ['home', 'fx', 'eq', 'set'];
function slideIn(dir) {
  const v = $(VIEWS[NAV.view]);
  v.classList.remove('in-l', 'in-r'); void v.offsetWidth;
  v.classList.add(dir > 0 ? 'in-r' : 'in-l');
  v.addEventListener('animationend', () => v.classList.remove('in-l', 'in-r'), { once: true });
}
(() => {
  const main = $('main');
  let sw = null;
  const scrollerX = node => {         // 옆으로 밀리는 줄 (플레이리스트 타일 · 장르 카드 · 칩)
    for (let n = node; n && n !== main; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 2) { const ox = getComputedStyle(n).overflowX; if (ox === 'auto' || ox === 'scroll') return n; }
    }
    return null;
  };
  const targetOf = dir => {          // dir: +1 = 다음 화면 (왼쪽으로 밀기), -1 = 이전 화면
    if (NAV.view === 'list') return dir < 0 ? 'back' : 'fx';
    const i = TABS.indexOf(NAV.view);
    return i < 0 ? null : TABS[i + dir] || null;
  };
  const reset = v => { v.classList.remove('swiping'); v.style.transform = ''; v.style.opacity = ''; };
  main.addEventListener('touchstart', e => {
    sw = null;
    if (!narrow() || e.touches.length !== 1 || EDIT.on || DRAG || openModal || openMenuClose || PL.open) return;
    const t = e.touches[0], tg = e.target;
    if (!tg.closest || tg.closest('input, select, textarea, .vs, .knob, .grip, .menu, .topbar')) return;
    if (t.clientX < 20 || t.clientX > innerWidth - 20) return;
    sw = { x: t.clientX, y: t.clientY, t: Date.now(), mode: null, dx: 0, view: $(VIEWS[NAV.view]), sx: scrollerX(tg) };
  }, { passive: true });
  main.addEventListener('touchmove', e => {
    if (!sw || e.touches.length !== 1) return;
    const t = e.touches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y;
    if (!sw.mode) {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        // 옆으로 밀리는 줄 위라면 그 줄이 더 밀릴 수 있을 때는 줄을 밀고, 끝에 닿아 있을 때만 화면을 옮김
        const sx = sw.sx;
        if (sx && (dx < 0 ? sx.scrollLeft < sx.scrollWidth - sx.clientWidth - 2 : sx.scrollLeft > 2)) { sw = null; return; }
        sw.mode = 'h';
      } else { if (Math.abs(dy) > 12) sw = null; return; }
    }
    sw.dx = dx;
    const shift = targetOf(dx < 0 ? 1 : -1) ? dx * 0.5 : dx * 0.12;     // 더 갈 곳이 없으면 조금만 (끝이라는 느낌)
    sw.view.classList.add('swiping');
    sw.view.style.transform = `translateX(${shift}px)`;
    sw.view.style.opacity = String(1 - Math.min(0.35, Math.abs(shift) / innerWidth));
  }, { passive: true });
  const end = () => {
    const s = sw; sw = null;
    if (!s || s.mode !== 'h') return;
    const dt = Math.max(1, Date.now() - s.t), dir = s.dx < 0 ? 1 : -1;
    const far = Math.abs(s.dx) > innerWidth * 0.22 || (Math.abs(s.dx) > 40 && Math.abs(s.dx) / dt > 0.45);
    const target = far ? targetOf(dir) : null;
    if (!target) {
      s.view.classList.remove('swiping'); s.view.classList.add('snap'); s.view.style.transform = ''; s.view.style.opacity = '';
      setTimeout(() => s.view.classList.remove('snap'), 220);
      return;
    }
    reset(s.view);
    if (target === 'back') back(); else go(target);
    slideIn(dir);
  };
  main.addEventListener('touchend', end, { passive: true });
  main.addEventListener('touchcancel', () => { const s = sw; sw = null; if (s && s.mode === 'h') { s.view.classList.add('snap'); reset(s.view); setTimeout(() => s.view.classList.remove('snap'), 220); } }, { passive: true });
})();
function back() {
  if (NAV.stack.length) { go(NAV.stack.pop(), { push: false }); return true; }
  if (NAV.view !== 'home') { go('home'); return true; }
  return false;
}
function renderTopbar() {
  const v = NAV.view;
  $('btnBack').hidden = v !== 'list';
  $('brandM').hidden = v !== 'home';
  $('tbTitle').textContent = v === 'list' ? shown.name : v === 'home' ? '' : TITLES[v];
  $('btnAdd').hidden = $('btnFind').hidden = !(v === 'home' || v === 'list');
}
let heroBottom = 0;
function onScroll() {
  const y = scroller.scrollTop;
  $('main').classList.toggle('scrolled', y > 6);
  $('topbar').classList.toggle('titled', NAV.view !== 'home' && (NAV.view !== 'list' || y > heroBottom - 70));
}
scroller.addEventListener('scroll', () => { onScroll(); if (NAV.view === 'list') scheduleRows(false); }, { passive: true });

/* ======================= 화면: 홈 =======================
   플레이리스트 (2줄, 옆으로 밀어 더 보기) → 최근에 들은 곡 6곡 (더보기) → 장르별 곡 */
const HOME = { sig: '', timer: 0, at: 0, touch: 0 };
function homeDirty() {
  if (!HOME.timer) HOME.timer = setTimeout(homeFlush, 700);
}
function homeFlush() {
  HOME.timer = 0;
  const now = Date.now();
  // 사용자가 홈을 만지는 중이거나, 장르를 천천히 읽는 중이면 다시 그리기를 미룸 (진행 글자는 그 자리에서 바뀜)
  if (NAV.view === 'home' && (now - HOME.touch < 1500 || (GENRE_Q.busy && now - HOME.at < 8000))) { HOME.timer = setTimeout(homeFlush, 1500); return; }
  if (NAV.view === 'home') renderHome();
  markSide(true);
}
['pointerdown', 'wheel', 'scroll', 'touchmove'].forEach(ev => $('viewHome').addEventListener(ev, () => { HOME.touch = Date.now(); }, { capture: true, passive: true }));
scroller.addEventListener('scroll', () => { if (NAV.view === 'home') HOME.touch = Date.now(); }, { passive: true });
function homeSig(lib, groups) {
  const tk = t => t.key + '\u0001' + displayTitle(t) + '\u0001' + t.artist;
  return [
    pls.map(p => [p.id, p.name, p.tracks.length, ...p.tracks.slice(0, 8).map(t => t.key)].join('\u0002')).join('|'),
    recent.slice(0, 6).map(r => { const t = lib.get(r.k); return t ? tk(t) : ''; }).join('|'),
    groups.slice(0, 10).map(g => g.name + ':' + g.tracks.length + ':' + g.tracks.slice(0, 12).map(tk).join('\u0002')).join('|'),
    lib.size, pendingGenres(lib) > 0,
  ].join('#');
}
const pendingGenres = lib => { let n = 0; for (const t of lib.values()) if (t.genre == null) n++; return n; };
function renderHome(force) {
  const box = $('viewHome'), lib = library(), groups = genreGroups(lib);
  const sig = homeSig(lib, groups);
  if (!force && sig === HOME.sig && box.childElementCount) { markPlaying(); return; }
  HOME.sig = sig; HOME.at = Date.now();
  const keepX = new Map([...box.querySelectorAll('[data-x]')].map(n => [n.dataset.x, n.scrollLeft]));
  if (!lib.size) { box.replaceChildren(homeEmpty(), ...(pls.length > 1 ? [shelfPlaylists()] : [])); return; }
  const kids = [genreChips(groups, lib), shelfPlaylists()];
  const rec = [];
  for (const r of recent) { const t = lib.get(r.k); if (t) rec.push(t); if (rec.length >= 6) break; }
  if (rec.length) kids.push(sectionRecent(rec));
  kids.push(...sectionGenres(groups, lib));
  box.replaceChildren(...kids);
  for (const n of box.querySelectorAll('[data-x]')) { const x = keepX.get(n.dataset.x); if (x) n.scrollLeft = x; }
  markPlaying();
  backfillGenres(lib);
}
function shelf(title, body, { sub = '', more = null, arrows = false } = {}) {
  const head = el('div', { class: 'shead' }, el('h2', {}, title, sub ? el('small', {}, sub) : null), el('span', { class: 'sp' }));
  if (arrows) {
    const by = dir => body.scrollBy({ left: dir * body.clientWidth * 0.92, behavior: 'smooth' });
    head.append(el('button', { class: 'ib sm arrow', title: '이전', 'aria-label': '이전', onclick: () => by(-1) }, icon('chevLeft')),
      el('button', { class: 'ib sm arrow', title: '다음', 'aria-label': '다음', onclick: () => by(1) }, icon('chev')));
  }
  if (more) head.append(el('button', { class: 'more', onclick: more[1] }, more[0]));
  return el('section', { class: 'shelf' }, head, body);
}
function genreChips(groups, lib) {
  const row = el('div', { class: 'gchips', 'data-x': 'chips' },
    el('button', { class: 'gchip', onclick: () => showPlaylist(allSongsPl()) }, '모든 곡', el('small', {}, String(lib.size))));
  for (const g of groups) row.append(el('button', { class: 'gchip', onclick: () => showPlaylist(genrePl(g.name)) }, g.name, el('small', {}, String(g.tracks.length))));
  return row;
}
function shelfPlaylists() {
  const grid = el('div', { class: 'pgrid', 'data-x': 'pls' });
  for (const p of pls) grid.append(plTile(p));
  grid.append(el('button', { class: 'ptile new', onclick: () => createPlaylist() },
    el('span', { class: 'mosaic' }, el('span', { class: 'fb' }, icon('plus'))), el('span', { class: 'nm' }, '새 플레이리스트'), el('span', { class: 'ct' }, '만들기')));
  return shelf('플레이리스트', grid, { more: ['관리', managePlaylists], arrows: true });
}
function plTile(p) {
  const tile = el('div', { class: 'ptile', role: 'button', tabindex: '0', 'data-pl': p.id, title: p.name, onclick: () => showPlaylist(p),
    onkeydown: e => { if (e.key === 'Enter') showPlaylist(p); } },
  mosaic(p.tracks, p.name),
  p.tracks.length ? el('button', { class: 'pplay', title: '재생', 'aria-label': `${p.name} 재생`, onclick: e => { e.stopPropagation(); playIn(p, S.shuffle ? -1 : 0); } }, icon('play')) : null,
  el('span', { class: 'nm' }, p.name), el('span', { class: 'ct' }, `${p.tracks.length}곡`));
  tile.addEventListener('contextmenu', e => { e.preventDefault(); plMenu(pointRect(e.clientX, e.clientY), p); });
  return tile;
}
function sectionRecent(rec) {
  const rows = el('div', { class: 'qgrid' });
  rec.forEach((t, i) => rows.append(songRow(t, () => playIn(recentPl(), i, { exact: t.key }))));
  return shelf('최근에 들은 곡', rows, { more: ['더보기 +', () => showPlaylist(recentPl())] });
}
function songRow(t, onPlay) {
  const r = el('div', { class: 'srow2', role: 'button', tabindex: '0', 'data-song': t.key, title: t.name, onclick: onPlay, onkeydown: e => { if (e.key === 'Enter') onPlay(); } },
    thumbEl(t.key, { lazy: true, extra: el('span', { class: 'nowp' }, icon('vol')) }),
    el('span', { class: 'tx' }, el('span', { class: 't1' }, displayTitle(t)), el('span', { class: 't2' }, subLine(t))),
    el('span', { class: 'd num' }, t.duration ? fmtTime(t.duration) : ''),
    el('button', { class: 'x', title: '곡 메뉴', 'aria-label': '곡 메뉴', onclick: e => { e.stopPropagation(); songMenu(rectOf(e.currentTarget), t, onPlay); } }, icon('more')));
  r.addEventListener('contextmenu', e => { e.preventDefault(); songMenu(pointRect(e.clientX, e.clientY), t, onPlay); });
  return r;
}
function songCard(t, onPlay) {
  const c = el('div', { class: 'scard', role: 'button', tabindex: '0', 'data-song': t.key, title: t.name, onclick: onPlay, onkeydown: e => { if (e.key === 'Enter') onPlay(); } },
    thumbEl(t.key, { lazy: true, extra: el('span', { class: 'nowp' }, icon('vol')) }),
    el('span', { class: 't1' }, displayTitle(t)), el('span', { class: 't2' }, t.artist || '알 수 없는 아티스트'));
  c.addEventListener('contextmenu', e => { e.preventDefault(); songMenu(pointRect(e.clientX, e.clientY), t, onPlay); });
  return c;
}
function sectionGenres(groups, lib) {
  const out = [];
  const pending = pendingGenres(lib);
  const named = groups.filter(g => g.name !== '장르 없음');
  if (!named.length) {
    if (pending) out.push(el('div', { class: 'hint ghint' }, genreHint(lib.size, pending)));
    return out;
  }
  for (const g of groups.slice(0, 10)) {
    const row = el('div', { class: 'cards', 'data-x': 'g:' + g.name });
    g.tracks.slice(0, 12).forEach((t, i) => row.append(songCard(t, () => playIn(genrePl(g.name), i, { exact: t.key }))));
    out.push(shelf(g.name === '장르 없음' ? '장르 정보 없음' : g.name, row, { sub: `${g.tracks.length}곡`, more: ['모두 보기', () => showPlaylist(genrePl(g.name))], arrows: true }));
  }
  if (pending) out.push(el('div', { class: 'hint ghint' }, genreHint(lib.size, pending)));
  return out;
}
const genreHint = (n, pending) => `장르 정보를 읽는 중이에요… (${n - pending}/${n})`;
function homeEmpty() {
  return el('div', { class: 'welcome' },
    el('div', { class: 'big' }, icon('note')),
    el('h2', {}, '울림에 오신 걸 환영해요'),
    el('p', {}, '음악 파일이나 폴더를 추가하면 여기에 플레이리스트, 최근에 들은 곡, 장르별 곡이 나와요.'),
    el('div', { class: 'tools' }, ...toolButtons(target())));
}
/** 홈 · 왼쪽 목록에서 '재생 중' 표시만 바꾸기 (다시 그리지 않음) */
function markPlaying() {
  const t = list[P.index], curKey = t ? t.key : null, plId = t && playPl ? playPl.id : null;
  for (const n of document.querySelectorAll('[data-pl]')) n.classList.toggle('playing', n.dataset.pl === plId);
  for (const n of document.querySelectorAll('[data-song]')) n.classList.toggle('cur', n.dataset.song === curKey);
}
/* 1.1.x 에서 옮겨 온 곡은 장르를 아직 모름 → 쉬는 시간에 한 곡씩 읽기 (화면이 켜져 있을 때만) */
const GENRE_Q = { busy: false, done: new Set() };
function backfillGenres(lib = library()) {
  if (GENRE_Q.busy || document.hidden || isSaving()) return;     // 배터리 절약 중에는 미룸
  let t = null;
  const queued = new Set(metaQ.map(x => x.key));
  for (const x of lib.values()) if (x.genre == null && !GENRE_Q.done.has(x.key) && !queued.has(x.key)) { t = x; break; }
  if (!t) return;
  GENRE_Q.busy = true; GENRE_Q.done.add(t.key);
  const idle = fn => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 60));
  idle(() => readTags(platform.tagSource(t.key), { picture: false }).then(info => applyTagsAll(t.key, info)).catch(() => applyTagsAll(t.key, { genre: '' }))
    .finally(() => {
      GENRE_Q.busy = false; saveList();
      const h = document.querySelector('#viewHome .ghint'), l2 = library(), pend = pendingGenres(l2);
      if (h) h.textContent = pend ? genreHint(l2.size, pend) : '';
      setTimeout(() => backfillGenres(), 40);
    }));
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) backfillGenres(); });
/** 같은 파일을 가리키는 모든 곡에 태그 넣기 (여러 플레이리스트 · 재생 중인 가상 목록) */
function applyTagsAll(key, info) {
  const seen = new Set();
  for (const p of [...pls, playPl, shown]) {
    if (!p || seen.has(p)) continue; seen.add(p);
    for (const t of p.tracks) if (t.key === key) { if (info.title || info.artist || info.genre != null) applyTags(t, info, true); }
  }
  homeDirty();
}
function playIn(pl, i = 0, { shuffle = null, exact = null } = {}) {
  if (!pl || !pl.tracks.length) return;
  if (shuffle != null && shuffle !== S.shuffle) { S.shuffle = shuffle; saveSettings(); renderModes(); }
  playPl = pl; list = pl.tracks; order = []; P.index = -1;
  if (!pl.virtual) P.lastReal = pl;
  if (exact) { const j = list.findIndex(t => t.key === exact); if (j >= 0) i = j; }
  if (i < 0) { if (S.shuffle) { rebuildOrder(); i = order[0]; } else i = 0; }
  playIndex(clamp(i, 0, list.length - 1));
  saveList();
}

/* ======================= 화면: 플레이리스트 (긴 목록은 보이는 줄만 그림) ======================= */
const ROW_H = 56;
const vlist = $('vlist'), spacer = $('spacer');
let view = [], query = '', listTop = 0, rowKeys = new Set();
/** 목록 첫 줄이 스크롤 안에서 어디에 있는지 (줄 위치 계산용) */
const offsetIn = node => { let y = 0, n = node; while (n && n !== scroller) { y += n.offsetTop; n = n.offsetParent; } return y; };
function measureList() {
  listTop = offsetIn(vlist);
  const hero = $('plHero');
  heroBottom = offsetIn(hero) + hero.offsetHeight;
}
function refreshView() {
  const L = shown.tracks, q = query.trim().toLowerCase();
  view = [];
  for (let i = 0; i < L.length; i++) {
    const t = L[i];
    if (!q || `${displayTitle(t)} ${t.artist} ${t.album} ${t.name}`.toLowerCase().includes(q)) view.push(i);
  }
  spacer.style.height = view.length * ROW_H + 'px';
  const empty = L.length === 0;
  $('empty').hidden = !empty; vlist.hidden = empty;
  if (empty) { renderEmpty(); spacer.replaceChildren(); }
  if (EDIT.on) renderEditBar();
  renderHero();
  renderPlHead();
  if (NAV.view === 'list') { measureList(); renderRows(); }
  renderNowPlaying();
}
function updateCount() {
  const m = $('plMeta'); if (!m) return;
  const L = shown.tracks, total = L.reduce((s, t) => s + (t.duration || 0), 0);
  m.textContent = L.length ? `${L.length}곡 · ${fmtLong(total)}` + (query.trim() ? ` · 검색 결과 ${view.length}곡` : '') : '곡이 없어요';
}
const fmtLong = s => { const h = Math.floor(s / 3600), m = Math.round(s / 60) % 60; return h ? `${h}시간 ${m}분` : `${Math.max(m, s > 0 ? 1 : 0)}분`; };
let rowsQueued = false, countQueued = false;
function scheduleRows(count = true) {
  if (count) countQueued = true;
  if (rowsQueued) return;
  rowsQueued = true;
  requestAnimationFrame(() => { rowsQueued = false; renderRows(); if (countQueued) { countQueued = false; updateCount(); } });
}
function renderRows() {
  if (NAV.view !== 'list' || vlist.hidden) return;
  const L = shown.tracks, st = scroller.scrollTop - listTop, h = scroller.clientHeight || 800;
  const first = Math.max(0, Math.floor(st / ROW_H) - 6), last = Math.min(view.length, Math.ceil((st + h) / ROW_H) + 6);
  const frag = document.createDocumentFragment(), playing = isPlaying(), cur = list[P.index], curKey = cur ? cur.key : null;
  const keys = new Set();
  for (let k = first; k < last; k++) {
    const i = view[k], t = L[i];
    if (!t) continue;
    keys.add(t.key);
    const isCur = t.key === curKey, sel = EDIT.on && EDIT.sel.has(t);
    frag.append(el('div', { class: 'row' + (isCur ? ' cur' : '') + (isCur && playing ? ' on' : '') + (t.bad ? ' bad' : '') + (sel ? ' sel' : '') + (DRAG && DRAG.from === i ? ' dragging' : ''), style: `top:${k * ROW_H}px`, 'data-i': i, title: t.name },
      EDIT.on ? el('div', { class: 'ck', role: 'checkbox', 'aria-checked': sel ? 'true' : 'false' }, el('span', { class: 'box' }, sel ? icon('check') : null)) : null,
      thumbEl(t.key, { cancelable: true, extra: isCur ? el('span', { class: 'nowp' }, icon(playing ? 'vol' : 'pause')) : null }),
      el('div', { class: 'tx' }, el('div', { class: 't1' }, displayTitle(t)), el('div', { class: 't2' }, subLine(t))),
      el('div', { class: 'd num' }, t.duration ? fmtTime(t.duration) : ''),
      EDIT.on ? el('div', { class: 'grip', title: '끌어서 순서 바꾸기', 'aria-label': '끌어서 순서 바꾸기' }, icon('grip'))
        : el('button', { class: 'x', title: '곡 메뉴', 'aria-label': '곡 메뉴', 'data-act': 'more' }, icon('more'))));
  }
  spacer.replaceChildren(frag);
  const gone = [];
  for (const k of rowKeys) if (!keys.has(k)) gone.push(k);
  if (gone.length) forgetPending(gone);              // 빨리 넘겨 지나간 줄의 그림은 만들지 않음
  rowKeys = keys;
}
function scrollToCurrent() {
  if (NAV.view !== 'list' || !(shown === playPl || (shown.virtual && playPl.virtual && shown.id === playPl.id))) return;
  const cur = list[P.index]; if (!cur) return;
  const k = view.findIndex(i => shown.tracks[i] && shown.tracks[i].key === cur.key);
  if (k < 0 || vlist.hidden) return;
  const y = listTop + k * ROW_H, top = scroller.scrollTop, h = scroller.clientHeight - 200;
  if (y < top + 60 || y + ROW_H > top + h) scroller.scrollTop = Math.max(0, y - h / 2);
}
spacer.addEventListener('click', e => {
  const r = e.target.closest('.row'); if (!r) return;
  const i = +r.dataset.i;
  if (EDIT.on) { if (!e.target.closest('.grip')) toggleSel(i); return; }
  const more = e.target.closest('[data-act=more]');
  if (more) { trackMenu(rectOf(more), i); return; }
  playFromShown(i);
});
// 오른쪽 클릭 · 길게 누르기 → 곡 메뉴
spacer.addEventListener('contextmenu', e => {
  const r = e.target.closest('.row'); if (!r || EDIT.on) return;
  e.preventDefault();
  trackMenu(pointRect(e.clientX, e.clientY), +r.dataset.i);
});
new ResizeObserver(() => { if (NAV.view === 'list') { measureList(); scheduleRows(); } }).observe(scroller);

/** 화면의 플레이리스트에서 i 번째 곡 재생 (재생 목록이 다르면 이 플레이리스트로 옮겨 감) */
function playFromShown(i) { adoptShown(); playIndex(i); }
function adoptShown() {
  if (shown === playPl) return;
  playPl = shown; list = shown.tracks; order = []; P.index = -1;
  if (!shown.virtual) P.lastReal = shown;
  saveList();
}
/** 음악을 넣을 플레이리스트: 보고 있는 플레이리스트, 아니면 마지막으로 본 · 재생한 플레이리스트 */
function target() {
  if (NAV.view === 'list' && !shown.virtual) return shown;
  return P.lastReal && pls.includes(P.lastReal) ? P.lastReal : pls[0];
}
function addItems(items, { play: playNow = false, to = null, open = false } = {}) {
  if (!items || !items.length) return;
  const pl = to && pls.includes(to) ? to : target();
  const L = pl.tracks;
  const have = new Set(L.map(t => t.key)), add = [];
  for (const it of items) { if (!it || !it.key || have.has(it.key)) continue; have.add(it.key); add.push(mkTrack(it)); }
  if (!add.length) {
    toast(`'${pl.name}'에 이미 있는 곡이에요`);
    if (playNow) { const i = L.findIndex(t => t.key === items[0].key); if (i >= 0) playIn(pl, i); }
    return;
  }
  const start = L.length, wasEmpty = start === 0;
  L.push(...add); if (pl === playPl) order = [];
  if (pl === shown) refreshView();
  saveList(); queueMeta(add);
  toast(`'${pl.name}'에 ${add.length}곡을 추가했어요`);
  if (open && !(NAV.view === 'list' && shown === pl)) showPlaylist(pl);
  if (playNow || (wasEmpty && P.index < 0 && !isPlaying())) playIn(pl, start);
}
/** 화면의 플레이리스트에서 곡 빼기 (번호 여러 개) */
function removeTracks(idxs) {
  if (DRAG) DRAG.cancel();
  if (shown.virtual) return;
  const L = shown.tracks, here = shown === playPl;
  const set = new Set(idxs.filter(i => i >= 0 && i < L.length));
  if (!set.size) return;
  const cur = here ? L[P.index] : null, wasCur = here && set.has(P.index), wasPlaying = isPlaying();
  const removed = L.filter((_, i) => set.has(i));
  // 지금 곡을 뺐으면 그 뒤에 남는 첫 곡으로 (= 지금 곡 앞에 남는 곡 수)
  let nextAt = 0;
  if (wasCur) for (let i = 0; i < P.index; i++) if (!set.has(i)) nextAt++;
  const keep = L.filter((_, i) => !set.has(i));
  L.length = 0; L.push(...keep);            // 배열은 그대로 (list 와 같은 배열일 수 있음)
  removed.forEach(t => { t.removed = true; EDIT.sel.delete(t); });
  releaseUnused(removed.map(t => t.key));
  if (here) {
    order = [];
    if (wasCur) {
      endCrossfade(); engine.unload(engine.deck); engine.unload(engine.other); P.index = -1;
      if (L.length && wasPlaying) playIndex(Math.min(nextAt, L.length - 1));
      else { onTrackChange(); onPlayState(); }
    } else if (cur) P.index = L.indexOf(cur);
  }
  if (EDIT.on && !L.length) exitEdit();
  refreshView(); saveList();
}
function removeTrack(i) { removeTracks([i]); }
async function clearList() {
  const L = shown.tracks;
  if (!L.length || shown.virtual) return;
  const ok = await dialog({ title: `'${shown.name}'을(를) 비울까요?`, text: `${L.length}곡이 목록에서 빠져요. 음악 파일은 지워지지 않아요.`, okText: '비우기' });
  if (!ok) return;
  removeTracks(L.map((_, i) => i));
}
function sortList(kind) {
  if (DRAG) DRAG.cancel();
  if (shown.virtual) return;
  const L = shown.tracks, here = shown === playPl, cur = here ? L[P.index] : null;
  const key = t => kind === 'artist' ? `${t.artist}\u0000${t.album}\u0000${displayTitle(t)}` : kind === 'name' ? t.name : displayTitle(t);
  if (kind === 'random') { for (let i = L.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [L[i], L[j]] = [L[j], L[i]]; } }
  else L.sort((a, b) => key(a).localeCompare(key(b), 'ko', { numeric: true, sensitivity: 'base' }));
  if (here) { P.index = cur ? L.indexOf(cur) : -1; order = []; }
  refreshView(); saveList(); scrollToCurrent();
}
/** 화면의 플레이리스트 안에서 from 번째 곡을 to 자리로 */
function moveTrack(from, to) {
  const L = shown.tracks;
  if (shown.virtual || from === to || from < 0 || from >= L.length || to < 0 || to >= L.length) return;
  const here = shown === playPl, cur = here ? L[P.index] : null;
  const [t] = L.splice(from, 1); L.splice(to, 0, t);
  if (here) { P.index = cur ? L.indexOf(cur) : -1; order = []; }
  refreshView(); saveList();
}

async function pickFiles(to = null) { try { addItems(await platform.pickFiles(), { to, open: true }); } catch (e) { toast(errMsg(e, '파일을 열지 못했어요')); } }
async function pickFolder(to = null) {
  try { const items = await platform.pickFolder(); if (items && !items.length) toast('폴더에서 음악 파일을 찾지 못했어요'); addItems(items, { to, open: true }); }
  catch (e) { toast(errMsg(e, '폴더를 열지 못했어요')); }
}
async function scanLibrary(to = null) {
  toast('음악을 찾는 중이에요…');
  try { const items = await platform.scanLibrary(); if (!items.length) toast('음악 파일을 찾지 못했어요'); else addItems(items, { to, open: true }); }
  catch (e) { toast(errMsg(e, '음악을 불러오지 못했어요')); }
}
const errMsg = (e, d) => (e && e.message && /[가-힣]/.test(e.message)) ? e.message : d;

function toolButtons(to = null) {
  return [
    el('button', { class: 'btn', onclick: () => pickFiles(to) }, icon('file'), '파일 추가'),
    el('button', { class: 'btn', onclick: () => pickFolder(to) }, icon('folder'), '폴더 추가'),
    platform.canScan ? el('button', { class: 'btn', onclick: () => scanLibrary(to) }, icon('note'), platform.scanLabel + ' 불러오기') : null,
  ].filter(Boolean);
}
/** 음악 추가 메뉴 (위 막대의 + · 플레이리스트의 +) */
function addMenu(anchor, to, { create = false } = {}) {
  openMenu(anchor, [
    ['file', '파일 추가', () => pickFiles(to), create ? `→ ${to.name}` : ''],
    ['folder', '폴더 추가', () => pickFolder(to)],
    platform.canScan && ['note', platform.scanLabel + ' 불러오기', () => scanLibrary(to)],
    create && null,
    create && ['plus', '새 플레이리스트 만들기', () => createPlaylist()],
  ]);
}
function toggleSearch(open) {
  if (NAV.view !== 'list') { showPlaylist(allSongsPl()); open = true; }
  if (EDIT.on) exitEdit();
  const box = $('searchBox');
  const want = open != null ? open : box.hidden;
  box.hidden = !want;
  if (want) { $('searchInput').focus(); measureList(); scroller.scrollTop = Math.max(scroller.scrollTop, Math.max(0, listTop - 130)); }
  else { query = ''; $('searchInput').value = ''; refreshView(); }
}
function renderEmpty() {
  $('empty').replaceChildren(
    el('div', { class: 'big' }, icon('note')),
    el('b', {}, shown.virtual ? '아직 곡이 없어요' : `'${shown.name}'이(가) 비어 있어요`),
    shown.virtual ? el('div', {}, shown.kind === 'recent' ? '곡을 들으면 여기에 나와요' : '음악을 추가하면 여기에 나와요')
      : el('div', {}, platform.name === 'electron' ? '음악 파일이나 폴더를 추가하거나 창에 끌어다 놓으세요' : '음악 파일이나 폴더를 추가하세요'),
    shown.virtual ? null : el('div', { class: 'tools' }, ...toolButtons(shown)));
}

/* ======================= 플레이리스트 화면 머리 · 만들기 · 관리 ======================= */
const rectOf = node => { const r = node.getBoundingClientRect(); return { getBoundingClientRect: () => r }; };
const pointRect = (x, y) => ({ getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }) });
function renderHero() {
  const p = shown, L = p.tracks, box = $('plHero');
  const sig = [p.id, p.name, p.virtual ? 'v' : '', L.length ? 1 : 0, ...L.slice(0, 8).map(t => t.key)].join('\u0001');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    const kind = p.virtual ? (p.kind === 'genre' ? '장르' : KIND_LABEL[p.kind] || '목록') : '플레이리스트';
    box.replaceChildren(
      mosaic(L, p.name, 'big'),
      el('div', { class: 'hinfo' },
        el('div', { class: 'kind' }, kind),
        el('h1', { class: 'hname' }, p.name),
        el('div', { class: 'hmeta', id: 'plMeta' }),
        el('div', { class: 'hacts' },
          el('button', { class: 'btn primary pill', id: 'plPlay', disabled: !L.length, onclick: () => playIn(p, 0, { shuffle: false }) }, icon('play'), '재생'),
          el('button', { class: 'btn pill', id: 'plShuffle', disabled: !L.length, onclick: () => playIn(p, -1, { shuffle: true }) }, icon('shuffle'), '셔플'),
          p.virtual ? null : el('button', { class: 'ib', id: 'plAdd', title: '음악 추가', 'aria-label': '음악 추가', onclick: e => addMenu(rectOf(e.currentTarget), p) }, icon('plus')),
          el('button', { class: 'ib', id: 'plMenu', title: '더보기', 'aria-label': '플레이리스트 메뉴', onclick: e => listMenu(rectOf(e.currentTarget)) }, icon('more')))));
  }
  updateCount();
}
function renderPlHead() {
  if (NAV.view === 'list') $('tbTitle').textContent = shown.name;
  // 다른 목록에서 재생 중이면 한 줄로 알려 주고 바로 갈 수 있게
  const away = P.index >= 0 && shown !== playPl && !(shown.virtual && playPl.virtual && shown.id === playPl.id);
  const bar = $('plNow');
  bar.hidden = !away;
  if (away) bar.replaceChildren(icon('vol'), el('span', {}, `'${playPl.name}'에서 재생 중`),
    playPl.virtual && !playPl.kind ? null : el('button', { class: 'link', onclick: () => showPlaylist(playPl) }, '그 목록 보기'));
}
function listMenu(anchor) {
  const p = shown, has = p.tracks.length > 0;
  if (p.virtual) {
    openMenu(anchor, [
      has && ['listAdd', '새 플레이리스트로 저장', () => saveAsPlaylist(p)],
      has && ['listAdd', '다른 플레이리스트에 모두 넣기…', () => addToPlaylistMenu(anchor, p.tracks)],
      null,
      ['list', '플레이리스트 관리', managePlaylists],
    ]);
    return;
  }
  openMenu(anchor, [
    has && ['check', '편집 (여러 곡 선택 · 순서 바꾸기)', enterEdit],
    has && ['sort', '정렬…', () => openMenu(anchor, [
      ['sort', '제목 순', () => sortList('title')],
      ['sort', '아티스트 순', () => sortList('artist')],
      ['sort', '파일 이름 순', () => sortList('name')],
      ['shuffle', '무작위로 섞기', () => sortList('random')],
    ])],
    has && ['search', '이 목록에서 찾기', () => toggleSearch(true)],
    null,
    ['edit', '이름 바꾸기', () => renamePlaylist(p)],
    ['copy', '복사해서 새 플레이리스트로', () => duplicatePlaylist(p, { show: true })],
    !!platform.savePlaylist && has && ['export', 'M3U 파일로 내보내기', () => exportPlaylist(p)],
    ['list', '플레이리스트 관리', managePlaylists],
    null,
    has && ['trash', '목록 비우기', clearList],
    pls.length > 1 && ['trash', '이 플레이리스트 삭제', () => deletePlaylist(p)],
  ]);
}
/** 홈 타일 · 왼쪽 목록에서 오른쪽 클릭 */
function plMenu(anchor, p) {
  openMenu(anchor, [
    p.tracks.length && ['play', '재생', () => playIn(p, 0, { shuffle: false })],
    p.tracks.length && ['shuffle', '셔플 재생', () => playIn(p, -1, { shuffle: true })],
    null,
    ['edit', '이름 바꾸기', () => renamePlaylist(p)],
    ['copy', '복사', () => duplicatePlaylist(p)],
    !!platform.savePlaylist && p.tracks.length && ['export', 'M3U 파일로 내보내기', () => exportPlaylist(p)],
    pls.length > 1 && ['trash', '삭제', () => deletePlaylist(p)],
  ]);
}
function uniqueName(base, except = null) {
  base = String(base || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '새 플레이리스트';
  const taken = new Set(pls.filter(p => p !== except).map(p => p.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}
/** 플레이리스트 화면에 보일 목록 바꾸기 (재생 중인 곡은 그대로) */
function setShown(pl) {
  if (!pl || pl === shown) return;
  if (EDIT.on) exitEdit();
  shown = pl;
  query = ''; $('searchInput').value = ''; $('searchBox').hidden = true;
  if (!pl.virtual) P.lastReal = pl;
  queueMeta(pl.tracks.filter(t => !t.tagged));
  saveList();
}
function showPlaylist(pl) {
  if (!pl) return;
  if (PL.open) closePlayer();
  const same = NAV.view === 'list' && shown === pl;
  go('list', { pl, push: NAV.view !== 'list' });
  if (!same) { scroller.scrollTop = 0; onScroll(); scheduleRows(); }
  scrollToCurrent();
}
async function createPlaylist({ show = true, name = null } = {}) {
  const n = name || await dialog({ title: '새 플레이리스트', text: '이름을 정해 주세요.', input: uniqueName('새 플레이리스트'), okText: '만들기', maxLength: 40 });
  if (!n) return null;
  const p = mkPl(uniqueName(n));
  pls.push(p); saveList();
  if (show) { showPlaylist(p); toast(`'${p.name}'을(를) 만들었어요 — 음악을 추가하거나 다른 목록에서 곡을 넣어 보세요`); }
  return p;
}
async function renamePlaylist(p) {
  const n = await dialog({ title: '이름 바꾸기', input: p.name, okText: '바꾸기', maxLength: 40 });
  if (!n || n === p.name) return;
  p.name = uniqueName(n, p); saveList(); if (p === shown) { renderHero(); renderPlHead(); renderTopbar(); } if (MGR.render) MGR.render();
  if (p === shown && !p.tracks.length) renderEmpty();
  renderNowPlaying();
}
function duplicatePlaylist(p, { show = false } = {}) {
  const c = mkPl(uniqueName(`${p.name} 복사본`), p.tracks.map(t => mkTrack(t)));
  pls.splice(pls.indexOf(p) + 1, 0, c); saveList();
  toast(`'${c.name}'을(를) 만들었어요`);
  if (show) showPlaylist(c); else if (MGR.render) MGR.render();
  return c;
}
/** 최근에 들은 곡 · 장르 · 모든 곡 → 진짜 플레이리스트로 */
function saveAsPlaylist(v) {
  const c = mkPl(uniqueName(v.name), v.tracks.map(t => mkTrack(t)));
  pls.push(c); saveList();
  toast(`'${c.name}' 플레이리스트로 저장했어요`);
  showPlaylist(c);
  return c;
}
async function deletePlaylist(p) {
  if (pls.length <= 1) { toast('플레이리스트는 하나 이상 있어야 해요. 대신 목록 비우기를 써 주세요'); return; }
  const ok = await dialog({ title: `'${p.name}'을(를) 지울까요?`, text: `${p.tracks.length}곡이 든 플레이리스트예요. 음악 파일은 지워지지 않아요.`, okText: '지우기' });
  if (!ok || !pls.includes(p)) return;
  const i = pls.indexOf(p);
  pls.splice(i, 1);
  if (P.lastReal === p) P.lastReal = null;
  if (p === playPl) {          // 재생하던 목록이면 멈추고 다른 목록으로
    endCrossfade(); engine.unload(engine.deck); engine.unload(engine.other); P.index = -1;
    playPl = shown !== p ? shown : pls[Math.min(i, pls.length - 1)];
    list = playPl.tracks; order = [];
    onTrackChange(); onPlayState();
  }
  p.tracks.forEach(t => { t.removed = true; });
  releaseUnused(p.tracks.map(t => t.key));
  if (p === shown) { if (EDIT.on) exitEdit(); shown = pls[Math.min(i, pls.length - 1)]; if (NAV.view === 'list') back(); }
  else if (NAV.view === 'list') refreshView();
  saveList(); if (MGR.render) MGR.render();
  toast(`'${p.name}'을(를) 지웠어요`);
}
/** 곡들을 다른 플레이리스트에 복사해 넣기 (이미 있는 곡은 건너뜀) */
function addTracksTo(pl, tracks) {
  const have = new Set(pl.tracks.map(t => t.key));
  const add = [];
  for (const t of tracks) if (t && !t.removed && !have.has(t.key)) { have.add(t.key); add.push(mkTrack(t)); }
  if (!add.length) { toast(`'${pl.name}'에 이미 있는 곡이에요`); return 0; }
  pl.tracks.push(...add); if (pl === playPl) order = [];
  saveList(); if (pl === shown && NAV.view === 'list') refreshView(); if (MGR.render) MGR.render();
  toast(`'${pl.name}'에 ${add.length}곡을 넣었어요`);
  return add.length;
}
function addToPlaylistMenu(anchor, tracks, exclude = null) {
  const items = pls.filter(p => p !== exclude).map(p => ['list', p.name, () => addTracksTo(p, tracks), `${p.tracks.length}곡`]);
  if (items.length) items.push(null);
  items.push(['plus', '새 플레이리스트 만들어 넣기', async () => { const p = await createPlaylist({ show: false }); if (p) addTracksTo(p, tracks); }]);
  openMenu(anchor, items);
}
function trackMenu(anchor, i) {
  const t = shown.tracks[i]; if (!t) return;
  openMenu(anchor, [
    ['play', '재생', () => { const j = shown.tracks.indexOf(t); if (j >= 0) playFromShown(j); }],
    ['listAdd', '다른 플레이리스트에 넣기…', () => addToPlaylistMenu(anchor, [t], shown.virtual ? null : shown)],
    !shown.virtual && null,
    !shown.virtual && ['trash', '이 목록에서 빼기', () => { const j = shown.tracks.indexOf(t); if (j >= 0) removeTracks([j]); }],
  ]);
}
/** 홈의 곡 (최근 · 장르) 메뉴 */
function songMenu(anchor, t, onPlay) {
  openMenu(anchor, [
    ['play', '재생', onPlay],
    ['listAdd', '플레이리스트에 넣기…', () => addToPlaylistMenu(anchor, [t])],
  ]);
}
/* 관리 창: 이름 바꾸기 · 복사 · 순서 · 내보내기 · 지우기 · 가져오기 */
const MGR = { render: null };
function managePlaylists() {
  if (openMenuClose) openMenuClose();
  const rows = el('div', { class: 'plrows' });
  const close = () => { m.remove(); openModal = null; MGR.render = null; };
  const ib = (ic, title, fn, extra = {}) => el('button', { class: 'ib', title, 'aria-label': title, onclick: fn, ...extra }, icon(ic));
  MGR.render = () => {
    rows.replaceChildren(...pls.map((p, i) => el('div', { class: 'plrow' + (p === shown && NAV.view === 'list' ? ' cur' : '') },
      el('button', { class: 'open', onclick: () => { close(); showPlaylist(p); } },
        el('span', { class: 'nm' }, p.name),
        el('small', {}, [`${p.tracks.length}곡`, p.tracks.length ? fmtLong(p.tracks.reduce((s, t) => s + (t.duration || 0), 0)) : '', p === playPl && P.index >= 0 ? '재생 중' : ''].filter(Boolean).join(' · '))),
      ib('up', '위로', () => { if (i > 0) { pls.splice(i - 1, 0, pls.splice(i, 1)[0]); saveList(); MGR.render(); } }, { disabled: i === 0 }),
      ib('edit', '이름 바꾸기', () => renamePlaylist(p)),
      ib('copy', '복사', () => duplicatePlaylist(p)),
      platform.savePlaylist ? ib('export', 'M3U 파일로 내보내기', () => exportPlaylist(p), { disabled: !p.tracks.length }) : null,
      ib('trash', '지우기', () => deletePlaylist(p), { disabled: pls.length <= 1 }))));
  };
  MGR.render();
  const m = el('div', { class: 'modal', onclick: e => { if (e.target === m) close(); } },
    el('div', { class: 'dialog plmgr', role: 'dialog', 'aria-modal': 'true' },
      el('h3', {}, '플레이리스트'),
      rows,
      el('div', { class: 'acts' },
        platform.openPlaylists ? el('button', { class: 'btn', onclick: importPlaylists }, icon('import'), 'M3U 가져오기') : null,
        el('span', { class: 'sp' }),
        el('button', { class: 'btn', onclick: async () => { const p = await createPlaylist({ show: false }); if (p) MGR.render && MGR.render(); } }, icon('plus'), '새로 만들기'),
        el('button', { class: 'btn primary', onclick: close }, '닫기'))));
  document.body.append(m); openModal = close;
  setTimeout(() => m.querySelector('.primary').focus(), 30);
}
/* M3U (PC) */
function toM3U(p) {
  const lines = ['#EXTM3U', `#PLAYLIST:${p.name}`];
  for (const t of p.tracks) {
    lines.push(`#EXTINF:${t.duration > 0 ? Math.round(t.duration) : -1},${[t.artist, displayTitle(t)].filter(Boolean).join(' - ')}`);
    lines.push(t.key);
  }
  return lines.join('\r\n') + '\r\n';
}
async function exportPlaylist(p) {
  try { const f = await platform.savePlaylist(p.name, toM3U(p)); if (f) toast(`'${p.name}'을(를) 내보냈어요`); }
  catch (e) { toast('파일로 내보내지 못했어요'); }
}
async function importPlaylists() {
  let res;
  try { res = await platform.openPlaylists(); } catch (e) { toast('플레이리스트 파일을 열지 못했어요'); return; }
  const lists = Array.isArray(res) ? res : (res && res.lists) || [], failed = (res && res.failed) || 0;
  if (!lists.length) { if (failed) toast(failed > 1 ? `플레이리스트 파일 ${failed}개를 읽지 못했어요` : '플레이리스트 파일을 읽지 못했어요'); return; }
  let last = null, songs = 0, miss = 0;
  for (const r of lists) {
    const p = mkPl(uniqueName(r.name || '가져온 플레이리스트'), r.paths.map(k => mkTrack({ key: k, name: k.split(/[\\/]/).pop() })));
    pls.push(p); last = p;
    songs += r.paths.length; miss += r.missing || 0;
  }
  toast((lists.length > 1 ? `플레이리스트 ${lists.length}개, ${songs}곡을 가져왔어요` : `'${last.name}' — ${songs}곡을 가져왔어요`)
    + (miss > 0 ? ` (${miss}곡은 파일을 찾지 못했어요)` : '') + (failed ? ` · 읽지 못한 파일 ${failed}개` : ''));
  saveList();
  if (MGR.render) MGR.render();
  if (last) { queueMeta(last.tracks); showPlaylist(last); }
}

/* ======================= 왼쪽 메뉴 (PC): 플레이리스트 목록 ======================= */
let sideSig = '';
function markSide(rebuild) {
  const box = $('sidePls');
  const sig = pls.map(p => [p.id, p.name, p.tracks.length, ...p.tracks.slice(0, 6).map(t => t.key)].join('\u0002')).join('|');
  if (rebuild !== false && (sig !== sideSig || !box.childElementCount)) {
    sideSig = sig;
    box.replaceChildren(...pls.map(p => {
      const b = el('button', { class: 'spl', 'data-pl': p.id, title: p.name, onclick: () => showPlaylist(p) },
        mosaic(p.tracks, p.name, 'sm'), el('span', { class: 'tx' }, el('span', { class: 'nm' }, p.name), el('small', {}, `${p.tracks.length}곡`)), el('span', { class: 'eqi' }, icon('vol')));
      b.addEventListener('contextmenu', e => { e.preventDefault(); plMenu(pointRect(e.clientX, e.clientY), p); });
      return b;
    }));
  }
  for (const b of box.children) b.classList.toggle('on', NAV.view === 'list' && shown.id === b.dataset.pl);
  markPlaying();
}

/* 편집: 여러 곡 고르기 · 끌어서 순서 바꾸기 */
const EDIT = { on: false, sel: new Set() };
let DRAG = null;
function enterEdit() {
  if (!shown.tracks.length || shown.virtual) return;
  EDIT.on = true; EDIT.sel.clear();
  if (!$('searchBox').hidden) { query = ''; $('searchInput').value = ''; $('searchBox').hidden = true; }
  $('listPane').classList.add('editing'); document.body.classList.add('editing');
  refreshView();
}
function exitEdit() {
  if (!EDIT.on) return;
  if (DRAG) DRAG.cancel();
  EDIT.on = false; EDIT.sel.clear();
  $('listPane').classList.remove('editing'); document.body.classList.remove('editing'); $('editBar').hidden = true;
  renderRows();
}
function toggleSel(i) {
  const t = shown.tracks[i]; if (!t) return;
  if (EDIT.sel.has(t)) EDIT.sel.delete(t); else EDIT.sel.add(t);
  renderEditBar(); renderRows();
}
const selectedIdx = () => shown.tracks.map((t, i) => EDIT.sel.has(t) ? i : -1).filter(i => i >= 0);
function renderEditBar() {
  const n = EDIT.sel.size, L = shown.tracks, all = L.length > 0 && n === L.length;
  const bar = $('editBar'); bar.hidden = false;
  bar.replaceChildren(
    el('div', { class: 'eh' },
      el('span', { class: 'n' }, n ? `${n}곡 선택` : '곡을 눌러 고르고, ≡ 를 끌어 순서를 바꿔요'),
      el('button', { class: 'btn ghost', onclick: () => { if (all) EDIT.sel.clear(); else L.forEach(t => EDIT.sel.add(t)); renderEditBar(); renderRows(); } }, all ? '선택 해제' : '모두 선택')),
    el('div', { class: 'ea' },
      el('button', { class: 'btn', disabled: !n, onclick: e => addToPlaylistMenu(rectOf(e.currentTarget), L.filter(t => EDIT.sel.has(t)), shown) }, icon('listAdd'), '플레이리스트에 넣기'),
      el('button', { class: 'btn', disabled: !n, onclick: () => removeTracks(selectedIdx()) }, icon('trash'), '빼기'),
      el('button', { class: 'btn primary', onclick: exitEdit }, '완료')));
}
// ≡ 를 끌어 순서 바꾸기 (마우스 · 터치 모두). 줄은 다시 그려지므로 vlist 가 포인터를 잡고 있는다. 화면 끝에 가까우면 페이지를 굴린다
vlist.addEventListener('pointerdown', e => {
  const g = e.target.closest && e.target.closest('.grip');
  if (!g || !EDIT.on || DRAG) return;
  const row = g.closest('.row'), from = +row.dataset.i, L = shown.tracks, tr = L[from];
  const fromK = view.indexOf(from);   // 보이는 줄 위치 (검색으로 걸러져 있으면 곡 번호와 다름)
  if (!(from >= 0 && from < L.length) || fromK < 0) return;
  e.preventDefault();
  vlist.setPointerCapture(e.pointerId);
  const ghost = row.cloneNode(true); ghost.classList.add('dragghost'); ghost.classList.remove('dragging');
  const line = el('div', { class: 'dropline' });
  vlist.append(ghost, line);
  const d = DRAG = { from, k: fromK, y: e.clientY, raf: 0, id: e.pointerId };
  const tick = () => {
    if (DRAG !== d) return;
    const sb = scroller.getBoundingClientRect();
    const barTop = narrow() ? Math.min($('pbar').getBoundingClientRect().top, $('editBar').hidden ? Infinity : $('editBar').getBoundingClientRect().top) : Math.min(sb.bottom, $('editBar').hidden ? Infinity : $('editBar').getBoundingClientRect().top);
    const topEdge = sb.top + 70, bottomEdge = Math.min(sb.bottom, barTop) - 40;
    if (d.y < topEdge) scroller.scrollTop -= Math.ceil((topEdge - d.y) / 5);
    else if (d.y > bottomEdge) scroller.scrollTop += Math.ceil((d.y - bottomEdge) / 5);
    const y = d.y - vlist.getBoundingClientRect().top;
    d.k = clamp(Math.floor(y / ROW_H), 0, view.length - 1);
    ghost.style.top = (y - ROW_H / 2) + 'px';
    line.style.top = ((d.k > fromK ? d.k + 1 : d.k) * ROW_H - 1) + 'px';
    d.raf = requestAnimationFrame(tick);
  };
  const move = ev => { if (DRAG === d && ev.pointerId === d.id) d.y = ev.clientY; };
  const finish = () => {
    DRAG = null;
    cancelAnimationFrame(d.raf); ghost.remove(); line.remove();
    vlist.removeEventListener('pointermove', move); vlist.removeEventListener('pointerup', end); vlist.removeEventListener('pointercancel', end);
    try { vlist.releasePointerCapture(d.id); } catch (err) { /* 이미 놓음 */ }
  };
  // Esc · 뒤로 가기 · 편집 끝내기 · 목록이 바뀔 때: 옮기지 않고 끝냄
  d.cancel = () => { if (DRAG !== d) return; finish(); renderRows(); };
  const end = ev => {
    if (DRAG !== d || ev.pointerId !== d.id) return;
    finish();
    const now = L.indexOf(tr), to = view[d.k];   // 끄는 사이 다른 손가락으로 곡을 뺐을 수도 있으니 곡으로 다시 찾음
    if (ev.type === 'pointerup' && shown.tracks === L && now >= 0 && to != null && to !== now) moveTrack(now, to); else renderRows();
  };
  vlist.addEventListener('pointermove', move); vlist.addEventListener('pointerup', end); vlist.addEventListener('pointercancel', end);
  renderRows();
  d.raf = requestAnimationFrame(tick);
});

/* ======================= 재생 화면 (전체) =======================
   휴대폰: 미니 플레이어를 누르면 아래에서 올라옴 (아래로 밀거나 ⌄ 로 닫기). '다음 트랙' · '가사' 탭.
   PC: 재생 막대는 그대로 두고 그 위를 덮음. 오른쪽에 다음 트랙 · 가사 */
const PL = { open: false, tab: null, timer: 0 };
function openPlayer(tab) {
  if (!list.length && P.index < 0) { toast('재생할 곡이 없어요 — 먼저 음악을 추가해 주세요'); return; }
  if (openMenuClose) openMenuClose();
  const box = $('player');
  clearTimeout(PL.timer);
  PL.open = true; box.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => { if (PL.open) box.classList.add('show'); }));
  PL.timer = setTimeout(() => { if (PL.open) document.body.classList.add('pl-open'); }, 340);   // 다 올라온 뒤에 뒤 화면을 쉬게 함
  setPlayerTab(tab !== undefined ? tab : narrow() ? null : (PL.tab || 'queue'));
  renderPlayerArt(); renderModes(); onPlayState(); updateTimeUI(true);
  setIcon($('btnExpand'), 'chevDown'); $('btnExpand').title = '재생 화면 닫기';
  startViz();
}
function closePlayer() {
  if (!PL.open) return;
  PL.open = false;
  const box = $('player');
  box.classList.remove('show'); document.body.classList.remove('pl-open');
  clearTimeout(PL.timer);
  PL.timer = setTimeout(() => { if (!PL.open) box.hidden = true; }, 320);
  setIcon($('btnExpand'), 'up'); $('btnExpand').title = '재생 화면';
  hostLyrics();
}
function togglePlayer() { if (PL.open) closePlayer(); else openPlayer(); }
function setPlayerTab(tab) {
  if (!narrow() && !tab) tab = 'queue';
  PL.tab = tab;
  $('player').dataset.tab = tab || '';
  document.querySelectorAll('[data-ptab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.ptab === tab)));
  if (tab === 'queue') renderQueue();
  hostLyrics();
  if (isPlaying()) startViz();
}
function renderPlayerArt() {
  const img = $('pArtImg');
  if (P.artUrl) { img.src = P.artUrl; img.hidden = false; } else img.hidden = true;
}
/** 가사 칸은 하나: PC 가사 화면 ↔ 재생 화면의 가사 탭 사이를 옮겨 다닌다 */
function hostLyrics() {
  const pane = $('paneLyr');
  const inPlayer = PL.open && PL.tab === 'lyr';
  const host = inPlayer ? $('pPanel') : $('viewLyr');
  if (pane.parentNode !== host) host.append(pane);
  $('pQueue').hidden = !(PL.open && PL.tab === 'queue');
  const show = inPlayer || (NAV.view === 'lyr' && !narrow());
  const was = !pane.hidden;
  pane.hidden = !show;
  if (show) {
    const t = list[P.index];
    if (t && LY.key !== t.key) loadLyrics(t);
    else if (!was || inPlayer !== LY.inPlayer) renderLyrics();
  }
  LY.inPlayer = inPlayer;
}
/** 다음에 나올 곡 번호들 (무작위 재생 · 반복 설정대로) */
function upcoming(max) {
  const n = list.length, out = [];
  if (!n || P.index < 0) return list.slice(0, max).map((_, i) => i);
  if (S.shuffle) {
    if (order.length !== n) rebuildOrder();
    const k = order.indexOf(P.index);
    for (let j = k + 1; j < n && out.length < max; j++) out.push(order[j]);
  } else {
    for (let j = P.index + 1; j < n && out.length < max; j++) out.push(j);
    if (S.repeat === 'all') for (let j = 0; j < P.index && out.length < max; j++) out.push(j);
  }
  return out;
}
function renderQueue() {
  const box = $('pQueue');
  if (!PL.open || PL.tab !== 'queue') return;
  const cur = list[P.index], kids = [];
  const qrow = (t, i, now) => el('div', { class: 'qrow' + (now ? ' cur' : ''), role: 'button', tabindex: '0', onclick: () => { if (!now) playIndex(i); } },
    thumbEl(t.key, { lazy: true, extra: now ? el('span', { class: 'nowp' }, icon(isPlaying() ? 'vol' : 'pause')) : null }),
    el('span', { class: 'tx' }, el('span', { class: 't1' }, displayTitle(t)), el('span', { class: 't2' }, subLine(t))),
    el('span', { class: 'd num' }, t.duration ? fmtTime(t.duration) : ''));
  if (cur) kids.push(el('div', { class: 'qh' }, '지금 재생 중'), qrow(cur, P.index, true));
  const up = upcoming(80);
  if (up.length) {
    kids.push(el('div', { class: 'qh' }, `다음 트랙 · ${playPl.name}`, S.shuffle ? el('small', {}, ' (무작위)') : null));
    for (const i of up) kids.push(qrow(list[i], i, false));
    if (list.length - 1 > up.length && !(S.repeat !== 'all' && !S.shuffle)) kids.push(el('div', { class: 'hint qmore' }, `… 모두 ${list.length}곡`));
  } else if (cur) kids.push(el('div', { class: 'hint qmore' }, S.repeat === 'off' ? '마지막 곡이에요' : '다음 곡이 없어요'));
  box.replaceChildren(...kids);
}
function playerMenu(anchor) {
  const t = list[P.index];
  openMenu(anchor, [
    t && ['listAdd', '플레이리스트에 넣기…', () => addToPlaylistMenu(anchor, [t])],
    playPl && ['list', `'${playPl.name}' 보기`, () => { closePlayer(); showPlaylist(playPl); }],
    null,
    ['moon', P.sleepAt ? `수면 타이머 (${Math.max(0, Math.ceil((P.sleepAt - Date.now()) / 60000))}분 남음)` : '수면 타이머', () => openMenu(anchor, [
      [P.sleepAt ? 'close' : 'moon', '끄기', () => setSleep(0)], ['moon', '15분', () => setSleep(15)], ['moon', '30분', () => setSleep(30)], ['moon', '1시간', () => setSleep(60)], ['moon', '1시간 30분', () => setSleep(90)],
    ])],
    ['fx', '음장 효과', () => go('fx')],
    ['eq', '이퀄라이저', () => go('eq')],
  ]);
}
// 휴대폰: 재생 화면을 아래로 밀어서 닫기
(() => {
  const box = $('player');
  let y0 = null, t0 = 0, dy = 0;
  box.addEventListener('pointerdown', e => {
    if (!narrow() || e.button > 0 || e.target.closest('input, .pl-panel, .menu, button.ib, .play')) { y0 = null; return; }
    y0 = e.clientY; t0 = Date.now(); dy = 0;
  });
  box.addEventListener('pointermove', e => {
    if (y0 == null) return;
    dy = e.clientY - y0;
    if (dy > 0) { box.classList.add('dragging'); box.style.transform = `translateY(${dy}px)`; }
  });
  const end = () => {
    if (y0 == null) return;
    y0 = null; box.classList.remove('dragging'); box.style.transform = '';
    if (dy > 110 || (dy > 50 && Date.now() - t0 < 300)) closePlayer();
  };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
})();

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
  const pf = $('pFx'); if (pf) pf.classList.toggle('on', n > 0);
}
function renderFx() {
  const pane = $('paneFx'), st0 = scroller.scrollTop;
  const top = el('div', { class: 'fxtop' },
    el('div', {}, el('div', { class: 'label' }, '음장 효과'), el('div', { class: 'hint', id: 'fxHint' })),
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
  pane.replaceChildren(top, el('div', { class: 'label sub' }, '빠른 조절'), macroRow(), chips, listEl);
  updateFxHint();
  if (NAV.view === 'fx') scroller.scrollTop = st0;
}
function fxCard(def) {
  const st = fxState(def.id);
  const card = el('div', { class: 'fx' + (st.on ? ' on' : ''), 'data-id': def.id });
  const sw = switchEl(st.on, v => {
    st.on = v; S.preset = null;
    if (v && !S.fxOn) { S.fxOn = true; engine.setBypass(false); }
    engine.setEnabled(def.id, v); saveSettings();
    if (def.id === 'speed') renderSpeed();
    card.replaceWith(fxCard(def)); refreshFxHeader();
  }, def.name);
  card.append(el('div', { class: 'fx-head', onclick: () => sw.click() },
    el('div', { class: 'tt' }, el('div', { class: 'fx-name' }, def.name), el('div', { class: 'fx-desc' }, def.desc)), sw));
  if (st.on && def.params.length) card.append(fxBody(def));
  return card;
}
function fxBody(def) {
  const st = fxState(def.id), body = el('div', { class: 'fx-body' });
  const touch = () => { if (S.preset) { S.preset = null; refreshPresetChips(); } saveSettings(); };
  const knobs = el('div', { class: 'knobs' });
  for (const p of def.params) {
    const setP = v => { st.p[p.k] = v; engine.setParam(def.id, p.k, v); if (def.id === 'speed') renderSpeed(); syncMacro(def.id, p.k); touch(); };
    if (p.type === 'select') {
      const ctl = p.options.length <= 4 ? segmented(p.options, st.p[p.k], setP) : selectEl(p.options, st.p[p.k], setP);
      body.append(el('div', { class: 'prm' }, el('label', {}, p.label), el('div', { class: 'ctl' }, ctl)));
    } else if (p.type === 'toggle') {
      body.append(el('div', { class: 'prm' }, el('label', {}, p.label), el('div', { class: 'ctl' }, switchEl(!!st.p[p.k], setP, p.label))));
    } else {
      knobs.append(knob({ min: p.min, max: p.max, step: p.step, value: st.p[p.k], def: p.def, center: p.center, label: p.label, fmt: v => fmtParam(p, v), onInput: setP }));
    }
  }
  if (knobs.childElementCount) body.prepend(knobs);
  body.append(el('div', { class: 'fx-foot' },
    el('span', { class: 'hint' }, knobs.childElementCount ? (matchMedia('(pointer: coarse)').matches ? '휠을 좌우로 밀어 돌려요 · 두 번 누르면 기본값' : '휠을 위아래로 끌거나 마우스 휠로 돌려요 · 두 번 누르면 기본값') : ''),
    el('button', {
      class: 'link', onclick: () => {
        st.p = defaultParams(def);
        for (const [k, v] of Object.entries(st.p)) { engine.setParam(def.id, k, v); syncMacro(def.id, k); }
        if (def.id === 'speed') renderSpeed();
        saveSettings(); body.replaceWith(fxBody(def));
      },
    }, '기본값으로')));
  return body;
}
/* 빠른 조절: 맨 위의 휠 6개 — 휠 하나가 효과 하나의 대표 값 (0 이면 그 효과를 끔) */
const macroKnobs = new Map();
const macroOff = m => (m.center != null ? m.center : m.min);
function macroRow() {
  macroKnobs.clear();
  const row = el('div', { class: 'macros', role: 'group', 'aria-label': '빠른 조절' });
  for (const m of MACROS) {
    const st = fxState(m.fx), p = FX_BY_ID[m.fx].params.find(x => x.k === m.k), off = macroOff(m);
    const k = knob({
      min: m.min, max: m.max, step: m.step, value: st.on && S.fxOn ? clamp(st.p[m.k], m.min, m.max) : off, def: off, center: m.center, label: m.label, size: 'm',
      fmt: v => (v === off ? '끔' : fmtParam(p, v)), onInput: v => setMacro(m, v),
    });
    macroKnobs.set(m.fx + '.' + m.k, { m, k });
    row.append(k);
  }
  return row;
}
function setMacro(m, v) {
  const st = fxState(m.fx), on = v !== macroOff(m);
  if (on) { st.p[m.k] = v; engine.setParam(m.fx, m.k, v); }          // 0 으로 돌려 끌 때는 값은 두고 끄기만 (다시 켜면 그 값)
  if (on && !S.fxOn) { S.fxOn = true; engine.setBypass(false); }
  if (on !== st.on) { st.on = on; engine.setEnabled(m.fx, on); }
  S.preset = null; refreshPresetChips(); saveSettings(); updateBadges(); updateFxHint();
  const card = document.querySelector(`#paneFx .fx[data-id="${m.fx}"]`);
  if (card) card.replaceWith(fxCard(FX_BY_ID[m.fx]));
}
/** 효과 카드에서 값을 바꾸면 위의 빠른 조절 휠도 같이 */
function syncMacro(fx, k) {
  const it = macroKnobs.get(fx + '.' + k);
  if (!it) return;
  const st = fxState(fx);
  it.k.setValue(st.on && S.fxOn ? clamp(st.p[k], it.m.min, it.m.max) : macroOff(it.m));
}
function updateFxHint() {
  const h = $('fxHint');
  if (h) h.textContent = S.fxOn ? (activeFxCount() ? `켜진 효과 ${activeFxCount()}개` : '켜진 효과 없음 — 원음') : '꺼짐 — 원음으로 듣는 중';
}

/* ======================= 재생 속도 (재생 화면) ======================= */
const SPEEDS = [50, 75, 100, 125, 150, 200];
const speedLabel = r => (r / 100).toFixed(r % 10 ? 2 : 1) + '×';            // 50 → 0.5×, 125 → 1.25×, 100 → 1.0×
function curSpeed() { const st = fxState('speed'); return { rate: st.on ? st.p.rate : 100, keep: st.p.keep !== false }; }
function renderSpeed() {
  const b = $('pSpeed'); if (!b) return;
  const { rate } = curSpeed();
  b.replaceChildren(icon('speed'), el('b', {}, speedLabel(rate)));
  b.classList.toggle('on', rate !== 100);
}
function applySpeed(rate, keep) {
  const st = fxState('speed');
  st.p.rate = rate; st.p.keep = keep;
  const on = rate !== 100;
  if (on !== st.on) { st.on = on; engine.setEnabled('speed', on); }
  engine.setParam('speed', 'rate', rate); engine.setParam('speed', 'keep', keep);
  saveSettings(); renderSpeed(); updateBadges();
  const card = document.querySelector('#paneFx .fx[data-id="speed"]');
  if (card) card.replaceWith(fxCard(FX_BY_ID.speed));
}
function speedPopover(anchor) {
  const { rate, keep } = curSpeed();
  const chips = el('div', { class: 'spd-chips' });
  const paintChips = r => chips.querySelectorAll('button').forEach(c => c.setAttribute('aria-pressed', String(+c.dataset.r === r)));
  for (const r of SPEEDS) chips.append(el('button', { class: 'chip', 'data-r': r, onclick: () => { kn.setValue(r); set(r); } }, speedLabel(r)));
  const val = el('b', { class: 'num' }, speedLabel(rate));
  const set = r => { applySpeed(r, curSpeed().keep); val.textContent = speedLabel(r); paintChips(r); };
  const kn = knob({ min: 50, max: 200, step: 5, value: rate, def: 100, label: '속도', size: 'l', fmt: v => speedLabel(v), onInput: set });
  const sw = switchEl(keep, v => applySpeed(curSpeed().rate, v), '음정 유지');
  const box = el('div', { class: 'pop spd', role: 'dialog', 'aria-label': '재생 속도' },
    el('div', { class: 'pop-h' }, el('span', {}, '재생 속도'), val),
    chips, el('div', { class: 'spd-knob' }, kn),
    el('label', { class: 'pop-row' }, el('span', {}, '음정 유지', el('small', {}, '빠르게 해도 목소리가 높아지지 않게')), sw));
  paintChips(rate);
  openPopover(anchor, box);
}

function refreshPresetChips() {
  document.querySelectorAll('#presetChips .chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
}
function refreshFxHeader() {
  renderFx();
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
    outputGroup(),
    el('div', { class: 'sgroup' }, el('h3', {}, '가사'),
      srow('인터넷에서 가사 자동으로 찾기', '곡이 바뀌면 제목 · 가수 · 앨범 · 길이로 LRCLIB(lrclib.net)와 다른 사용자들이 고른 가사 목록에서 찾아요 · 앱을 보고 있지 않을 때(백그라운드 재생)는 찾지 않아요', switchEl(S.lyrAuto, v => { S.lyrAuto = v; saveSettings(); }, '가사 자동으로 찾기')),
      platform.network ? srow('모바일 데이터에서 가사 불러오기', '끄면 모바일 데이터로 연결돼 있을 때는 가사를 자동으로 찾지 않아요 (와이파이에 연결되면 찾아요 · 가사 화면의 [지금 찾기]는 언제든 돼요)',
        switchEl(S.lyrOnData, v => { S.lyrOnData = v; saveSettings(); const t = list[P.index]; if (v && t && LY.state === 'data') loadLyrics(t); }, '모바일 데이터에서 가사 불러오기')) : '',
      srow('싱크 없는 가사 자동으로 맞추기', '시간 정보가 없는 가사는 노래를 한 번 분석해 줄마다 시간을 맞춰 따라 넘어가게 해요 (곡마다 한 번, 결과는 이 기기에만 저장)',
        switchEl(S.lyrSync, v => { S.lyrSync = v; saveSettings(); const t = list[P.index]; if (t && LY.key === t.key) loadLyrics(t); }, '싱크 없는 가사 자동으로 맞추기')),
      srow('내가 고른 가사를 다른 사용자와 나누기', '직접 고르거나 틀렸다고 한 가사를 자동으로 알려, 여러 사람이 고른 가사가 모두의 앱에 나와요. 곡 제목 · 가수 · 길이와 가사 번호만 익명으로 보내요.', switchEl(S.lyrShare, v => { S.lyrShare = v; saveSettings(); if (v) flushFeedback().catch(() => {}); }, '고른 가사 나누기'))),
    platform.update ? el('div', { class: 'sgroup' }, el('h3', {}, '업데이트'),
      srow('자동 업데이트', platform.name === 'android' ? '새 버전이 나오면 알려 줘요 — [받기]를 누르면 브라우저에서 받아 설치해요' : '새 버전을 알아서 받아 두었다가 앱을 닫을 때 설치해요',
        switchEl(S.autoUpdate, v => { S.autoUpdate = v; saveSettings(); if (v) checkUpdate(); else discardUpdate(); }, '자동 업데이트')),
      srow(`지금 버전 ${VERSION}`, updateHint(), el('button', { class: 'btn', id: 'updCheckBtn', onclick: () => checkUpdate({ manual: true }) }, '업데이트 확인'))) : '',
    el('div', { class: 'sgroup' }, el('h3', {}, '화면'),
      srow('테마', null, segmented([['system', '시스템'], ['dark', '어둡게'], ['light', '밝게']], S.theme, v => { S.theme = v; saveSettings(); applyTheme(); })),
      srow('유리 효과', '자동: 휴대폰은 가볍게, PC는 풍부하게 굴절 · 배터리 절약 모드이거나 배터리가 20% 이하면 꺼져요',
        segmented([['auto', '자동'], ['rich', '풍부하게'], ['light', '가볍게'], ['off', '끄기']], S.glass, v => { S.glass = v; saveSettings(); setGlass(v, narrow()); })),
      srow('강조 색', null, el('div', { class: 'swatches' }, ...[['blue', '#4c9dff'], ['mint', '#1fc8a0'], ['coral', '#ff7158'], ['violet', '#8f7dff'], ['amber', '#f2b33d']].map(([id, c]) =>
        el('button', { class: 'swatch', style: `background:${c}`, 'aria-pressed': String(S.accent === id), 'aria-label': id, onclick: () => { S.accent = id; saveSettings(); applyTheme(); renderSettings(); } }))))),
    el('div', { class: 'sgroup' }, el('h3', {}, '초기화'),
      srow('음장 효과 · 이퀄라이저 초기화', '모든 효과를 끄고 기본값으로', el('button', { class: 'btn', onclick: resetSound }, '초기화')),
      srow('모든 설정 초기화', '재생목록은 그대로 두고 설정만', el('button', { class: 'btn', onclick: resetAll }, '초기화'))),
    el('div', { class: 'sgroup' }, el('h3', {}, '정보'),
      el('div', { class: 'srow about' }, el('div', {},
        el('b', {}, `울림 ${VERSION}`), el('br'),
        '음장 엔진은 브라우저 엔진(Chromium)에 들어 있는 네이티브 오디오 처리(컨볼루션 잔향 · HRTF 입체음향 · 다이내믹스 · 필터, 2~4배 오버샘플링)로 만들어 끊김이 없어요. 공개된 기법: bs2b 헤드폰 크로스피드(MIT), RBJ 오디오 EQ 필터 공식, MaxxBass 방식 가상 저음, 크리스탈라이저 등.', el('br'),
        '키 조절은 Signalsmith Stretch(MIT), 코덱 엔진은 FFmpeg 7.1.1(LGPL 2.1 이상 — 고치지 않고 wasm 으로 빌드, 소스 · 빌드 방법은 GitHub 의 codec 폴더와 릴리스 페이지)으로 DSD · APE · WavPack · ALAC · AIFF · WMA 등을 풀어요.', el('br'),
        el('button', { class: 'link', onclick: showLicenses }, '오픈소스 라이선스 보기'), el('br'),
        '가사는 LRCLIB(lrclib.net) — 사용자들이 함께 만드는 무료 공개 가사 데이터베이스에서 가져오고, 음악 파일에 들어 있는 가사와 같은 이름의 .lrc 파일도 읽어요.', el('br'),
        el('button', { class: 'link', onclick: () => openExternal(`https://github.com/${REPO}`) }, `github.com/${REPO}`), el('br'),
        `${platform.name === 'android' ? 'Android System WebView' : platform.name === 'electron' ? 'Electron · Chromium' : '브라우저'} 위에서 Web Audio API로 동작해요.`))));
}
/* ---------- 고음질 출력 (DAC) ---------- */
const OUT = { info: null, sinks: null };
const kHz = r => (r % 1000 ? (r / 1000).toFixed(1) : r / 1000) + 'kHz';
/** 파일 형식 한 줄: 'FLAC · 24bit · 96kHz · 무손실' */
function fmtLine(f) {
  if (!f) return '';
  const parts = [f.codec];
  if (f.dsd) parts.push((f.rate / 1e6).toFixed(1) + 'MHz 1bit');
  else { if (f.bits) parts.push(f.bits + 'bit'); if (f.rate) parts.push(kHz(f.rate)); }
  if (f.kbps) parts.push(f.kbps + 'kbps');
  if (f.ch > 2) parts.push(f.ch + '채널');
  parts.push(f.lossless || f.dsd ? '무손실' : '손실 압축');
  return parts.join(' · ');
}
async function curFmt() {
  const d = engine.deck, t = d.track;
  if (!t) return null;
  if (d.fmt) return d.fmt;
  if (d.codec) return null;                     // 코덱 엔진이 곧 알려 줌 (oninfo) — 파일을 한 번 더 열지 않음
  const info = await tagInfo(t).catch(() => null);
  return info && info.fmt ? info.fmt : null;
}
const OUT_NAMES = { usb: 'USB DAC', wired: '유선 이어폰', bt: '블루투스', ble: '블루투스 LE', speaker: '휴대폰 스피커', hdmi: 'HDMI', other: '외부 장치' };
/** 재생 화면의 짧은 형식 표시: 'FLAC 24/96' · 'DSD64' · 'MP3 320k' (고해상도면 강조색) */
function shortFmt(f) {
  if (!f) return '';
  if (f.dsd) return f.codec;
  const r = f.rate ? (f.rate % 1000 ? (f.rate / 1000).toFixed(1) : f.rate / 1000) : '';
  if (f.lossless) return `${f.codec}${f.bits && r ? ` ${f.bits}/${r}` : r ? ` ${r}k` : ''}`;
  return f.kbps ? `${f.codec} ${Math.round(f.kbps)}k` : f.codec;
}
async function renderFmtTag() {
  const tag = $('pFmt');
  if (!tag) return;
  const f = await curFmt().catch(() => null);
  tag.textContent = shortFmt(f);
  tag.hidden = !tag.textContent;
  tag.classList.toggle('hr', !!f && (f.dsd || (f.lossless && ((f.bits || 0) >= 24 || (f.rate || 0) > 48000))));
  tag.title = f ? fmtLine(f) : '';
}
async function renderOutput() {
  renderFmtTag();
  const box = $('outPath');
  if (!box) return;
  const row = (k, v, hint) => el('div', { class: 'op-row' }, el('span', { class: 'op-k' }, k), el('span', { class: 'op-v' }, v, hint ? el('small', {}, hint) : null));
  const f = await curFmt().catch(() => null);
  const t = engine.deck.track, sr = engine.ctx.sampleRate;
  const fileLine = !t ? '곡을 재생하면 보여요' : fmtLine(f) || (t.name || '').split('.').pop().toUpperCase();
  let fileHint = '';
  if (f && f.dsd && engine.deck.codec && engine.deck.codec.out) fileHint = `DSD → ${kHz(engine.deck.codec.out.rate)} 24bit PCM으로 바꿔 재생 (무손실 FLAC으로 넘김)`;
  else if (engine.deck.codec) fileHint = '코덱 엔진(FFmpeg)으로 풀어 재생';
  const n = activeFxCount() + (S.eq.on ? 1 : 0), sp = engine.speed.rate !== 100;
  const procLine = `32bit 실수 · ${kHz(sr)}` + (engine.procOn ? ` · 음장 효과 ${n}개` : ' · 원음 그대로');
  let procHint = engine.procOn ? '효과를 모두 끄면 원음을 한 비트도 바꾸지 않고 내보내요' : '효과가 꺼져 있어 소리를 바꾸지 않아요' + (S.volume < 1 ? ' (볼륨만 디지털로 조절)' : '');
  if (f && f.rate && !f.dsd && f.rate !== sr) procHint = `파일 ${kHz(f.rate)} → ${kHz(sr)}로 고품질 변환 · ` + procHint;
  if (sp) procHint = `속도 ${(engine.speed.rate / 100).toFixed(2)}× · ` + procHint;
  let outLine = '', outHint = '';
  const o = OUT.info;
  if (platform.name === 'android' && o) {
    const d = o.out || {}, name = OUT_NAMES[d.type] || '출력 장치';
    outLine = name + (d.name && d.type !== 'speaker' ? ` (${d.name})` : '');
    if (d.type === 'usb') {
      if (o.mixer) outLine += ` · ${o.mixer.bits}bit${o.mixer.float ? ' 실수' : ''} · ${kHz(o.mixer.rate)}`;
      outHint = !o.hires ? '안드로이드 14 이상에서는 DAC가 받는 최고 품질로 내보낼 수 있어요' : o.mode === 'off' ? '안드로이드 기본 형식으로 내보내요' : o.mixer ? 'DAC가 받는 최고 품질로 내보내요' : '이 DAC는 형식을 바꿀 수 없어요 (안드로이드 기본)';
    } else if (d.type === 'bt' || d.type === 'ble') outHint = '블루투스는 휴대폰과 이어폰이 고른 코덱(LDAC · aptX · AAC 등)으로 보내요';
    else outHint = `휴대폰 DAC · ${kHz(o.native || sr)}`;
  } else {
    const sinks = OUT.sinks || [], cur = sinks.find(x => x.deviceId === (engine.sinkId || 'default')) || sinks.find(x => x.deviceId === 'default');
    outLine = (cur && cur.label) || (engine.sinkId ? '고른 출력 장치' : '시스템 기본 장치');
    outHint = platform.name === 'electron' ? `Windows 공유 모드 · ${kHz(sr)} 32bit 실수로 보냄 — 장치 형식은 Windows 소리 설정에서` : `${kHz(sr)} 32bit 실수`;
  }
  box.replaceChildren(row('파일', fileLine, fileHint), el('div', { class: 'op-arrow' }, '↓'), row('앱 처리', procLine, procHint), el('div', { class: 'op-arrow' }, '↓'), row('출력', outLine, outHint));
}
async function listSinks() {
  try { OUT.sinks = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput'); } catch (e) { OUT.sinks = []; }
  return OUT.sinks;
}
function outputGroup() {
  const g = el('div', { class: 'sgroup', id: 'outGroup' }, el('h3', {}, '고음질 출력 (DAC)'), el('div', { class: 'opath', id: 'outPath' }));
  const A = platform.audioOut;
  if (platform.name === 'android' && A && A.info) {
    const o = OUT.info = A.info();
    if (o.hires) {
      const opts = [['auto', '자동 (최고 품질)'], ['off', '안드로이드 기본'], ...(o.options || []).map(x => [`${x.rate}/${x.enc}`, `${x.bits}bit${x.float ? ' 실수' : ''} · ${kHz(x.rate)}`])];
      g.append(srow('USB DAC 출력 형식', (o.out && o.out.type === 'usb') ? 'DAC가 받는 형식 중에서 골라요 · 자동은 가장 높은 비트와 샘플레이트(최대 192kHz)' : 'USB DAC를 연결하면 적용돼요',
        selectEl(opts, opts.some(x => x[0] === o.mode) ? o.mode : 'auto', v => { A.setMode(v); })));
    } else g.append(srow('USB DAC 출력 형식', '안드로이드 14 이상에서 USB DAC로 최고 품질(예: 32bit · 192kHz)을 직접 고를 수 있어요. 지금은 안드로이드가 정한 형식으로 나가요'));
    if (o.out && (o.out.type === 'bt' || o.out.type === 'ble'))
      g.append(srow('블루투스 음질', 'LDAC를 지원하는 이어폰이면 휴대폰 설정 → 개발자 옵션 → 블루투스 오디오 LDAC 코덱의 재생 품질을 \'오디오 품질에 최적화됨(990kbps)\'으로 두면 가장 좋아요'));
  } else if (A && A.pickSink && engine.canPickSink) {
    const sel = selectEl([['', '시스템 기본 장치']], engine.sinkId, async v => {
      const lab = (OUT.sinks || []).find(x => x.deviceId === v);
      const ok = await engine.setSink(v === 'default' ? '' : v);
      if (!ok) { toast('그 장치로 바꾸지 못했어요'); return; }
      S.sink = v && v !== 'default' ? { id: v, label: lab ? lab.label : '' } : null; saveSettings();
      // 장치의 샘플레이트가 지금과 다르면: 다음에 열 때 그 장치에 맞춰 연다(앱 안 변환 없이)
      let hw = 0; try { const c = new AudioContext({ sinkId: v && v !== 'default' ? v : undefined }); hw = c.sampleRate; c.close(); } catch (e) { /* noop */ }
      toast(hw && hw !== engine.ctx.sampleRate ? `출력 장치를 바꿨어요 · 앱을 다시 열면 이 장치의 ${kHz(hw)}로 맞춰요` : '출력 장치를 바꿨어요');
      renderOutput();
    });
    sel.id = 'sinkSel';
    listSinks().then(sinks => {
      const cur = engine.sinkId;
      sel.replaceChildren(...[['', '시스템 기본 장치'], ...sinks.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => [d.deviceId, d.label || `출력 장치 ${i + 1}`])]
        .map(([v, l]) => el('option', { value: v, selected: v === cur || null }, l)));
      renderOutput();
    });
    g.append(srow('출력 장치', 'USB DAC · 오디오 인터페이스를 고르면 그 장치로 내보내요', sel));
    if (platform.audioOut.openSoundSettings && navigator.userAgent.includes('Windows'))
      g.append(srow('장치 형식 (비트 · 샘플레이트)', 'Windows 소리 설정 → 출력 장치 속성 → 형식에서 24비트 · 192000Hz 처럼 높이면, 앱을 다시 열 때 그 형식으로 맞춰 내보내요',
        el('button', { class: 'btn', onclick: () => platform.audioOut.openSoundSettings() }, '소리 설정 열기')));
  }
  setTimeout(renderOutput, 0);
  return g;
}
if (platform.audioOut && platform.audioOut.onChange) platform.audioOut.onChange(o => {
  const prev = OUT.info && OUT.info.out && OUT.info.out.type;
  OUT.info = o;
  if ($('outGroup')) { if (prev !== (o.out && o.out.type)) renderSettings(); else renderOutput(); }
});
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener && platform.audioOut && platform.audioOut.pickSink) {
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    const sinks = await listSinks();
    if (S.sink && S.sink.id && !sinks.some(d => d.deviceId === S.sink.id)) {       // 고른 장치가 빠짐 → 기본 장치로
      await engine.setSink(''); toast('출력 장치가 빠져 기본 장치로 내보내요');
    } else if (S.sink && S.sink.id && engine.sinkId !== S.sink.id && sinks.some(d => d.deviceId === S.sink.id)) {
      await engine.setSink(S.sink.id);                                             // 다시 꽂음 → 그 장치로
    }
    if ($('outGroup')) renderSettings();
  });
}

/** 함께 쓰는 공개 소프트웨어의 라이선스 전문 */
async function showLicenses() {
  const parts = await Promise.all([['Signalsmith Stretch (MIT)', 'js/vendor/LICENSE-signalsmith-stretch.txt'], ['FFmpeg (LGPL 2.1 이상)', 'js/vendor/LICENSE-ffmpeg-LGPL-2.1.txt']]
    .map(async ([name, path]) => { let t = ''; try { t = await (await fetch(path)).text(); } catch (e) { t = '(읽지 못함)'; } return [name, t]; }));
  const prev = openModal;
  const close = () => { m.remove(); openModal = prev; };
  const m = el('div', { class: 'modal', onclick: e => { if (e.target === m) close(); } },
    el('div', { class: 'dialog lic', role: 'dialog', 'aria-modal': 'true' }, el('h3', {}, '오픈소스 라이선스'),
      el('p', {}, 'FFmpeg 은 고치지 않은 7.1.1 판을 codec 폴더의 설정(build_codec.sh)으로 빌드했어요. FFmpeg 소스는 GitHub 릴리스 페이지에서 받을 수 있어요.'),
      el('div', { class: 'lic-body' }, ...parts.flatMap(([name, t]) => [el('h4', {}, name), el('pre', {}, t)])),
      el('div', { class: 'acts' }, el('button', { class: 'btn primary', onclick: close }, '닫기'))));
  document.body.append(m); openModal = close;
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
/* 가사의 인터넷 사용: 화면이 꺼져 있으면(백그라운드 재생) 찾지 않고 다시 볼 때 찾음,
   휴대폰이 모바일 데이터로 연결돼 있으면 설정('모바일 데이터에서 가사 불러오기')을 켰을 때만 자동으로 찾음 (직접 찾기는 언제든) */
const onCellular = () => !!(platform.network && platform.network() === 'cellular');
const lyricsNetOK = () => S.lyrOnData || !onCellular();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const t = list[P.index];
  if (t && LY.key !== t.key) loadLyrics(t);                // 백그라운드에서 미뤄 둔 가사
});
if (platform.onNetwork) platform.onNetwork(type => {
  const t = list[P.index];
  if (type !== 'cellular' && t && !document.hidden && LY.key === t.key && LY.state === 'data') loadLyrics(t);   // 와이파이에 연결되면 찾기
});
async function loadLyrics(t, { force = false, retry = false } = {}) {
  if (lyRetry) lyRetry();
  stopAutoSync();
  if (t && document.hidden && !force) { LY.key = null; LY.tok++; LY.data = null; LY.state = 'idle'; return; }   // 다시 보일 때 (visibilitychange)
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
  if (!force && !lyricsNetOK()) return c && !c.none ? show(c) : show(null, 'data');      // 모바일 데이터 — 전에 찾아 둔 가사만
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
const syncLabel = d => d.auto ? (LY.auto && LY.auto.data === d && (LY.auto.confidence >= 0.6 || LY.auto.anchors.length >= 2) ? ' · 자동 맞춤' : ' · 자동 맞춤(대략)') : d.synced ? ' · 싱크' : '';
const fmtSrc = d => !d ? '' : d.source === 'lrc' ? '.lrc 파일' + syncLabel(d) : d.source === 'tag' ? '음악 파일에 들어 있는 가사' + syncLabel(d)
  : d.source === 'community' ? '다른 사용자들이 고른 가사' + syncLabel(d) : d.source === 'manual' ? '내가 고른 가사' + syncLabel(d)
  : d.source === 'lrclib' ? 'LRCLIB 자동 검색' + syncLabel(d) : '';
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
  else if (LY.state === 'data') kids.push(msg('모바일 데이터로 연결돼 있어 가사를 찾지 않았어요', el('div', { class: 'hint' }, '와이파이에 연결되면 자동으로 찾아요 · 설정 → 가사에서 바꿀 수 있어요'),
    el('button', { class: 'btn', onclick: () => loadLyrics(t, { force: true }) }, icon('search'), '지금 찾기')));
  else if (LY.state === 'offline') kids.push(msg('인터넷에 연결되어 있지 않아요', el('div', { class: 'hint' }, '연결되면 자동으로 다시 찾아요'),
    el('button', { class: 'btn', onclick: () => loadLyrics(t, { force: true }) }, '다시 시도')));
  else if (LY.state === 'busy') kids.push(msg('가사 서버(LRCLIB)가 지금 붐벼서 가사를 가져오지 못했어요', el('div', { class: 'hint' }, '30초 뒤 자동으로 다시 찾아볼게요'),
    el('button', { class: 'btn', onclick: () => loadLyrics(t, { force: true }) }, '지금 다시 시도')));
  else if (LY.state === 'instrumental') {
    kids.push(msg(LY.data && LY.data.match ? '연주곡이에요 — 가사가 없어요' : '가사가 없는 곡이에요'));
    if (online) kids.push(lyricsFooter());
  } else if (LY.data) {
    const A = LY.auto && LY.auto.data === LY.data ? LY.auto : null;
    if (A && A.state === 'working') kids.push(el('div', { class: 'lynote' }, el('span', { class: 'spin' }), '노래에 맞춰 가사 시간을 맞추는 중이에요…'));
    const body = el('div', { class: 'lybody' + (LY.data.synced ? ' synced' : ' plain') + (LY.data.auto ? ' auto' : ''), id: 'lyBody' });
    LY.data.lines.forEach((l, i) => {
      if (!l.text) { body.append(el('p', { class: 'ly gap', 'data-i': i })); return; }
      body.append(el('p', { class: 'ly', 'data-i': i }, l.text));
    });
    if (LY.data.auto) {
      // 자동 맞춤: 줄을 누르면 '지금 이 줄을 부르는 중' 으로 맞춤 (가장 빨리 정확해지는 방법). 길게 누르기 · 오른쪽 클릭 = 메뉴
      body.classList.toggle('rough', !(A && (A.confidence >= 0.25 || A.anchors.length)));
      kids.push(el('div', { class: 'lynote auto' }, icon('check'),
        el('span', {}, A && A.anchors.length ? `내가 맞춘 줄 ${A.anchors.length}개로 맞췄어요 · 어긋나면 지금 부르는 줄을 눌러 주세요` : '시간 정보가 없는 가사라 노래를 분석해 대략 맞췄어요 · 지금 부르는 줄을 누르면 거기에 맞춰져요')));
      body.addEventListener('click', e => { const p = e.target.closest('.ly:not(.gap)'); if (p) anchorLine(+p.dataset.i); });
      body.addEventListener('contextmenu', e => { const p = e.target.closest('.ly:not(.gap)'); if (!p) return; e.preventDefault(); autoLineMenu(pointRect(e.clientX, e.clientY), +p.dataset.i); });
    } else if (LY.data.synced) body.addEventListener('click', e => { const p = e.target.closest('.ly'); if (!p) return; const l = LY.data.lines[+p.dataset.i]; if (l && l.t != null) { seekTo(l.t); LY.userScroll = 0; } });
    kids.push(body);
    if (online) kids.push(lyricsFooter());
  }
  pane.replaceChildren(...kids);
  pane.scrollTop = 0;
  LY.idx = -2;
  syncLyrics(true);
  maybeAutoSync();
}

/* ---------- 자동 싱크: 시간 정보가 없는 가사를 노래에 맞추기 (js/autosync.js) ----------
   가사 화면이 보일 때만, 곡마다 한 번 분석하고 기기에 저장 (다음부터는 바로). 사용자가 줄을 눌러 맞춘 시간도 함께 저장 */
function trackDur(t) {
  const a = engine.deck.a;
  return engine.deck.track === t && isFinite(a.duration) && a.duration > 0 ? a.duration : (t ? t.duration || 0 : 0);
}
function stopAutoSync() { if (LY.auto && LY.auto.ctrl) LY.auto.ctrl.abort(); LY.auto = null; }
function maybeAutoSync() {
  const d = LY.data, t = list[P.index];
  if (document.hidden || !S.lyrSync || !d || d.synced || d.instrumental || !t || LY.key !== t.key || (LY.auto && LY.auto.data === d)) return;
  if (d.lines.filter(l => l.text).length < 2 || !(trackDur(t) >= 20)) return;
  runAutoSync(t, d);
}
async function runAutoSync(t, d) {
  const ctrl = new AbortController(), dur = trackDur(t), lines = d.lines.map(l => l.text || '');
  const A = LY.auto = { state: 'working', ctrl, key: t.key, data: d, lines, dur, times: null, anchors: [], confidence: 0, seq: 0 };
  const timer = setTimeout(() => { if (LY.auto === A && A.state === 'working') renderLyrics(); }, 400);   // 금방 끝나면 '맞추는 중' 을 안 보임
  try {
    const r = await autoSync({ key: t.key, url: platform.mediaUrl(t.key), lines, duration: dur, signal: ctrl.signal });
    if (LY.auto !== A || LY.data !== d) return;
    if (!r || !Array.isArray(r.times) || r.times.length !== lines.length) throw new Error('no times');
    Object.assign(A, { state: 'done', ctrl: null, times: r.times, anchors: r.anchors || [], method: r.method, confidence: r.confidence || 0 });
    applyAutoTimes(A);
    renderLyrics();                 // 설명은 가사 위 안내 줄에 (알림을 덮어쓰지 않게 토스트는 안 띄움)
    memHint();
  } catch (e) {
    if (ctrl.signal.aborted || LY.auto !== A) return;
    A.state = 'failed'; A.ctrl = null;
    renderLyrics();
  } finally { clearTimeout(timer); }
}
/** 맞춘 시간을 가사 줄에 넣는다 (빈 줄 · 머리말은 다음 줄 시간). A.times 에는 사용자가 맞춘 줄이 이미 반영돼 있음 */
function applyAutoTimes(A) {
  const d = A.data, n = d.lines.length, times = A.times;
  const out = new Array(n);
  let next = null;
  for (let i = n - 1; i >= 0; i--) { if (times[i] != null && isFinite(times[i])) next = times[i]; out[i] = times[i] != null && isFinite(times[i]) ? times[i] : next; }
  let prev = 0;
  for (let i = 0; i < n; i++) { if (out[i] == null) out[i] = prev; out[i] = Math.max(prev, out[i]); prev = out[i]; }
  d.lines.forEach((l, i) => { l.t = out[i]; });
  d.synced = true; d.auto = true;
}
/** 사용자가 맞춘 줄 목록을 바꾸고 다시 맞추기: 바로 앞뒤를 늘이고 줄여 보여 준 뒤, 저장해 둔 목소리 곡선으로 다시 정렬한 결과로 바꿈 */
function setAnchors(A, anchors, msg) {
  const seq = ++A.seq;
  A.anchors = anchors;
  if (anchors.length) { A.times = applyAnchors(A.times, anchors); applyAutoTimes(A); }
  LY.idx = -2; LY.userScroll = 0; syncLyrics(true);
  saveAnchors(A.key, A.lines, A.dur, anchors).then(r => {
    if (seq !== A.seq || LY.auto !== A || !r || !Array.isArray(r.times) || r.times.length !== A.lines.length) return;
    A.times = r.times; A.confidence = r.confidence || 0;
    applyAutoTimes(A); renderLyrics();
  }).catch(() => {});
  if (msg) toast(msg);
}
/** 줄을 눌렀을 때: '지금 이 줄을 부르는 중' (사람은 듣고 조금 늦게 누르므로 0.3초 앞당김) */
function anchorLine(i) {
  const A = LY.auto, d = LY.data, t = list[P.index];
  if (!A || A.data !== d || A.state !== 'done' || !d.lines[i] || !t || t.key !== A.key) return;
  const now = Math.max(0, (engine.deck.a.currentTime || 0) - 0.3);
  const anchors = [...A.anchors.filter(x => x.i !== i && Math.abs(x.t - now) > 0.4), { i, t: now }].sort((a, b) => a.i - b.i);
  // 순서가 맞지 않는 기준점(앞 줄인데 시간이 더 늦음)은 새로 누른 것을 믿고 뺀다
  const ok = anchors.filter(x => x.i === i || (x.i < i ? x.t < now : x.t > now));
  setAnchors(A, ok, ok.length > 1 ? `맞춘 줄 ${ok.length}개를 기준으로 시간을 다시 맞췄어요` : '이 줄을 지금 위치에 맞추고 나머지도 다시 맞췄어요');
}
function autoLineMenu(anchor, i) {
  const A = LY.auto, d = LY.data;
  if (!A || A.data !== d || A.state !== 'done' || !d.lines[i]) return;
  const playing = list[P.index] && list[P.index].key === A.key;
  openMenu(anchor, [
    playing && ['check', '지금 부르는 줄로 맞추기', () => anchorLine(i)],
    ['play', '이 줄부터 듣기', () => { seekTo(d.lines[i].t || 0); LY.userScroll = 0; }],
    A.anchors.length && ['close', '내가 맞춘 시간 모두 지우기', () => setAnchors(A, [], '자동으로 맞춘 시간으로 되돌렸어요')],
  ]);
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
  stopAutoSync();
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

/* ======================= 테마 ======================= */
let vizColor = '';
const mqDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const theme = S.theme === 'system' ? (mqDark.matches ? 'dark' : 'light') : S.theme;
  const root = document.documentElement;
  root.dataset.theme = theme; root.dataset.accent = S.accent; vizColor = '';
  const logo = theme === 'dark' ? 'img/icon-dark.png' : 'img/icon.png';     // 로고 바탕: 밝은 화면 흰색 · 어두운 화면 검정
  document.querySelectorAll('.brand img, link[rel=icon]').forEach(n => { if (n.tagName === 'LINK') n.href = logo; else if (!n.src.endsWith(logo)) n.src = logo; });
  if (platform.setTheme) platform.setTheme(getComputedStyle(root).getPropertyValue('--bg').trim(), theme === 'light');
  drawCurve();
}
mqDark.addEventListener('change', () => { if (S.theme === 'system') applyTheme(); });
// 휴대폰 ↔ 넓은 화면 (창 크기 · 화면 회전)
PHONE_MQ.addEventListener('change', () => {
  setGlass(S.glass, narrow());
  if (narrow() && NAV.view === 'lyr') go('home');
  if (PL.open) setPlayerTab(PL.tab);
  hostLyrics(); renderTopbar(); updateTimeUI(true);
  if (NAV.view === 'list') { measureList(); scheduleRows(); }
  sizeAllViz();
  if (isPlaying()) startViz();
});

/* ======================= 비주얼라이저 =======================
   PC 재생 막대 · 재생 화면 두 곳. 보이는 곳이 없으면 그리지 않고 멈춘다 (휴대폰에서 재생 화면을 닫으면 0) */
const fbuf = new Uint8Array(engine.analyser.frequencyBinCount);
const VZ = [
  { c: $('viz'), on: () => !narrow() },
  { c: $('pViz'), on: () => PL.open },
].map(v => ({ ...v, g: v.c.getContext('2d'), w: 0, h: 0, bars: new Float32Array(64) }));
function sizeViz(v) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  v.w = v.c.clientWidth; v.h = v.c.clientHeight;
  v.c.width = Math.round(v.w * dpr); v.c.height = Math.round(v.h * dpr);
  v.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawViz(v, true);
}
function sizeAllViz() { VZ.forEach(sizeViz); }
VZ.forEach(v => new ResizeObserver(() => { sizeViz(v); if (v.w && v.on() && isPlaying()) startViz(); }).observe(v.c));
function drawViz(v, idle) {
  if (!v.w || !v.h) return 0;
  const n = clamp(Math.floor(v.w / 7), 12, 64), gap = 2, bw = (v.w - gap * (n - 1)) / n;
  const sr = engine.ctx.sampleRate, bins = fbuf.length, binHz = sr / 2 / bins;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    let x = 0;
    if (!idle) {
      const f0 = 40 * Math.pow(400, i / n), f1 = 40 * Math.pow(400, (i + 1) / n);
      const b0 = Math.floor(f0 / binHz), b1 = Math.max(b0 + 1, Math.floor(f1 / binHz));
      for (let b = b0; b < b1 && b < bins; b++) x = Math.max(x, fbuf[b]);
      x /= 255;
    }
    v.bars[i] = Math.max(x, v.bars[i] * 0.86);
    energy += v.bars[i];
  }
  v.g.clearRect(0, 0, v.w, v.h);
  if (!vizColor) vizColor = getComputedStyle(document.documentElement).getPropertyValue('--viz').trim() || '#fff';
  v.g.fillStyle = vizColor;
  for (let i = 0; i < n; i++) {
    const x = v.bars[i], hgt = Math.max(2, x * v.h);
    v.g.globalAlpha = 0.3 + 0.6 * x;
    v.g.fillRect(i * (bw + gap), v.h - hgt, bw, hgt);
  }
  v.g.globalAlpha = 1;
  return energy;
}
let vizRAF = 0, vizTick = 0;
function vizLoop() {
  const playing = isPlaying();
  updateTimeUI(); syncLyrics();
  const vis = VZ.filter(v => v.on() && v.w);
  if (!vis.length) { vizRAF = 0; engine.setTap(false); return; }      // 그릴 곳이 없으면 멈춤 (시간 · 가사는 timeupdate 로)
  let e = 1;
  if ((++vizTick & 1) === 0 || !playing) {             // 30fps 면 충분 (배터리)
    if (playing) engine.analyser.getByteFrequencyData(fbuf);
    e = 0; for (const v of vis) e += drawViz(v, !playing);
  }
  if (!playing && e < 0.05) { vizRAF = 0; engine.setTap(false); for (const v of vis) drawViz(v, true); return; }
  vizRAF = requestAnimationFrame(vizLoop);
}
function startViz() { if (!vizRAF && !document.hidden) { engine.setTap(true); vizRAF = requestAnimationFrame(vizLoop); } }
document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(vizRAF); vizRAF = 0; engine.setTap(false); } else if (isPlaying()) startViz(); });

/* ======================= 토스트 · 대화상자 · 메뉴 ======================= */
let toastT = 0;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}
let openModal = null;
function dialog({ title, text, input, okText = '확인', cancelText = '취소', maxLength = 20 }) {
  return new Promise(resolve => {
    const inp = input != null ? el('input', { type: 'text', value: input, maxlength: String(maxLength) }) : null;
    const prev = openModal;                       // 관리 창 위에 열렸으면 닫을 때 되돌려 준다
    const close = v => { m.remove(); openModal = prev; resolve(v); };
    const ok = () => close(inp ? inp.value.trim() || null : true);
    const m = el('div', { class: 'modal', onclick: e => { if (e.target === m) close(null); } },
      el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, el('h3', {}, title), text ? el('p', {}, text) : null, inp,
        el('div', { class: 'acts' }, el('button', { class: 'btn ghost', onclick: () => close(null) }, cancelText), el('button', { class: 'btn primary', onclick: ok }, okText))));
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    document.body.append(m); openModal = () => close(null);
    setTimeout(() => (inp || m.querySelector('.primary')).focus(), 30);
    if (inp) inp.select();
  });
}
let openMenuClose = null;
/** items: [아이콘, 글, 할 일, 오른쪽 작은 글씨?] · null = 구분선 · false = 숨김 */
function openMenu(anchor, items, { align = 'right' } = {}) {
  if (openMenuClose) openMenuClose();
  const menu = el('div', { class: 'menu', role: 'menu' });
  const clean = [];
  for (const it of items) {
    if (it === false || it === undefined) continue;
    if (!it && (!clean.length || !clean[clean.length - 1])) continue;
    clean.push(it);
  }
  while (clean.length && !clean[clean.length - 1]) clean.pop();
  for (const it of clean) {
    if (!it) { menu.append(el('hr')); continue; }
    const [ic, label, fn, hint] = it;
    menu.append(el('button', { role: 'menuitem', title: label, onclick: () => { close(); fn(); } }, icon(ic), el('span', { class: 'lb' }, label), hint ? el('small', {}, hint) : null));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = clamp(align === 'left' ? r.left : r.right - mw, 8, innerWidth - mw - 8) + 'px';
  menu.style.top = (r.bottom + 6 + mh > innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6) + 'px';
  const onDoc = e => { if (!menu.contains(e.target)) close(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  function close() { menu.remove(); document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey); openMenuClose = null; }
  setTimeout(() => { document.addEventListener('pointerdown', onDoc, true); document.addEventListener('keydown', onKey); }, 0);
  openMenuClose = close;
}

/** 작은 창 (재생 속도 등): 메뉴처럼 버튼 근처에 뜨고 바깥을 누르거나 Esc 로 닫힘 */
function openPopover(anchor, box) {
  if (openMenuClose) openMenuClose();
  box.classList.add('menu');
  document.body.append(box);
  const r = anchor.getBoundingClientRect(), mw = box.offsetWidth, mh = box.offsetHeight;
  box.style.left = clamp(r.left + r.width / 2 - mw / 2, 8, innerWidth - mw - 8) + 'px';
  box.style.top = (r.bottom + 8 + mh > innerHeight ? Math.max(8, r.top - mh - 8) : r.bottom + 8) + 'px';
  const onDoc = e => { if (!box.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  function close() { box.remove(); document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey); openMenuClose = null; }
  setTimeout(() => { document.addEventListener('pointerdown', onDoc, true); document.addEventListener('keydown', onKey); }, 0);
  openMenuClose = close;
  const f = box.querySelector('.knob, button'); if (f) f.focus({ preventScroll: true });
}

/* ======================= 키보드 · 끌어놓기 · 뒤로가기 ======================= */
document.addEventListener('keydown', e => {
  if (e.defaultPrevented) return;
  if (openModal) { if (e.key === 'Escape') { e.preventDefault(); openModal(); } return; }   // 맨 위 창만 닫기 (대화상자 → 관리 창 순서)
  if (openMenuClose) return;                     // 메뉴가 열려 있으면 메뉴가 처리 (Esc 로 닫기)
  const tg = e.target;
  if (tg.closest && tg.closest('input[type=text]') && e.key === 'Escape') { if (tg.id === 'searchInput') { toggleSearch(false); tg.blur(); } return; }
  if (tg.closest && (tg.closest('input[type=text], select, .vs, .knob, .menu') || (tg.matches('input[type=range]') && e.key.startsWith('Arrow')))) return;
  if (e.key === 'Enter' && tg.closest && tg.closest('button, [role=button]')) return;
  const a = engine.deck.a, ctrl = e.ctrlKey || e.metaKey;
  if (EDIT.on && e.key === 'Escape') { exitEdit(); return; }
  if (EDIT.on && e.key === 'Delete' && EDIT.sel.size) { if (DRAG) DRAG.cancel(); removeTracks(selectedIdx()); return; }
  if (e.key === 'Escape') { if (PL.open) closePlayer(); else if (!$('searchBox').hidden) toggleSearch(false); else back(); return; }
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight' && ctrl) { e.preventDefault(); next(); }
  else if (e.key === 'ArrowLeft' && ctrl) { e.preventDefault(); prev(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(a.currentTime + 5); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(a.currentTime - 5); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); S.volume = clamp(S.volume + 0.05, 0, 1); S.muted = false; engine.setVolume(S.volume, false); renderVolume(); saveSettings(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); S.volume = clamp(S.volume - 0.05, 0, 1); engine.setVolume(S.volume, S.muted); renderVolume(); saveSettings(); }
  else if (e.key.toLowerCase() === 'm' && !ctrl) { S.muted = !S.muted; engine.setVolume(S.volume, S.muted); renderVolume(); saveSettings(); }
  else if (e.key.toLowerCase() === 'o' && ctrl) { e.preventDefault(); pickFiles(); }
  else if (e.key.toLowerCase() === 'f' && ctrl) { e.preventDefault(); if (PL.open) closePlayer(); toggleSearch(true); }
  else if (e.key.toLowerCase() === 'l' && ctrl) { e.preventDefault(); $('btnLyr').click(); }
});
// 버튼에 포커스가 있어도 스페이스는 '재생/일시정지'로만 동작하게
document.addEventListener('keyup', e => { if (e.key === ' ' && !openModal && e.target.closest && e.target.closest('button') && !e.target.closest('.menu')) e.preventDefault(); }, true);
const dropEl = el('div', { class: 'drop', hidden: true }, '여기에 놓으면 플레이리스트에 추가돼요');
document.body.append(dropEl);
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropEl.textContent = `여기에 놓으면 '${target().name}'에 추가돼요`; dropEl.hidden = false; });
window.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropEl.hidden = true; } });
window.addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; dropEl.hidden = true;
  try { addItems(await platform.fromDrop(e.dataTransfer), { play: !isPlaying(), open: NAV.view !== 'list' }); } catch (err) { toast('파일을 추가하지 못했어요'); }
});
// 안드로이드 뒤로 가기: 맨 위에 열린 것부터 닫고, 홈이면 false (앱이 뒤로 감)
window.__ullimBack = () => {
  if (openModal) { openModal(); return true; }
  if (openMenuClose) { openMenuClose(); return true; }
  if (EDIT.on) { exitEdit(); return true; }
  if (PL.open) { if (narrow() && PL.tab) setPlayerTab(null); else closePlayer(); return true; }
  if (!$('searchBox').hidden) { toggleSearch(false); return true; }
  return back();
};
const flush = () => { S.lastPos = P.index >= 0 ? engine.deck.a.currentTime || 0 : 0; store(LS.set, S); savePlaylists(); store(RECENT_KEY, recent); };
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
  setGlass(S.glass, narrow());
  lens($('side')); lens($('pbar'), { light: true }); lens($('bnav'), { light: true });
  watchPower(platform.powerSave);
  renderTransport(); renderFx(); renderEq(); renderSettings();
  go('home', { push: false });
  updateBadges();
  await engine.applyAll(S.fx, S.eq, !S.fxOn);
  if (!engine.workletSupported) toast('이 기기에서는 일부 음장 효과를 쓸 수 없어요');
  if (resumeKey && P.index < 0) {   // 그사이 사용자가 다른 곡을 틀었으면 건드리지 않음
    let i = list.findIndex(t => t.key === resumeKey);
    if (i < 0) {                     // 홈(최근 · 장르)에서 튼 곡이었으면 그 곡이 든 플레이리스트에서
      const pl = pls.find(p => p.tracks.some(t => t.key === resumeKey));
      if (pl) { playPl = pl; list = pl.tracks; order = []; i = list.findIndex(t => t.key === resumeKey); }
    }
    if (i >= 0) await playIndex(i, { autoplay: false, startAt: resumePos });
  }
  renderNowPlaying();
  queueMeta(list.filter(t => !t.tagged));
  if (platform.startupFiles) { try { const items = await platform.startupFiles(); if (items.length) addItems(items, { play: true }); } catch (e) { /* noop */ } }
  if (platform.ready) platform.ready();
  VZ.forEach(v => drawViz(v, true));
  if (S.lyrShare) setTimeout(() => { if (lyricsNetOK()) flushFeedback().catch(() => {}); }, 15000);   // 인터넷이 끊겨 못 보낸 가사 의견 다시 보내기 (모바일 데이터면 다음에)
  if (S.lastVersion && S.lastVersion !== VERSION && isNewer(VERSION, S.lastVersion)) setTimeout(() => toast(`울림 ${VERSION}(으)로 업데이트했어요`), 1500);
  if (S.lastVersion !== VERSION) { S.lastVersion = VERSION; saveSettings(); if (platform.update && platform.update.cleanup) platform.update.cleanup(); }
  if (platform.update) {
    setTimeout(() => { if (S.autoUpdate) checkUpdate(); }, 12000);
    setInterval(() => { if (S.autoUpdate) checkUpdate(); }, 6 * 3600 * 1000);
  }
  setTimeout(() => backfillGenres(), 4000);
}

/* ======================= 자동 업데이트 =======================
   Windows: 새 설치 파일을 받아 두었다가 앱을 닫을 때 조용히 설치 (또는 '지금 다시 시작').
   Android: 새 버전이 나오면 알려 주고 [받기] → 브라우저가 GitHub 릴리스의 APK 를 받음 → 받은 파일을 눌러 설치.
   (앱이 직접 APK 를 내려받아 설치하는 기능은 Play 프로텍트가 '유해한 앱'으로 막아서 1.1.1 부터 쓰지 않음) */
const UPD = { state: 'idle', version: null, notes: '', url: '', err: '' };   // idle · checking · downloading · ready · available · installing · latest · error
const ANDROID_UPD = () => platform.name === 'android';
function updateHint() {
  const v = UPD.version;
  return UPD.state === 'checking' ? '새 버전을 확인하는 중이에요…'
    : UPD.state === 'downloading' ? `새 버전 ${v}을(를) 받는 중이에요…`
    : UPD.state === 'ready' ? `새 버전 ${v} 준비됨 — 앱을 닫으면 설치돼요`
    : UPD.state === 'available' ? `새 버전 ${v}이(가) 나왔어요 — [받기]를 누르면 브라우저에서 받아요`
    : UPD.state === 'installing' ? '설치하는 중이에요…'
    : UPD.state === 'latest' ? '최신 버전이에요'
    : UPD.state === 'error' ? '업데이트를 확인하지 못했어요 (인터넷 연결을 확인해 주세요)'
    : 'GitHub 에서 새 버전을 확인해요';
}
function renderUpdate() {
  const bar = $('updBar');
  const show = (UPD.state === 'available' && S.updHidden !== UPD.version) || UPD.state === 'ready' || UPD.state === 'installing';
  bar.hidden = !show;
  if (show) {
    if (UPD.state === 'available') {
      bar.replaceChildren(icon('import'),
        el('div', { class: 'tx' }, el('b', {}, `새 버전 ${UPD.version}`), el('span', {}, ' 나왔어요')),
        el('button', { class: 'btn primary', onclick: openUpdateDownload }, '받기'),
        el('button', { class: 'ib', title: '이 버전은 알리지 않기', 'aria-label': '이 버전은 알리지 않기', onclick: () => { S.updHidden = UPD.version; saveSettings(); renderUpdate(); } }, icon('close')));
    } else {
      const busy = UPD.state === 'installing';
      bar.replaceChildren(icon('import'),
        el('div', { class: 'tx' }, el('b', {}, `새 버전 ${UPD.version}`), el('span', {}, busy ? ' 설치하는 중…' : ' — 닫으면 자동으로 설치돼요')),
        el('button', { class: 'btn primary', disabled: busy, onclick: restartForUpdate }, '지금 다시 시작'));
    }
  }
  const btn = document.getElementById('updCheckBtn');
  const sm = btn && btn.closest('.srow') && btn.closest('.srow').querySelector('small');
  if (sm) sm.textContent = updateHint();
}
function openUpdateDownload() {
  if (!UPD.url) return;
  platform.openExternal(UPD.url);
  toast('브라우저에서 받은 뒤, 받은 파일을 눌러 설치해 주세요 (재생목록 · 설정은 그대로예요)');
}
function restartForUpdate() {
  if (UPD.state !== 'ready') return;
  UPD.state = 'installing'; renderUpdate();
  flush();
  platform.update.restartNow();
}
function discardUpdate() {
  if (!platform.update || ['downloading', 'installing'].includes(UPD.state)) return;
  UPD.state = 'idle'; UPD.version = null; renderUpdate();
  Promise.resolve(platform.update.discard && platform.update.discard()).catch(() => {});
}
async function checkUpdate({ manual = false } = {}) {
  if (!platform.update || ['checking', 'downloading', 'installing'].includes(UPD.state)) return;
  if (UPD.state === 'ready') { if (manual) toast(`새 버전 ${UPD.version}이(가) 이미 준비되어 있어요`); return; }
  UPD.state = 'checking'; renderUpdate();
  try {
    const m = await fetchLatest();
    const newer = m.file && (ANDROID_UPD() ? Number(m.file.versionCode) > platform.update.versionCode() : isNewer(m.version, VERSION));
    if (!newer) { UPD.state = 'latest'; renderUpdate(); if (manual) toast('지금이 최신 버전이에요'); return; }
    UPD.version = m.version; UPD.notes = m.notes; UPD.url = m.file.url;
    if (ANDROID_UPD()) {
      if (manual && S.updHidden === m.version) { S.updHidden = null; saveSettings(); }   // 직접 확인하면 숨겼던 알림도 다시
      UPD.state = 'available'; renderUpdate();
      if (manual || S.updHidden !== m.version) toast(`새 버전 ${m.version}이(가) 나왔어요 — 화면 맨 위 [받기]를 눌러 주세요`);
      return;
    }
    UPD.state = 'downloading'; renderUpdate();
    if (manual) toast(`새 버전 ${m.version}을(를) 받는 중이에요`);
    await platform.update.download(m.file.url, m.file.sha256, Number(m.file.size), m.version);
    UPD.state = 'ready'; renderUpdate();
    toast(`새 버전 ${m.version}을(를) 받아 두었어요 — 앱을 닫으면 설치돼요`);
  } catch (e) {
    UPD.state = 'error'; UPD.err = String((e && e.message) || e); renderUpdate();
    if (manual) toast('업데이트를 확인하지 못했어요');
  }
}
init();

// 개발 · 테스트용
window.__ullim = { engine, S, get list() { return list; }, get pls() { return pls; }, get shown() { return shown; }, get playPl() { return playPl; },
  addItems, playIndex, playFromShown, applySoundPreset, go, back, P, NAV, PL, setTab: t => (t === 'list' ? showPlaylist(shown) : go(t)), showPlaylist, createPlaylist, renamePlaylist, deletePlaylist, duplicatePlaylist,
  addTracksTo, removeTracks, moveTrack, enterEdit, exitEdit, toggleSel, managePlaylists, toM3U, importPlaylists, checkUpdate, UPD,
  openPlayer, closePlayer, setPlayerTab, playIn, renderHome, recentPl, genrePl, allSongsPl, genreGroups, library, get recent() { return recent; }, toggleSearch, LY, applyTheme, setPlayGlyph, setGlassMode: () => setGlass(S.glass, narrow()) };
