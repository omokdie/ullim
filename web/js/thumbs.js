/*
 * 울림 — 앨범아트 작은 그림 (플레이리스트 타일 · 최근 곡 · 장르 · 목록)
 *  - 음악 파일 태그 속 그림을 160px JPEG 로 줄여 IndexedDB 에 저장 → 다음부터는 파일을 다시 읽지 않음
 *  - 같은 그림(한 앨범의 곡들)은 하나만 저장하고 곡은 그 그림을 가리킴 → 저장 공간이 앨범 수만큼만
 *  - 화면에 보이는 것만, 한 번에 하나씩, 쉬는 시간(requestIdleCallback)에 만든다 (배터리 · 버벅임 줄이기)
 *  - 그림이 없는 곡도 '없음'으로 기억해 다시 읽지 않는다
 *  - 대표 색(평균 색)도 함께 저장 → 재생 화면 배경 색
 *  - 재생 중인 곡의 큰 그림(bigArt)도 여기서: 원본(3000px 면 풀었을 때 36MB)을 화면에 주지 않고 768px 로 줄여서 (메모리)
 *  - JPEG 는 ImageDecoder 로 1/2 · 1/4 · 1/8 크기로 바로 풀어 원본 크기로 풀지 않음, 캔버스는 하나를 돌려 씀
 */
import { readTags } from './tags.js';

const SIZE = 160, BIG = 768, DB = 'ullim-art', ST = 'thumbs', MEM_MAX = 240;
const mem = new Map();          // key → { url, color } | null(그림 없음)
const waiters = new Map();      // key → [{ res, cancelable }]
let wanted = [];                // 만들 차례 (나중에 부탁한 것이 먼저 — 지금 보이는 것)
let busy = false, dbp = null, srcOf = k => k, tagSink = null, idleHook = null;

export function setSource(fn) { srcOf = fn; }
/** 그림을 만들려고 읽은 태그(제목 · 장르 …)를 앱에도 넘겨 같은 파일을 두 번 읽지 않게 */
export function setTagSink(fn) { tagSink = fn; }
/** 만들 그림을 다 만들었을 때 (앱이 메모리 정리를 부탁할 때) */
export function setIdleHook(fn) { idleHook = fn; }

