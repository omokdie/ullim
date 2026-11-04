/*
 * 울림 (Ullim) — AudioWorklet DSP processors
 * All algorithms here are written from public descriptions of free / public-domain
 * techniques (RBJ biquad cookbook, Freeverb by Jezar (public domain), bs2b crossfeed
 * formulas (MIT), classic delay-line pitch shifting, etc.). No third-party code copied.
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

/** Ring-buffer delay line with fractional (cubic Hermite) reads. */
class DelayLine {
  constructor(maxSamples) { this.size = pow2(Math.max(8, Math.ceil(maxSamples) + 8)); this.mask = this.size - 1; this.buf = new Float32Array(this.size); this.w = 0; }
  push(x) { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }
  /** read sample written `d` samples ago (d >= 1) */
  read(d) {
    const buf = this.buf, m = this.mask;
    const pos = this.w - d;
    const i = Math.floor(pos), f = pos - i;
    const y0 = buf[(i - 1) & m], y1 = buf[i & m], y2 = buf[(i + 1) & m], y3 = buf[(i + 2) & m];
    const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }
  readInt(d) { return this.buf[(this.w - d) & this.mask]; }
  clear() { this.buf.fill(0); }
}

/** Smoothed parameter (one-pole, ~15 ms). */
class Smooth {
  constructor(v, ms = 15) { this.v = v; this.t = v; this.k = 1 - Math.exp(-1 / (sampleRate * ms / 1000)); }
  target(t) { this.t = t; }
  next() { this.v += (this.t - this.v) * this.k; return this.v; }
}

/* Fast xorshift PRNG — returns [0,1) */
class Rng {
  constructor(seed = 0x9e3779b9) { this.s = seed >>> 0 || 1; }
  next() { let x = this.s; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.s = x; return x / 4294967296; }
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

/* ---------- 1. Headphone crossfeed (bs2b formulas) ---------- */
class CrossfeedFx extends Fx {
  static get parameterDescriptors() { return [P('fcut', 700, 300, 2000), P('feed', 4.5, 1, 15)]; }
  constructor() { super(); this.loL = this.loR = this.hiL = this.hiR = this.asL = this.asR = 0; this.pf = -1; this.pd = -1; }
  coeffs(fc, feed) {
    const GB_lo = feed * -5 / 6 - 3, GB_hi = feed / 6 - 3;
    const G_lo = Math.pow(10, GB_lo / 20), G_hi = 1 - Math.pow(10, GB_hi / 20);
    const Fc_hi = fc * Math.pow(2, (GB_lo - 20 * Math.log10(G_hi)) / 12);
    const gain = 1 / (1 - G_hi + G_lo);
    let x = Math.exp(-TAU * fc / sampleRate);
    this.b1_lo = x; this.a0_lo = G_lo * (1 - x) * gain;
    x = Math.exp(-TAU * Math.min(Fc_hi, sampleRate * 0.45) / sampleRate);
    this.b1_hi = x; this.a0_hi = (1 - G_hi * (1 - x)) * gain; this.a1_hi = -x * gain;
    this.pf = fc; this.pd = feed;
  }
  render(iL, iR, oL, oR, p, n) {
    const fc = p.fcut[0], feed = p.feed[0];
    if (fc !== this.pf || feed !== this.pd) this.coeffs(fc, feed);
    let { loL, loR, hiL, hiR, asL, asR } = this;
    const a0l = this.a0_lo, b1l = this.b1_lo, a0h = this.a0_hi, a1h = this.a1_hi, b1h = this.b1_hi;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i];
      loL = a0l * l + b1l * loL; loR = a0l * r + b1l * loR;
      hiL = a0h * l + a1h * asL + b1h * hiL; hiR = a0h * r + a1h * asR + b1h * hiR;
      asL = l; asR = r;
      oL[i] = hiL + loR; oR[i] = hiR + loL;
    }
    Object.assign(this, { loL, loR, hiL, hiR, asL, asR });
  }
}
registerProcessor('ul-crossfeed', CrossfeedFx);

