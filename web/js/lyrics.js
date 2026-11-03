/*
 * 울림 — 가사
 *  1) 음악 파일과 같은 이름의 .lrc 파일 (PC)
 *  2) 음악 파일 태그 속 가사 (ID3 USLT, Vorbis LYRICS, MP4 ©lyr)
 *  3) LRCLIB (https://lrclib.net) — 누구나 쓸 수 있는 무료 공개 가사 데이터베이스, 싱크 가사 우선
 */
import { platform } from './platform.js';
import { ARTIST_ALIASES } from './aliases.js';

const API = 'https://lrclib.net/api';
export const REPO = 'omokdie/ullim';
const OVR_URL = `https://raw.githubusercontent.com/${REPO}/main/lyrics/overrides.json`;
const OVR_KEY = 'ullim.lyrovr.v1';
const OVR_TTL = 2 * 3600 * 1000;   // 공용 목록은 2시간마다 새로 받음
const CACHE_KEY = 'ullim.lyrics.v1';
const MAX_CACHE = 300;
const MISS_TTL = 24 * 3600 * 1000;   // 끝까지 찾아도 없던 곡은 하루 뒤 다시 시도 (LRCLIB 이 나중에 채우기도 함)

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
  let title = (t.title || '').trim(), artist = (t.artist || '').trim(), swap = false;
  if (!title) {
    let n = stripExt((t.name || '').split(/[\\/]/).pop()).replace(/^\s*\d{1,3}\s*[.\-_)]\s*/, '').replace(/_/g, ' ');
    const parts = n.split(/\s+-\s+/);
    if (parts.length >= 2) { if (!artist) { artist = parts[0].trim(); swap = true; } title = parts.slice(1).join(' - ').trim(); }
    else title = n.trim();
  }
  title = title.replace(/\s*[(\[](official|mv|m\/v|lyrics?|audio|video|live|가사|뮤직\s*비디오|공식)[^)\]]*[)\]]/gi, '').trim();
  const q = { title, artist, album: (t.album || '').trim() };
  if (swap) Object.defineProperty(q, 'swap', { value: true });   // '제목 - 가수.mp3' 일 수도 있음 (열쇠 · 저장에는 안 들어감)
  return q;
}
/** 곡 비교용 정규화 — .github/scripts/lyrics_feedback.py 의 norm() 과 똑같아야 한다 */
export const norm = s => (s || '').toLowerCase().normalize('NFKC')
  .replace(/\(.*?\)|\[.*?\]/g, '').replace(/(^|\s)(feat|ft)\.\s.*$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
export const songKey = q => norm(q.artist) + '|' + norm(q.title);

/* ---------- 이름 맞추기 ----------
   LRCLIB 에는 'IU (아이유)' · 'Through the Night (밤편지)' 처럼 괄호 안에 다른 언어 이름을 적은 곡이 많다.
   괄호 밖 · 괄호 안 이름을 따로 떼어 비교하고, 'A, B' · 'A & B' 같은 여러 가수는 한 명씩도 비교한다.
   (songKey 의 norm 과는 별개 — norm 은 봇과 같아야 해서 바꾸지 않는다) */
const flat = x => x.replace(/(^|\s)(feat|ft)\.?\s.*$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
export function names(s, people = false) {
  s = (s || '').normalize('NFKC').toLowerCase().trim();
  const out = new Set();
  const add = x => { const f = flat(x); if (f) out.add(f); };
  add(s);
  const outside = s.replace(/\(.*?\)|\[.*?\]/g, ' ');
  add(outside);
  for (const m of s.matchAll(/[(\[]([^)\]]+)[)\]]/g)) add(m[1]);
  if (people) {
    for (const part of outside.split(/\s*(?:,|&|\/|\+|;|\sx\s|\s×\s|\sand\s|\swith\s|\sfeat\.?\s|\sft\.?\s)\s*/)) add(part);
    for (const v of [...out]) for (const a of ALIAS.get(v) || []) out.add(a);   // 아이유 ↔ IU
  }
  return [...out];
}
const ALIAS = new Map();
for (const group of ARTIST_ALIASES) {
  const keys = group.map(x => flat(x.normalize('NFKC').toLowerCase())).filter(Boolean);
  for (const k of keys) ALIAS.set(k, keys);
}
/** 검색에 써 볼 다른 표기 (예: 아이유 → IU) */
function aliasOf(artist) {
  const k = flat((artist || '').normalize('NFKC').toLowerCase());
  const g = ARTIST_ALIASES.find(group => group.some(x => flat(x.normalize('NFKC').toLowerCase()) === k));
  return g ? g.find(x => flat(x.normalize('NFKC').toLowerCase()) !== k) : null;
}
/** 0 다름 · 1 일부 겹침 · 2 같음 */
function nameMatch(a, b) {
  let best = 0;
  for (const x of a) for (const y of b) {
    if (x === y) return 2;
    if (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))) best = 1;
  }
  return best;
}
/** 점수와 받아들일지. 제목이 같아야 받아들인다 (일부만 같으면 가수가 같고 길이가 3초 안일 때만).
    제목 · 가수는 같은데 길이가 15초 넘게 다르면(라이브 · 다른 버전) 시간 맞춤 없이 가사만 보여 준다 */