function db() {
  if (!dbp) {
    dbp = new Promise(res => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(ST);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
  }
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  if (!d) return null;
  return new Promise(res => {
    try {
      const tx = d.transaction(ST, mode), st = tx.objectStore(ST);
      const r = fn(st);
      tx.oncomplete = () => res(r && 'result' in r ? r.result : null);
      tx.onerror = tx.onabort = () => res(null);
    } catch (e) { res(null); }
  });
}

/* ---------- 같은 그림은 한 번만 저장 ----------
   한 앨범의 곡들은 보통 똑같은 그림을 품고 있다 → 그림은 ART+해시 이름으로 하나만 { blob, color },
   곡은 { ref, color } 로 그 그림을 가리킨다 (저장 공간 · 그림을 다시 만드는 시간 절약). 예전 기록 { blob, color } 도 그대로 읽는다 */
const ART = '#art#';            // 곡 키(파일 경로 · content://)는 # 으로 시작하지 않음
/** 그림 바이트 → 이름 (길이 + 32비트 해시 둘). 아주 큰 그림은 1MB 만큼만 고르게 골라 읽음 */
function picHash(d) {
  const n = d.length, step = n > 1048576 ? Math.ceil(n / 1048576) : 1;
  let a = 0x811c9dc5, b = 0x27d4eb2f;
  for (let i = 0; i < n; i += step) {
    const x = d[i];
    a = Math.imul(a ^ x, 16777619);
    b = Math.imul(b ^ x, 0x5bd1e995); b ^= b >>> 15;
  }
  return ART + n.toString(36) + '.' + (a >>> 0).toString(36) + '.' + (b >>> 0).toString(36);
}
const isBlob = b => typeof Blob === 'function' && b instanceof Blob;
/** 저장된 작은 그림: { blob, color } · null(그림 없는 곡) · undefined(모름 → 만들어야 함) */
async function load(key) {
  let v = await idb('readonly', st => st.get(key));
  if (v === 'none') return null;
  if (v && typeof v.ref === 'string') {
    const a = await idb('readonly', st => st.get(v.ref));
    v = a && isBlob(a.blob) ? { blob: a.blob, color: v.color || a.color || null } : undefined;
  }
  return v && isBlob(v.blob) ? v : undefined;
}

/* 1.2.2 까지 곡마다 따로 저장한 그림을 하나로 합치기 — 한 번만, 화면이 보이고 그림을 만들지 않을 때 100개씩 */
const MERGED = 'ullim.thumbs.merged';
let merging = false, mergeTimer = 0;
const merged = () => { try { return !!localStorage.getItem(MERGED); } catch (e) { return true; } };
function scheduleMerge(ms) {
  if (mergeTimer || merging || merged()) return;
  mergeTimer = setTimeout(() => { mergeTimer = 0; mergeOld(); }, ms);
}
async function scan(after, max) {
  const d = await db();
  if (!d) return null;
  return new Promise(res => {
    const out = [];
    try {
      const tx = d.transaction(ST, 'readonly');
      const rq = tx.objectStore(ST).openCursor(after === null ? null : IDBKeyRange.lowerBound(after, true));
      rq.onsuccess = () => { const c = rq.result; if (c && out.length < max) { out.push([c.key, c.value]); c.continue(); } };
      tx.oncomplete = () => res(out);
      tx.onerror = tx.onabort = () => res(null);
    } catch (e) { res(null); }
  });
}
async function mergeOld() {
  if (merging || merged()) return;
  merging = true;
  try {
    const seen = new Set();
    let after = null;
    for (;;) {
      if (document.hidden || busy || wanted.length) { scheduleMerge(8000); return; }   // 나중에 이어서
      const rows = await scan(after, 100);
      if (!rows) return;                                  // 저장소를 못 씀
      if (!rows.length) break;
      after = rows[rows.length - 1][0];
      const puts = [];
      for (const [k, v] of rows) {
        if (typeof k !== 'string' || k.startsWith(ART) || !v || !isBlob(v.blob)) continue;
        let ref;
        try { ref = picHash(new Uint8Array(await v.blob.arrayBuffer())); } catch (e) { continue; }
        if (!seen.has(ref)) { seen.add(ref); puts.push([ref, { blob: v.blob, color: v.color || null }]); }
        puts.push([k, { ref, color: v.color || null }]);
      }
      if (puts.length) await idb('readwrite', st => { let r = null; for (const [k, v] of puts) r = st.put(v, k); return r; });
      await new Promise(r => setTimeout(r, 50));
    }
    try { localStorage.setItem(MERGED, '1'); } catch (e) { /* noop */ }
  } finally { merging = false; }
}
/** (시험용) 예전 기록 합치기를 지금 바로 */
export const _mergeNow = () => mergeOld();
function remember(key, v) {
  mem.set(key, v);
  if (mem.size > MEM_MAX) {
    const [k, old] = mem.entries().next().value;
    mem.delete(k);
    if (old && old.url) setTimeout(() => URL.revokeObjectURL(old.url), 30000);   // 화면에 남은 그림이 바뀔 시간
  }
}
/** 이미 알고 있으면 바로 (없으면 undefined) */
export function peek(key) { return mem.has(key) ? mem.get(key) : undefined; }

/** 작은 그림 { url, color } 또는 null. 화면에 보일 때 부른다.
    cancelable: 긴 목록의 줄처럼 화면에서 금방 사라질 수 있는 요청 (forgetPending 으로 취소 → undefined) */
export function thumb(key, { cancelable = false } = {}) {
  if (mem.has(key)) return Promise.resolve(mem.get(key));
  return new Promise(res => {
    const w = waiters.get(key);
    if (w) { w.push({ res, cancelable }); bump(key); return; }
    waiters.set(key, [{ res, cancelable }]);
    load(key).then(v => {
      if (v !== undefined) { done(key, v && { url: URL.createObjectURL(v.blob), color: v.color }); return; }
      bump(key);
      pump();
    });
  });
}
function bump(key) { wanted = wanted.filter(k => k !== key); wanted.push(key); if (wanted.length > 400) wanted = wanted.slice(-400); }
function done(key, v) {
  if (mem.has(key)) {                                   // 같은 그림을 두 번 읽었으면 먼저 것을 씀 (새 주소는 버림)
    const old = mem.get(key);
    if (v && v.url && (!old || old.url !== v.url)) URL.revokeObjectURL(v.url);
    v = old;
  } else remember(key, v);
  wanted = wanted.filter(k => k !== key);
  for (const w of waiters.get(key) || []) w.res(v);
  waiters.delete(key);
}
/** 화면에서 사라진 줄의 요청은 취소 (빨리 넘긴 긴 목록). 다른 곳(배경 색 · 플레이리스트 그림 …)이 기다리는 그림은 계속 만든다 */
export function forgetPending(keys) {
  const drop = new Set();
  for (const k of keys) {
    const w = waiters.get(k);
    if (!w) { drop.add(k); continue; }
    const keep = w.filter(x => !x.cancelable);
    for (const x of w) if (x.cancelable) x.res(undefined);
    if (keep.length) waiters.set(k, keep); else { waiters.delete(k); drop.add(k); }
  }
  if (drop.size) wanted = wanted.filter(k => !drop.has(k));
}
const idle = fn => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 30));
function pump() {
  if (busy || !wanted.length || document.hidden) return;
  busy = true;
  idle(async () => {
    if (!wanted.length) { busy = false; return; }         // 기다리는 사이 모두 취소됨
    const key = wanted.pop();
    try { done(key, await make(key)); }
    catch (e) { done(key, null); }
    finally { busy = false; if (wanted.length) setTimeout(pump, 16); else if (idleHook) idleHook(); }
  });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pump(); scheduleMerge(10000); } });