/* ---------- 2. 3D surround (mid/side ambience) ---------- */
class SurroundFx extends Fx {
  static get parameterDescriptors() { return [P('depth', 0.6, 0, 1), P('delay', 16, 4, 40)]; }
  constructor() {
    super(); this.tail = true;
    this.dl = new DelayLine(sampleRate * 0.05);
    this.hp = new Biquad().set('hp', 160, 0.707); this.lp = new Biquad().set('lp', 5200, 0.707);
    this.lp2 = new Biquad().set('lp', 5200, 0.707);
    this.dep = new Smooth(0.6);
  }
  render(iL, iR, oL, oR, p, n) {
    this.dep.target(p.depth[0]);
    const d = p.delay[0] * sampleRate / 1000;
    const dl = this.dl, hp = this.hp, lp = this.lp, lp2 = this.lp2;
    for (let i = 0; i < n; i++) {
      const dep = this.dep.next();
      const l = iL[i], r = iR[i];
      const M = (l + r) * 0.5, S = (l - r) * 0.5;
      dl.push(hp.run(S));
      const amb = lp2.run(lp.run(dl.read(d)));
      const Sx = S * (1 + dep * 0.9) + amb * dep * 0.85;
      const norm = 1 / (1 + dep * 0.3);
      oL[i] = (M + Sx) * norm; oR[i] = (M - Sx) * norm;
    }
  }
}
registerProcessor('ul-surround', SurroundFx);

/* ---------- 3. Crystalizer (sample-difference sharpening) ---------- */
class CrystalFx extends Fx {
  static get parameterDescriptors() { return [P('intensity', 1.2, 0, 4)]; }
  constructor() { super(); this.pl = 0; this.pr = 0; this.k = new Smooth(1.2); }
  render(iL, iR, oL, oR, p, n) {
    this.k.target(p.intensity[0]);
    let pl = this.pl, pr = this.pr;
    for (let i = 0; i < n; i++) {
      const k = this.k.next();
      const l = iL[i], r = iR[i];
      oL[i] = softClip(l + k * (l - pl)); oR[i] = softClip(r + k * (r - pr));
      pl = l; pr = r;
    }
    this.pl = pl; this.pr = pr;
  }
}
function softClip(x) {
  const a = x < 0 ? -x : x;
  if (a <= 0.9) return x;
  const y = 0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1);
  return x < 0 ? -y : y;
}
registerProcessor('ul-crystal', CrystalFx);

/* ---------- 4. Harmonic exciter ---------- */
class ExciterFx extends Fx {
  static get parameterDescriptors() { return [P('amount', 0.4, 0, 1), P('freq', 3500, 1000, 10000)]; }
  constructor() {
    super(); this.f = -1;
    this.h1 = [new Biquad(), new Biquad()]; this.h2 = [new Biquad(), new Biquad()];
    this.amt = new Smooth(0.4);
  }
  render(iL, iR, oL, oR, p, n) {
    const f = p.freq[0];
    if (f !== this.f) { this.f = f; for (const b of this.h1) b.set('hp', f, 0.707); for (const b of this.h2) b.set('hp', f, 0.707); }
    this.amt.target(p.amount[0]);
    const [aL, aR] = this.h1, [bL, bR] = this.h2;
    for (let i = 0; i < n; i++) {
      const amt = this.amt.next() * 1.4;
      const l = iL[i], r = iR[i];
      let hl = Math.tanh(aL.run(l) * 10), hr = Math.tanh(aR.run(r) * 10);
      hl = bL.run(hl + 0.3 * hl * hl) * 0.09; hr = bR.run(hr + 0.3 * hr * hr) * 0.09;
      oL[i] = l + amt * hl; oR[i] = r + amt * hr;
    }
  }
}
registerProcessor('ul-exciter', ExciterFx);

