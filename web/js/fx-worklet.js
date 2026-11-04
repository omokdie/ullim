/*
 * 울림 (Ullim) — AudioWorklet DSP processors
 * 1.3.0 부터 효과 대부분은 브라우저 기본 노드(effects.js)로 처리하고, 여기에는 기본 노드로 만들 수 없는 둘만 남김:
 *  - 볼륨 평준화(느린 자동 이득 — RMS 를 몇 초에 걸쳐 재서 조금씩 올리고 내림)
 *  - 초저음 생성(옥타브 아래 — 파형이 지날 때마다 뒤집는 분주기)
 * process() 안에서는 새 객체를 만들지 않는다(쓰레기 수거가 오디오 스레드를 멈추지 않게).
 */
const TAU = Math.PI * 2;

/* ---------- shared helpers ---------- */
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q, gainDb) {
    const sr = sampleRate;
    f = Math.min(Math.max(f, 5), sr * 0.49);
    const w = TAU * f / sr, cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * (q || 0.7071));
    const A = Math.pow(10, (gainDb || 0) / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lp': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'hp': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'bp': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'peak': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
      case 'ls': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
        a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
      }
      case 'hs': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
        a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
      }
      default: b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = this.z2 = 0; }
}

function pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

/** Smoothed parameter (one-pole, ~15 ms). */
class Smooth {
  constructor(v, ms = 15) { this.v = v; this.t = v; this.k = 1 - Math.exp(-1 / (sampleRate * ms / 1000)); }
  target(t) { this.t = t; }
  next() { this.v += (this.t - this.v) * this.k; return this.v; }
}

/** Base processor: handles silent/missing input and gives L/R views. */
class Fx extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = e => { if (e && e.data === 'stop') this.stopped = true; };   // 효과를 끄면 멈춤 (false 를 돌려줘야 처리 목록에서 빠짐)
  }
  process(inputs, outputs, params) {
    if (this.stopped) return false;
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const inp = inputs[0];
    if (!inp || inp.length === 0) {
      // keep tails alive for time-based effects
      if (this.tail) {
        if (Fx.ZERO.length < oL.length) Fx.ZERO = new Float32Array(oL.length);
        this.render(Fx.ZERO, Fx.ZERO, oL, oR, params, oL.length);
      }
      else { oL.fill(0); if (oR !== oL) oR.fill(0); }
      return true;
    }
    const iL = inp[0], iR = inp[1] || inp[0];
    this.render(iL, iR, oL, oR, params, oL.length);
    return true;
  }
}
Fx.ZERO = new Float32Array(128);

const P = (name, def, min, max) => ({ name, defaultValue: def, minValue: min, maxValue: max, automationRate: 'k-rate' });

/* ---------- 6. Sub-harmonic synthesizer (octave down) ---------- */
class SubHarmFx extends Fx {
  static get parameterDescriptors() { return [P('amount', 0.4, 0, 1), P('cutoff', 90, 40, 160)]; }
  constructor() {
    super(); this.c = -1; this.env = 0; this.state = 0; this.flip = 1; this.amt = new Smooth(0.4);
    this.l1 = new Biquad(); this.l2 = new Biquad(); this.s1 = new Biquad(); this.s2 = new Biquad();
    this.atk = 1 - Math.exp(-1 / (sampleRate * 0.004)); this.rel = 1 - Math.exp(-1 / (sampleRate * 0.08));
  }
  render(iL, iR, oL, oR, p, n) {
    const c = p.cutoff[0];
    if (c !== this.c) { this.c = c; this.l1.set('lp', c, 0.707); this.l2.set('lp', c, 0.707); this.s1.set('lp', c * 0.55, 0.707); this.s2.set('lp', c * 0.55, 0.707); }
    this.amt.target(p.amount[0]);
    let env = this.env, state = this.state, flip = this.flip;
    const { l1, l2, s1, s2, atk, rel } = this;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i];
      const low = l2.run(l1.run((l + r) * 0.5));
      const a = low < 0 ? -low : low;
      env += (a - env) * (a > env ? atk : rel);
      const th = env * 0.15 + 1e-5;
      if (state === 0 && low > th) { state = 1; flip = -flip; } else if (state === 1 && low < -th) { state = 0; }
      const sub = s2.run(s1.run(flip * env)) * this.amt.next() * 1.2;
      oL[i] = l + sub; oR[i] = r + sub;
    }
    this.env = env; this.state = state; this.flip = flip;
  }
}
registerProcessor('ul-subharm', SubHarmFx);

/* ---------- 7. Volume leveler (slow AGC) ---------- */
class LevelerFx extends Fx {
  static get parameterDescriptors() { return [P('target', -16, -30, -6), P('maxgain', 12, 0, 24), P('speed', 1, 0, 2)]; }
  constructor() { super(); this.pow = 0; this.gdb = 0; this.g = 1; }
  render(iL, iR, oL, oR, p, n) {
    const speed = Math.round(p.speed[0]);
    const tau = [5, 2, 0.7][speed] || 2;
    const aPow = 1 - Math.exp(-1 / (sampleRate * tau));
    let pow = this.pow;
    for (let i = 0; i < n; i++) { const l = iL[i], r = iR[i]; pow += ((l * l + r * r) * 0.5 - pow) * aPow; }
    this.pow = pow;
    const lvl = 10 * Math.log10(pow + 1e-12);
    const dt = n / sampleRate;
    if (lvl > -55) {
      const desired = Math.max(-12, Math.min(p.maxgain[0], p.target[0] - lvl));
      const up = [2, 4, 9][speed] || 4, down = 24;
      if (desired > this.gdb) this.gdb = Math.min(desired, this.gdb + up * dt);
      else this.gdb = Math.max(desired, this.gdb - down * dt);
    }
    const g0 = this.g, g1 = Math.pow(10, this.gdb / 20);
    for (let i = 0; i < n; i++) { const g = g0 + (g1 - g0) * (i + 1) / n; oL[i] = iL[i] * g; oR[i] = iR[i] * g; }
    this.g = g1;
  }
}
registerProcessor('ul-leveler', LevelerFx);

