/*
 * 울림 — 음악 파일을 조금씩(약 15초) 풀어 8000Hz PCM 으로 넘겨 주기 (자동 싱크용)
 *   파일 전체를 메모리에 올려 한 번에 풀면 4분짜리 곡도 순간 100MB 넘게 쓴다 (원래 샘플레이트로 다 푼 뒤 줄이므로).
 *   형식마다 프레임 · 페이지 경계에서 잘라 decodeAudioData 로 풀고, 앞 조각과 이어지도록 시간을 맞춘다.
 *   - MP3 · ADTS(AAC): 프레임 길이를 보며 자름, 앞쪽 몇 프레임을 더 넣어(예열) 비트 저장소 · 겹침을 채운 뒤 그 부분은 버림
 *   - M4A(AAC): 샘플 표(stsz · stco · stsc)로 프레임 위치를 알아 ADTS 로 바꿔 풂 (Range 요청)
 *   - FLAC: 프레임마다 따로 풀 수 있음 — STREAMINFO 머리 + 프레임들
 *   - Ogg(Vorbis · Opus): 머리 페이지 + 페이지들, 시간은 granule 로
 *   - WAV: PCM 을 그대로 잘라 머리만 새로 붙임
 *   어느 조각이든 '풀린 끝 = 조각의 끝'으로 맞춘다 (코덱 지연은 모든 조각에서 같아 어긋남이 쌓이지 않음).
 *   모르는 형식이면 Unsupported 를 던짐 → 부르는 쪽이 (짧은 곡만) 통째로 풀거나 글자로 어림.
 */
import { mpegHeader } from './tags.js';