/* ---------- 5. Virtual bass (psychoacoustic harmonics) ---------- */
class VBassFx extends Fx {
  static get parameterDescriptors() { return [P('amount', 0.5, 0, 1), P('cutoff', 110, 50, 250)]; }
  constructor() {
    super(); this.c = -1; this.amt = new Smooth(0.5);
    this.l1 = new Biquad(); this.l2 = new Biquad(); this.h1 = new Biquad(); this.h2 = new Biquad(); this.l3 = new Biquad();
  }
  render(iL, iR, oL, oR, p, n) {
    const c = p.cutoff[0];
    if (c !== this.c) { this.c = c; this.l1.set('lp', c, 0.707); this.l2.set('lp', c, 0.707); this.h1.set('hp', c * 1.1, 0.707); this.h2.set('hp', c * 1.1, 0.707); this.l3.set('lp', c * 4.5, 0.707); }
    this.amt.target(p.amount[0]);
    const { l1, l2, h1, h2, l3 } = this;
    for (let i = 0; i < n; i++) {
      const amt = this.amt.next();
      const l = iL[i], r = iR[i];
      const low = l2.run(l1.run((l + r) * 0.5));
      const nl = Math.abs(low) + 0.5 * Math.tanh(low * 3) / 3;   // even + odd harmonics
      const h = l3.run(h2.run(h1.run(nl))) * amt * 3.2;
      oL[i] = l + h; oR[i] = r + h;
    }
  }
}
registerProcessor('ul-vbass', VBassFx);

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

/* ---------- 8. Vocal remover (karaoke) ---------- */
class KaraokeFx extends Fx {
  static get parameterDescriptors() { return [P('strength', 1, 0, 1), P('low', 140, 60, 400), P('high', 9000, 3000, 15000)]; }
  constructor() { super(); this.lo = -1; this.hi = -1; this.s = new Smooth(1); this.l1 = new Biquad(); this.l2 = new Biquad(); this.h1 = new Biquad(); this.h2 = new Biquad(); }
  render(iL, iR, oL, oR, p, n) {
    if (p.low[0] !== this.lo) { this.lo = p.low[0]; this.l1.set('lp', this.lo, 0.707); this.l2.set('lp', this.lo, 0.707); }
    if (p.high[0] !== this.hi) { this.hi = p.high[0]; this.h1.set('hp', this.hi, 0.707); this.h2.set('hp', this.hi, 0.707); }
    this.s.target(p.strength[0]);
    const { l1, l2, h1, h2 } = this;
    for (let i = 0; i < n; i++) {
      const st = this.s.next();
      const l = iL[i], r = iR[i];
      const M = (l + r) * 0.5, S = (l - r) * 0.5;
      const keep = l2.run(l1.run(M)) + 0.7 * h2.run(h1.run(M));
      const kl = S + keep, kr = -S + keep;
      oL[i] = l + st * (kl - l); oR[i] = r + st * (kr - r);
    }
  }
}
registerProcessor('ul-karaoke', KaraokeFx);

/* ---------- 9. Vocal enhancer ---------- */
class VocalFx extends Fx {
  static get parameterDescriptors() { return [P('amount', 0.6, 0, 1)]; }
  constructor() { super(); this.a = -1; this.p1 = new Biquad(); this.p2 = new Biquad(); this.hp = new Biquad().set('hp', 90, 0.707); }
  render(iL, iR, oL, oR, p, n) {
    const a = p.amount[0];
    if (a !== this.a) { this.a = a; this.p1.set('peak', 1800, 0.6, a * 8); this.p2.set('peak', 3600, 1.0, a * 4); }
    const sideG = 1 - 0.35 * a, norm = 1 / (1 + a * 0.35);
    const { p1, p2 } = this;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i];
      const M = p2.run(p1.run((l + r) * 0.5)), S = (l - r) * 0.5 * sideG;
      oL[i] = (M + S) * norm; oR[i] = (M - S) * norm;
    }
  }
}
registerProcessor('ul-vocal', VocalFx);

