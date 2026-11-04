/* 울림 — 오디오 엔진 (1.3.0)
 *
 *   덱 A ┐                      ┌→ direct (효과 없음 · 원음) ───────────────────────────────┐
 *   덱 B ┴→ mix (크로스페이드) ─┤                                                           ├→ switcher → 볼륨 → 수면 → 출력
 *                               └→ head (자동 여유 음량) → [효과 칸 …] → safety → proc ────┘        └→ (분석기)
 *
 * 효과 칸(slot): in ─→ dry ───────────→ sum
 *                   └→ [효과] → wet ──→ sum      켜고 끄기 = dry · wet 을 0.12초 동안 겹쳐 바꿈 (끊김 없음)
 *  - 칸은 그 효과를 처음 켤 때 순서(ORDER)에 맞는 자리에 끼워 넣고, 앱을 닫을 때까지 빼지 않는다
 *    (빼면 지연이 있는 효과 뒤에서 소리가 튐). 꺼진 효과는 입력을 끊어 계산하지 않고, 20초 뒤 버린다(메모리).
 *  - 칸을 끼워 넣을 때 새 칸은 그대로 통과라(지연 없음) 소리를 줄이지 않고 바로 연결을 바꾼다.
 *  - 켜진 효과가 없거나 '원음'이면 효과 경로를 아예 끊고 direct 로 (계산 0, 원음 그대로).
 *  - head: 켜진 EQ · 음색 효과가 올리는 최대치만큼 미리 줄여 0dBFS 를 넘지 않게 (자동 프리앰프 — 찌그러짐 방지)
 *  - safety: 마지막 안전망 소프트 클리퍼 (0.9 까지는 그대로, 2배 오버샘플링)
 */
import { FX_BY_ID, ORDER, buildEQ, defaultParams } from './effects.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const XF = 0.12;                                          // 켜고 끄기 겹침 시간(초)
const db = v => Math.pow(10, v / 20);
const FREQS = Array.from({ length: 56 }, (_, i) => 20 * Math.pow(1000, i / 55));   // 20Hz~20kHz (자동 여유 음량 계산)

/** 마지막 안전망 곡선: 0.9 까지는 그대로, 그 위는 1.0 을 넘지 않게 부드럽게 (입력 ±2 범위 → 넣을 때 반으로) */
export function safetyCurve(n = 8193) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const u = (i / (n - 1)) * 4 - 2, a = Math.abs(u); curve[i] = a <= 0.9 ? u : Math.sign(u) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1)); }
  return curve;
}
/** 자동 여유 음량(dB): 켜진 EQ · 음색 효과가 올리는 만큼 미리 줄여 리미터가 덜 일하게.
    주파수 응답의 최고치만큼 파형의 봉우리가 다 오르지는 않으므로(저음만 올리면 봉우리는 몇 dB) 일부만 줄이고,
    가끔 넘는 봉우리는 리미터 · 안전망이 부드럽게 잡는다. 다 줄이면 저음을 올릴 때 전체가 너무 작아짐 */
// 올린 만큼의 55% 를 미리 줄임 (남는 봉우리는 리미터가 잡음 — 시험: test/preset_level_test.py).
// 음악은 높은음으로 갈수록 에너지가 작아(분홍 잡음과 비슷) 높은음을 올려도 봉우리가 덜 오른다 → 1.5kHz 위는 덜 줄임 (16kHz 에서 25%)
const HRW = FREQS.map(f => f <= 1500 ? 0.55 : 0.55 - 0.3 * Math.min(1, Math.log2(f / 1500) / Math.log2(16000 / 1500)));
export function headroomFor(mods) {
  let worst = 0;
  const rs = mods.filter(m => m && m.resp);
  if (rs.length) FREQS.forEach((f, i) => { let t = 0; for (const m of rs) t += m.resp(f); const v = Math.max(0, t - 1) * HRW[i]; if (v > worst) worst = v; });
  return -worst;
}
/** 실제로 쓸 효과 칸. 리미터만 켜져 있으면 효과 경로를 아예 쓰지 않는다 — 원음은 넘칠 일이 없으니
    한 비트도 바꾸지 않고 그대로 내보냄(무손실 · 비트 퍼펙트). 다른 효과를 켜면 리미터가 함께 일한다 */
export function liveIds(isOn, bypass) {
  if (bypass) return [];
  const ids = ORDER.filter(id => isOn(id) && (id === 'eq' || (FX_BY_ID[id] && !FX_BY_ID[id].pseudo)));
  return ids.every(id => id === 'limiter') ? [] : ids;
}

