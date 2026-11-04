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
const nfc = s => String(s || '').normalize('NFC');      // macOS 파일 이름 · 태그의 풀어 쓴 한글(ㅂㅏㅁ…)을 모아 쓴 글자로
const HANGUL = /[가-힣]/;
// 유튜브 · 음원 파일 이름에 붙는 꼬리표: [MV] (Official Video) [가사/Lyrics] (Audio) 【4K】 등
const TAGS_RE = /\s*[\[(【「]\s*(?:official|mv|m\/v|lyrics?|lyric\s*video|audio|video|visualizer|live\s*clip|special\s*clip|4k|hd|가사|가사\s*\/\s*lyrics|lyrics\s*\/\s*가사|뮤직\s*비디오|공식|full\s*audio|teaser)[^\])】」]*[\])】」]/gi;
const TAIL_RE = /\s+(?:m\/v|mv|official|music\s+video|video|audio|lyrics?|lyric\s+video|live\s+clip|special\s+clip|가사|뮤비|뮤직\s*비디오)\s*$/i;
/** 파일 이름 → { title, artist } ('가수 - 제목', '[MV] 가수(Artist) _ 제목', "가수 '제목' Live Clip", '가수-제목' 등) */
function fromFileName(name) {
  let n = stripExt(nfc(name).split(/[\\/]/).pop()).replace(/^\s*\d{1,3}\s*[.\-_)]\s*/, '');
  n = n.replace(TAGS_RE, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4 && TAIL_RE.test(n); i++) n = n.replace(TAIL_RE, '').trim();      // 'Official MV' 처럼 여러 개
  const quoted = /^(.+?)\s*['‘’"“”「『](.+?)['‘’"“”」』]\s*(.*)$/.exec(n);      // 아이유 '밤편지' Live Clip
  if (quoted && quoted[1].length <= 40) return { artist: quoted[1].replace(/[_\s]+$/, '').trim(), title: quoted[2].trim(), swap: false };
  let parts = n.split(/\s+[-–—|]\s+|\s+_\s+/);
  if (parts.length < 2) {
    const m = /^([^-]*[가-힣][^-]*?)\s*-\s*(.+)$/.exec(n) || /^([^-]+?)\s*-\s*([^-]*[가-힣].*)$/.exec(n);   // 아이유-밤편지 (한글 쪽이 있을 때만)
    if (m) parts = [m[1], m[2]];
  }
  const clean = x => x.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (parts.length >= 2) return { artist: clean(parts[0]), title: clean(parts.slice(1).join(' - ')), swap: true };
  return { artist: '', title: clean(n), swap: false };
}
export function guessQuery(t) {
  let title = nfc(t.title).trim(), artist = nfc(t.artist).trim(), swap = false;
  if (!title) {
    const f = fromFileName(t.name || '');
    title = f.title;
    if (!artist && f.artist) { artist = f.artist; swap = f.swap; }
  }
  title = title.replace(/\s*[(\[](official|mv|m\/v|lyrics?|audio|video|live|가사|뮤직\s*비디오|공식)[^)\]]*[)\]]/gi, '').trim();
  const q = { title, artist, album: nfc(t.album).trim() };
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
/** 같은 가수의 다른 표기 전부 (예: 악뮤 → AKMU, 악동뮤지션, Akdong Musician) */
function aliasGroup(artist) {
  const k = flat((artist || '').normalize('NFKC').toLowerCase());
  const g = ARTIST_ALIASES.find(group => group.some(x => flat(x.normalize('NFKC').toLowerCase()) === k));
  return g ? g.filter(x => flat(x.normalize('NFKC').toLowerCase()) !== k) : [];
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

/* ---------- 영어 제목으로만 올라간 한국 노래 ----------
   LRCLIB 에는 '벚꽃 엔딩' 이 'Cherry Blossom Ending' 으로만 있는 것처럼 영어 제목만 있는 곡이 있다.
   제목으로 못 찾았고 곡 길이를 알면: 가수(다른 표기 포함)로 검색해 길이가 2초 안인 곡 중
   가사 속에 우리 제목의 한글 낱말이 절반 이상 들어 있는 것만 받아들인다 (같은 가수의 다른 곡을 고르지 않도록) */
const plainName = x => (x || '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
// 가사에 흔히 나오는 낱말은 '이 곡이 맞다'는 증거가 못 된다 (예: '내 사람' 의 '사람' 은 다른 곡 가사에도 흔함)
const COMMON = new Set(('사랑 사람 우리 그대 당신 너를 나를 너의 나의 내가 네가 너와 나와 우린 오늘 내일 어제 마음 하루 시간 눈물 이별 기억 ' +
  '다시 모든 그리고 하지만 그냥 정말 너무 아직 이제 지금 언제 어디 노래 행복 세상 처음 마지막 영원 순간 그날 함께 혼자 바람 하늘 ' +
  '거리 사랑해 안녕 미안 고마워 좋아 그대여 사랑아 이야기 추억 마음이 사랑이 사람이 우리의 그녀 소녀 소년 친구 밤에 오늘밤 ' +
  '내게 너에게 나에게 그대에게 사랑을 사람을 마음을 눈을 너만 나만 그대만 날을 별이 꽃이 꿈을 꿈이 웃음 미소').split(' '));
function titleWords(title) {
  return [...new Set(plainName(nfc(title)).split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())
    .filter(w => w.length >= 2 && HANGUL.test(w) && !COMMON.has(w)))];
}
const lyricText = r => nfc(r.syncedLyrics || r.plainLyrics || '').toLowerCase().replace(STAMP, '').replace(/[^\p{L}\p{N}]+/gu, '');
export function lyricsMentionTitle(r, title) {
  const w = titleWords(title);
  if (!w.length) return false;
  const text = lyricText(r);
  return w.filter(x => text.includes(x)).length / w.length >= 0.5;
}
/* 한글 제목이 영어 제목을 소리 나는 대로 적은 것인지 (바운스 ↔ Bounce, 러브 다이브 ↔ Love Dive, 넥스트 레벨 ↔ Next Level)
   양쪽을 자음 소리 갈래(K T P S J N M R H)로 줄여 비교한다. 가수 · 곡 길이가 맞을 때만 쓰므로 거칠게 맞춰도 된다 */
const CHO = ['K', 'K', 'N', 'T', 'T', 'R', 'M', 'P', 'P', 'S', 'S', '', 'J', 'J', 'J', 'K', 'T', 'P', 'H'];
const JONG = ['', 'K', 'K', 'KS', 'N', 'NJ', 'N', 'T', 'R', 'RK', 'RM', 'RP', 'RS', 'RT', 'RP', 'R', 'M', 'P', 'PS', 'T', 'T', 'N', 'T', 'T', 'K', 'T', 'P', 'T'];
const squeeze = x => x.replace(/(.)\1+/g, '$1');
export function soundKo(s) {
  let out = '';
  for (const ch of nfc(s)) {
    const c = ch.codePointAt(0) - 0xac00;
    if (c < 0 || c > 11171) continue;
    out += CHO[Math.floor(c / 588)] + JONG[c % 28];
  }
  return squeeze(out);
}
export function soundEn(s) {
  let w = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  w = w.replace(/gh/g, '').replace(/[ts]ion/g, 'sn').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'k').replace(/sch/g, 's').replace(/ch|tch/g, 'j')
    .replace(/sh/g, 's').replace(/th/g, 's').replace(/ng\b|ng(?=[^aeiouy])/g, 'n').replace(/c(?=[eiy])/g, 's').replace(/g(?=[eiy])/g, 'j').replace(/x/g, 'ks');
  const map = { b: 'P', p: 'P', f: 'P', v: 'P', d: 'T', t: 'T', g: 'K', k: 'K', c: 'K', q: 'K', s: 'S', z: 'J', j: 'J', n: 'N', m: 'M', l: 'R', r: 'R', h: 'H' };
  let out = '';
  for (const ch of w) out += map[ch] || '';
  return squeeze(out);
}
function soundDist(a, b) {
  const cost = (x, y) => x === y ? 0 : (x + y === 'ST' || x + y === 'TS' || x + y === 'SJ' || x + y === 'JS') ? 0.5 : 1;
  const del = x => (x === 'R' || x === 'H') ? 0.4 : 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i ? d0(a, i, del) : 0]);
  function d0(str, i, f) { let t = 0; for (let k = 0; k < i; k++) t += f(str[k]); return t; }
  for (let j = 1; j <= b.length; j++) d[0][j] = d[0][j - 1] + del(b[j - 1]);
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + del(a[i - 1]), d[i][j - 1] + del(b[j - 1]), d[i - 1][j - 1] + cost(a[i - 1], b[j - 1]));
  return d[a.length][b.length];
}
export { titleKeywords };
export function soundAlike(ko, en) {
  if (!HANGUL.test(ko || '') || /[가-힣]/.test(plainName(en) || '') || !/[a-z]/i.test(en || '')) return false;
  const a = soundKo(plainName(ko)), b = soundEn(plainName(en));
  if (a.length < 3 || b.length < 3) return false;
  return soundDist(a, b) <= Math.max(0.6, 0.15 * Math.max(a.length, b.length));
}
/* 제목이 영어로 번역되어 올라간 곡 (봄이 좋냐?? ↔ What The Spring??) — 많은 곡을 낸 가수는 이름만으로 찾으면
   결과 20개 안에 안 들어오므로, 제목의 흔한 낱말을 영어로 바꿔 '가수 + 낱말' 로도 찾는다 (받아들이는 기준은 그대로) */
