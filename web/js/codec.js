/* 울림 — 코덱 엔진 (메인 스레드)
 *
 * 브라우저 엔진이 못 푸는 형식(DSD · APE · WavPack · ALAC · AIFF · WMA · TTA · AC3 · DTS · MPC · TAK …)을
 * FFmpeg(wasm, codec-worker.js)으로 풀어 FLAC(무손실) fMP4 조각으로 MediaSource 에 넣는다.
 * <audio> 는 그대로라 재생 · 탐색 · 속도(음정 유지) · 음장 효과 · 크로스페이드가 다른 형식과 똑같다.
 *
 *  - 파일은 여기(메인 스레드)서 Range 로 조각조각 읽어 워커에 준다 (JSPI 가 없으면 통째로).
 *  - 앞으로 20~30초(바이트 상한 안에서)만 미리 풀고, 들은 부분은 버려 메모리를 적게 쓴다.
 *  - 버퍼 밖으로 탐색하면 워커가 그 자리부터 다시 푼다 (세대 번호로 늦게 온 조각은 버림).
 */
const EXT = ['ape', 'wv', 'tta', 'dsf', 'dff', 'wma', 'asf', 'aif', 'aiff', 'aifc', 'ac3', 'eac3', 'ec3', 'dts', 'dtshd',
  'mp2', 'mpa', 'mpc', 'mp+', 'tak', 'shn', 'caf', 'w64', 'thd', 'mlp', 'alac'];