export const SR = 8000;
const CHUNK = 15;                         // 한 번에 푸는 길이(초)
export class Unsupported extends Error {}
const abortErr = () => (typeof DOMException !== 'undefined' ? new DOMException('Aborted', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' }));
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
function concat(parts, total) {
  const out = new Uint8Array(total ?? parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ---------- 풀기 (8000Hz) ---------- */
let octx = null;
function ctx() {
  const C = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!C) throw new Unsupported('no OfflineAudioContext');
  if (!octx) octx = new C(2, SR, SR);
  return octx;
}
function decode(bytes) {
  const c = ctx(), ab = bytes.buffer.byteLength === bytes.length && bytes.byteOffset === 0 ? bytes.buffer : bytes.slice().buffer;
  return new Promise((resolve, reject) => {
    const p = c.decodeAudioData(ab, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

/** 순서대로 읽는 바이트 창: 버퍼 하나를 돌려 쓰며(BYOB 로 바로 그 안에 읽음) 필요할 때만 늘림 → 읽은 조각마다 새 배열이 생기지 않음.
    win 은 그때그때의 보기(view) — await 를 건너 들고 있지 말 것 */
class Win {
  constructor(res, signal) {
    this.signal = signal; this.eof = false; this.size = Number(res.headers.get('content-length')) || 0;
    try { this.r = res.body.getReader({ mode: 'byob' }); this.byob = true; } catch (e) { this.r = res.body.getReader(); this.byob = false; }
    this.buf = new Uint8Array(1 << 20); this.off = 0; this.len = 0;      // 쓸 수 있는 바이트 = buf[off, len)
  }
  get win() { return this.buf.subarray(this.off, this.len); }
  room(n) {                                           // len 뒤에 n 바이트 자리 만들기 (앞으로 당기거나 두 배로)
    if (this.len + n <= this.buf.length) return;
    const used = this.len - this.off;
    if (used + n <= this.buf.length) { this.buf.copyWithin(0, this.off, this.len); this.off = 0; this.len = used; return; }
    let cap = this.buf.length; while (cap < used + n) cap *= 2;
    const nb = new Uint8Array(cap); nb.set(this.buf.subarray(this.off, this.len));
    this.buf = nb; this.off = 0; this.len = used;
  }
  async ensure(n) {                                   // 창이 n 바이트 이상 되게 (끝이면 덜 될 수 있음)
    while (this.len - this.off < n && !this.eof) {
      if (this.signal && this.signal.aborted) { this.cancel(); throw abortErr(); }
      const want = Math.max(n - (this.len - this.off), 256 * 1024);
      this.room(want);
      if (this.byob) {
        const { value, done } = await this.r.read(new Uint8Array(this.buf.buffer, this.len, this.buf.length - this.len));
        if (value) this.buf = new Uint8Array(value.buffer);              // 읽는 동안 넘겨줬던 같은 메모리를 되찾음
        if (done) { this.eof = true; break; }
        this.len += value.byteLength;
      } else {
        const { value, done } = await this.r.read();
        if (done) { this.eof = true; break; }
        this.room(value.length); this.buf.set(value, this.len); this.len += value.length;
      }
    }
    return this.len - this.off >= n;
  }
  drop(n) { if (n > 0) this.off = Math.min(this.len, this.off + n); }
  /** 앞에서 n 바이트 건너뛰기 (창보다 길면 읽으며 버림 — 큰 그림 블록 등) */
  async skip(n) {
    for (;;) {
      const d = Math.min(n, this.len - this.off);
      this.drop(d); n -= d;
      if (n <= 0) return;
      await this.ensure(Math.min(n, 1 << 20));
      if (this.len - this.off <= 0) throw new Unsupported('eof');
    }
  }
  cancel() { try { this.r.cancel(); } catch (e) { /* noop */ } }
}

/** 조각 하나를 풀어 [t0, t1) 로 넘김. 풀린 소리의 끝을 조각의 끝에 맞추고, 모자라면 앞을 0 으로 채움.
    t1 = null: 끝을 모름(마지막 조각) → 풀린 길이만큼 */
async function emit(bytes, t0, t1, out) {
  let L = null, R = null;
  try {
    const ab = await decode(bytes);
    L = ab.getChannelData(0); R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L;
  } catch (e) { out.bad++; if (t1 == null) return; }
  if (t1 == null) t1 = (Math.round(t0 * SR) + L.length) / SR;
  const n0 = Math.round(t0 * SR), n1 = Math.round(t1 * SR), C = n1 - n0;
  if (C <= 0) return;
  // 첫 조각: 코덱 지연(인코더 앞 여백 + 디코더 지연)만큼 앞을 버려 재생 시간과 맞춤 (통째로 풀 때 FFmpeg 가 하는 것과 같게)
  const sk = out.n === 0 && out.skip > 0 ? Math.min(Math.round(out.skip * SR), C) : 0;
  if (L && L.length >= C) out.push(L.subarray(L.length - C + sk), R.subarray(R.length - C + sk), t0, t1);
  else {
    const l2 = new Float32Array(C), r2 = R === L || !R ? l2 : new Float32Array(C);
    if (L) { l2.set(L, C - L.length); if (r2 !== l2) r2.set(R, C - R.length); }
    out.push(l2.subarray(sk), r2.subarray(sk), t0, t1);
  }
  out.n++; out.t = t1;
}

/* ---------- MP3 · MP2 (+ ADTS AAC) : 프레임마다 ---------- */
function adtsHeader(b, o) {
  if (b[o] !== 0xff || (b[o + 1] & 0xf6) !== 0xf0) return null;
  const sfi = (b[o + 2] >> 2) & 15, len = ((b[o + 3] & 3) << 11) | (b[o + 4] << 3) | (b[o + 5] >> 5), blocks = (b[o + 6] & 3) + 1;
  const sr = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][sfi];
  if (!sr || len < 7) return null;
  return { len, sr, spf: 1024 * blocks, aac: true };
}
async function framed(w, start, head, out, preroll) {
  w.drop(start);
  let p = 0, idx = 0, cutIdx = 0, skipFirst = 0, spf = 0, sr = 0, base = 0;
  const marks = [];                                    // marks[i - base] = 창 안에서 i 번째 프레임의 시작
  const tOf = i => Math.max(0, i - skipFirst) * spf / sr;
  const flush = async () => {
    if (idx <= cutIdx) return;
    const from = cutIdx === 0 ? 0 : Math.max(base, cutIdx - preroll);         // 예열 프레임부터
    await emit(w.win.slice(marks[from - base] ?? 0, p), tOf(cutIdx), tOf(idx), out);
    cutIdx = idx;
  };
  for (;;) {
    if (!(await w.ensure(p + 10))) break;
    let h = head(w.win, p);
    if (h && sr && (h.sr !== sr || h.spf !== spf)) h = null;
    if (h) {
      const full = await w.ensure(p + h.len + 4);
      if (!full && p + h.len > w.win.length) h = null;                      // 끝에서 잘린 프레임
      else if (idx === 0 && full && !head(w.win, p + h.len)) h = null;        // 첫 프레임은 다음 프레임으로 확인
    }
    if (!h) {                                          // 동기 다시 찾기 (태그 · 쓰레기 바이트)
      let q = p + 1, found = false;
      for (; q - p < (1 << 20); q++) {
        if (!(await w.ensure(q + 10))) break;
        const g = head(w.win, q);
        if (g && (!sr || (g.sr === sr && g.spf === spf)) && (await w.ensure(q + g.len + 4)) && head(w.win, q + g.len)) { found = true; break; }
      }
      if (!found) break;
      p = q; continue;
    }
    if (!sr) {
      sr = h.sr; spf = h.spf;
      if (h.xing) skipFirst = 1;                       // Xing/Info 프레임은 소리가 아님
      out.skip = h.aac ? 1024 / sr : h.lame >= 0 ? (h.lame + 529) / sr : 0;   // 코덱 지연 (LAME 태그에 적힌 앞 여백 + MP3 디코더 529)
    }
    marks.push(p); idx++; p += h.len;
    if (tOf(idx) - tOf(cutIdx) >= CHUNK) {
      await flush();
      const keep = Math.max(base, idx - preroll), cut = marks[keep - base];   // 다음 조각 예열 프레임만 남김
      w.drop(cut); p -= cut;
      marks.splice(0, keep - base); for (let i = 0; i < marks.length; i++) marks[i] -= cut;
      base = keep;
      if (out.signal && out.signal.aborted) throw abortErr();
    }
  }
  await flush();
  if (!out.n) throw new Unsupported('no frames');
}
function mp3Head(b, o) {
  const h = mpegHeader(b, o);
  if (!h || h.len < 21) return null;
  const side = h.L === 3 ? (h.v === 3 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17)) : 0, x = o + 4 + side;
  const tag = x + 4 <= b.length ? ascii(b, x, 4) : '';
  let lame = -1;
  if ((tag === 'Xing' || tag === 'Info') && x + 8 <= b.length) {          // Xing 머리 뒤의 LAME 태그 → 인코더 앞 여백(샘플)
    const fl = be32(b, x + 4); let q = x + 8 + (fl & 1 ? 4 : 0) + (fl & 2 ? 4 : 0) + (fl & 4 ? 100 : 0) + (fl & 8 ? 4 : 0);
    if (q + 24 <= b.length && /^(LAME|Lavf|Lavc|GOGO)/.test(ascii(b, q, 4))) lame = (b[q + 21] << 4) | (b[q + 22] >> 4);
  }
  return { len: h.len, sr: h.sr, spf: h.spf, lame, xing: tag === 'Xing' || tag === 'Info' || (o + 40 <= b.length && ascii(b, o + 36, 4) === 'VBRI') };
}

/* ---------- FLAC : 프레임은 따로 풀 수 있음 ---------- */
const CRC8 = (() => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; t[i] = c; } return t; })();
/** 프레임 머리 확인 · 첫 샘플 번호. ref(첫 프레임 머리)와 성질이 같아야 함 */
function flacFrame(b, o, info, ref) {
  if (o + 16 > b.length || b[o] !== 0xff || (b[o + 1] & 0xfe) !== 0xf8) return null;
  const strat = b[o + 1] & 1, bsc = b[o + 2] >> 4, src = b[o + 2] & 15, ch = b[o + 3] >> 4, ss = (b[o + 3] >> 1) & 7;
  if (b[o + 3] & 1 || bsc === 0 || src === 15 || ch > 10 || ss === 3 || ss === 7) return null;
  if (ref && (strat !== ref.strat || src !== ref.src || ss !== ref.ss || (ch < 8 ? ch : 1) !== ref.chs)) return null;
  let p = o + 4, v = b[p++], n;                         // UTF-8 처럼 적힌 번호
  if (v < 0x80) n = v;
  else {
    let extra = 0;
    if ((v & 0xe0) === 0xc0) { n = v & 0x1f; extra = 1; } else if ((v & 0xf0) === 0xe0) { n = v & 0x0f; extra = 2; } else if ((v & 0xf8) === 0xf0) { n = v & 0x07; extra = 3; }
    else if ((v & 0xfc) === 0xf8) { n = v & 0x03; extra = 4; } else if ((v & 0xfe) === 0xfc) { n = v & 0x01; extra = 5; } else if (v === 0xfe) { n = 0; extra = 6; } else return null;
    for (let i = 0; i < extra; i++) { const c = b[p++]; if ((c & 0xc0) !== 0x80) return null; n = n * 64 + (c & 0x3f); }
  }
  let bs;
  if (bsc === 1) bs = 192; else if (bsc <= 5) bs = 576 << (bsc - 2); else if (bsc === 6) bs = b[p++] + 1; else if (bsc === 7) { bs = be16(b, p) + 1; p += 2; } else bs = 256 << (bsc - 8);
  if (src === 12) p += 1; else if (src === 13 || src === 14) p += 2;
  let crc = 0; for (let i = o; i < p; i++) crc = CRC8[crc ^ b[i]];
  if (crc !== b[p]) return null;
  const sample = strat ? n : n * info.blockFixed;
  return { strat, src, ss, chs: ch < 8 ? ch : 1, bs, sample };
}
async function flac(w, start, out) {
  if (!(await w.ensure(start + 42)) || ascii(w.win, start, 4) !== 'fLaC') throw new Unsupported('flac');
  await w.skip(start + 4);
  let si = null;
  for (let guard = 0; guard < 128; guard++) {          // 메타데이터 블록: STREAMINFO 만 챙기고 나머지(그림 …)는 건너뜀
    if (!(await w.ensure(4))) throw new Unsupported('flac meta');
    const last = w.win[0] & 0x80, type = w.win[0] & 0x7f, len = (w.win[1] << 16) | (w.win[2] << 8) | w.win[3];
    if (type === 0) { if (!(await w.ensure(4 + 34))) throw new Unsupported('flac si'); si = w.win.slice(4, 4 + 34); }
    await w.skip(4 + len);
    if (last) break;
  }
  if (!si) throw new Unsupported('no streaminfo');
  const rate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4), minB = be16(si, 0), maxB = be16(si, 2);
  if (!rate) throw new Unsupported('flac rate');
  const info = { blockFixed: minB === maxB ? minB : 0 };
  const hdr = new Uint8Array(4 + 4 + 34);                // fLaC + 마지막 블록 표시한 STREAMINFO (전체 길이 · MD5 는 0)
  hdr.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]); hdr.set(si, 8);
  hdr[8 + 13] &= 0xf0; hdr.fill(0, 8 + 14);
  if (!(await w.ensure(64))) throw new Unsupported('flac frames');
  const ref = flacFrame(w.win, 0, info, null);
  if (!ref) throw new Unsupported('flac first frame');
  if (!info.blockFixed && !ref.strat) info.blockFixed = ref.bs;
  const bytesPerSec = w.size && out.duration ? w.size / out.duration : rate * 4;
  let t0 = 0;
  for (;;) {
    const want = Math.ceil(bytesPerSec * CHUNK);
    await w.ensure(want + 32);
    let q = -1, next = null;
    if (!w.eof || w.win.length > want) {
      for (let i = Math.min(want, w.win.length - 16); i + 16 <= w.win.length; i++) {
        if (w.win[i] !== 0xff) continue;
        const f = flacFrame(w.win, i, info, ref);
        if (f && f.sample / rate > t0) { q = i; next = f; break; }
      }
      if (q < 0 && !w.eof) { await w.ensure(w.win.length + (1 << 18)); continue; }
    }
    if (q < 0) {                                         // 끝까지
      if (w.win.length) await emit(concat([hdr, w.win]), t0, null, out);
      break;
    }
    const t1 = next.sample / rate;
    await emit(concat([hdr, w.win.subarray(0, q)]), t0, t1, out);
    w.drop(q); t0 = t1;
    if (out.signal && out.signal.aborted) throw abortErr();
  }
  if (!out.n) throw new Unsupported('flac nothing');
}

