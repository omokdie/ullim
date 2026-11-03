/*
 * 울림 — 음악 파일 태그/길이 읽기 (ID3v1/v2, FLAC, Ogg Vorbis/Opus, MP4/M4A, WAV)
 * 파일 전체를 읽지 않고 필요한 부분만 Range 요청으로 읽는다.
 */

const td8 = new TextDecoder('utf-8');
const td16le = new TextDecoder('utf-16le');
const td16be = new TextDecoder('utf-16be');
let tdKr = null, td1252 = null;
try { tdKr = new TextDecoder('euc-kr', { fatal: true }); } catch (e) { /* noop */ }
try { td1252 = new TextDecoder('windows-1252'); } catch (e) { td1252 = new TextDecoder('latin1'); }

const HEAD = 256 * 1024;
const MAX_TAG = 12 * 1024 * 1024;

/* ---------- reader ---------- */
async function makeReader(src) {
  if (typeof Blob !== 'undefined' && src instanceof Blob) {
    return { size: src.size, read: async (s, n) => new Uint8Array(await src.slice(s, s + n).arrayBuffer()) };
  }
  const rd = { size: null, cache: null, full: null };
  rd.read = async (start, len) => {
    if (start < 0) start = 0;
    if (rd.full) return rd.full.subarray(start, start + len);
    if (rd.cache && start + len <= rd.cache.length) return rd.cache.subarray(start, start + len);
    const r = await fetch(src, { headers: { Range: `bytes=${start}-${start + len - 1}` } });
    if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (r.status === 206) {
      const m = /\/(\d+)\s*$/.exec(r.headers.get('Content-Range') || '');
      if (m) rd.size = +m[1];
      if (start === 0) rd.cache = buf;
      return buf;
    }
    rd.full = buf; rd.size = buf.length;
    return buf.subarray(start, start + len);
  };
  return rd;
}

/* ---------- byte helpers ---------- */
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const clean = s => (s || '').replace(/\u0000.*$/s, '').replace(/[\u0000-\u001f]/g, ' ').trim();

function latin1OrKorean(bytes) {
  let hi = false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) { hi = true; break; }
  if (!hi) return td1252.decode(bytes);
  if (tdKr) { try { const s = tdKr.decode(bytes); if (/[가-힣]/.test(s)) return s; } catch (e) { /* not EUC-KR */ } }
  // 잘못 UTF-8 로 저장된 경우
  try { const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return s; } catch (e) { /* noop */ }
  return td1252.decode(bytes);
}