scheduleMerge(20000);

/* ---------- 그림 풀기 · 줄이기 ---------- */
const picType = pic => (/png/i.test(pic.mime) ? 'image/png' : /webp/i.test(pic.mime) ? 'image/webp' : /gif/i.test(pic.mime) ? 'image/gif' : 'image/jpeg');
/** want(px) 가까이로 풀기 (want 의 7/8~1 배 이상). JPEG 는 ImageDecoder 가 1/8 단위로 줄여 바로 풀어 준다 (3000px 그림도 수백 px 만큼만 메모리).
    크게 부탁하면 그만큼 큰 버퍼가 남으므로(discardable) 꼭 필요한 만큼만 */
async function decodeNear(pic, want) {
  const type = picType(pic);
  if (typeof ImageDecoder === 'function') {
    let dec = null;
    try {
      if (await ImageDecoder.isTypeSupported(type)) {
        dec = new ImageDecoder({ data: pic.data, type, desiredWidth: want, desiredHeight: want, preferAnimation: false });
        const { image } = await dec.decode({ frameIndex: 0 });
        const d = dec;
        return { src: image, w: image.displayWidth, h: image.displayHeight, type, close: () => { image.close(); d.close(); } };
      }
    } catch (e) { if (dec) try { dec.close(); } catch (e2) { /* noop */ } }
  }
  const bmp = await createImageBitmap(new Blob([pic.data], { type }));
  return { src: bmp, w: bmp.width, h: bmp.height, type, close: () => bmp.close && bmp.close() };
}
const canvases = {};
/** 캔버스는 쓰임새마다 하나만 만들어 돌려 씀 (그림마다 새로 만들면 GC 전까지 메모리에 쌓임) */
function canvas(name, w, h) {
  let c = canvases[name];
  if (!c) c = canvases[name] = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}
const toBlob = (c, q) => (c.convertToBlob ? c.convertToBlob({ type: 'image/jpeg', quality: q }) : new Promise(res => c.toBlob(res, 'image/jpeg', q)));