function stereo(ctx, g = 1) {
  const n = ctx.createGain();
  n.channelCount = 2; n.channelCountMode = 'explicit'; n.channelInterpretation = 'speakers';
  n.gain.value = g;
  return n;
}

export class Engine extends EventTarget {
  /** opt.light: 휴대폰 — 잔향 길이 · 키 조절 계산량을 줄임 · opt.sinkId: 출력 장치 (PC · USB DAC)
      출력 장치를 정해 만들면 그 장치의 샘플레이트로 열린다 → 앱 안에서 한 번 더 바꾸지 않음 */
  constructor(opt = {}) {
    super();
    const AC = window.AudioContext || window.webkitAudioContext;
    let made = null;
    if (opt.sinkId) { try { made = new AC({ latencyHint: 'playback', sinkId: opt.sinkId }); } catch (e) { made = null; } }   // 장치가 없어졌으면 기본 장치로
    this.ctx = made || new AC({ latencyHint: 'playback' });
    const ctx = this.ctx;
    this.opt = { light: !!opt.light, maxIR: opt.light ? 1.8 : 5 };    // 잔향 IR 최대 길이(초): 컨볼루션 계산량이 길이에 비례
    this.mix = stereo(ctx);
    this.switcher = ctx.createGain();
    this.master = ctx.createGain();
    this.sleepGain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096; this.analyser.smoothingTimeConstant = 0.72;
    this.analyser.minDecibels = -90; this.analyser.maxDecibels = -12;
    this.switcher.connect(this.master).connect(this.sleepGain).connect(ctx.destination);
    this.tap = false;                                    // 분석기는 비주얼라이저가 그릴 때만 연결 (setTap)

    // 원음 경로 · 효과 경로
    this.direct = stereo(ctx, 1);
    this.head = stereo(ctx, 1);
    this.safety = ctx.createWaveShaper();
    this.safety.curve = safetyCurve(); this.safety.oversample = '2x';
    this.safetyIn = stereo(ctx, 0.5);                    // 곡선이 ±2 범위라 반으로 넣고
    this.proc = stereo(ctx, 0);
    this.safetyOut = stereo(ctx, 1);
    this.mix.connect(this.direct).connect(this.switcher);
    this.head.connect(this.safetyIn).connect(this.safety).connect(this.safetyOut).connect(this.proc).connect(this.switcher);
    this.procOn = false;                                  // 효과 경로를 쓰는 중
    this.headLinked = false;                              // mix → head 연결 (안 쓸 때는 끊어 계산 0)

    this.decks = [this._deck(), this._deck()];
    this.active = 0;

    this.state = {};      // id → { on, p }
    this.slots = new Map();
    this.bypass = false;
    this.speed = { rate: 100, keep: true };
    this.volume = 1;
    this._chain = '';
    this._queue = Promise.resolve();
    this._hrTimer = 0;
    // 볼륨 평준화 · 초저음용 워클릿은 그 효과를 처음 켤 때 불러온다
    this.workletOK = false;
    this.workletSupported = !!ctx.audioWorklet;
    this._wl = null;
  }
  ensureWorklet() {
    if (!this._wl) {
      this._wl = (this.ctx.audioWorklet
        ? this.ctx.audioWorklet.addModule(new URL('./fx-worklet.js', import.meta.url).href).then(() => true, e => { console.warn('worklet', e); return false; })
        : Promise.resolve(false)).then(ok => { this.workletOK = ok; return ok; });
    }
    return this._wl;
  }
  get running() { return this.ctx.state === 'running'; }

  /* ---------- 출력 장치 (PC: USB DAC 등) ---------- */
  get canPickSink() { return typeof this.ctx.setSinkId === 'function'; }
  get sinkId() { const v = this.ctx.sinkId; return typeof v === 'string' ? v : ''; }
  async setSink(id) {
    if (!this.canPickSink) return false;
    try { await this.ctx.setSinkId(id || ''); return true; } catch (e) { console.warn('sink', e); return false; }
  }

  _deck() {
    const a = new Audio();
    a.preload = 'auto';
    const src = this.ctx.createMediaElementSource(a);
    const g = this.ctx.createGain();
    src.connect(g).connect(this.mix);
    return { a, src, g, track: null };
  }
  /** 비주얼라이저가 그리는 동안만 분석기에 소리를 넣음 */
  setTap(on) {
    if (this.tap === !!on) return;
    this.tap = !!on;
    try { if (on) this.switcher.connect(this.analyser); else this.switcher.disconnect(this.analyser); } catch (e) { /* noop */ }
  }
  get deck() { return this.decks[this.active]; }
  get other() { return this.decks[1 - this.active]; }