export const CODEC_EXT = EXT;
const extOf = n => (String(n || '').split(/[?#]/)[0].split('.').pop() || '').toLowerCase();
export const needsCodec = name => EXT.includes(extOf(name));

let modP = null, wurlP = null;
const here = p => new URL(p, import.meta.url).href;
function wasmModule() {
  if (!modP) modP = fetch(here('./vendor/ullim-codec.wasm')).then(r => { if (!r.ok) throw new Error('codec ' + r.status); return r.arrayBuffer(); }).then(b => WebAssembly.compile(b));
  modP.catch(() => { modP = null; });
  return modP;
}
// 워커 스크립트는 직접 받아 Blob 으로 띄운다 (안드로이드: 워커가 직접 앱 주소를 못 읽을 수 있어서)
function workerUrl() {
  if (!wurlP) wurlP = fetch(here('./codec-worker.js')).then(r => r.text()).then(t => URL.createObjectURL(new Blob([t], { type: 'text/javascript' })));
  wurlP.catch(() => { wurlP = null; });
  return wurlP;
}
let mseOK = null;
export function supported() {
  if (mseOK === null) {
    try { mseOK = typeof WebAssembly === 'object' && typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mp4; codecs="flac"'); }
    catch (e) { mseOK = false; }
  }
  return mseOK;
}

/* ---------- 파일 읽기 ---------- */
const HEAD = 1 << 19;
async function readRange(url, pos, len) {
  const r = await fetch(url, { headers: { Range: `bytes=${pos}-${pos + len - 1}` } });
  if (!r.ok) throw new Error('read ' + r.status);
  const buf = await r.arrayBuffer();
  if (r.status === 206) {
    const m = /\/(\d+)\s*$/.exec(r.headers.get('Content-Range') || '');
    return { buf, total: m ? +m[1] : 0 };
  }
  return { buf, whole: true };                         // Range 를 무시하고 전체를 줬음
}

/** 워커 하나 = 파일 하나 (재생용) 또는 여러 파일을 차례로 (정보 읽기용) */
class Job {
  constructor() { this.handlers = new Set(); this.url = null; this.wholeBuf = null; }
  async start() {
    const [mod, wu] = await Promise.all([wasmModule(), workerUrl()]);
    this.w = new Worker(wu);
    this.w.onmessage = e => this._msg(e.data);
    this.w.onerror = e => this._emit({ type: 'error', msg: (e && e.message) || 'worker' });
    const ready = this.wait(m => m.type === 'ready');
    this.w.postMessage({ cmd: 'init', module: mod, noJSPI: !!globalThis.__ullimNoJSPI });   // (시험용: 통째로 읽기 길)
    const r = await ready;
    this.jspi = r.jspi;
  }
  _emit(m) { for (const h of [...this.handlers]) h(m); }
  async _msg(m) {
    if (m.type === 'read') {          // 워커가 파일 조각을 원함
      try {
        let buf;
        if (this.wholeBuf) buf = this.wholeBuf.slice(m.pos, m.pos + m.len);
        else {
          const r = await readRange(this.url, m.pos, m.len);
          if (r.whole) { this.wholeBuf = r.buf; buf = r.buf.slice(m.pos, m.pos + m.len); } else buf = r.buf;
        }
        this.w.postMessage({ cmd: 'data', rid: m.rid, buf }, [buf]);
      } catch (e) { this.w.postMessage({ cmd: 'data', rid: m.rid, buf: null, err: String(e) }); }
      return;
    }
    this._emit(m);
  }
  wait(pred, ms = 20000) {
    return new Promise((resolve, reject) => {
      const h = m => {
        if (m.type === 'error') { this.handlers.delete(h); clearTimeout(t); reject(new Error(m.msg)); }
        else if (pred(m)) { this.handlers.delete(h); clearTimeout(t); resolve(m); }
      };
      const t = setTimeout(() => { this.handlers.delete(h); reject(new Error('시간 초과')); }, ms);
      this.handlers.add(h);
    });
  }
  /** 파일 열기: 앞부분을 먼저 읽어 크기를 알아내고, JSPI 가 없으면 통째로 */
  async open(url, { meta = false, maxRate = 0 } = {}) {
    this.url = url; this.wholeBuf = null;
    const h = await readRange(url, 0, HEAD);
    let size = h.total, whole = null, head = h.buf;
    if (h.whole) { size = h.buf.byteLength; this.wholeBuf = h.buf; }
    if (!size) size = head.byteLength;
    if (!this.jspi) {                                   // 통째로 넘김 (워커가 동기로 읽음)
      if (!this.wholeBuf) {
        if (size > (navigator.deviceMemory && navigator.deviceMemory <= 4 ? 400e6 : 1200e6)) throw new Error('파일이 너무 커요');
        const r = await fetch(url); if (!r.ok) throw new Error('read ' + r.status);
        this.wholeBuf = await r.arrayBuffer();
      }
      whole = this.wholeBuf; this.wholeBuf = null; head = null;
    } else if (this.wholeBuf) head = null;              // 서버가 통째로 줬음 → 조각 요청을 여기 사본에서

    const got = this.wait(m => m.type === (meta ? 'meta' : 'info'), 30000);
    this.w.postMessage({ cmd: 'open', size, head, whole, meta, maxRate }, [head, whole].filter(Boolean));
    return got;
  }
  post(m) { this.w.postMessage(m); }
  terminate() { try { this.w.terminate(); } catch (e) { /* noop */ } this.handlers.clear(); this.wholeBuf = null; }
}

/* ---------- 태그 · 앨범아트 읽기 (목록에 넣을 때) ---------- */
let probeJob = null, probeQ = Promise.resolve(), probeIdle = 0;
export function probe(url, { picture = true } = {}) {
  const run = async () => {
    clearTimeout(probeIdle);
    if (!probeJob) { probeJob = new Job(); await probeJob.start(); }
    try {
      const r = await probeJob.open(url, { meta: true });
      probeJob.post({ cmd: 'close' });
      return { info: r.info, pic: picture ? r.pic : null };
    } finally {
      probeIdle = setTimeout(() => { if (probeJob) { probeJob.terminate(); probeJob = null; } }, 15000);   // 한동안 안 쓰면 정리
    }
  };
  const p = probeQ.then(run, run);
  probeQ = p.catch(() => {});
  return p;
}

/* ---------- 재생: MediaSource 로 <audio> 에 ---------- */
export class CodecSource {
  /** opt.maxRate: DSD 를 이 샘플레이트 아래로 (휴대폰 96000) · opt.onerror(err) · opt.oninfo(info, out) */
  constructor(url, opt = {}) {
    this.url = url; this.opt = opt; this.gen = 0; this.busy = false; this.eos = false; this.dead = false;
    this.bps = 0; this.appending = Promise.resolve(); this.info = null; this.out = null;
  }
  attach(a) {
    this.a = a;
    this.ms = new MediaSource();
    this.src = URL.createObjectURL(this.ms);
    this.ms.addEventListener('sourceopen', () => this._open(), { once: true });
    this._onSeek = () => this._seeking();
    this._onTime = () => this._pump();
    a.addEventListener('seeking', this._onSeek);
    a.addEventListener('timeupdate', this._onTime);
    return this.src;
  }
  _fail(e) {
    if (this.dead) return;
    console.warn('codec', e);
    this.dead = true;
    if (this.opt.onerror) this.opt.onerror(e);
  }
  async _open() {
    try {
      this.job = new Job();
      await this.job.start();
      if (this.dead) return;
      this.job.handlers.add(m => this._msg(m));
      const r = await this.job.open(this.url, { maxRate: this.opt.maxRate || 0 });
      if (this.dead) return;
      this.info = r.info; this.out = r.out;
      if (this.opt.oninfo) this.opt.oninfo(r.info, r.out);
      this.sb = this.ms.addSourceBuffer('audio/mp4; codecs="flac"');
      this.sb.mode = 'segments';
      if (r.info.dur > 0) this.ms.duration = r.info.dur;
      await this._append(r.init);
      this._pump();
    } catch (e) { this._fail(e); }
  }
  _ahead() {
    const a = this.a, b = this.sb && this.sb.buffered, t = a.currentTime;
    if (!b) return 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.25 && b.end(i) > t) return b.end(i) - t;
    return 0;
  }
  _target() {      // 미리 풀어 둘 초: 30초, 단 6MB 를 넘지 않게 (휴대폰 MSE 메모리 한도)
    return this.bps > 0 ? Math.max(8, Math.min(30, 6e6 / this.bps)) : 12;
  }
  _pump() {
    if (this.busy || this.eos || this.dead || !this.sb) return;
    const ahead = this._ahead();
    if (ahead >= this._target()) return;
    this.busy = true;
    this.job.post({ cmd: 'produce', secs: ahead < 1 ? 1.5 : 4, gen: this.gen });
  }
  async _msg(m) {
    if (this.dead) return;
    if (m.type === 'error') { if (m.gen === undefined || m.gen === this.gen) this._fail(new Error(m.msg)); return; }
    if (m.type !== 'chunk' || m.gen !== this.gen) return;     // 탐색 전에 만든 조각은 버림
    const gen = this.gen;
    try {
      if (m.data) {
        if (m.t1 > m.t0) { const r = m.data.byteLength / (m.t1 - m.t0); this.bps = this.bps ? this.bps * 0.7 + r * 0.3 : r; }
        await this._append(m.data);
      }
      if (gen !== this.gen) return;
      this.busy = false;
      if (m.done) { this.eos = true; await this._end(); }
      else this._pump();
    } catch (e) { if (gen === this.gen) this._fail(e); }
  }
  _waitIdle() {
    return new Promise(r => { if (!this.sb.updating) r(); else this.sb.addEventListener('updateend', () => r(), { once: true }); });
  }
  async _append(buf) {
    const run = async () => {
      for (let tries = 0; ; tries++) {
        if (this.dead) return;
        await this._waitIdle();
        this._evict();
        await this._waitIdle();
        try { this.sb.appendBuffer(buf); await this._waitIdle(); return; }
        catch (e) {
          if (e.name !== 'QuotaExceededError' || tries > 20) throw e;
          await this._evict(true);                       // 공간이 모자람: 지난 부분을 더 버리고 잠깐 기다림
          await new Promise(r => setTimeout(r, 400));
        }
      }
    };
    const p = this.appending.then(run, run);
    this.appending = p.catch(() => {});
    return p;
  }
  _evict(hard = false) {
    const b = this.sb.buffered, t = this.a.currentTime;
    if (!b.length || this.sb.updating) return Promise.resolve();
    const keep = hard ? 3 : 15, start = b.start(0);
    if (t - start > keep + 5) { this.sb.remove(start, t - keep); return this._waitIdle(); }
    return Promise.resolve();
  }
  async _end() {
    await this.appending; await this._waitIdle();
    if (this.ms.readyState === 'open' && this.eos && !this.dead) { try { this.ms.endOfStream(); } catch (e) { /* noop */ } }
  }
  async _seeking() {
    if (this.dead || !this.sb) return;
    const t = this.a.currentTime, b = this.sb.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.05 && b.end(i) > t + 0.5) return;   // 이미 있는 곳
    const gen = ++this.gen;
    this.busy = false; this.eos = false;
    try {
      await this.appending;
      if (gen !== this.gen) return;
      if (this.ms.readyState === 'open' && this.sb.updating) this.sb.abort();
      await this._waitIdle();
      if (this.sb.buffered.length) { this.sb.remove(0, Infinity); await this._waitIdle(); }
      if (gen !== this.gen) return;
      this.job.post({ cmd: 'seek', t, gen });
      this._pump();
    } catch (e) { if (gen === this.gen) this._fail(e); }
  }
  dispose() {
    this.dead = true;
    if (this.a) { this.a.removeEventListener('seeking', this._onSeek); this.a.removeEventListener('timeupdate', this._onTime); }
    if (this.job) this.job.terminate();
    if (this.src) URL.revokeObjectURL(this.src);
  }
}
