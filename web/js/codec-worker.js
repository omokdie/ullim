/* 울림 — 코덱 엔진 워커 (FFmpeg wasm, codec/ullim_codec.c)
 *
 * 메인 스레드가 보내는 것: init{module} · open{size, head, whole?, maxRate, meta} · produce{secs} · seek{t} · close · data{rid, buf}
 * 돌려주는 것: ready · read{rid, pos, len}(파일 조각 요청) · info{info, out, init} · chunk{data, t0, t1, done} · meta{info, pic} · error{msg}
 *
 * 파일은 메인 스레드가 읽어 준다(안드로이드 WebView 는 워커의 요청을 앱이 가로채지 못할 수 있어서).
 *  - JSPI(WebAssembly.Suspending)가 되면: FFmpeg 이 읽을 때마다 필요한 조각만 비동기로 받아 옴 (큰 DSD 파일도 메모리 적게)
 *  - 안 되면: 파일 전체를 미리 받아 동기로 읽음
 * 풀린 소리는 FLAC(무손실) 프레임 → fMP4 조각으로 싸서 MediaSource 에 넣을 수 있게 돌려준다.
 */
'use strict';
let X = null, mem = null, U = 0, size = 0, whole = null, outRate = 0, seq = 1;
const JSPI = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
const BLK = 1 << 18, MAXBLK = 48;            // 조각 256KB, 최대 12MB 기억
const cache = new Map();
const waiting = new Map(); let rid = 0;
let call = null;

function request(pos, len) {
  return new Promise((resolve, reject) => { const id = ++rid; waiting.set(id, { resolve, reject }); postMessage({ type: 'read', rid: id, pos, len }); });
}
function block(i) {
  const b = cache.get(i);
  if (b) { cache.delete(i); cache.set(i, b); return b; }       // 최근 사용 순서
  return null;
}
async function fetchBlock(i) {
  const pos = i * BLK, len = Math.min(BLK, size - pos);
  const b = new Uint8Array(await request(pos, len));
  cache.set(i, b);
  while (cache.size > MAXBLK) cache.delete(cache.keys().next().value);
  return b;
}
function copyOut(ptr, b, off, n, done) { new Uint8Array(mem.buffer, ptr + done, n).set(b.subarray(off, off + n)); }
/** FFmpeg 의 읽기: 조각이 다 있으면 바로, 없으면 받아 온 뒤(JSPI 가 기다려 줌) */
function readAsync(pos, ptr, len) {
  let done = 0;
  while (done < len) {
    const p = pos + done, i = Math.floor(p / BLK), off = p - i * BLK, b = block(i);
    if (!b) return (async () => {
      while (done < len) {
        const p2 = pos + done, j = Math.floor(p2 / BLK), o2 = p2 - j * BLK;
        const bb = block(j) || await fetchBlock(j);
        const n2 = Math.min(len - done, bb.length - o2); if (n2 <= 0) break;
        copyOut(ptr, bb, o2, n2, done); done += n2;
      }
      return done;
    })().catch(() => -1);
    const n = Math.min(len - done, b.length - off); if (n <= 0) break;
    copyOut(ptr, b, off, n, done); done += n;
  }
  return done;
}
function readSync(pos, ptr, len) {
  if (!whole) return -1;
  const n = Math.max(0, Math.min(len, whole.length - pos));
  new Uint8Array(mem.buffer, ptr, n).set(whole.subarray(pos, pos + n));
  return n;
}

/* WASI: 로그 출력(stderr) · 시계만 실제로, 나머지는 없음 */
const wasi = new Proxy({}, {
  get(t, k) {
    if (k === 'fd_write') return (fd, iovs, n, nw) => {
      const dv = new DataView(mem.buffer); let s = 0, txt = '';
      for (let i = 0; i < n; i++) { const p = dv.getUint32(iovs + i * 8, true), l = dv.getUint32(iovs + i * 8 + 4, true); txt += new TextDecoder().decode(new Uint8Array(mem.buffer, p, l)); s += l; }
      dv.setUint32(nw, s, true); if (txt.trim()) console.warn('[codec]', txt.trim()); return 0;
    };
    if (k === 'clock_time_get') return (id, prec, ptr) => { new DataView(mem.buffer).setBigUint64(ptr, BigInt(Math.round(performance.now() * 1e6)), true); return 0; };
    if (k === 'environ_sizes_get' || k === 'args_sizes_get') return (a, b) => { const dv = new DataView(mem.buffer); dv.setUint32(a, 0, true); dv.setUint32(b, 0, true); return 0; };
    if (k === 'fd_prestat_get') return () => 8;          // 열린 디렉터리 없음
    if (k === 'proc_exit') return c => { throw new Error('exit ' + c); };
    return () => 52;                                    // ENOSYS
  },
});