  resume() { if (this.ctx.state !== 'running') return this.ctx.resume().catch(() => {}); return Promise.resolve(); }

  /* ---------- 부드러운 값 바꾸기 ---------- */
  /** dur 초 안에 바꾸기 — setTargetAtTime(지수): 언제 불러도 지금 값에서 이어짐 (linearRamp 는 앞선 이벤트가 없으면 0초부터 계산돼 툭 튐).
      건조 1→0 · 젖음 0→1 을 같은 τ 로 바꾸면 합이 늘 1 이라 겹치는 동안 크기가 변하지 않음 */
  _fade(param, v, dur, delay = 0) {
    if (!this.running) { try { param.cancelScheduledValues(0); } catch (e) { /* noop */ } param.value = v; return; }
    const t = this.ctx.currentTime;
    try { param.cancelScheduledValues(t + delay); } catch (e) { /* noop */ }
    param.setTargetAtTime(v, t + delay, dur / 3.5);
  }
  _target(param, v, tc) {
    if (!this.running) { try { param.cancelScheduledValues(0); } catch (e) { /* noop */ } param.value = v; return; }
    const t = this.ctx.currentTime;
    try { param.cancelScheduledValues(t); } catch (e) { /* noop */ }
    param.setTargetAtTime(v, t, tc);
  }

  /* ---------- 볼륨 ---------- */
  setVolume(v, muted) {
    this.volume = v;
    const g = muted ? 0 : v * v;
    this._target(this.master.gain, g, 0.02);
    // 라우드니스: 볼륨을 낮춘 만큼(40·log10 v dB) 저음 · 고음을 더 채움
    const att = v > 0 ? 40 * Math.log10(v) : -60;
    const s = this.slots.get('loudness');
    if (s && s.mod && s.mod.setListening) { s.mod.setListening(att); this._headroomSoon(); }
  }

  /* ---------- 효과 상태 ---------- */
  isOn(id) { return !!(this.state[id] && this.state[id].on); }

  /** 전체 상태 적용 (프리셋, 시작 시) */
  async applyAll(fxState, eqState, bypass) {
    this.bypass = !!bypass;
    for (const id of ORDER) {
      if (id === 'eq') this.state.eq = { on: !!eqState.on, p: eqState.p };
      else {
        const def = FX_BY_ID[id];
        const s = fxState[id] || { on: false, p: defaultParams(def) };
        this.state[id] = { on: !!s.on, p: { ...defaultParams(def), ...s.p } };
      }
    }
    const sp = fxState.speed;
    this._applySpeed(sp && sp.on ? { ...defaultParams(FX_BY_ID.speed), ...sp.p } : null);
    for (const [id, s] of this.slots) if (s.mod) this._pushParams(id);
    return this.rebuild();
  }

  setEnabled(id, on) {
    if (id === 'speed') {
      this.state.speed = { on, p: (this.state.speed && this.state.speed.p) || defaultParams(FX_BY_ID.speed) };
      this._applySpeed(on ? this.state.speed.p : null);
      return Promise.resolve();
    }
    if (!this.state[id]) this.state[id] = { on, p: id === 'eq' ? {} : defaultParams(FX_BY_ID[id]) };
    this.state[id].on = on;
    return this.rebuild();
  }

  setParam(id, k, v) {
    if (!this.state[id]) this.state[id] = { on: false, p: id === 'eq' ? {} : defaultParams(FX_BY_ID[id]) };
    this.state[id].p[k] = v;
    if (id === 'speed') { if (this.state.speed.on) this._applySpeed(this.state.speed.p); return; }
    const s = this.slots.get(id);
    if (s && s.mod) { s.mod.set(k, v); if (s.mod.resp) this._headroomSoon(); }
  }

  setBypass(b) { this.bypass = !!b; return this.rebuild(); }

  /** 재생 속도 (재생 화면 · 효과 화면 공용). rate: 50~200(%) */
  setSpeed(rate, keep = true) {
    const p = { rate, keep };
    this.state.speed = { on: rate !== 100 || !keep, p };
    this._applySpeed(this.state.speed.on ? p : null);
  }
  _applySpeed(p) {
    this.speed = p ? { rate: p.rate, keep: p.keep } : { rate: 100, keep: true };
    for (const d of this.decks) this._speedTo(d.a);
  }
  _speedTo(a) {
    const r = this.speed.rate / 100;
    try { a.preservesPitch = this.speed.keep; a.mozPreservesPitch = this.speed.keep; a.webkitPreservesPitch = this.speed.keep; } catch (e) { /* noop */ }
    a.defaultPlaybackRate = r; a.playbackRate = r;
  }