/* ---------- Ogg (Vorbis · Opus) : 페이지마다 ---------- */
async function ogg(w, start, out) {
  w.drop(start);
  const page = async p => {                             // { len, granule(-1 = 없음), serial, packetsEnded }
    if (!(await w.ensure(p + 27)) || ascii(w.win, p, 4) !== 'OggS') return null;
    const ns = w.win[p + 26];
    if (!(await w.ensure(p + 27 + ns))) return null;
    let dl = 0, ended = 0;
    for (let i = 0; i < ns; i++) { const l = w.win[p + 27 + i]; dl += l; if (l < 255) ended++; }
    const lo = le32(w.win, p + 6), hi = le32(w.win, p + 10);
    const granule = lo === 0xffffffff && hi === 0xffffffff ? -1 : hi * 4294967296 + lo;
    if (!(await w.ensure(p + 27 + ns + dl))) return null;
    return { len: 27 + ns + dl, granule, serial: le32(w.win, p + 14), ended, first: w.win[p + 27 + ns] };
  };
  // 머리 페이지: Vorbis 3개 · Opus 2개 패킷이 끝날 때까지
  const g0 = await page(0);
  if (!g0) throw new Unsupported('ogg');
  const id = w.win.subarray(27 + w.win[26], 27 + w.win[26] + 19);
  let kind, rate, preskip = 0, need;
  if (id[0] === 1 && ascii(id, 1, 6) === 'vorbis') { kind = 'vorbis'; rate = le32(id, 12); need = 3; }
  else if (ascii(id, 0, 8) === 'OpusHead') { kind = 'opus'; rate = 48000; preskip = le16(id, 10); need = 2; }
  else throw new Unsupported('ogg codec');
  const serial = g0.serial;
  let p = 0, ended = 0;
  while (ended < need) { const g = await page(p); if (!g) throw new Unsupported('ogg head'); if (g.serial === serial) ended += g.ended; p += g.len; }
  const head = w.win.slice(0, p);
  w.drop(p);
  const tOf = g => Math.max(0, (g - preskip) / rate);
  const PRE = 3;
  let t0 = 0, q = 0, lastG = -1, cutStart = 0;
  const starts = [];                                     // 이번 조각의 페이지 시작들 (예열용)
  for (;;) {
    const g = await page(q);
    if (!g) {                                            // 끝 (또는 깨진 페이지)
      if (q > cutStart && lastG >= 0) await emit(concat([head, w.win.subarray(0, q)]), t0, tOf(lastG), out);
      break;
    }
    if (g.serial !== serial) { q += g.len; continue; }  // 다른 흐름(드묾)은 무시
    starts.push(q); q += g.len;
    if (g.granule >= 0) {
      if (lastG >= 0 && g.granule < lastG) throw new Unsupported('ogg chained');
      lastG = g.granule;
      if (tOf(lastG) - t0 >= CHUNK) {
        const t1 = tOf(lastG);
        await emit(concat([head, w.win.subarray(0, q)]), t0, t1, out);
        const keep = starts.length > PRE ? starts[starts.length - PRE] : 0;       // 다음 조각 예열: 마지막 몇 페이지
        w.drop(keep); q -= keep; cutStart = q; starts.length = 0;
        t0 = t1;
        if (out.signal && out.signal.aborted) throw abortErr();
      }
    }
  }
  if (!out.n) throw new Unsupported('ogg nothing');
  void kind;
}