export function rate(r, q, dur) {
  let s = 0;
  if (r.syncedLyrics) s += 3; else if (r.plainLyrics) s += 1; else if (r.instrumental) s += 0.5; else return null;
  const d = dur && r.duration ? Math.abs(r.duration - dur) : null;
  if (d != null) s += d <= 2 ? 4 : d <= 5 ? 2 : d <= 15 ? 0 : -4;
  const t = nameMatch(names(r.trackName || r.name), names(q.title));
  s += t === 2 ? 3 : t === 1 ? 1 : -3;
  const a = q.artist ? nameMatch(names(r.artistName, true), names(q.artist, true)) : -1;   // -1: 가수를 모름
  if (a >= 0) s += a === 2 ? 2 : a === 1 ? 1 : -1;
  // 가수가 다르면 길이가 거의 같을 때만 (한글 ↔ 영어 표기 차이일 수 있으면 조금 더 너그럽게)
  const hangul = x => /[\uac00-\ud7a3]/.test(x || '');
  const otherScript = q.artist && hangul(q.artist) !== hangul(r.artistName);
  const ok = t === 2 ? (a !== 0 || (d != null && d <= (otherScript ? 4 : 2))) : t === 1 ? (a === 2 && d != null && d <= 3) : false;
  return { s, ok, plainOnly: ok && d != null && d > 15 };
}
export function score(r, q, dur) { const x = rate(r, q, dur); return x ? x.s : -99; }
const STRONG_SCORE = 8;

export function fromRecord(r, plainOnly = false) {
  const match = { id: r.id, title: r.trackName, artist: r.artistName, album: r.albumName, duration: r.duration };
  if (!r.syncedLyrics && !r.plainLyrics) return { instrumental: !!r.instrumental, synced: false, lines: [], raw: '', source: 'lrclib', match };
  if (plainOnly) return toLyrics(r.plainLyrics || String(r.syncedLyrics).replace(STAMP, ''), 'lrclib', { match });
  return toLyrics(r.syncedLyrics || r.plainLyrics, 'lrclib', { match });
}

/* ---------- 네트워크 ----------
   LRCLIB 은 붐빌 때 503(ServerOverloaded, Retry-After: 1) · 429(요청이 많음, Retry-After) 로 답한다.
   → 잠깐 기다렸다가 다시 묻고, 끝내 안 되면 '인터넷 끊김' 과 '서버 붐빔' 을 구분해 알린다.
   검색을 끝까지 못 했으면 '가사 없음' 으로 판단(기억)하지 않는다. */
