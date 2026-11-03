/*
 * 울림 — 가사
 *  1) 음악 파일과 같은 이름의 .lrc 파일 (PC)
 *  2) 음악 파일 태그 속 가사 (ID3 USLT, Vorbis LYRICS, MP4 ©lyr)
 *  3) LRCLIB (https://lrclib.net) — 누구나 쓸 수 있는 무료 공개 가사 데이터베이스, 싱크 가사 우선
 */
import { platform } from './platform.js';

const API = 'https://lrclib.net/api';
export const REPO = 'omokdie/ullim';
const OVR_URL = `https://raw.githubusercontent.com/${REPO}/main/lyrics/overrides.json`;
const OVR_KEY = 'ullim.lyrovr.v1';
const OVR_TTL = 2 * 3600 * 1000;   // 공용 목록은 2시간마다 새로 받음
const CACHE_KEY = 'ullim.lyrics.v1';
const MAX_CACHE = 300;
const MISS_TTL = 3 * 24 * 3600 * 1000;   // 못 찾은 곡은 3일 뒤 다시 시도

/* ---------- LRC ---------- */
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
export function parseLRC(text) {
  const lines = [];
  let offset = 0;
  for (const raw of String(text || '').split(/\r\n|\n|\r/)) {
    const o = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
    if (o) { offset = Number(o[1]) / 1000; continue; }
    const stamps = [...raw.matchAll(STAMP)];
    if (!stamps.length) continue;
    const txt = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0;
      lines.push({ t: Math.max(0, Number(m[1]) * 60 + Number(m[2]) + frac - offset), text: txt });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

/** 원문 → { synced, lines, raw, source, ... } */
export function toLyrics(raw, source, extra = {}) {
  const text = String(raw || '');
  const timed = parseLRC(text);
  if (timed.filter(l => l.text).length >= 3) return { synced: true, lines: timed, raw: text, source, ...extra };
  const plain = text.replace(/^\s*\[[a-z]+:[^\]]*\]\s*$/gim, '').replace(STAMP, '').split(/\r\n|\n|\r/).map(s => s.trim());
  while (plain.length && !plain[0]) plain.shift();
  while (plain.length && !plain[plain.length - 1]) plain.pop();
  const lines = [];
  for (const s of plain) { if (!s && lines.length && !lines[lines.length - 1].text) continue; lines.push({ text: s }); }
  return { synced: false, lines, raw: text, source, ...extra };
}

/* ---------- 검색어 만들기 ---------- */
const stripExt = n => (n || '').replace(/\.[^.\\/]+$/, '');
export function guessQuery(t) {
  let title = (t.title || '').trim(), artist = (t.artist || '').trim();
  if (!title) {
    let n = stripExt((t.name || '').split(/[\\/]/).pop()).replace(/^\s*\d{1,3}\s*[.\-_)]\s*/, '').replace(/_/g, ' ');
    const parts = n.split(/\s+-\s+/);
    if (parts.length >= 2) { if (!artist) artist = parts[0].trim(); title = parts.slice(1).join(' - ').trim(); }
    else title = n.trim();
  }
  title = title.replace(/\s*[(\[](official|mv|m\/v|lyrics?|audio|video|live|가사|뮤직\s*비디오|공식)[^)\]]*[)\]]/gi, '').trim();
  return { title, artist, album: (t.album || '').trim() };
}
/** 곡 비교용 정규화 — .github/scripts/lyrics_feedback.py 의 norm() 과 똑같아야 한다 */
export const norm = s => (s || '').toLowerCase().normalize('NFKC')
  .replace(/\(.*?\)|\[.*?\]/g, '').replace(/(^|\s)(feat|ft)\.\s.*$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
export const songKey = q => norm(q.artist) + '|' + norm(q.title);

function score(r, q, dur) {
  let s = 0;
  if (r.syncedLyrics) s += 3; else if (r.plainLyrics) s += 1; else if (r.instrumental) s += 0.5; else return -99;
  if (dur && r.duration) { const d = Math.abs(r.duration - dur); s += d <= 2 ? 4 : d <= 5 ? 2 : d <= 15 ? 0 : -4; }
  const rt = norm(r.trackName), qt = norm(q.title);
  if (rt && qt) s += rt === qt ? 3 : (rt.includes(qt) || qt.includes(rt)) ? 1 : -2;
  const ra = norm(r.artistName), qa = norm(q.artist);
  if (qa && ra) s += ra === qa ? 2 : (ra.includes(qa) || qa.includes(ra)) ? 1 : -1;
  return s;
}

export function fromRecord(r) {
  const match = { id: r.id, title: r.trackName, artist: r.artistName, album: r.albumName, duration: r.duration };
  if (!r.syncedLyrics && !r.plainLyrics) return { instrumental: !!r.instrumental, synced: false, lines: [], raw: '', source: 'lrclib', match };
  return toLyrics(r.syncedLyrics || r.plainLyrics, 'lrclib', { match });
}

/* ---------- 네트워크 ---------- */
async function http(url) {
  if (platform.httpGet) {
    const r = await platform.httpGet(url);
    return r || { status: 0, body: '' };
  }
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  return { status: r.status, body: await r.text() };
}
const json = s => { try { return JSON.parse(s); } catch (e) { return null; } };

/** 검색 결과 목록 (직접 검색 화면용) */
export async function searchList(q) {
  const tries = [];
  if (q.title && q.artist) tries.push({ track_name: q.title, artist_name: q.artist });
  const free = [q.title, q.artist].filter(Boolean).join(' ').trim();
  if (free) tries.push({ q: free });
  let reached = false;
  for (const p of tries) {
    const r = await http(`${API}/search?${new URLSearchParams(p)}`);
    if (r.status === 0 || r.status >= 500) continue;
    reached = true;
    const arr = r.status === 200 ? json(r.body) : null;
    if (Array.isArray(arr) && arr.length) return arr.slice(0, 20);
  }
  if (!reached) throw new Error('network');
  return [];
}

/** 가장 잘 맞는 가사 하나 (자동 찾기용). avoid: 사용자들이 '틀렸다'고 알린 LRCLIB 번호 */
export async function findOnline(q, dur, avoid = []) {
  if (!q.title) return null;
  const bad = new Set(avoid.map(Number));
  if (q.artist) {
    const p = new URLSearchParams({ track_name: q.title, artist_name: q.artist });
    if (q.album) p.set('album_name', q.album);
    if (dur > 0) p.set('duration', String(Math.round(dur)));
    const r = await http(`${API}/get?${p}`);
    const j = r.status === 200 ? json(r.body) : null;
    if (j && !bad.has(Number(j.id)) && (j.syncedLyrics || j.plainLyrics || j.instrumental)) return fromRecord(j);
  }
  const list = await searchList(q);
  let best = null, bs = 2.5;
  for (const r of list) { if (bad.has(Number(r.id))) continue; const s = score(r, q, dur); if (s > bs) { bs = s; best = r; } }
  return best ? fromRecord(best) : null;
}

/** LRCLIB 번호로 가져오기 (커뮤니티가 고른 가사) */
export async function getById(id) {
  const r = await http(`${API}/get/${Number(id)}`);
  if (r.status === 0 || r.status >= 500) throw new Error('network');
  const j = r.status === 200 ? json(r.body) : null;
  return j ? fromRecord(j) : null;
}

/* ---------- 커뮤니티 가사 목록 (GitHub 저장소의 lyrics/overrides.json) ---------- */
let ovr = null;
export async function loadOverrides(force = false) {
  let c = null;
  try { c = JSON.parse(localStorage.getItem(OVR_KEY)); } catch (e) { /* noop */ }
  if (c && c.data && !force && Date.now() - c.at < OVR_TTL) { ovr = c.data; return ovr; }
  try {
    const r = await http(`${OVR_URL}?t=${Math.floor(Date.now() / 600000)}`);
    const j = r.status === 200 ? json(r.body) : null;
    if (j && j.songs && typeof j.songs === 'object') {
      ovr = j;
      try { localStorage.setItem(OVR_KEY, JSON.stringify({ at: Date.now(), data: j })); } catch (e) { /* noop */ }
      return ovr;
    }
  } catch (e) { /* offline */ }
  ovr = c && c.data ? c.data : (ovr || { songs: {} });
  return ovr;
}
/** { pick: LRCLIB 번호 | 0(가사 없음) | null, wrong: [자동 찾기에서 뺄 번호…] } — 투표 계산은 GitHub Actions 가 미리 해 둔다 */
export function communityFor(q) {
  const e = ovr && ovr.songs ? ovr.songs[songKey(q)] : null;
  if (!e) return null;
  const pick = typeof e.pick === 'number' && e.pick >= 0 ? e.pick : null;
  const wrong = Array.isArray(e.avoid) ? e.avoid.map(Number).filter(n => n > 0) : [];
  return { pick, wrong };
}

/* ---------- 고른 가사를 다른 사용자와 나누기 (익명 · 자동) ----------
   앱 → ntfy.sh 의 공개 메시지함(로그인 없이 쓰는 무료 서비스, 12시간 보관)
      → GitHub Actions 가 30분마다 모아서 확인 · 투표 → lyrics/overrides.json → 모든 앱이 받아 감
   보내는 것: 곡 제목 · 가수 · 길이, 틀린/맞는 가사 번호, 앱이 처음 켜질 때 만든 무작위 번호(한 사람 한 표용), 앱 버전 */
export const FEEDBACK_URL = 'https://ntfy.sh/ullim-lyrics-259gyx3gfnw7';
const OUT_KEY = 'ullim.lyrout.v1', VOTER_KEY = 'ullim.voter';
function voterId() {
  let v = null;
  try { v = localStorage.getItem(VOTER_KEY); } catch (e) { /* noop */ }
  if (!v || !/^[0-9a-f-]{16,64}$/.test(v)) {
    v = crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(VOTER_KEY, v); } catch (e) { /* noop */ }
  }
  return v;
}
const loadOut = () => { try { const a = JSON.parse(localStorage.getItem(OUT_KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
const saveOut = a => { try { localStorage.setItem(OUT_KEY, JSON.stringify(a)); } catch (e) { /* noop */ } };
async function post(url, body) {
  if (platform.httpPost) { const r = await platform.httpPost(url, body); return r ? r.status : 0; }
  const r = await fetch(url, { method: 'POST', body });
  return r.status;
}
/** 의견 하나를 보낼 상자에 넣고 바로 보낸다. correct: LRCLIB 번호 · 0(가사 없는 곡) · null(모름) */
export function sendFeedback(q, dur, wrong, correct, version) {
  if (!q || !q.title || (wrong == null && correct == null)) return Promise.resolve({ sent: 0, queued: loadOut().length });
  const msg = {
    v: 1, s: q.title.slice(0, 200), a: (q.artist || '').slice(0, 200), d: dur > 0 ? Math.round(dur) : 0,
    w: wrong ? Number(wrong) : null, c: correct == null ? null : Number(correct), u: voterId(), app: version || '',
  };
  const k = songKey(q);
  const box = loadOut().filter(x => x.k !== k);          // 같은 곡에 대한 이전 의견은 새 의견으로 바꾼다
  box.push({ k, body: JSON.stringify(msg), at: Date.now() });
  saveOut(box.slice(-50));
  return flushFeedback();
}
let flushing = null;
/** 아직 못 보낸 의견을 보낸다 (인터넷이 끊겼을 때 쌓인 것 포함) */
export function flushFeedback() {
  if (flushing) return flushing;
  flushing = (async () => {
    let box = loadOut(), sent = 0;
    for (const it of [...box]) {
      if (Date.now() - (it.at || 0) > 30 * 86400e3) { box = box.filter(x => x !== it); continue; }
      let st = 0;
      try { st = await post(FEEDBACK_URL, it.body); } catch (e) { st = 0; }
      if (st >= 200 && st < 300) { box = box.filter(x => x !== it); sent++; }
      else if (st >= 400 && st < 500 && st !== 408 && st !== 429) box = box.filter(x => x !== it);   // 받지 않는 형식 → 버림
      else break;                                         // 인터넷 끊김 · 잠시 제한 → 다음에
    }
    saveOut(box);
    return { sent, queued: box.length };
  })().finally(() => { flushing = null; });
  return flushing;
}

/* ---------- 캐시 (곡별로 기억) ---------- */
let cache = null;
const loadCache = () => { if (!cache) { try { cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (e) { cache = {}; } } return cache; };
export function cacheGet(key) {
  const c = loadCache()[key];
  if (!c) return null;
  if (c.none && c.manual) return { none: true, manual: true, wrong: c.wrong || null };   // 사용자가 '틀렸다'고 한 곡
  if (c.none && Date.now() - c.at > MISS_TTL) return null;
  if (c.none) return { none: true };
  const l = c.instrumental && !c.raw ? { instrumental: true, synced: false, lines: [], raw: '' } : toLyrics(c.raw, c.source);
  return { ...l, source: c.source, match: c.match, instrumental: !!c.instrumental };
}
export function cachePut(key, lyr, opt = {}) {
  const c = loadCache();
  c[key] = lyr ? { raw: lyr.raw || '', source: lyr.source, match: lyr.match || null, instrumental: !!lyr.instrumental, at: Date.now() }
    : opt.manual ? { none: true, manual: true, wrong: opt.wrong || null, at: Date.now() } : { none: true, at: Date.now() };
  const keys = Object.keys(c);
  if (keys.length > MAX_CACHE) keys.sort((a, b) => c[a].at - c[b].at).slice(0, keys.length - MAX_CACHE).forEach(k => delete c[k]);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* 저장 공간 부족 */ }
}
export function cacheDrop(key) { const c = loadCache(); delete c[key]; try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* noop */ } }

/* ---------- .lrc 파일 ---------- */
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { /* not utf-8 */ }
  try { return new TextDecoder('euc-kr').decode(b); } catch (e) { return new TextDecoder('latin1').decode(b); }
}