const KO_EN = new Map(('봄:spring 여름:summer 가을:autumn 겨울:winter 밤:night 낮:day 아침:morning 저녁:evening 새벽:dawn 하늘:sky 바다:sea ' +
  '비:rain 눈:snow 바람:wind 별:star 달:moon 해:sun 꽃:flower 벚꽃:cherry 사랑:love 이별:goodbye 안녕:hello 꿈:dream 노래:song ' +
  '친구:friend 시간:time 기억:memory 추억:memories 눈물:tears 마음:heart 집:home 길:road 불꽃:fireworks 비밀:secret 첫사랑:first 마지막:last ' +
  '행복:happy 세상:world 오늘:today 내일:tomorrow 어제:yesterday 하루:day 영원:forever 천국:heaven 우주:universe 여행:trip 편지:letter ' +
  '거짓말:lie 바보:fool 소원:wish 약속:promise 운명:destiny 고백:confession 그림자:shadow 빛:light 불:fire 물:water 숲:forest 섬:island ' +
  '도시:city 거리:street 창문:window 우산:umbrella 커피:coffee 장미:rose 나비:butterfly 고양이:cat 강아지:puppy 인형:doll 선물:gift ' +
  '생일:birthday 축제:festival 춤:dance 파도:waves 노을:sunset 은하수:galaxy 무지개:rainbow 첫눈:snow 크리스마스:christmas 자장가:lullaby ' +
  '엄마:mom 아빠:dad 어머니:mother 아버지:father 청춘:youth 소년:boy 소녀:girl 왕:king 여왕:queen 천사:angel 악마:devil 괴물:monster ' +
  '좋아:like 미안:sorry 고마워:thanks 보고싶다:miss 그리움:longing 외로움:lonely 혼자:alone 위로:comfort 응원:cheer 자유:freedom').split(' ').map(x => x.split(':')));