const cstr = p => { const b = new Uint8Array(mem.buffer, p); let e = 0; while (b[e]) e++; return new TextDecoder().decode(b.slice(0, e)); };

/* ---------- fMP4 (FLAC-in-ISOBMFF) ---------- */
function box(type, ...parts) {
  let n = 8; for (const p of parts) n += p.length;
  const b = new Uint8Array(n), dv = new DataView(b.buffer);
  dv.setUint32(0, n); for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  let o = 8; for (const p of parts) { b.set(p, o); o += p.length; }
  return b;
}
function bytes(...vals) {           // [크기(바이트), 값] 쌍들
  let n = 0; for (const [s] of vals) n += s;
  const b = new Uint8Array(n), dv = new DataView(b.buffer); let o = 0;
  for (const [s, v] of vals) {
    if (s === 1) dv.setUint8(o, v); else if (s === 2) dv.setUint16(o, v); else if (s === 4) dv.setUint32(o, v >>> 0);
    else if (s === 8) { dv.setUint32(o, Math.floor(v / 4294967296)); dv.setUint32(o + 4, v % 4294967296); }
    o += s;
  }
  return b;
}
const str = s => Uint8Array.from(s, c => c.charCodeAt(0));
const zeros = n => new Uint8Array(n);
const MATRIX = bytes([4, 0x00010000], [4, 0], [4, 0], [4, 0], [4, 0x00010000], [4, 0], [4, 0], [4, 0], [4, 0x40000000]);
function initSegment(rate, ch, bits, streaminfo) {
  const ftyp = box('ftyp', str('isom'), bytes([4, 0x200]), str('isomiso6mp41'));
  const mvhd = box('mvhd', bytes([4, 0], [4, 0], [4, 0], [4, 1000], [4, 0], [4, 0x00010000], [2, 0x0100], [2, 0], [8, 0]), MATRIX, zeros(24), bytes([4, 2]));
  const tkhd = box('tkhd', bytes([4, 3], [4, 0], [4, 0], [4, 1], [4, 0], [4, 0], [8, 0], [2, 0], [2, 0], [2, 0x0100], [2, 0]), MATRIX, bytes([4, 0], [4, 0]));
  const mdhd = box('mdhd', bytes([4, 0], [4, 0], [4, 0], [4, rate], [4, 0], [2, 0x55c4], [2, 0]));
  const hdlr = box('hdlr', bytes([4, 0], [4, 0]), str('soun'), zeros(12), str('SoundHandler\0'));
  const dfla = box('dfLa', bytes([4, 0], [1, 0x80], [1, 0], [2, 34]), streaminfo);
  // 표본 항목의 samplerate 는 16.16 고정소수점이라 65535 를 넘으면 0 (실제 값은 dfLa 의 STREAMINFO)
  const fLaC = box('fLaC', zeros(6), bytes([2, 1], [8, 0], [2, ch], [2, bits], [2, 0], [2, 0], [4, rate <= 65535 ? rate * 65536 : 0]), dfla);
  const stbl = box('stbl', box('stsd', bytes([4, 0], [4, 1]), fLaC), box('stts', bytes([4, 0], [4, 0])), box('stsc', bytes([4, 0], [4, 0])),
    box('stsz', bytes([4, 0], [4, 0], [4, 0])), box('stco', bytes([4, 0], [4, 0])));
  const minf = box('minf', box('smhd', bytes([4, 0], [4, 0])), box('dinf', box('dref', bytes([4, 0], [4, 1]), box('url ', bytes([4, 1])))), stbl);
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  const mvex = box('mvex', box('trex', bytes([4, 0], [4, 1], [4, 1], [4, 0], [4, 0], [4, 0])));
  const moov = box('moov', mvhd, trak, mvex);
  const out = new Uint8Array(ftyp.length + moov.length); out.set(ftyp); out.set(moov, ftyp.length);
  return out;
}
function fragment(payload, sizes, durs, basePts) {
  const n = sizes.length;
  const trunHead = bytes([4, 0x000301], [4, n], [4, 0]);
  const trunBody = new Uint8Array(n * 8), dv = new DataView(trunBody.buffer);
  for (let i = 0; i < n; i++) { dv.setUint32(i * 8, durs[i]); dv.setUint32(i * 8 + 4, sizes[i]); }
  const trun = box('trun', trunHead, trunBody);
  const traf = box('traf', box('tfhd', bytes([4, 0x020000], [4, 1])), box('tfdt', bytes([4, 0x01000000], [8, basePts])), trun);
  const moof = box('moof', box('mfhd', bytes([4, 0], [4, seq++])), traf);
  // trun 의 data_offset = moof 처음부터 mdat 내용까지
  const off = moof.length + 8, tp = moof.length - trun.length + 8 + 8;   // trun 안 data_offset 자리
  new DataView(moof.buffer).setInt32(tp, off);
  const mdatHead = bytes([4, payload.length + 8]);
  const out = new Uint8Array(moof.length + 8 + payload.length);
  out.set(moof); out.set(mdatHead, moof.length); out.set(str('mdat'), moof.length + 4); out.set(payload, moof.length + 8);
  return out;
}

