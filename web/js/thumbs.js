/*
 * 울림 — 앨범아트 작은 그림 (플레이리스트 타일 · 최근 곡 · 장르 · 목록)
 *  - 음악 파일 태그 속 그림을 160px JPEG 로 줄여 IndexedDB 에 저장 → 다음부터는 파일을 다시 읽지 않음
 *  - 화면에 보이는 것만, 한 번에 하나씩, 쉬는 시간(requestIdleCallback)에 만든다 (배터리 · 버벅임 줄이기)
 *  - 그림이 없는 곡도 '없음'으로 기억해 다시 읽지 않는다
 *  - 대표 색(평균 색)도 함께 저장 → 재생 화면 배경 색
 */
import { readTags } from './tags.js';

const SIZE = 160, DB = 'ullim-art', ST = 'thumbs', MEM_MAX = 700;
const mem = new Map();          // key → { url, color } | null(그림 없음)
const waiters = new Map();      // key → [{ res, cancelable }]
let wanted = [];                // 만들 차례 (나중에 부탁한 것이 먼저 — 지금 보이는 것)
let busy = false, dbp = null, srcOf = k => k, tagSink = null;

export function setSource(fn) { srcOf = fn; }
/** 그림을 만들려고 읽은 태그(제목 · 장르 …)를 앱에도 넘겨 같은 파일을 두 번 읽지 않게 */
export function setTagSink(fn) { tagSink = fn; }

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
    idb('readonly', st => st.get(key)).then(v => {
      if (v !== null && v !== undefined) { done(key, v === 'none' ? null : { url: URL.createObjectURL(v.blob), color: v.color }); return; }
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
    finally { busy = false; if (wanted.length) setTimeout(pump, 16); }
  });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) pump(); });

async function make(key) {
  let info = null;
  try { info = await readTags(srcOf(key)); } catch (e) { info = null; }
  if (info && tagSink) { try { tagSink(key, info); } catch (e) { /* noop */ } }
  const pic = info && info.picture;
  if (!pic || !pic.data || !pic.data.length) { await idb('readwrite', st => st.put('none', key)); return null; }
  const bmp = await createImageBitmap(new Blob([pic.data], { type: pic.mime || 'image/jpeg' }));
  const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(SIZE, SIZE) : Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
  const g = c.getContext('2d');
  const r = Math.max(SIZE / bmp.width, SIZE / bmp.height);
  g.drawImage(bmp, (SIZE - bmp.width * r) / 2, (SIZE - bmp.height * r) / 2, bmp.width * r, bmp.height * r);
  bmp.close && bmp.close();
  const px = g.getImageData(0, 0, SIZE, SIZE).data;
  let rr = 0, gg = 0, bb = 0, n = 0;
  for (let i = 0; i < px.length; i += 4 * 37) { rr += px[i]; gg += px[i + 1]; bb += px[i + 2]; n++; }
  const color = n ? `rgb(${Math.round(rr / n)}, ${Math.round(gg / n)}, ${Math.round(bb / n)})` : null;
  const blob = c.convertToBlob ? await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 }) : await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
  await idb('readwrite', st => st.put({ blob, color }, key));
  return { url: URL.createObjectURL(blob), color };
}

/** 이름으로 정해지는 그라데이션 (그림이 없을 때) */
export function fallbackStyle(seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const a = h % 360, b = (a + 40 + (h >> 9) % 60) % 360;
  return `background: linear-gradient(135deg, hsl(${a} 55% 46%), hsl(${b} 60% 28%))`;
}