/* ---------- 10. Chorus (2 voices per side) ---------- */
class ChorusFx extends Fx {
  static get parameterDescriptors() { return [P('rate', 0.8, 0.05, 5), P('depth', 0.5, 0, 1), P('mix', 0.5, 0, 1)]; }
  constructor() { super(); this.tail = true; this.dL = new DelayLine(sampleRate * 0.06); this.dR = new DelayLine(sampleRate * 0.06); this.ph = 0; this.mix = new Smooth(0.5); this.dep = new Smooth(0.5); }
  render(iL, iR, oL, oR, p, n) {
    const inc = TAU * p.rate[0] / sampleRate;
    this.mix.target(p.mix[0]); this.dep.target(p.depth[0]);
    const base = 0.016 * sampleRate;
    const c1 = Math.cos(2.1), s1 = Math.sin(2.1), c2 = Math.cos(1.57), s2 = Math.sin(1.57), c3 = Math.cos(3.67), s3 = Math.sin(3.67);
    let ph = this.ph;
    const { dL, dR } = this;
    for (let i = 0; i < n; i++) {
      const mix = this.mix.next(), dep = this.dep.next() * 0.007 * sampleRate;
      const s = Math.sin(ph), c = Math.cos(ph);
      const l = iL[i], r = iR[i];
      dL.push(l); dR.push(r);
      const wl = 0.5 * (dL.read(base + dep * (1 + s)) + dL.read(base * 1.37 + dep * (1 + s * c1 + c * s1)));
      const wr = 0.5 * (dR.read(base + dep * (1 + s * c2 + c * s2)) + dR.read(base * 1.37 + dep * (1 + s * c3 + c * s3)));
      oL[i] = l * (1 - 0.5 * mix) + wl * mix * 0.8;
      oR[i] = r * (1 - 0.5 * mix) + wr * mix * 0.8;
      ph += inc; if (ph > TAU) ph -= TAU;
    }
    this.ph = ph;
  }
}
registerProcessor('ul-chorus', ChorusFx);

/* ---------- 11. Flanger ---------- */
class FlangerFx extends Fx {
  static get parameterDescriptors() { return [P('rate', 0.25, 0.02, 3), P('depth', 0.7, 0, 1), P('feedback', 0.5, -0.95, 0.95), P('mix', 0.8, 0, 1)]; }
  constructor() { super(); this.tail = true; this.dL = new DelayLine(sampleRate * 0.02); this.dR = new DelayLine(sampleRate * 0.02); this.ph = 0; this.yl = 0; this.yr = 0; }
  render(iL, iR, oL, oR, p, n) {
    const inc = TAU * p.rate[0] / sampleRate, depth = p.depth[0], fb = p.feedback[0], mix = p.mix[0];
    const min = 0.0006 * sampleRate, span = depth * 0.0045 * sampleRate;
    let ph = this.ph, yl = this.yl, yr = this.yr;
    const { dL, dR } = this;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i];
      dL.push(l + fb * yl); dR.push(r + fb * yr);
      yl = dL.read(min + span * (0.5 + 0.5 * Math.sin(ph)));
      yr = dR.read(min + span * (0.5 + 0.5 * Math.cos(ph)));
      oL[i] = (1 - mix) * l + mix * 0.5 * (l + yl);
      oR[i] = (1 - mix) * r + mix * 0.5 * (r + yr);
      ph += inc; if (ph > TAU) ph -= TAU;
    }
    this.ph = ph; this.yl = yl; this.yr = yr;
  }
}
registerProcessor('ul-flanger', FlangerFx);