export class LookupError extends Error {
  constructor(kind) { super(kind); this.kind = kind; }   // 'busy' | 'offline' | 'stale'
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
async function http(url) {
  if (platform.httpGet) {
    try { const r = await platform.httpGet(url); return r || { status: 0, error: 'network' }; }
    catch (e) { return { status: 0, error: 'network' }; }
  }
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
    return { status: r.status, body: await r.text(), retryAfter: r.headers.get('Retry-After') };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'timeout' : isOffline() ? 'offline' : 'network' };
  } finally { clearTimeout(tm); }
}
const json = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const BUSY = new Set([429, 500, 502, 503, 504]);
/** 붐비면 Retry-After 만큼(+조금) 기다렸다가 최대 4번까지 묻는다. ctx 에 무슨 일이 있었는지 적는다 */
async function request(url, ctx = {}) {
  for (let i = 0; ; i++) {
    if (ctx.stale && ctx.stale()) throw new LookupError('stale');
    const r = await http(url);
    const busy = BUSY.has(r.status) || (r.status === 0 && r.error === 'timeout');
    if (r.status === 0 && !busy) { ctx.offline = true; return r; }          // 연결 자체가 안 됨 → 다시 물어도 소용없음
    if (!busy) { ctx.answered = true; return r; }
    const ra = parseFloat(r.retryAfter);
    const wait = (ra > 0 ? ra * 1000 : r.status === 429 ? 5000 : 1000) * (1 + Math.random() * 0.3) + i * 500;
    if (i >= 3 || wait > 8000) { ctx.busy = true; return r; }                // 오래 기다려야 하면 이번엔 그만
    if (!ctx.slow) { ctx.slow = true; if (ctx.onBusy) ctx.onBusy(); }        // 화면에 '붐벼서 조금 걸려요'
    await sleep(wait);
  }
}
const failKind = ctx => ctx.offline && !ctx.answered && !ctx.busy ? 'offline' : 'busy';

/** 검색 순서: 제목+가수 → 아무 칸('제목 가수') → 제목만(가수 표기가 다를 때) → 괄호 속 다른 이름 */
function searchPlans(q) {
  const plans = [], keys = new Set();
  const add = p => { const k = JSON.stringify(p); if (!keys.has(k) && (p.q || p.track_name)) { keys.add(k); plans.push(p); } };
  const plain = x => (x || '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
  const title = plain(q.title) || q.title, artist = plain(q.artist) || q.artist;
  if (q.artist) add({ track_name: q.title, artist_name: q.artist });
  const alias = aliasOf(artist);
  if (alias) add({ track_name: title, artist_name: alias });                 // 아이유 → IU
  add({ q: [title, artist].filter(Boolean).join(' ') });
  add({ track_name: title });
  const alt = [...(q.title || '').matchAll(/[(\[]([^)\]]+)[)\]]/g)].map(m => m[1].trim()).find(x => x && !/^(feat|ft|with|prod)\b/i.test(x));
  if (alt) add({ track_name: alt });
  if (q.swap && q.artist) {                                                  // '제목 - 가수.mp3' 일 수도 있으면 반대로도
    add({ track_name: artist, artist_name: title });
    const a2 = aliasOf(title);
    if (a2) add({ track_name: artist, artist_name: a2 });
  }
  return plans;
}
function best(list, q, dur, bad) {
  let top = null;
  const qs = q.swap && q.artist ? [q, { title: q.artist, artist: q.title, album: q.album }] : [q];
  for (const r of list) {
    if (bad && bad.has(Number(r.id))) continue;
    for (const qq of qs) {
      const x = rate(r, qq, dur);
      if (x && x.ok && (!top || x.s > top.s)) top = { r, s: x.s, plainOnly: x.plainOnly };
    }
  }
  return top;
}