  _pushParams(id) {
    const s = this.slots.get(id), st = this.state[id];
    if (!s || !s.mod || !st) return;
    for (const [k, v] of Object.entries(st.p || {})) s.mod.set(k, v);
  }

  _buildMod(id) {
    try {
      let m;
      if (id === 'eq') m = buildEQ(this.ctx);
      else {
        const def = FX_BY_ID[id];
        if (!def || def.pseudo) return null;
        if (def.build.worklet && !this.workletOK) return null;
        m = def.build(this.ctx, this.opt);
      }
      return m;
    } catch (e) {
      console.warn('effect build failed', id, e);
      this.dispatchEvent(new CustomEvent('fxerror', { detail: id }));
      return null;
    }
  }

  /* ---------- 효과 칸 ---------- */
  _newSlot(id) {
    const ctx = this.ctx, s = { id, in: stereo(ctx), dry: stereo(ctx, 1), wet: stereo(ctx, 0), sum: stereo(ctx), mod: null, on: false, fed: false, timers: [] };
    s.in.connect(s.dry).connect(s.sum); s.wet.connect(s.sum);
    // 순서에 맞는 자리: 앞 칸(없으면 head) → [새 칸] → 뒤 칸(없으면 safety)
    const idx = ORDER.indexOf(id);
    let prev = null, next = null;
    for (const [oid, os] of this.slots) {
      const j = ORDER.indexOf(oid);
      if (j < idx && (!prev || j > ORDER.indexOf(prev.id))) prev = os;
      if (j > idx && (!next || j < ORDER.indexOf(next.id))) next = os;
    }
    const from = prev ? prev.sum : this.head, to = next ? next.in : this.safetyIn;
    try { from.disconnect(to); } catch (e) { /* noop */ }
    from.connect(s.in); s.sum.connect(to);
    this.slots.set(id, s);
    return s;
  }
  /** 새 칸 끼워 넣기: 새 칸은 그대로 통과(dry = 1, 지연 없음)라 연결을 바꿔도 소리가 같다.
      (연결 바꾸기는 다음 오디오 블록에 한꺼번에 반영 — 두 호출 사이 몇 µs 에 블록이 끼어들 확률만 아주 작게 남음.
       예전처럼 소리를 줄였다 올리면 매번 15ms 가 비어 오히려 더 잘 들림) */
  async _spliced(fn) { fn(); }
  _clearTimers(s) { for (const t of s.timers) clearTimeout(t); s.timers = []; }
  async _enable(s) {
    s.on = true;
    this._clearTimers(s);
    if (!s.mod) {
      s.mod = this._buildMod(s.id);
      if (!s.mod) { s.on = false; return false; }
      this._pushParams(s.id);
      s.mod.output.connect(s.wet);
      if (s.id === 'loudness' && s.mod.setListening) s.mod.setListening(this.volume > 0 ? 40 * Math.log10(this.volume) : -60);
    }
    if (!s.fed) { s.in.connect(s.mod.input); s.fed = true; }
    if (s.mod.ready) {
      try { await Promise.race([s.mod.ready, sleep(8000).then(() => { throw new Error('timeout'); })]); }
      catch (e) { console.warn('effect not ready', s.id, e); s.on = false; this.dispatchEvent(new CustomEvent('fxerror', { detail: s.id })); return false; }
      if (!s.on) return false;
    }
    if ((s.mod.latency || 0) > 0.03) { this._fade(s.dry.gain, 0, 0.05); this._fade(s.wet.gain, 1, 0.08, 0.05); }   // 지연이 큰 효과(키 조절): 겹치면 소리가 두 번 들려 잠깐 줄였다가
    else { this._fade(s.dry.gain, 0, XF); this._fade(s.wet.gain, 1, XF); }
    return true;
  }
  _disable(s) {
    s.on = false;
    this._clearTimers(s);
    this._fade(s.wet.gain, 0, XF); this._fade(s.dry.gain, 1, XF);
    const unfeed = () => { if (!s.on && s.fed && s.mod) { try { s.in.disconnect(s.mod.input); } catch (e) { /* noop */ } s.fed = false; } };
    const drop = () => {
      if (s.on || !s.mod) return;
      unfeed();
      try { s.mod.output.disconnect(); } catch (e) { /* noop */ }
      try { if (s.mod.dispose) s.mod.dispose(); } catch (e) { /* noop */ }
      s.mod = null;
    };
    if (!this.running) { drop(); return; }
    s.timers.push(setTimeout(unfeed, XF * 1000 + 200), setTimeout(drop, 20000));
  }
  /** 효과 경로 ↔ 원음 경로 */
  _route(on) {
    if (on === this.procOn) return;
    this.procOn = on;
    if (on && !this.headLinked) { this.mix.connect(this.head); this.headLinked = true; }
    this._fade(this.proc.gain, on ? 1 : 0, XF); this._fade(this.direct.gain, on ? 0 : 1, XF);
    clearTimeout(this._unlinkT);
    if (!on) {
      const unlink = () => { if (!this.procOn && this.headLinked) { try { this.mix.disconnect(this.head); } catch (e) { /* noop */ } this.headLinked = false; } };
      if (this.running) this._unlinkT = setTimeout(unlink, XF * 1000 + 200); else unlink();
    }
  }