/* ---------- 12. Phaser (6 all-pass stages) ---------- */
class PhaserFx extends Fx {
  static get parameterDescriptors() { return [P('rate', 0.4, 0.02, 5), P('depth', 0.7, 0, 1), P('feedback', 0.4, 0, 0.9), P('mix', 1, 0, 1)]; }
  constructor() { super(); this.ph = 0; this.zL = new Float64Array(6); this.zR = new Float64Array(6); this.yl = 0; this.yr = 0; this.aL = 0; this.aR = 0; }
  coef(f) { const t = Math.tan(Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate); return (t - 1) / (t + 1); }
  render(iL, iR, oL, oR, p, n) {
    const inc = TAU * p.rate[0] / sampleRate, depth = p.depth[0], fb = p.feedback[0], mix = p.mix[0];
    const fmin = 180, ratio = Math.pow(2, 1 + depth * 4.2);
    let ph = this.ph, yl = this.yl, yr = this.yr, aL = this.aL, aR = this.aR;
    const zL = this.zL, zR = this.zR;
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) {
        aL = this.coef(fmin * Math.pow(ratio, 0.5 + 0.5 * Math.sin(ph)));
        aR = this.coef(fmin * Math.pow(ratio, 0.5 + 0.5 * Math.sin(ph + 1.2)));
      }
      const l = iL[i], r = iR[i];
      let xl = l + fb * yl, xr = r + fb * yr;
      for (let k = 0; k < 6; k++) {
        const y1 = aL * xl + zL[k]; zL[k] = xl - aL * y1; xl = y1;
        const y2 = aR * xr + zR[k]; zR[k] = xr - aR * y2; xr = y2;
      }
      yl = xl; yr = xr;
      oL[i] = (1 - mix) * l + mix * 0.5 * (l + yl);
      oR[i] = (1 - mix) * r + mix * 0.5 * (r + yr);
      ph += inc; if (ph > TAU) ph -= TAU;
    }
    this.ph = ph; this.yl = yl; this.yr = yr; this.aL = aL; this.aR = aR;
  }
}
registerProcessor('ul-phaser', PhaserFx);

/* ---------- 13. Tremolo ---------- */
class TremoloFx extends Fx {
  static get parameterDescriptors() { return [P('rate', 5, 0.5, 15), P('depth', 0.5, 0, 1)]; }
  constructor() { super(); this.ph = 0; this.dep = new Smooth(0.5); }
  render(iL, iR, oL, oR, p, n) {
    const inc = TAU * p.rate[0] / sampleRate; this.dep.target(p.depth[0]);
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      const g = 1 - this.dep.next() * (0.5 - 0.5 * Math.cos(ph));
      oL[i] = iL[i] * g; oR[i] = iR[i] * g;
      ph += inc; if (ph > TAU) ph -= TAU;
    }
    this.ph = ph;
  }
}
registerProcessor('ul-tremolo', TremoloFx);

/* ---------- 14. Vibrato ---------- */
class VibratoFx extends Fx {
  static get parameterDescriptors() { return [P('rate', 5, 0.5, 12), P('depth', 0.3, 0, 1)]; }
  constructor() { super(); this.tail = true; this.dL = new DelayLine(sampleRate * 0.02); this.dR = new DelayLine(sampleRate * 0.02); this.ph = 0; this.dep = new Smooth(0.3); }
  render(iL, iR, oL, oR, p, n) {
    const inc = TAU * p.rate[0] / sampleRate; this.dep.target(p.depth[0]);
    const base = 0.005 * sampleRate;
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      this.dL.push(iL[i]); this.dR.push(iR[i]);
      const d = base + this.dep.next() * 0.0035 * sampleRate * Math.sin(ph);
      oL[i] = this.dL.read(d); oR[i] = this.dR.read(d);
      ph += inc; if (ph > TAU) ph -= TAU;
    }
    this.ph = ph;
  }
}
registerProcessor('ul-vibrato', VibratoFx);

/* ---------- 15. Auto-pan ---------- */
class AutoPanFx extends Fx {
  static get parameterDescriptors() { return [P('rate', 0.3, 0.02, 5), P('depth', 0.8, 0, 1)]; }
  constructor() { super(); this.ph = 0; this.dep = new Smooth(0.8); }
  render(iL, iR, oL, oR, p, n) {
    const inc = TAU * p.rate[0] / sampleRate; this.dep.target(p.depth[0]);
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      const th = (this.dep.next() * Math.sin(ph) + 1) * Math.PI / 4;
      oL[i] = iL[i] * Math.min(1, Math.cos(th) * Math.SQRT2); oR[i] = iR[i] * Math.min(1, Math.sin(th) * Math.SQRT2);
      ph += inc; if (ph > TAU) ph -= TAU;
    }
    this.ph = ph;
  }
}
registerProcessor('ul-autopan', AutoPanFx);