/* ---------- WAV : PCM 그대로 잘라 머리를 다시 붙임 ---------- */
async function wav(w, out) {
  if (!(await w.ensure(12)) || ascii(w.win, 0, 4) !== 'RIFF' || ascii(w.win, 8, 4) !== 'WAVE') throw new Unsupported('wav');
  await w.skip(12);
  let fmt = null, rate = 0, align = 0, found = false;
  for (let guard = 0; guard < 64; guard++) {
    if (!(await w.ensure(8))) throw new Unsupported('wav eof');
    const id = ascii(w.win, 0, 4), len = le32(w.win, 4);
    if (id === 'data') { await w.skip(8); found = true; break; }
    if (id === 'fmt ') { await w.ensure(8 + len); fmt = w.win.slice(0, 8 + len); rate = le32(fmt, 12); align = le16(fmt, 20); }
    await w.skip(8 + len + (len & 1));
  }
  if (!found || !fmt || !rate || !align) throw new Unsupported('wav fmt');
  const per = Math.max(1, Math.floor(rate * CHUNK)) * align;
  let frames = 0;
  for (;;) {
    await w.ensure(per);
    const n = Math.floor(Math.min(per, w.win.length) / align) * align;
    if (n <= 0) break;
    const head = new Uint8Array(12 + fmt.length + 8);
    head.set([0x52, 0x49, 0x46, 0x46]); const tot = 4 + fmt.length + 8 + n;
    head.set([tot & 255, (tot >> 8) & 255, (tot >> 16) & 255, tot >>> 24], 4); head.set([0x57, 0x41, 0x56, 0x45], 8);
    head.set(fmt, 12); const d = 12 + fmt.length;
    head.set([0x64, 0x61, 0x74, 0x61, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24], d);
    const f0 = frames; frames += n / align;
    await emit(concat([head, w.win.subarray(0, n)]), f0 / rate, frames / rate, out);
    w.drop(n);
    if (w.eof && !w.win.length) break;
    if (out.signal && out.signal.aborted) throw abortErr();
  }
}