/* ---------- 명령 ---------- */
function closeFile() { if (U) X.ul_close(U); U = 0; cache.clear(); whole = null; }
async function open(msg) {
  closeFile();
  seq = 1; size = msg.size; whole = msg.whole ? new Uint8Array(msg.whole) : null;
  if (msg.head) { const h = new Uint8Array(msg.head); for (let i = 0; i * BLK < h.length; i++) cache.set(i, h.subarray(i * BLK, Math.min(h.length, (i + 1) * BLK))); }
  U = await call.ul_open(size);
  if (!U) throw new Error('이 파일을 열 수 없어요');
  const info = JSON.parse(cstr(X.ul_info(U)));
  if (msg.meta) {
    let pic = null;
    const pl = X.ul_pic_len(U);
    if (pl > 0 && pl < 8 << 20) pic = { mime: X.ul_pic_mime(U) ? 'image/png' : 'image/jpeg', data: new Uint8Array(mem.buffer, X.ul_pic_ptr(U), pl).slice() };
    postMessage({ type: 'meta', info, pic }, pic ? [pic.data.buffer] : []);
    return;
  }
  if (X.ul_start(U, msg.maxRate || 0) < 0) throw new Error('출력 준비 실패');
  outRate = X.ul_out_rate(U);
  const out = { rate: outRate, ch: X.ul_out_ch(U), bits: X.ul_out_bits(U) };
  const si = new Uint8Array(mem.buffer, X.ul_streaminfo(U), 34).slice();
  const init = initSegment(out.rate, out.ch, out.bits, si);
  postMessage({ type: 'info', info, out, init: init.buffer }, [init.buffer]);
}
async function produce(secs, gen) {
  const n = await call.ul_produce(U, secs);
  if (n < 0) throw new Error('디코드 오류');
  const done = !!X.ul_done(U);
  if (n === 0) { postMessage({ type: 'chunk', data: null, done: true, gen }); return; }
  const len = X.ul_out_len(U), payload = new Uint8Array(mem.buffer, X.ul_out_ptr(U), len).slice();
  const sizes = new Int32Array(mem.buffer, X.ul_sizes(U), n).slice(), durs = new Int32Array(mem.buffer, X.ul_durs(U), n).slice();
  const base = X.ul_first_pts(U);
  let total = 0; for (const d of durs) total += d;
  const data = fragment(payload, sizes, durs, base);
  postMessage({ type: 'chunk', data: data.buffer, t0: base / outRate, t1: (base + total) / outRate, done, gen }, [data.buffer]);
}

let queue = Promise.resolve();
onmessage = e => {
  const m = e.data;
  if (m.cmd === 'data') {           // 파일 조각 도착 (순서 상관없이 바로)
    const w = waiting.get(m.rid); waiting.delete(m.rid);
    if (w) { if (m.buf) w.resolve(m.buf); else w.reject(new Error(m.err || 'read')); }
    return;
  }
  queue = queue.then(async () => {
    try {
      if (m.cmd === 'init') {
        const env = { js_read: JSPI && !m.noJSPI ? new WebAssembly.Suspending(readAsync) : readSync };
        const inst = await WebAssembly.instantiate(m.module, { env, wasi_snapshot_preview1: wasi });
        X = inst.exports; mem = X.memory; X._initialize();
        const wrap = f => (JSPI && !m.noJSPI ? WebAssembly.promising(f) : f);
        call = { ul_open: wrap(X.ul_open), ul_produce: wrap(X.ul_produce), ul_seek: wrap(X.ul_seek) };
        postMessage({ type: 'ready', jspi: JSPI && !m.noJSPI });
      } else if (m.cmd === 'open') await open(m);
      else if (m.cmd === 'produce') { if (U) await produce(m.secs || 2, m.gen); }
      else if (m.cmd === 'seek') { if (U) { const r = await call.ul_seek(U, m.t); postMessage({ type: 'seeked', t: m.t, ok: r >= 0, gen: m.gen }); } }
      else if (m.cmd === 'close') closeFile();
    } catch (err) {
      postMessage({ type: 'error', msg: String((err && err.message) || err), gen: m.gen });
    }
  });
};