/** 검색 결과 목록 (직접 검색 화면용) — 여러 방법으로 찾아 합치고 잘 맞는 순서로 */
export async function searchList(q, opt = {}) {
  const ctx = { stale: opt.stale }, seen = new Map();
  for (const p of searchPlans(q)) {
    const r = await request(`${API}/search?${new URLSearchParams(p)}`, ctx);
    if (r.status === 200) for (const x of json(r.body) || []) if (x && x.id && !seen.has(x.id)) seen.set(x.id, x);
    if (seen.size >= 20 && p.q) break;
  }
  if (!seen.size && (ctx.busy || ctx.offline)) throw new LookupError(failKind(ctx));
  return [...seen.values()].map(r => ({ r, s: score(r, q, 0) })).sort((a, b) => b.s - a.s).map(x => x.r).slice(0, 20);
}

/** 가장 잘 맞는 가사 하나 (자동 찾기용). avoid: 사용자들이 '틀렸다'고 알린 LRCLIB 번호.
    못 찾았는데 중간에 서버가 붐볐거나 연결이 끊겼으면 LookupError 를 던진다 (→ '없음'으로 기억하지 않음) */
export async function findOnline(q, dur, avoid = [], opt = {}) {
  if (!q.title) return null;
  const ctx = { stale: opt.stale, onBusy: opt.onBusy }, bad = new Set(avoid.map(Number)), seen = new Map();
  if (q.artist) {
    const p = new URLSearchParams({ track_name: q.title, artist_name: q.artist });
    if (q.album) p.set('album_name', q.album);
    if (dur >= 1 && dur <= 3600) p.set('duration', String(Math.round(dur)));
    const r = await request(`${API}/get?${p}`, ctx);
    const j = r.status === 200 ? json(r.body) : null;
    if (j && j.id && !bad.has(Number(j.id)) && (j.syncedLyrics || j.plainLyrics || j.instrumental)) {
      if (j.syncedLyrics || j.instrumental || !dur) return fromRecord(j);
      seen.set(j.id, j);                                  // 일반 가사뿐이면 싱크 가사가 있는지 검색도 해 본다
    }
  }
  for (const p of searchPlans(q)) {
    const r = await request(`${API}/search?${new URLSearchParams(p)}`, ctx);
    if (r.status === 200) for (const x of json(r.body) || []) if (x && x.id && !seen.has(x.id)) seen.set(x.id, x);
    const top = best(seen.values(), q, dur, bad);
    if (top && top.s >= STRONG_SCORE) return fromRecord(top.r, top.plainOnly);
  }
  const top = best(seen.values(), q, dur, bad);
  if (top) return fromRecord(top.r, top.plainOnly);
  if (ctx.busy || ctx.offline) throw new LookupError(failKind(ctx));
  return null;
}

/** LRCLIB 번호로 가져오기 (커뮤니티가 고른 가사) */
export async function getById(id, opt = {}) {
  const ctx = { stale: opt.stale };
  const r = await request(`${API}/get/${Number(id)}`, ctx);
  if (ctx.busy || ctx.offline) throw new LookupError(failKind(ctx));
  const j = r.status === 200 ? json(r.body) : null;
  return j && j.id ? fromRecord(j) : null;
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
  if (c.none && (c.v !== 2 || Date.now() - c.at > MISS_TTL)) return null;   // 1.0.1 이 서버 붐빔 때문에 잘못 기억한 '없음'은 버림
  if (c.none) return { none: true };
  const l = c.instrumental && !c.raw ? { instrumental: true, synced: false, lines: [], raw: '' } : toLyrics(c.raw, c.source);
  return { ...l, source: c.source, match: c.match, instrumental: !!c.instrumental };
}
export function cachePut(key, lyr, opt = {}) {
  const c = loadCache();
  c[key] = lyr ? { raw: lyr.raw || '', source: lyr.source, match: lyr.match || null, instrumental: !!lyr.instrumental, at: Date.now() }
    : opt.manual ? { none: true, manual: true, wrong: opt.wrong || null, at: Date.now() } : { none: true, v: 2, at: Date.now() };
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