/* ---------- M4A (AAC) : 샘플 표 → ADTS ---------- */
function rangeReader(url, signal) {
  const cache = { s: -1, b: null };
  const read = async (s, n) => {
    if (cache.b && s >= cache.s && s + n <= cache.s + cache.b.length) return cache.b.subarray(s - cache.s, s - cache.s + n);
    const len = Math.max(n, 64 * 1024);
    const r = await fetch(url, { headers: { Range: `bytes=${s}-${s + len - 1}` }, signal });
    if (r.status !== 206) throw new Unsupported('no range');
    const m = /\/(\d+)\s*$/.exec(r.headers.get('Content-Range') || '');
    if (m) read.size = +m[1];
    const b = new Uint8Array(await r.arrayBuffer());
    cache.s = s; cache.b = b;
    return b.subarray(0, n);
  };
  read.size = 0;
  return read;
}
async function boxes(read, s, e, fn) {                   // 상자 머리만 읽으며 차례로
  for (let p = s, g = 0; g < 4000 && p + 8 <= e; g++) {
    const h = await read(p, 16);
    let sz = be32(h, 0), hdr = 8;
    if (sz === 1) { sz = be32(h, 8) * 4294967296 + be32(h, 12); hdr = 16; } else if (sz === 0) sz = e - p;
    if (sz < 8) return;
    if ((await fn(ascii(h, 4, 4), p + hdr, p + sz)) === false) return;
    p += sz;
  }
}
async function mp4(url, size, out) {
  const read = rangeReader(url, out.signal);
  if (!size) { await read(0, 16); size = read.size; }
  if (!size) throw new Unsupported('mp4 size');
  let moov = null;
  await boxes(read, 0, size, (t, cs, ce) => { if (t === 'moov') { moov = [cs, ce]; return false; } });
  if (!moov) throw new Unsupported('no moov');
  let trak = null;
  await boxes(read, moov[0], moov[1], async (t, cs, ce) => {
    if (t !== 'trak' || trak) return;
    let hdlr = '', mdia = null;
    await boxes(read, cs, ce, async (t2, c2, e2) => { if (t2 === 'mdia') mdia = [c2, e2]; });
    if (!mdia) return;
    await boxes(read, mdia[0], mdia[1], async (t3, c3) => { if (t3 === 'hdlr') hdlr = ascii(await read(c3 + 8, 4), 0, 4); });
    if (hdlr === 'soun') trak = mdia;
  });
  if (!trak) throw new Unsupported('no audio trak');
  let ts = 0, stbl = null;
  await boxes(read, trak[0], trak[1], async (t, cs, ce) => {
    if (t === 'mdhd') { const b = await read(cs, 32); ts = b[0] === 1 ? be32(b, 20) : be32(b, 12); }
    else if (t === 'minf') await boxes(read, cs, ce, (t2, c2, e2) => { if (t2 === 'stbl') stbl = [c2, e2]; });
  });
  if (!stbl || !ts) throw new Unsupported('no stbl');
  const tab = {};
  await boxes(read, stbl[0], stbl[1], async (t, cs, ce) => {
    if (['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64'].includes(t)) {
      if (ce - cs > 16 * 1024 * 1024) throw new Unsupported('table too big');
      tab[t] = (await read(cs, ce - cs)).slice();
    }
  });
  const sd = tab.stsd;
  if (!sd || ascii(sd, 12, 4) !== 'mp4a') throw new Unsupported('codec ' + (sd ? ascii(sd, 12, 4) : '?'));
  // esds → AudioSpecificConfig
  const ei = (() => { for (let i = 8 + 28; i + 8 < sd.length; i++) if (ascii(sd, i + 4, 4) === 'esds') return i + 8 + 4; return -1; })();
  if (ei < 0) throw new Unsupported('no esds');
  let p = ei, asc = null, oti = 0;
  const desc = () => { const tag = sd[p++]; let len = 0; for (let k = 0; k < 4; k++) { const c = sd[p++]; len = (len << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return { tag, len }; };
  for (let g = 0; g < 8 && p < sd.length; g++) {
    const d = desc();
    if (d.tag === 3) { const fl = sd[p + 2]; p += 3; if (fl & 0x80) p += 2; if (fl & 0x40) p += 1 + sd[p]; if (fl & 0x20) p += 2; }
    else if (d.tag === 4) { oti = sd[p]; p += 13; }
    else if (d.tag === 5) { asc = sd.subarray(p, p + d.len); break; }
    else p += d.len;
  }
  const mp3in = oti === 0x6b || oti === 0x69;
  let aot = 0, sfi = 0, chc = 0;
  if (!mp3in) {
    if (!asc || asc.length < 2) throw new Unsupported('no asc');
    let bit = 0; const bits = n => { let v = 0; for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((asc[bit >> 3] >> (7 - (bit & 7))) & 1); return v; };
    aot = bits(5); if (aot === 31) aot = 32 + bits(6);
    sfi = bits(4); if (sfi === 15) throw new Unsupported('explicit rate');
    chc = bits(4);
    if (aot === 5 || aot === 29) { const ex = bits(4); if (ex === 15) bits(24); aot = bits(5); if (aot === 31) aot = 32 + bits(6); }
    if (aot < 1 || aot > 4 || !chc) throw new Unsupported('aot ' + aot);
  }
  // 샘플 위치 · 길이 · 시간
  const sz = tab.stsz, n = be32(sz, 8), fixed = be32(sz, 4);
  if (!n) throw new Unsupported('no samples');
  const sizeOf = i => (fixed || be32(sz, 12 + i * 4));
  const offs = new Float64Array(n);
  const co = tab.stco || tab.co64, is64 = !tab.stco, nc = be32(co, 4), chunkOff = c => (is64 ? be32(co, 8 + c * 8) * 4294967296 + be32(co, 12 + c * 8) : be32(co, 8 + c * 4));
  const sc = tab.stsc, ne = be32(sc, 4);
  for (let e = 0, si = 0; e < ne && si < n; e++) {
    const first = be32(sc, 8 + e * 12) - 1, per = be32(sc, 12 + e * 12), last = e + 1 < ne ? be32(sc, 8 + (e + 1) * 12) - 1 : nc;
    for (let c = first; c < last && si < n; c++) { let o = chunkOff(c); for (let k = 0; k < per && si < n; k++, si++) { offs[si] = o; o += sizeOf(si); } }
  }
  const tt = tab.stts, nt = be32(tt, 4), start = new Float64Array(n + 1);
  for (let e = 0, si = 0, acc = 0; e < nt; e++) { const cnt = be32(tt, 8 + e * 8), d = be32(tt, 12 + e * 8); for (let k = 0; k < cnt && si < n; k++, si++) { start[si] = acc; acc += d; start[si + 1] = acc; } }
  const PRE = mp3in ? 10 : 3;
  if (!mp3in) out.skip = 1024 / (ts || 44100) * (ts > 0 ? 1 : 0);          // AAC 디코더 지연 1024 샘플
  for (let a = 0; a < n;) {
    let b = a; while (b < n && (start[b] - start[a]) / ts < CHUNK) b++;
    const s0 = Math.max(0, a - PRE);
    let lo = Infinity, hi = 0, tot = 0;
    for (let i = s0; i < b; i++) { lo = Math.min(lo, offs[i]); hi = Math.max(hi, offs[i] + sizeOf(i)); tot += sizeOf(i) + (mp3in ? 0 : 7); }
    if (hi - lo > 64 * 1024 * 1024) throw new Unsupported('scattered');
    const r = await fetch(url, { headers: { Range: `bytes=${lo}-${hi - 1}` }, signal: out.signal });
    if (r.status !== 206 && !(r.status === 200 && lo === 0)) throw new Unsupported('range ' + r.status);
    const src = new Uint8Array(await r.arrayBuffer());
    const buf = new Uint8Array(tot);
    let q = 0;
    for (let i = s0; i < b; i++) {
      const L = sizeOf(i), o = offs[i] - lo;
      if (!mp3in) {
        const fl = L + 7;
        buf.set([0xff, 0xf1, ((aot - 1) << 6) | (sfi << 2) | (chc >> 2), ((chc & 3) << 6) | (fl >> 11), (fl >> 3) & 255, ((fl & 7) << 5) | 0x1f, 0xfc], q); q += 7;
      }
      buf.set(src.subarray(o, o + L), q); q += L;
    }
    await emit(buf, start[a] / ts, start[b] / ts, out);
    a = b;
    if (out.signal && out.signal.aborted) throw abortErr();
  }
}

/* ---------- 입구 ---------- */
/** url 의 음악을 조금씩 풀어 onChunk(L, R, t0, t1) 로 (8000Hz). 끝나면 { seconds, chunks, bad } */
export async function decodeChunks(url, { duration = 0, signal = null, onChunk }) {
  const out = { n: 0, bad: 0, t: 0, signal, duration, push: onChunk };
  const res = await fetch(url, { signal });
  if (!res.ok && res.status !== 206) throw new Error('fetch ' + res.status);
  const w = new Win(res, signal);
  try {
    await w.ensure(64 * 1024);
    const b = w.win;
    let off = 0;
    if (ascii(b, 0, 3) === 'ID3') { await w.skip(syncsafe(b, 6) + 10 + ((b[5] & 0x10) ? 10 : 0)); }    // 태그(그림 포함)는 읽으며 버림
    await w.ensure(off + 16);
    const sig = ascii(w.win, off, 4);
    if (sig === 'fLaC') await flac(w, off, out);
    else if (sig === 'OggS') await ogg(w, off, out);
    else if (sig === 'RIFF') await wav(w, out);
    else if (ascii(w.win, off + 4, 4) === 'ftyp') { w.cancel(); await mp4(url, w.size, out); }
    else if (adtsHeader(w.win, off) && !mpegHeader(w.win, off)) await framed(w, off, adtsHeader, out, 3);
    else await framed(w, off, mp3Head, out, 10);
  } finally { w.cancel(); }
  if (out.bad > out.n / 2) throw new Unsupported('decode failed');
  return { seconds: out.t, chunks: out.n, bad: out.bad };
}