async function make(key) {
  let info = null;
  try { info = await readTags(srcOf(key)); } catch (e) { info = null; }
  if (info && tagSink) { try { tagSink(key, info); } catch (e) { /* noop */ } }
  const pic = info && info.picture;
  if (info) info.picture = null;
  if (!pic || !pic.data || !pic.data.length) { await idb('readwrite', st => st.put('none', key)); return null; }
  const ref = picHash(pic.data);
  const same = await idb('readonly', st => st.get(ref));          // 같은 앨범의 다른 곡이 이미 만든 그림 → 풀지 않고 같이 씀
  if (same && isBlob(same.blob)) {
    await idb('readwrite', st => st.put({ ref, color: same.color || null }, key));
    return { url: URL.createObjectURL(same.blob), color: same.color || null };
  }
  const img = await decodeNear(pic, SIZE * 2);
  const c = canvas('thumb', SIZE, SIZE), g = c.getContext('2d', { willReadFrequently: true });   // 대표 색을 읽으므로 CPU 캔버스 (GPU 에서 되읽기 없음)
  try {
    g.clearRect(0, 0, SIZE, SIZE);                                // 돌려 쓰는 캔버스: 투명한 PNG 에 앞 그림이 비치지 않게
    g.imageSmoothingQuality = 'medium';
    const r = Math.max(SIZE / img.w, SIZE / img.h);
    g.drawImage(img.src, (SIZE - img.w * r) / 2, (SIZE - img.h * r) / 2, img.w * r, img.h * r);
  } finally { img.close(); }
  const px = g.getImageData(0, 0, SIZE, SIZE).data;
  let rr = 0, gg = 0, bb = 0, n = 0;
  for (let i = 0; i < px.length; i += 4 * 37) { rr += px[i]; gg += px[i + 1]; bb += px[i + 2]; n++; }
  const color = n ? `rgb(${Math.round(rr / n)}, ${Math.round(gg / n)}, ${Math.round(bb / n)})` : null;
  const blob = await toBlob(c, 0.82);
  if (!blob) return null;
  await idb('readwrite', st => { st.put({ blob, color }, ref); return st.put({ ref, color }, key); });
  return { url: URL.createObjectURL(blob), color };
}

/* ---------- 재생 중인 곡의 큰 그림 (재생 막대 · 재생 화면 · 미디어 알림) ---------- */
const bigs = new Map();          // key → Promise<{ url, blob } | null>  (최근 3곡만)
/** 큰 그림 { url, blob } 또는 null. pic: 이미 읽은 태그 그림(있으면 파일을 다시 읽지 않음) */
export function bigArt(key, pic) {
  if (bigs.has(key)) { const v = bigs.get(key); bigs.delete(key); bigs.set(key, v); return v; }
  const p = (async () => {
    if (!pic) {
      const info = await readTags(srcOf(key)).catch(() => null);
      pic = info && info.picture;
      if (info) { info.picture = null; if (tagSink) try { tagSink(key, info); } catch (e) { /* noop */ } }
    }
    if (!pic || !pic.data || !pic.data.length) return null;
    const img = await decodeNear(pic, BIG);
    let blob;
    try {
      if (img.w <= BIG && img.h <= BIG && img.type === 'image/jpeg' && pic.data.length < 160 * 1024) blob = new Blob([pic.data], { type: 'image/jpeg' });   // 이미 작은 JPEG
      else {
        const k = Math.min(1, BIG / Math.max(img.w, img.h)), w = Math.max(1, Math.round(img.w * k)), h = Math.max(1, Math.round(img.h * k));
        const c = canvas('big', w, h), g = c.getContext('2d');
        g.clearRect(0, 0, w, h);
        g.imageSmoothingQuality = 'high';
        g.drawImage(img.src, 0, 0, w, h);
        blob = await toBlob(c, 0.86);
      }
    } finally { img.close(); pic = null; }
    return blob ? { url: URL.createObjectURL(blob), blob } : null;
  })().catch(() => null);
  bigs.set(key, p);
  while (bigs.size > 3) {
    const [k, old] = bigs.entries().next().value;
    bigs.delete(k);
    old.then(v => { if (v) setTimeout(() => URL.revokeObjectURL(v.url), 30000); });   // 화면에서 바뀔 시간을 두고
  }
  return p;
}

/** 이름으로 정해지는 그라데이션 (그림이 없을 때) */
export function fallbackStyle(seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const a = h % 360, b = (a + 40 + (h >> 9) % 60) % 360;
  return `background: linear-gradient(135deg, hsl(${a} 55% 46%), hsl(${b} 60% 28%))`;
}
