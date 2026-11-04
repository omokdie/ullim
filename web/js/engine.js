/* 울림 — 오디오 엔진: 두 개의 덱(크로스페이드용) → 효과 체인 → 볼륨 → 출력 */
import { FX_BY_ID, ORDER, buildEQ, defaultParams } from './effects.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Engine extends EventTarget {
  constructor() {
    super();
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'playback' });
    const ctx = this.ctx;
    this.mix = ctx.createGain();
    this.mix.channelCount = 2; this.mix.channelCountMode = 'explicit'; this.mix.channelInterpretation = 'speakers';
    this.switcher = ctx.createGain();
    this.master = ctx.createGain();
    this.sleepGain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096; this.analyser.smoothingTimeConstant = 0.72;
    this.analyser.minDecibels = -90; this.analyser.maxDecibels = -12;
    this.switcher.connect(this.master).connect(this.sleepGain).connect(ctx.destination);
    this.tap = false;                                    // 분석기는 비주얼라이저가 그릴 때만 연결 (setTap)
    this.mix.connect(this.switcher);

    this.decks = [this._deck(), this._deck()];
    this.active = 0;

    this.state = {};      // id → { on, p }
    this.mods = {};       // id → built module
    this.bypass = false;
    this.speed = { rate: 100, keep: true };
    this._chain = '';
    this._queue = Promise.resolve();
    // 효과용 AudioWorklet 은 그 효과를 처음 켤 때 불러온다 (안 쓰면 JS 실행 환경 하나 · 스레드 전환이 없어 메모리 · 배터리 절약)
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

  _deck() {
    const a = new Audio();
    a.preload = 'auto';
    const src = this.ctx.createMediaElementSource(a);
    const g = this.ctx.createGain();
    src.connect(g).connect(this.mix);
    return { a, src, g, track: null };
  }
  /** 비주얼라이저가 그리는 동안만 분석기에 소리를 넣음 (안 그릴 때 · 백그라운드에서 계산 줄이기) */
  setTap(on) {
    if (this.tap === !!on) return;
    this.tap = !!on;
    try { if (on) this.switcher.connect(this.analyser); else this.switcher.disconnect(this.analyser); } catch (e) { /* noop */ }
  }
  get deck() { return this.decks[this.active]; }
  get other() { return this.decks[1 - this.active]; }

  resume() { if (this.ctx.state !== 'running') return this.ctx.resume().catch(() => {}); return Promise.resolve(); }

  /* ---------- 볼륨 ---------- */
  setVolume(v, muted) {
    const g = muted ? 0 : v * v;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }

  /* ---------- 효과 상태 ---------- */
  isOn(id) { return !!(this.state[id] && this.state[id].on); }

  /** 전체 상태 적용 (프리셋, 시작 시) */
  async applyAll(fxState, eqState, bypass) {
    this.bypass = !!bypass;
    for (const id of ORDER) {
      if (id === 'eq') {
        this.state.eq = { on: !!eqState.on, p: eqState.p };
      } else {
        const def = FX_BY_ID[id];
        const s = fxState[id] || { on: false, p: defaultParams(def) };
        this.state[id] = { on: !!s.on, p: { ...defaultParams(def), ...s.p } };
      }
    }
    const sp = fxState.speed;
    this._applySpeed(sp && sp.on ? { ...defaultParams(FX_BY_ID.speed), ...sp.p } : null);
    for (const id of Object.keys(this.mods)) this._pushParams(id);
    return this.rebuild();
  }

  setEnabled(id, on) {
    if (id === 'speed') { this.state.speed = { on, p: (this.state.speed && this.state.speed.p) || defaultParams(FX_BY_ID.speed) }; this._applySpeed(on ? this.state.speed.p : null); return Promise.resolve(); }
    if (!this.state[id]) this.state[id] = { on, p: id === 'eq' ? {} : defaultParams(FX_BY_ID[id]) };
    this.state[id].on = on;
    return this.rebuild();
  }

  setParam(id, k, v) {
    if (!this.state[id]) this.state[id] = { on: false, p: id === 'eq' ? {} : defaultParams(FX_BY_ID[id]) };
    this.state[id].p[k] = v;
    if (id === 'speed') { if (this.state.speed.on) this._applySpeed(this.state.speed.p); return; }
    const m = this.mods[id];
    if (m) m.set(k, v);
  }

  setBypass(b) { this.bypass = b; return this.rebuild(); }

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
    const m = this.mods[id], s = this.state[id];
    if (!m || !s) return;
    for (const [k, v] of Object.entries(s.p)) m.set(k, v);
  }

  _build(id) {
    if (this.mods[id]) return this.mods[id];
    try {
      let m;
      if (id === 'eq') m = buildEQ(this.ctx);
      else {
        const def = FX_BY_ID[id];
        if (!def || def.pseudo) return null;
        if (def.build.worklet && !this.workletOK) return null;
        m = def.build(this.ctx);
      }
      this.mods[id] = m;
      this._pushParams(id);
      return m;
    } catch (e) {
      console.warn('effect build failed', id, e);
      this.dispatchEvent(new CustomEvent('fxerror', { detail: id }));
      return null;
    }
  }

  /** 켜진 효과만 순서대로 다시 연결. 짧게 페이드해서 '틱' 소리를 막는다. */
  rebuild() {
    this._queue = this._queue.then(() => this._rebuildNow()).catch(e => console.warn(e));
    return this._queue;
  }
  async _rebuildNow() {
    const ids = this.bypass ? [] : ORDER.filter(id => this.isOn(id));
    const ctx = this.ctx, g = this.switcher.gain, running = ctx.state === 'running';
    let faded = false;
    const fadeOut = async () => {
      if (faded || !running) return;
      const t = ctx.currentTime;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + 0.015);
      faded = true;
      await sleep(30);
    };
    if (!this._wl && ids.some(id => FX_BY_ID[id] && FX_BY_ID[id].build && FX_BY_ID[id].build.worklet)) {
      await fadeOut();                                   // 처음 불러올 때 오디오 스레드가 바뀌므로 소리를 줄여 둔 채로
      await this.ensureWorklet();
    } else if (this._wl) await this._wl;
    const chain = ids.map(id => this._build(id) ? id : '').filter(Boolean);
    const sig = chain.join('>');
    if (sig !== this._chain) {
      await fadeOut();
      this.mix.disconnect();
      for (const id of Object.keys(this.mods)) { try { this.mods[id].output.disconnect(); } catch (e) { /* noop */ } }
      let node = this.mix;
      for (const id of chain) { node.connect(this.mods[id].input); node = this.mods[id].output; }
      node.connect(this.switcher);
      this._chain = sig;
      this.dispatchEvent(new CustomEvent('chain', { detail: chain }));
    }
    if (faded || !running) {
      const t = ctx.currentTime;
      g.cancelScheduledValues(t); g.setValueAtTime(running ? 0 : 1, t); g.linearRampToValueAtTime(1, t + 0.03);
    }
    // 꺼진 효과는 버림: 연결을 끊어도 워클릿 처리기는 계속 돌고(배터리) 리버브 등은 큰 버퍼를 들고 있으므로
    for (const id of Object.keys(this.mods)) if (!chain.includes(id)) this._dispose(id);
  }
  _dispose(id) {
    const m = this.mods[id];
    delete this.mods[id];
    if (!m) return;
    try { m.input.disconnect(); } catch (e) { /* noop */ }
    try { m.output.disconnect(); } catch (e) { /* noop */ }
    try { if (m.dispose) m.dispose(); } catch (e) { /* noop */ }
  }

  /* ---------- 덱 ---------- */
  load(deck, url) {
    const a = deck.a;
    a.src = url;
    this._speedTo(a);
    a.load();
  }
  unload(deck) {
    const a = deck.a;
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