/* ---------- 16. Rotary speaker ---------- */
class RotaryFx extends Fx {
  static get parameterDescriptors() { return [P('speed', 1, 0, 1), P('mix', 1, 0, 1)]; }
  constructor() {
    super(); this.tail = true;
    this.lp1 = new Biquad().set('lp', 800, 0.707); this.lp2 = new Biquad().set('lp', 800, 0.707);
    this.hp1 = new Biquad().set('hp', 800, 0.707); this.hp2 = new Biquad().set('hp', 800, 0.707);
    this.dl = new DelayLine(sampleRate * 0.01);
    this.hr = 6.7; this.dr = 5.8; this.ph = 0; this.pd = 0;
    this.ah = 1 - Math.exp(-1 / (sampleRate * 0.7)); this.ad = 1 - Math.exp(-1 / (sampleRate * 2.5));
  }
  render(iL, iR, oL, oR, p, n) {
    const fast = p.speed[0] > 0.5, mix = p.mix[0];
    const th = fast ? 6.7 : 0.8, td = fast ? 5.8 : 0.66;
    let ph = this.ph, pd = this.pd, hr = this.hr, dr = this.dr;
    const base = 0.0015 * sampleRate, dep = 0.00035 * sampleRate;
    for (let i = 0; i < n; i++) {
      hr += (th - hr) * this.ah; dr += (td - dr) * this.ad;
      const l = iL[i], r = iR[i], m = (l + r) * 0.5;
      const lo = this.lp2.run(this.lp1.run(m)), hi = this.hp2.run(this.hp1.run(m));
      this.dl.push(hi);
      const sh = Math.sin(ph), ch = Math.cos(ph), sd = Math.sin(pd), cd = Math.cos(pd);
      const h = this.dl.read(base + dep * sh) * (1 - 0.35 * (0.5 - 0.5 * ch));
      const d = lo * (1 - 0.2 * (0.5 - 0.5 * cd));
      const wl = (h * (0.6 + 0.4 * sh) + d * (0.8 + 0.2 * sd)) * 1.3;
      const wr = (h * (0.6 - 0.4 * sh) + d * (0.8 - 0.2 * sd)) * 1.3;
      oL[i] = (1 - mix) * l + mix * wl; oR[i] = (1 - mix) * r + mix * wr;
      ph += TAU * hr / sampleRate; if (ph > TAU) ph -= TAU;
      pd += TAU * dr / sampleRate; if (pd > TAU) pd -= TAU;
    }
    Object.assign(this, { ph, pd, hr, dr });
  }
}
registerProcessor('ul-rotary', RotaryFx);

/* ---------- 17. Pitch shifter: two Hann-crossfaded delay taps, each new grain
 *  phase-aligned to the other tap by a short cross-correlation search (SOLA-style),
 *  which removes most of the warble of the plain two-tap design. ---------- */