const PARTICLE = /(?:이|가|은|는|을|를|의|에|도|만|야|아|여|요|로|와|과)$/;
function titleKeywords(title) {
  const out = [];
  for (const w0 of plainName(nfc(title)).split(/\s+/)) {
    const w = w0.replace(/[^\p{L}\p{N}]/gu, '');
    const en = KO_EN.get(w) || (w.length >= 2 && PARTICLE.test(w) ? KO_EN.get(w.slice(0, -1)) : null);
    if (en && !out.includes(en)) out.push(en);
  }
  return out.slice(0, 2);
}
async function scanByArtist(q, dur, bad, ctx, seen) {
  if (!(dur >= 30) || !q.artist || !HANGUL.test(q.title || '') || (!titleWords(q.title).length && soundKo(plainName(q.title)).length < 3)) return null;
  const album = plainName(q.album);
  // 가수 이름: 괄호 밖 · 안 ('츄 (CHUU)'), 다른 표기, 제목 속 피처링 가수 ('… feat KIXO' → KIXO 로도 찾음)
  const inParens = x => [...String(x || '').matchAll(/[(\[]([^)\]]+)[)\]]/g)].map(m => m[1].trim());
  const feats = [...String(q.title || '').matchAll(/(?:^|[\s(\[])(?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+)/gi)]
    .flatMap(m => m[1].split(/\s*(?:,|&|\/|\sx\s|\sand\s)\s*/)).map(x => x.trim()).filter(x => x.length >= 2);
  const who = new Set();
  for (const n of [plainName(q.artist) || q.artist, ...inParens(q.artist), ...feats]) { if (!n) continue; who.add(n); for (const al of aliasGroup(n)) who.add(al); }
  const plans = [], first = [...who][0];
  plans.push({ q: first });
  for (const k of titleKeywords(q.title)) plans.push({ q: `${first} ${k}` });
  if (album) plans.push({ q: `${first} ${album}` });
  for (const a of [...who].slice(1)) { plans.push({ q: a }); if (album) plans.push({ q: `${a} ${album}` }); }
  const qa = names(q.artist, true);
  const featNames = feats.flatMap(f => names(f, true));
  const featHit = x => featNames.length && nameMatch(names(`${x.trackName || ''} ${x.artistName || ''}`.replace(/[()[\]]/g, ' '), true).concat(names(x.artistName, true)), featNames) >= 1;
  let top = null, songs = new Set();
  const pick = () => {
    top = null; songs = new Set();
    for (const x of seen.values()) {
      if (bad.has(Number(x.id)) || !(x.syncedLyrics || x.plainLyrics)) continue;
      const d = Math.abs((x.duration || 0) - dur);
      if (d > 2 || (nameMatch(names(x.artistName, true), qa) < 1 && !featHit(x)) || !(soundAlike(q.title, x.trackName) || lyricsMentionTitle(x, q.title))) continue;
      songs.add(flat((x.trackName || '').normalize('NFKC').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '')));
      const sc = (x.syncedLyrics ? 3 : 1) + (2 - d);
      if (!top || sc > top.s) top = { r: x, s: sc };
    }
  };
  pick();
  for (const p of plans.slice(0, 6)) {
    if (top && top.r.syncedLyrics) break;
    const r = await request(`${API}/search?${new URLSearchParams(p)}`, ctx);
    if (r.status === 200) for (const x of json(r.body) || []) if (x && x.id && !seen.has(x.id)) seen.set(x.id, x);
    pick();
  }
  return top && songs.size === 1 ? fromRecord(top.r) : null;   // 서로 다른 두 곡이 걸리면 어느 쪽인지 모르니 고르지 않음
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
  const scanned = await scanByArtist(q, dur, bad, ctx, seen);
  if (scanned) return scanned;
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
/** 저장 공간이 모자랄 때(플레이리스트 저장이 실패하면): 직접 고른 가사와 최근 곡만 남긴다 */
export function cacheShrink(keep = 40) {
  const c = loadCache();
  Object.keys(c).filter(k => !(c[k].manual || c[k].source === 'manual'))
    .sort((a, b) => (c[b].at || 0) - (c[a].at || 0)).slice(keep).forEach(k => delete c[k]);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* noop */ }
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