function decodeText(enc, b) {
  switch (enc) {
    case 0: return latin1OrKorean(b);
    case 1: {
      if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return td16be.decode(b.subarray(2));
      if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return td16le.decode(b.subarray(2));
      return td16le.decode(b);
    }
    case 2: return td16be.decode(b);
    default: return td8.decode(b);
  }
}
/** index after the terminator of an encoded string starting at o */
function skipString(b, o, enc) {
  if (enc === 1 || enc === 2) { for (let i = o; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2; return b.length; }
  for (let i = o; i < b.length; i++) if (b[i] === 0) return i + 1;
  return b.length;
}
function unsync(b) {
  const out = new Uint8Array(b.length); let j = 0;
  for (let i = 0; i < b.length; i++) { out[j++] = b[i]; if (b[i] === 0xff && b[i + 1] === 0x00) i++; }
  return out.subarray(0, j);
}

/* ---------- ID3v2 ---------- */
function parseID3v2(tag, info) {
  const ver = tag[3], flags = tag[5];
  let body = tag.subarray(10);
  if ((flags & 0x80) && ver < 4) body = unsync(body);
  let p = 0;
  if (flags & 0x40) p = ver === 4 ? syncsafe(body, 0) : be32(body, 0) + 4;
  const idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
  let pics = [];
  while (p + hdrLen <= body.length) {
    const id = ascii(body, p, idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let size = ver === 2 ? be24(body, p + 3) : ver === 4 ? syncsafe(body, p + 4) : be32(body, p + 4);
    const fflags = ver === 2 ? 0 : body[p + 9];
    let data = body.subarray(p + hdrLen, p + hdrLen + size);
    p += hdrLen + size;
    if (size <= 0) continue;
    if (ver === 4) {
      if (fflags & 0x0c) continue;                // compressed / encrypted
      if (fflags & 0x40) data = data.subarray(1);   // grouping id
      if (fflags & 0x01) data = data.subarray(4);   // data length indicator
      if (fflags & 0x02) data = unsync(data);
    } else if (ver === 3) {
      if (fflags & 0xc0) continue;
      if (fflags & 0x20) data = data.subarray(1);
    }
    const key = id.length === 3 ? ({ TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TP2: 'TPE2', TRK: 'TRCK', PIC: 'APIC', TLE: 'TLEN', ULT: 'USLT' })[id] || id : id;
    if (key[0] === 'T' && key !== 'TXXX') {
      const s = clean(decodeText(data[0], data.subarray(1)));
      if (key === 'TIT2') info.title = s;
      else if (key === 'TPE1') info.artist = s;
      else if (key === 'TALB') info.album = s;
      else if (key === 'TPE2') info.albumArtist = s;
      else if (key === 'TRCK') info.track = parseInt(s, 10) || 0;
      else if (key === 'TLEN' && +s > 0) info.tlen = +s / 1000;
    } else if (key === 'USLT') {
      const enc = data[0];
      const o = skipString(data, 4, enc);
      const txt = decodeText(enc, data.subarray(o)).replace(/\u0000+$/, '').trim();
      if (txt && (!info.lyrics || txt.length > info.lyrics.length)) info.lyrics = txt;
    } else if (key === 'APIC') {
      const enc = data[0];
      let o = 1, mime;
      if (id === 'PIC') { const f = ascii(data, 1, 3).toUpperCase(); mime = f === 'PNG' ? 'image/png' : 'image/jpeg'; o = 4; }
      else { const e = skipString(data, 1, 0); mime = ascii(data, 1, e - 2 - 0) || 'image/jpeg'; o = e; if (!/\//.test(mime)) mime = 'image/' + (mime.toLowerCase() === 'png' ? 'png' : 'jpeg'); }
      const type = data[o]; o = skipString(data, o + 1, enc);
      if (o < data.length) pics.push({ type, mime, data: data.slice(o) });
    }
  }
  if (pics.length) info.picture = pics.find(x => x.type === 3) || pics[0];
}

/* ---------- MPEG audio frame (duration) ---------- */
const BR = {
  '3-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '3-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '3-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-x': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SRS = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mpegHeader(b, o) {
  if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const v = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3, bri = b[o + 2] >> 4, sri = (b[o + 2] >> 2) & 3;
  if (v === 1 || layer === 0 || bri === 0 || bri === 15 || sri === 3) return null;
  const L = 4 - layer; // 1..3
  const table = v === 3 ? BR['3-' + L] : (L === 1 ? BR['2-3'] : BR['2-x']);
  const bitrate = table[bri] * 1000, sr = SRS[v][sri], pad = (b[o + 2] >> 1) & 1, mono = (b[o + 3] >> 6) === 3;
  const spf = L === 1 ? 384 : L === 2 ? 1152 : (v === 3 ? 1152 : 576);
  const len = L === 1 ? Math.floor((12 * bitrate / sr + pad) * 4) : Math.floor(spf / 8 * bitrate / sr + pad);
  return { v, L, bitrate, sr, spf, mono, len };
}
function mp3Duration(b, start, fileSize, hasV1) {
  for (let o = start; o + 4 < Math.min(b.length, start + 65536); o++) {
    const h = mpegHeader(b, o);
    if (!h || h.len < 20) continue;
    const nh = mpegHeader(b, o + h.len);          // confirm with the next frame
    if (!nh && o + h.len + 4 < b.length) continue;
    const side = h.L === 3 ? (h.v === 3 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17)) : 0;
    const x = o + 4 + side, tag = ascii(b, x, 4);
    if ((tag === 'Xing' || tag === 'Info') && (be32(b, x + 4) & 1)) return be32(b, x + 8) * h.spf / h.sr;
    if (ascii(b, o + 36, 4) === 'VBRI') return be32(b, o + 36 + 14) * h.spf / h.sr;
    if (fileSize && h.bitrate) return (fileSize - o - (hasV1 ? 128 : 0)) * 8 / h.bitrate;
    return 0;
  }
  return 0;
}

/* ---------- Vorbis comment block (FLAC/Ogg) ---------- */
function parseVorbisComment(b, o, info) {
  const vlen = le32(b, o); o += 4 + vlen;
  const n = le32(b, o); o += 4;
  for (let i = 0; i < n && o + 4 <= b.length; i++) {
    const len = le32(b, o); o += 4;
    const s = td8.decode(b.subarray(o, o + len)); o += len;
    const eq = s.indexOf('='); if (eq < 0) continue;
    const k = s.slice(0, eq).toUpperCase(), raw = s.slice(eq + 1), v = clean(raw);
    if ((k === 'LYRICS' || k === 'UNSYNCEDLYRICS' || k === 'SYNCEDLYRICS') && raw.trim() && !info.lyrics) { info.lyrics = raw.trim(); continue; }
    if (k === 'TITLE' && !info.title) info.title = v;
    else if (k === 'ARTIST' && !info.artist) info.artist = v;
    else if (k === 'ALBUM' && !info.album) info.album = v;
    else if (k === 'ALBUMARTIST' && !info.albumArtist) info.albumArtist = v;
    else if (k === 'TRACKNUMBER') info.track = parseInt(v, 10) || 0;
    else if (k === 'METADATA_BLOCK_PICTURE' && !info.picture) {
      try { const bin = Uint8Array.from(atob(v), c => c.charCodeAt(0)); parseFlacPicture(bin, 0, info); } catch (e) { /* noop */ }
    }
  }
}
function parseFlacPicture(b, o, info) {
  const type = be32(b, o); o += 4;
  const ml = be32(b, o); o += 4; const mime = ascii(b, o, ml); o += ml;
  const dl = be32(b, o); o += 4 + dl + 16;
  const len = be32(b, o); o += 4;
  const pic = { type, mime: mime || 'image/jpeg', data: b.slice(o, o + len) };
  if (!info.picture || (type === 3 && info.picture.type !== 3)) info.picture = pic;
}

/* ---------- FLAC ---------- */
async function parseFlac(rd, off, info) {
  let o = off + 4;
  for (let guard = 0; guard < 64; guard++) {
    const h = await rd.read(o, 4);
    if (h.length < 4) break;
    const last = h[0] & 0x80, type = h[0] & 0x7f, len = be24(h, 1);
    if (type === 0 || type === 4 || type === 6) {
      if (len > MAX_TAG) break;
      const b = await rd.read(o + 4, len);
      if (type === 0) {
        const sr = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
        const total = (b[13] & 0x0f) * 4294967296 + be32(b, 14);
        if (sr) info.duration = total / sr;
      } else if (type === 4) parseVorbisComment(b, 0, info);
      else parseFlacPicture(b, 0, info);
    }
    o += 4 + len;
    if (last) break;
  }
}

/* ---------- Ogg ---------- */
async function parseOgg(rd, info, size, start = 0) {
  let o = start, packets = [], cur = [], serial = null, kind = null, rate = 0, preskip = 0;
  for (let pages = 0; pages < 400 && packets.length < 2; pages++) {
    const h = await rd.read(o, 27);
    if (h.length < 27 || ascii(h, 0, 4) !== 'OggS') break;
    const nseg = h[26];
    const seg = await rd.read(o + 27, nseg);
    let dlen = 0; for (let i = 0; i < nseg; i++) dlen += seg[i];
    if (serial === null) serial = le32(h, 14);
    const data = await rd.read(o + 27 + nseg, dlen);
    let p = 0;
    for (let i = 0; i < nseg; i++) {
      cur.push(data.subarray(p, p + seg[i])); p += seg[i];
      if (seg[i] < 255) {
        let n = 0; for (const c of cur) n += c.length;
        const pk = new Uint8Array(n); let q = 0; for (const c of cur) { pk.set(c, q); q += c.length; }
        packets.push(pk); cur = [];
        if (packets.length >= 2) break;
      }
    }
    o += 27 + nseg + dlen;
    if (o > MAX_TAG) break;
  }
  const id = packets[0];
  if (id && ascii(id, 1, 6) === 'vorbis') { kind = 'vorbis'; rate = le32(id, 12); }
  else if (id && ascii(id, 0, 8) === 'OpusHead') { kind = 'opus'; rate = 48000; preskip = le16(id, 10); }
  const cm = packets[1];
  if (cm) {
    if (kind === 'vorbis' && ascii(cm, 1, 6) === 'vorbis') parseVorbisComment(cm, 7, info);
    else if (kind === 'opus' && ascii(cm, 0, 8) === 'OpusTags') parseVorbisComment(cm, 8, info);
  }
  // 길이: 마지막 페이지의 granule position
  if (size && rate) {
    const n = Math.min(size, 65536), tail = await rd.read(size - n, n);
    for (let i = tail.length - 27; i >= 0; i--) {
      if (tail[i] === 0x4f && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53 && le32(tail, i + 14) === serial) {
        const g = le32(tail, i + 6) + le32(tail, i + 10) * 4294967296;
        if (g > 0) { info.duration = (g - preskip) / rate; break; }
      }
    }
  }
}

/* ---------- MP4 / M4A ---------- */
async function parseMp4(rd, info, size) {
  let o = 0;
  const end = size || Infinity;
  let moov = null;
  for (let guard = 0; guard < 64 && o + 8 <= end; guard++) {
    const h = await rd.read(o, 16);
    if (h.length < 8) break;
    let sz = be32(h, 0); const type = ascii(h, 4, 4); let hdr = 8;
    if (sz === 1) { sz = be32(h, 8) * 4294967296 + be32(h, 12); hdr = 16; }
    else if (sz === 0) sz = end - o;
    if (sz < 8) break;
    if (type === 'moov') { if (sz <= MAX_TAG) moov = await rd.read(o + hdr, sz - hdr); break; }
    o += sz;
  }
  if (!moov) return;
  const ilstNames = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', 'aART': 'albumArtist' };
  const walk = (b, s, e, depth) => {
    let p = s;
    while (p + 8 <= e) {
      let sz = be32(b, p); const t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      let hdr = 8;
      if (sz === 1) { sz = be32(b, p + 12); hdr = 16; }
      if (sz < 8 || p + sz > e) sz = e - p;
      const cs = p + hdr, ce = p + sz;
      if (t === 'mvhd') {
        const v = b[cs];
        const ts = v === 1 ? be32(b, cs + 20) : be32(b, cs + 12);
        const du = v === 1 ? be32(b, cs + 24) * 4294967296 + be32(b, cs + 28) : be32(b, cs + 16);
        if (ts) info.duration = du / ts;
      } else if (t === 'udta' || t === 'ilst' || t === 'trak' || t === 'mdia') {
        walk(b, cs, ce, depth + 1);
      } else if (t === 'meta') {
        walk(b, cs + 4, ce, depth + 1);
      } else if (depth >= 1 && (ilstNames[t] || t === 'covr' || t === 'trkn' || t === '\u00a9lyr')) {
        // child 'data' atom
        const dsz = be32(b, cs), dt = ascii(b, cs + 4, 4);
        if (dt === 'data') {
          const typ = be24(b, cs + 9), payload = b.subarray(cs + 16, cs + dsz);
          if (t === 'covr') { if (!info.picture) info.picture = { type: 3, mime: typ === 14 ? 'image/png' : 'image/jpeg', data: payload.slice() }; }
          else if (t === 'trkn') info.track = be16(payload, 2);
          else if (t === '\u00a9lyr') info.lyrics = td8.decode(payload).trim();
          else info[ilstNames[t]] = clean(td8.decode(payload));
        }
      }
      p += sz;
    }
  };
  walk(moov, 0, moov.length, 0);
}

/* ---------- WAV ---------- */
async function parseWav(rd, info, size, head) {
  let o = 12, byteRate = 0;
  for (let guard = 0; guard < 64 && o + 8 <= (size || head.length); guard++) {
    const h = await rd.read(o, 8);
    if (h.length < 8) break;
    const id = ascii(h, 0, 4), len = le32(h, 4);
    if (id === 'fmt ') { const b = await rd.read(o + 8, Math.min(len, 64)); byteRate = le32(b, 8); }
    else if (id === 'data') { if (byteRate) info.duration = len / byteRate; }
    else if (id === 'LIST' && len < 1e6) {
      const b = await rd.read(o + 8, len);
      if (ascii(b, 0, 4) === 'INFO') {
        let p = 4;
        while (p + 8 <= b.length) {
          const k = ascii(b, p, 4), l = le32(b, p + 4);
          const s = clean(latin1OrKorean(b.subarray(p + 8, p + 8 + l)));
          if (k === 'INAM') info.title = s; else if (k === 'IART') info.artist = s; else if (k === 'IPRD') info.album = s;
          p += 8 + l + (l & 1);
        }
      }
    } else if ((id === 'id3 ' || id === 'ID3 ') && len < MAX_TAG) {
      const b = await rd.read(o + 8, len);
      if (ascii(b, 0, 3) === 'ID3') parseID3v2(b, info);
    }
    o += 8 + len + (len & 1);
  }
}

/* ---------- entry ---------- */
export async function readTags(src) {
  const info = { title: '', artist: '', album: '', albumArtist: '', track: 0, duration: 0, picture: null, lyrics: '' };
  const rd = await makeReader(src);
  const head = await rd.read(0, HEAD);
  const size = rd.size || head.length;
  let off = 0;
  if (ascii(head, 0, 3) === 'ID3') {
    const tlen = syncsafe(head, 6) + 10 + ((head[5] & 0x10) ? 10 : 0);
    const tag = tlen <= head.length ? head.subarray(0, tlen) : (tlen <= MAX_TAG ? await rd.read(0, tlen) : null);
    if (tag) { try { parseID3v2(tag, info); } catch (e) { /* broken tag */ } }
    off = tlen;
  }
  const b = off + 65536 <= head.length ? head.subarray(off) : await rd.read(off, HEAD);
  const sig = ascii(b, 0, 4);
  try {
    if (sig === 'fLaC') await parseFlac(rd, off, info);
    else if (sig === 'OggS') await parseOgg(rd, info, size, off);
    else if (ascii(b, 4, 4) === 'ftyp') await parseMp4(rd, info, size);
    else if (sig === 'RIFF' && ascii(b, 8, 4) === 'WAVE') await parseWav(rd, info, size, b);
    else {
      let hasV1 = false;
      if (size > 256) {
        const t = await rd.read(size - 128, 128);
        if (ascii(t, 0, 3) === 'TAG') {
          hasV1 = true;
          if (!info.title) info.title = clean(latin1OrKorean(t.subarray(3, 33)));
          if (!info.artist) info.artist = clean(latin1OrKorean(t.subarray(33, 63)));
          if (!info.album) info.album = clean(latin1OrKorean(t.subarray(63, 93)));
        }
      }
      info.duration = mp3Duration(b, 0, size - off, hasV1) || info.tlen || 0;
    }
  } catch (e) { /* partial info is fine */ }
  if (!info.artist && info.albumArtist) info.artist = info.albumArtist;
  delete info.tlen;
  return info;
}