class PitchFx extends Fx {
  static get parameterDescriptors() { return [P('semitones', 0, -12, 12), P('window', 60, 30, 120)]; }
  constructor() {
    super(); this.tail = true;
    const sr = sampleRate;
    this.dL = new DelayLine(sr * 0.4); this.dR = new DelayLine(sr * 0.4); this.dM = new DelayLine(sr * 0.4);
    this.S = Math.round(0.008 * sr); this.L = Math.round(0.010 * sr);
    this.p = 0; this.o1 = 0; this.o2 = 0; this.pp2 = 0.5;
  }
  /** offset δ∈[-S,S] so the grain starting at delay dNew+δ lines up with the grain playing at dRef */
  align(dRef, dNew) {
    const m = this.dM, buf = m.buf, mask = m.mask, w = m.w, S = this.S, L = this.L;
    const a0 = w - Math.round(dRef);
    let ea = 0;
    for (let j = 0; j < L; j += 2) { const a = buf[(a0 + j) & mask]; ea += a * a; }
    if (ea < 1e-9) return 0;
    let best = 0, bestScore = -Infinity;
    for (let d = -S; d <= S; d += 2) {
      const b0 = w - Math.round(dNew + d);
      let c = 0, e = 0;
      for (let j = 0; j < L; j += 2) { const a = buf[(a0 + j) & mask], b = buf[(b0 + j) & mask]; c += a * b; e += b * b; }
      const score = c / Math.sqrt(e + 1e-12);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }
  render(iL, iR, oL, oR, p, n) {
    const st = p.semitones[0];
    const W = Math.round(p.window[0] / 1000 * sampleRate);
    const ratio = Math.pow(2, st / 12);
    const dp = (1 - ratio) / W;
    const base = 3 + this.S;
    let ph = this.p, o1 = this.o1, o2 = this.o2, pp2 = this.pp2;
    const { dL, dR, dM } = this;
    const bypass = Math.abs(st) < 0.005;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i];
      dL.push(l); dR.push(r); dM.push(l + r);
      if (bypass) { oL[i] = l; oR[i] = r; continue; }
      ph += dp;
      let wrapped1 = false;
      if (ph >= 1) { ph -= 1; wrapped1 = true; } else if (ph < 0) { ph += 1; wrapped1 = true; }
      let p2 = ph + 0.5; if (p2 >= 1) p2 -= 1;
      if (wrapped1) o1 = this.align(p2 * W + base + o2, ph * W + base);
      if (Math.abs(p2 - pp2) > 0.5) o2 = this.align(ph * W + base + o1, p2 * W + base);
      pp2 = p2;
      const d1 = ph * W + base + o1, d2 = p2 * W + base + o2;
      const g1 = 0.5 - 0.5 * Math.cos(TAU * ph), g2 = 1 - g1;
      oL[i] = dL.read(d1) * g1 + dL.read(d2) * g2;
      oR[i] = dR.read(d1) * g1 + dR.read(d2) * g2;
    }
    this.p = ph; this.o1 = o1; this.o2 = o2; this.pp2 = pp2;
  }
}
registerProcessor('ul-pitch', PitchFx);

/* ---------- 18. Lo-fi / bitcrusher ---------- */
class LofiFx extends Fx {
  static get parameterDescriptors() { return [P('bits', 8, 2, 16), P('down', 4, 1, 32), P('mix', 1, 0, 1)]; }
  constructor() { super(); this.cnt = 0; this.hl = 0; this.hr = 0; }
  render(iL, iR, oL, oR, p, n) {
    const s = Math.pow(2, Math.round(p.bits[0]) - 1), down = Math.max(1, Math.round(p.down[0])), mix = p.mix[0];
    let cnt = this.cnt, hl = this.hl, hr = this.hr;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i];
      if (++cnt >= down) { cnt = 0; hl = Math.round(l * s) / s; hr = Math.round(r * s) / s; }
      oL[i] = (1 - mix) * l + mix * hl; oR[i] = (1 - mix) * r + mix * hr;
    }
    this.cnt = cnt; this.hl = hl; this.hr = hr;
  }
}
registerProcessor('ul-lofi', LofiFx);

/* ---------- 19. Vinyl (crackle, hiss, wow, band-limit) ---------- */
class VinylFx extends Fx {
  static get parameterDescriptors() { return [P('crackle', 0.5, 0, 1), P('noise', 0.3, 0, 1), P('wow', 0.3, 0, 1), P('tone', 0.5, 0, 1)]; }
  constructor() {
    super(); this.tail = true; this.rng = new Rng(12345); this.tone = -1;
    this.dL = new DelayLine(sampleRate * 0.02); this.dR = new DelayLine(sampleRate * 0.02);
    this.hpL = new Biquad().set('hp', 45, 0.707); this.hpR = new Biquad().set('hp', 45, 0.707);
    this.lpL = new Biquad(); this.lpR = new Biquad(); this.nlp = 0; this.cl = 0; this.cr = 0; this.ph = 0; this.pf = 0;
  }
  render(iL, iR, oL, oR, p, n) {
    const t = p.tone[0];
    if (t !== this.tone) { this.tone = t; const f = 16000 * Math.pow(0.35, t); this.lpL.set('lp', f, 0.6); this.lpR.set('lp', f, 0.6); }
    const crk = p.crackle[0], noise = p.noise[0], wow = p.wow[0];
    const rng = this.rng, prob = crk * crk * 0.0009;
    const base = 0.004 * sampleRate, wd = wow * 0.0011 * sampleRate, fd = wow * 0.00012 * sampleRate;
    const wInc = TAU * 0.55 / sampleRate, fInc = TAU * 6.5 / sampleRate;
    let ph = this.ph, pf = this.pf, nlp = this.nlp, cl = this.cl, cr = this.cr;
    for (let i = 0; i < n; i++) {
      this.dL.push(iL[i]); this.dR.push(iR[i]);
      const d = base + wd * Math.sin(ph) + fd * Math.sin(pf);
      let l = this.lpL.run(this.hpL.run(this.dL.read(d)));
      let r = this.lpR.run(this.hpR.run(this.dR.read(d)));
      // hiss
      nlp += ((rng.next() * 2 - 1) - nlp) * 0.35;
      const hiss = nlp * noise * 0.012;
      // crackle
      if (rng.next() < prob) {
        const a = (0.04 + 0.45 * Math.pow(rng.next(), 3)) * (0.4 + crk) * (rng.next() < 0.5 ? -1 : 1);
        const w = rng.next(); cl += a * (0.5 + w * 0.5); cr += a * (1 - w * 0.5);
      }
      cl *= 0.55; cr *= 0.55;
      oL[i] = l + hiss + cl; oR[i] = r + hiss * 0.9 + cr;
      ph += wInc; if (ph > TAU) ph -= TAU; pf += fInc; if (pf > TAU) pf -= TAU;
    }
    Object.assign(this, { ph, pf, nlp, cl, cr });
  }
}
registerProcessor('ul-vinyl', VinylFx);