  /** 켜진 효과에 맞춰 칸을 켜고 끔 (차례로) */
  rebuild() {
    this._queue = this._queue.then(() => this._reconcile()).catch(e => console.warn(e));
    return this._queue;
  }
  async _reconcile() {
    const isWk = id => id !== 'eq' && !!FX_BY_ID[id].build.worklet;
    const want = liveIds(id => this.isOn(id), this.bypass);
    if (want.some(isWk)) await this.ensureWorklet();
    const missing = want.filter(id => !this.slots.has(id) && !(isWk(id) && !this.workletOK));
    if (missing.length) await this._spliced(() => missing.forEach(id => this._newSlot(id)));
    const jobs = [];
    for (const [id, s] of this.slots) {
      const on = want.includes(id);
      if (on && !s.on) jobs.push(this._enable(s));
      else if (!on && (s.on || s.mod)) { if (s.on) this._disable(s); }
    }
    await Promise.all(jobs);
    const live = ORDER.filter(id => { const s = this.slots.get(id); return s && s.on && s.mod; });
    this._route(live.length > 0);
    this._headroom();
    const sig = live.join('>');
    if (sig !== this._chain) {
      this._chain = sig;
      this.dispatchEvent(new CustomEvent('chain', { detail: live }));
    }
  }

  /* ---------- 자동 여유 음량 (EQ · 음색 효과가 올린 만큼 미리 줄여 찌그러짐 방지) ---------- */
  _headroomSoon() { clearTimeout(this._hrTimer); this._hrTimer = setTimeout(() => this._headroom(), 40); }
  _headroom() {
    this.headroomDb = headroomFor([...this.slots.values()].filter(s => s.on && s.mod).map(s => s.mod));
    this._target(this.head.gain, db(this.headroomDb), 0.08);
  }

  /* ---------- 덱 ---------- */
  load(deck, url) {
    const a = deck.a;
    if (deck.codec && deck.codec.src !== url) { deck.codec.dispose(); deck.codec = null; }
    a.src = url;
    this._speedTo(a);
    a.load();
  }
  unload(deck) {
    const a = deck.a;
    if (deck.codec) { deck.codec.dispose(); deck.codec = null; }   // 코덱 엔진(FFmpeg)으로 풀던 곡
    a.pause();
    a.removeAttribute('src');
    try { a.load(); } catch (e) { /* noop */ }
    deck.track = null;
  }
  swap() { this.active = 1 - this.active; }

  /** 크로스페이드: from → to 를 dur 초 동안 */
  crossfade(from, to, dur) {
    const ctx = this.ctx, t = ctx.currentTime + 0.01, n = 64;
    const up = new Float32Array(n), down = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1); up[i] = Math.sin(x * Math.PI / 2); down[i] = Math.cos(x * Math.PI / 2); }
    from.g.gain.cancelScheduledValues(0); to.g.gain.cancelScheduledValues(0);
    to.g.gain.value = 0;
    to.g.gain.setValueCurveAtTime(up, t, dur);
    from.g.gain.setValueCurveAtTime(down, t, dur);
  }
  resetGain(deck, v = 1) {
    const p = deck.g.gain;
    p.cancelScheduledValues(0);
    p.value = v;
  }

  /* ---------- 수면 타이머 페이드 ---------- */
  fadeOutSleep(sec) {
    const t = this.ctx.currentTime, p = this.sleepGain.gain;
    p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(0.0001, t + sec);
  }
  restoreSleep() {
    const t = this.ctx.currentTime, p = this.sleepGain.gain;
    p.cancelScheduledValues(t); p.setValueAtTime(1, t);
  }
}