/* ---------- 20. Freeverb (Jezar at Dreampoint, public domain algorithm) ---------- */
class Comb {
  constructor(size) { this.buf = new Float32Array(size); this.i = 0; this.store = 0; }
  run(x, fb, d1, d2) {
    const out = this.buf[this.i];
    this.store = out * d2 + this.store * d1 + 1e-20;
    this.buf[this.i] = x + this.store * fb;
    if (++this.i >= this.buf.length) this.i = 0;
    return out;
  }
}
class Allpass {
  constructor(size) { this.buf = new Float32Array(size); this.i = 0; }
  run(x) {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i >= this.buf.length) this.i = 0;
    return b - x;
  }
}
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], APS = [556, 441, 341, 225], SPREAD = 23;
class FreeverbFx extends Fx {
  static get parameterDescriptors() { return [P('room', 0.6, 0, 1), P('damp', 0.5, 0, 1), P('mix', 0.3, 0, 1), P('width', 1, 0, 1), P('predelay', 20, 0, 200)]; }
  constructor() {
    super(); this.tail = true;
    const k = sampleRate / 44100;
    this.cL = COMBS.map(t => new Comb(Math.round(t * k))); this.cR = COMBS.map(t => new Comb(Math.round((t + SPREAD) * k)));
    this.aL = APS.map(t => new Allpass(Math.round(t * k))); this.aR = APS.map(t => new Allpass(Math.round((t + SPREAD) * k)));
    this.pre = new DelayLine(sampleRate * 0.25); this.mix = new Smooth(0.3);
  }
  render(iL, iR, oL, oR, p, n) {
    const fb = p.room[0] * 0.28 + 0.7, d1 = p.damp[0] * 0.4, d2 = 1 - d1, width = p.width[0];
    this.mix.target(p.mix[0]);
    const pd = Math.max(1, p.predelay[0] / 1000 * sampleRate);
    const { cL, cR, aL, aR, pre } = this;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i];
      pre.push((l + r) * 0.015);
      const x = pre.readInt(Math.round(pd));
      let sl = 0, sr = 0;
      for (let k = 0; k < 8; k++) { sl += cL[k].run(x, fb, d1, d2); sr += cR[k].run(x, fb, d1, d2); }
      for (let k = 0; k < 4; k++) { sl = aL[k].run(sl); sr = aR[k].run(sr); }
      const wet = this.mix.next() * 1.6;
      const w1 = wet * (width / 2 + 0.5), w2 = wet * ((1 - width) / 2);
      oL[i] = l + sl * w1 + sr * w2; oR[i] = r + sr * w1 + sl * w2;
    }
  }
}
registerProcessor('ul-freeverb', FreeverbFx);
