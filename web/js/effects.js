/*
 * 울림 — 음장 효과 정의 (1.3.0: 브라우저 내장 오디오 엔진으로 다시 만듦)
 *
 * 각 효과: { id, cat, name, desc, params[], build(ctx, opt, p?) → module }
 *   module = { input, output, set(k, v), dispose?(), ready?, latency?(초), resp?(f) → dB, setListening?(dB) }
 *   값은 화면 단위(%, dB, Hz …)로 받고 build 안에서 DSP 값으로 바꾼다.
 *
 * 왜 이렇게 바꿨나 (끊김 · 지지직):
 *  - 1.2.x 는 효과 대부분을 오디오 워클릿(자바스크립트)으로 계산 → 여러 개를 켜면 계산이 밀려 버퍼가 비고(지지직),
 *    휴대폰에서는 화면을 만지기만 해도 끊김. 이제는 Web Audio 기본 노드 = 브라우저(Chromium)에 들어 있는 C++ 오디오 엔진
 *    (바이쿼드 필터 · 지연 · FFT 컨볼루션 · HRTF 입체음향 · 다이내믹 컴프레서 · 오버샘플링 웨이브셰이퍼)으로 만든다.
 *    실시간 우선순위 오디오 스레드에서 돌고 쓰레기 수거(GC)가 끼어들지 않는다.
 *  - 키 조절: Signalsmith Stretch (MIT, WASM) — 전문가급 피치 · 타임 엔진 (vendor/)
 *  - 볼륨 평준화 · 초저음 생성만 워클릿(fx-worklet.js) — 켤 때만 불러온다
 *  - 모든 값 변경은 램프로 부드럽게. 구조가 바뀌는 변경(잔향 IR · IIR 계수 · 웨이브셰이퍼 곡선)은
 *    새 것을 옆에 만들어 겹쳐 바꾼다(swapper) — 소리를 끊었다 잇지 않는다.
 *
 * 사용한 공개 기법: RBJ Audio EQ Cookbook(퍼블릭 도메인) 필터 공식, bs2b 크로스피드 공식(MIT), 합성 잔향(주파수별 감쇠 노이즈 +
 * 초기 반사) 컨볼루션, Chromium HRTF(IRCAM LISTEN 데이터), MaxxBass 방식 가상 저음(배음 생성), 미드/사이드 처리,
 * Signalsmith Stretch(MIT). 코드는 Signalsmith(그대로, 두 곳 수정)를 빼고 모두 새로 작성.
 */

export const CATEGORIES = [
  { id: 'space', name: '공간 · 입체' },
  { id: 'reverb', name: '잔향 · 에코' },
  { id: 'tone', name: '음색 · 저음' },
  { id: 'dyn', name: '음량 · 다이내믹' },
  { id: 'vocal', name: '보컬' },
  { id: 'mod', name: '변조' },
  { id: 'pitch', name: '속도 · 키' },
  { id: 'fun', name: '특수 효과' },
  { id: 'util', name: '채널' },
];

/* ---------- 노드 도우미 ---------- */
const now = ctx => ctx.currentTime;
const running = ctx => ctx.state === 'running' && typeof OfflineAudioContext !== 'undefined' && !(ctx instanceof OfflineAudioContext);
function stereo(ctx, g = 1) {
  const n = ctx.createGain();
  n.channelCount = 2; n.channelCountMode = 'explicit'; n.channelInterpretation = 'speakers';
  n.gain.value = g;
  return n;
}
function mono(ctx, g = 1) {
  const n = ctx.createGain();
  n.channelCount = 1; n.channelCountMode = 'explicit'; n.channelInterpretation = 'speakers';
  n.gain.value = g;
  return n;
}
function gain(ctx, v = 1) { const g = ctx.createGain(); g.gain.value = v; return g; }
function biquad(ctx, type, f, q = 0.7071, g = 0) {
  const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g; return b;
}
/** 값을 부드럽게 (지퍼 소리 없게) */
export function ramp(ctx, param, v, tc = 0.03) {
  const t = now(ctx);
  if (!running(ctx)) { try { param.cancelScheduledValues(0); } catch (e) { /* noop */ } param.value = v; return; }
  try { param.cancelScheduledValues(t); } catch (e) { /* noop */ }
  param.setTargetAtTime(v, t, tc);
}
/** 정해진 시간 안에 바꾸기 (켜고 끄기 · 겹쳐 바꾸기): setTargetAtTime(지수) — 언제 불러도 지금 값에서 이어짐.
    (linearRamp 는 앞선 자동화 이벤트가 없으면 0초부터 계산돼 바로 툭 바뀜 → 1.3.0 개발 중 실제로 잰 끊김의 원인)
    서로 보완하는 두 값(건조 1→0, 젖음 0→1)을 같은 τ 로 바꾸면 합이 항상 1 */
export function fade(ctx, param, v, dur, delay = 0) {
  if (!running(ctx)) { try { param.cancelScheduledValues(0); } catch (e) { /* noop */ } param.value = v; return; }
  const t = now(ctx);
  try { param.cancelScheduledValues(t + delay); } catch (e) { /* noop */ }
  param.setTargetAtTime(v, t + delay, dur / 3.5);
}
/** 서로 상관없는 소리(잔향 꼬리)를 겹칠 때: 들어오는 쪽은 바로, 나가는 쪽은 조금 늦게 줄여 가운데서 비지 않게 */
function fade2(ctx, param, end, dur) { fade(ctx, param, end, dur * 0.8, end > 0.5 ? 0 : dur * 0.25); }
const db = v => Math.pow(10, v / 20);
function makeCurve(fn, range = 1, n = 4096) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = fn(x * range); }
  return c;
}
/** 저주파 진동기(LFO). phase(라디안)는 PeriodicWave 로 */
function lfo(ctx, rate, phase = 0) {
  const o = ctx.createOscillator();
  if (phase) {
    const real = new Float32Array([0, Math.sin(phase)]), imag = new Float32Array([0, Math.cos(phase)]);
    o.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
  }
  o.frequency.value = rate;
  o.start();
  return o;
}
const stopAll = list => { for (const o of list) { try { o.stop(); } catch (e) { /* noop */ } try { o.disconnect(); } catch (e) { /* noop */ } } };

/** 미드/사이드: M = (L+R)/2, S = (L-R)/2 (모노 노드 둘) */
function msSplit(ctx, input) {
  const sp = ctx.createChannelSplitter(2), M = mono(ctx), S = mono(ctx), sl = gain(ctx, 0.5), sr = gain(ctx, -0.5);
  input.connect(M);                                   // 스테레오 → 모노 'speakers' 다운믹스 = (L+R)/2
  input.connect(sp); sp.connect(sl, 0); sp.connect(sr, 1); sl.connect(S); sr.connect(S);
  return { M, S };
}
/** L = M + S, R = M − S → out(스테레오) */
function msJoin(ctx, M, S, out) {
  const mg = ctx.createChannelMerger(2), neg = gain(ctx, -1);
  M.connect(mg, 0, 0); M.connect(mg, 0, 1); S.connect(mg, 0, 0); S.connect(neg).connect(mg, 0, 1);
  mg.connect(out);
}

/** 건조/젖은 소리 섞기 (효과 안에서): input → dry → output, (효과) → wet → output */
function dryWet(ctx) {
  const input = stereo(ctx), output = stereo(ctx), dry = gain(ctx, 1), wet = gain(ctx, 1);
  input.connect(dry).connect(output); wet.connect(output);
  return {
    input, output, dry, wet,
    mix(m) {                                            // 비슷한 크기로 들리게
      ramp(ctx, dry.gain, Math.cos(m * Math.PI / 2) ** 0.8);
      ramp(ctx, wet.gain, Math.sin(m * Math.PI / 2) ** 0.8);
    },
  };
}

/**
 * 구조가 바뀌는 부분(잔향 IR · 필터 계수 · 곡선)을 새로 만들어 겹쳐 바꾸기.
 * 재생 중이면 잠깐(debounce) 모았다가 새 것을 만들고 fade 초 동안 교차(power: 서로 상관없는 소리 — 잔향 꼬리 — 는 등전력).
 * 재생 전(오프라인 · 정지)에는 바로 바꾼다.
 */
function swapper(ctx, make, { fade: fd = 0.08, debounce = 60, power = false } = {}) {
  const input = stereo(ctx), output = stereo(ctx);
  let cur = null, curG = null, timer = 0, dead = false;
  const olds = new Set();
  const drop = (sub, g) => { try { input.disconnect(sub.input); } catch (e) { /* noop */ } try { g.disconnect(); } catch (e) { /* noop */ } try { if (sub.dispose) sub.dispose(); } catch (e) { /* noop */ } };
  function build() {
    timer = 0;
    if (dead) return;
    const sub = make(), g = gain(ctx, 0);
    input.connect(sub.input); sub.output.connect(g).connect(output);
    if (cur && running(ctx)) {
      const old = cur, oldG = curG;
      if (power) { fade2(ctx, oldG.gain, 0, fd); fade2(ctx, g.gain, 1, fd); }   // 등전력에 가깝게 (가운데서 0.7 + 0.7)
      else { fade(ctx, oldG.gain, 0, fd); fade(ctx, g.gain, 1, fd); }
      olds.add(old);
      setTimeout(() => { olds.delete(old); drop(old, oldG); }, fd * 1000 + 250);
    } else {
      if (cur) drop(cur, curG);
      g.gain.value = 1;
    }
    cur = sub; curG = g;
  }
  build();
  return {
    input, output,
    get cur() { return cur; },
    update() {
      if (!running(ctx)) { clearTimeout(timer); build(); return; }
      if (!timer) timer = setTimeout(build, debounce);
    },
    dispose() { dead = true; clearTimeout(timer); if (cur) drop(cur, curG); for (const o of olds) try { if (o.dispose) o.dispose(); } catch (e) { /* noop */ } },
  };
}

/* ---------- 주파수 응답 (자동 여유 음량 계산용) — Web Audio BiquadFilterNode 와 같은 RBJ 식 ---------- */
export function rbjDb(type, f0, q, gainDb, f, sr) {
  const A = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * Math.min(f0, sr * 0.499) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peaking') {
    const al = sw / (2 * q); b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
  } else if (type === 'lowshelf' || type === 'highshelf') {
    const al = sw / 2 * Math.SQRT2, s = 2 * Math.sqrt(A) * al;
    if (type === 'lowshelf') { b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s); a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; }
    else { b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s); a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; }
  } else return 0;
  const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/* ---------- 합성 잔향 (컨볼루션용 임펄스 응답) ----------
 * 주파수마다 다르게 줄어드는 노이즈(저음은 길게 · 고음은 빨리 — 실제 공간처럼) + 초기 반사(짧게 번진 펄스) + 좌우 다른 노이즈.
 * 에너지를 맞춰 공간 · 길이가 달라도 잔향 양이 비슷하게 들린다. 컨볼루션은 브라우저 엔진이 FFT 로 한다. */
export const SPACES = {
  room: { label: '룸', decay: 0.7, lowMul: 1.1, highMul: 0.55, pre: 0.004, er: [[0.007, 0.5], [0.011, 0.42], [0.017, 0.33], [0.023, 0.27], [0.031, 0.2]] },
  studio: { label: '스튜디오', decay: 0.45, lowMul: 1.0, highMul: 0.7, pre: 0.002, er: [[0.005, 0.4], [0.009, 0.3], [0.013, 0.2]] },
  hall: { label: '콘서트홀', decay: 2.3, lowMul: 1.3, highMul: 0.5, pre: 0.022, er: [[0.019, 0.45], [0.027, 0.38], [0.035, 0.32], [0.043, 0.26], [0.052, 0.22], [0.064, 0.17]] },
  church: { label: '대성당', decay: 5.2, lowMul: 1.35, highMul: 0.42, pre: 0.04, er: [[0.035, 0.4], [0.051, 0.35], [0.067, 0.3], [0.083, 0.25], [0.104, 0.2]] },
  arena: { label: '아레나', decay: 3.4, lowMul: 1.2, highMul: 0.5, pre: 0.06, er: [[0.06, 0.5], [0.09, 0.4], [0.12, 0.3], [0.16, 0.22]] },
  plate: { label: '플레이트', decay: 1.8, lowMul: 0.85, highMul: 0.95, pre: 0, er: [] },
  cave: { label: '동굴', decay: 4.0, lowMul: 1.4, highMul: 0.32, pre: 0.03, er: [[0.05, 0.6], [0.11, 0.5], [0.17, 0.4], [0.23, 0.3]] },
};
export function synthIR(ctx, { decay = 2, lowMul = 1.2, highMul = 0.5, pre = 0.01, er = [], width = 1, maxLen = 6, seed = 1, channels = 2 } = {}) {
  const sr = ctx.sampleRate;
  const tLow = decay * lowMul, tMid = decay, tHigh = Math.max(0.08, decay * highMul);
  const len = Math.min(maxLen, pre + Math.max(tLow, tMid) * 0.85 + 0.03);   // −50dB 쯤까지 (그 뒤는 음악에 묻힘), 끝은 부드럽게 줄임
  const n = Math.max(256, Math.ceil(len * sr)), p0 = Math.min(n - 1, Math.round(pre * sr));
  const buf = ctx.createBuffer(channels, n, sr);
  const kL = Math.pow(10, -3 / (tLow * sr)), kM = Math.pow(10, -3 / (tMid * sr)), kH = Math.pow(10, -3 / (tHigh * sr));
  const aLo = 1 - Math.exp(-2 * Math.PI * 300 / sr), aHi = 1 - Math.exp(-2 * Math.PI * 3500 / sr);
  const onset = Math.max(1, Math.round(sr * Math.min(0.03, 0.006 + decay * 0.008)));     // 잔향이 차오르는 시간
  const fadeEnd = Math.max(Math.round(sr * 0.04), Math.round((n - p0) * 0.2));         // 끝 20% 를 부드럽게
  const ch = Array.from({ length: channels }, (_, c) => buf.getChannelData(c));
  for (let c = 0; c < channels; c++) {
    const d = ch[c];
    let s = (0x9e3779b9 ^ (seed * 7919 + c * 0x2545f491)) >>> 0 || 1;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    let lo = 0, hiLp = 0, eL = 1, eM = 1, eH = 1;
    for (let i = p0; i < n; i++) {
      const x = rnd() * 2 - 1;
      lo += aLo * (x - lo); hiLp += aHi * (x - hiLp);
      const hi = x - hiLp, mid = hiLp - lo;
      let y = lo * eL * 1.6 + mid * eM + hi * eH * 0.85;
      const k = i - p0;
      if (k < onset) y *= k / onset;
      if (i > n - fadeEnd) y *= 0.5 + 0.5 * Math.cos(Math.PI * (1 - (n - i) / fadeEnd));
      d[i] = y;
      eL *= kL; eM *= kM; eH *= kH;
    }
    // 초기 반사: 0.6ms 정도로 번진 펄스 (완전한 점이면 '틱' 소리처럼 들림)
    const w = Math.max(8, Math.round(sr * 0.0006));
    for (const [tm, g0] of er) {
      const at = Math.round((pre + tm + (c ? 0.0011 : 0)) * sr);
      const sign = rnd() < 0.5 ? -1 : 1, g = g0 * (c ? 0.93 : 1) * 2.2;
      for (let j = 0; j < w && at + j < n; j++) d[at + j] += sign * g * Math.sin(Math.PI * (j + 0.5) / w) * (rnd() * 0.6 + 0.7);
    }
  }
  // 퍼짐(width): 1 = 좌우 다른 잔향, 0 = 가운데로 모임
  if (channels === 2 && width < 0.999) {
    const a = (1 + width) / 2, b = (1 - width) / 2, L = ch[0], R = ch[1];
    for (let i = 0; i < n; i++) { const l = L[i], r = R[i]; L[i] = a * l + b * r; R[i] = a * r + b * l; }
  }
  // 에너지 맞추기: 채널마다 Σh² = 0.5
  for (const d of ch) {
    let e = 0; for (let i = 0; i < n; i++) e += d[i] * d[i];
    const g = Math.sqrt(0.5 / (e + 1e-20));
    for (let i = 0; i < n; i++) d[i] *= g;
  }
  return buf;
}
/** 예전 이름 (공간 시뮬레이션) */
export function makeIR(ctx, key, mul = 1, maxLen = 6, channels = 2) {
  const sp = SPACES[key] || SPACES.hall;
  return synthIR(ctx, { decay: sp.decay * mul, lowMul: sp.lowMul, highMul: sp.highMul, pre: sp.pre * Math.sqrt(mul), er: sp.er.map(([t, g]) => [t * Math.sqrt(mul), g]), maxLen, seed: key.length, channels });
}
/** 컨볼루션. IR 이 모노(휴대폰 가볍게)면 한 번만 계산하고, 오른쪽은 살짝 늦추고 위상을 돌려 좌우를 다르게 (계산 절반) */
function convo(ctx, ir) {
  const c = ctx.createConvolver();
  c.normalize = false;
  c.buffer = ir;
  if (ir.numberOfChannels > 1) return { input: c, output: c, dispose() { try { c.disconnect(); } catch (e) { /* noop */ } } };
  const input = mono(ctx), output = stereo(ctx), mg = ctx.createChannelMerger(2), d = ctx.createDelay(0.05), ap = biquad(ctx, 'allpass', 700, 0.7);
  d.delayTime.value = 0.0113;
  input.connect(c); c.connect(mg, 0, 0); c.connect(d).connect(ap).connect(mg, 0, 1); mg.connect(output);
  return { input, output, dispose() { try { c.disconnect(); mg.disconnect(); } catch (e) { /* noop */ } } };
}

/* ---------- 키 조절 엔진 (Signalsmith Stretch, MIT) — 처음 쓸 때 불러옴 ---------- */
let ssPromise = null;
function loadStretch() {
  if (!ssPromise) {
    const url = new URL('./vendor/signalsmith-stretch.mjs', import.meta.url).href;
    ssPromise = import(url).then(m => { const SS = m.default; SS.moduleUrl = url; return SS; });
  }
  return ssPromise;
}

/* ---------- 워클릿 효과 (볼륨 평준화 · 초저음) ---------- */
function wk(name, map) {
  const fn = ctx => {
    const node = new AudioWorkletNode(ctx, name, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    return {
      input: node, output: node,
      set(k, v) {
        const t = map[k]; if (!t) return;
        const prm = node.parameters.get(t[0]); if (!prm) return;
        prm.setValueAtTime(t[1] ? t[1](v) : v, now(ctx));      // 처리기 안에서 부드럽게 바꿈
      },
      dispose() { try { node.port.postMessage('stop'); node.port.close(); } catch (e) { /* noop */ } },
    };
  };
  fn.worklet = name;
  return fn;
}
const pct = v => v / 100;

function setPos(p, azDeg, el = 0) {
  const a = azDeg * Math.PI / 180, e = el * Math.PI / 180;
  const x = Math.sin(a) * Math.cos(e), y = Math.sin(e), z = -Math.cos(a) * Math.cos(e);
  if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
  else p.setPosition(x, y, z);
}
function hrtf(ctx, az) {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 1; p.maxDistance = 10000; p.rolloffFactor = 0;
  p.coneInnerAngle = 360; p.coneOuterAngle = 360; p.coneOuterGain = 1;
  setPos(p, az);
  return p;
}

/* ---------- 효과 목록 ---------- */
const R = (k, label, min, max, def, unit = '', step = 1, extra = {}) => ({ k, label, min, max, def, unit, step, ...extra });
const S = (k, label, options, def) => ({ k, label, type: 'select', options, def });
const T = (k, label, def) => ({ k, label, type: 'toggle', def });

export const FX = [
  /* 공간 · 입체 */
  {
    id: 'wide', cat: 'space', name: '스테레오 와이드', desc: '좌우 폭을 넓혀 시원하게',
    params: [R('width', '폭', 0, 300, 160, '%')],
    build(ctx) {
      const input = stereo(ctx), output = stereo(ctx), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      const ll = gain(ctx), lr = gain(ctx, 0), rl = gain(ctx, 0), rr = gain(ctx);
      input.connect(sp);
      sp.connect(ll, 0); sp.connect(lr, 0); sp.connect(rl, 1); sp.connect(rr, 1);
      ll.connect(mg, 0, 0); rl.connect(mg, 0, 0); lr.connect(mg, 0, 1); rr.connect(mg, 0, 1);
      mg.connect(output);
      return {
        input, output,
        set(k, v) {
          const w = v / 100, a = 0.5 + 0.5 * w, b = 0.5 - 0.5 * w;
          ramp(ctx, ll.gain, a); ramp(ctx, rr.gain, a); ramp(ctx, lr.gain, b); ramp(ctx, rl.gain, b);
          ramp(ctx, output.gain, w > 1 ? 1 / (1 + (w - 1) * 0.22) : 1);
        },
      };
    },
  },
  {
    id: 'surround', cat: 'space', name: '3D 서라운드', desc: '주변을 감싸는 입체 공간감',
    params: [R('depth', '깊이', 0, 100, 60, '%'), R('delay', '공간 크기', 4, 40, 16, 'ms')],
    build(ctx) {
      // 사이드(좌우 차이) 소리를 넓히고, 늦춰 걸러 낸 사이드를 더해 주변 울림을 만든다 (가운데 목소리는 그대로)
      const input = stereo(ctx), output = stereo(ctx), { M, S: Sd } = msSplit(ctx, input);
      const hp = biquad(ctx, 'highpass', 160), dl = ctx.createDelay(0.06), lp1 = biquad(ctx, 'lowpass', 5200), lp2 = biquad(ctx, 'lowpass', 5200);
      const sDir = gain(ctx, 1), amb = gain(ctx, 0), Sx = mono(ctx), Mx = mono(ctx), norm = stereo(ctx);
      dl.delayTime.value = 0.016;
      M.connect(Mx); Sd.connect(sDir).connect(Sx); Sd.connect(hp).connect(dl).connect(lp1).connect(lp2).connect(amb).connect(Sx);
      msJoin(ctx, Mx, Sx, norm); norm.connect(output);
      return {
        input, output,
        set(k, v) {
          if (k === 'depth') { const d = v / 100; ramp(ctx, sDir.gain, 1 + d * 0.9); ramp(ctx, amb.gain, d * 0.85); ramp(ctx, norm.gain, 1 / (1 + d * 0.3)); }
          if (k === 'delay') ramp(ctx, dl.delayTime, v / 1000, 0.06);
        },
      };
    },
  },
  {
    id: 'virtualizer', cat: 'space', name: '가상 스피커', desc: '헤드폰에서 앞쪽 스피커로 듣는 느낌 (HRTF)',
    params: [R('angle', '스피커 각도', 15, 70, 35, '°'), R('rear', '뒤쪽 울림', 0, 100, 45, '%'), R('mix', '적용량', 0, 100, 100, '%')],
    build(ctx) {
      const dw = dryWet(ctx), sp = ctx.createChannelSplitter(2);
      dw.input.connect(sp);
      const fl = hrtf(ctx, -35), fr = hrtf(ctx, 35), rl = hrtf(ctx, -125), rr = hrtf(ctx, 125);
      const fL = mono(ctx), fR = mono(ctx);
      sp.connect(fL, 0); sp.connect(fR, 1); fL.connect(fl); fR.connect(fr);
      const sL = gain(ctx, 0.5), sR = gain(ctx, -0.5), side = mono(ctx);
      sp.connect(sL, 0); sp.connect(sR, 1); sL.connect(side); sR.connect(side);
      const sd = ctx.createDelay(0.1); sd.delayTime.value = 0.013;
      const slp = biquad(ctx, 'lowpass', 6500);
      side.connect(sd).connect(slp);
      const rearL = gain(ctx, 0.45), rearR = gain(ctx, -0.45);
      slp.connect(rearL).connect(rl); slp.connect(rearR).connect(rr);
      const sum = gain(ctx, 0.55);
      [fl, fr, rl, rr].forEach(p => p.connect(sum));
      sum.connect(dw.wet);
      let ang = 35;
      return {
        input: dw.input, output: dw.output,
        set(k, v) {
          if (k === 'angle' && v !== ang) { ang = v; setPos(fl, -v); setPos(fr, v); }
          if (k === 'rear') { ramp(ctx, rearL.gain, v / 100 * 0.9); ramp(ctx, rearR.gain, -v / 100 * 0.9); }
          if (k === 'mix') dw.mix(v / 100);
        },
      };
    },
  },
  {
    id: 'rotate8d', cat: 'space', name: '8D 회전', desc: '소리가 머리 주위를 빙글빙글 회전',
    params: [R('period', '한 바퀴', 2, 30, 8, '초', 0.5), R('mix', '적용량', 0, 100, 100, '%')],
    build(ctx) {
      const dw = dryWet(ctx), m = mono(ctx), p = hrtf(ctx, 0);
      dw.input.connect(m).connect(p).connect(dw.wet);
      const oc = lfo(ctx, 1 / 8), os = lfo(ctx, 1 / 8, Math.PI / 2);
      const gx = gain(ctx, 1), gz = gain(ctx, -1);
      if (p.positionX) { p.positionX.value = 0; p.positionZ.value = 0; oc.connect(gx).connect(p.positionX); os.connect(gz).connect(p.positionZ); }
      return {
        input: dw.input, output: dw.output,
        set(k, v) {
          if (k === 'period') { ramp(ctx, oc.frequency, 1 / v, 0.3); ramp(ctx, os.frequency, 1 / v, 0.3); }
          if (k === 'mix') dw.mix(v / 100);
        },
        dispose() { stopAll([oc, os]); },
      };
    },
  },
  {
    id: 'haas', cat: 'space', name: '하스 입체감', desc: '한쪽을 아주 살짝 늦춰 넓게',
    params: [R('delay', '지연', 1, 40, 12, 'ms'), S('side', '늦출 쪽', [['r', '오른쪽'], ['l', '왼쪽']], 'r')],
    build(ctx) {
      const input = stereo(ctx), output = stereo(ctx), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      const dl = ctx.createDelay(0.1), dr = ctx.createDelay(0.1);
      input.connect(sp); sp.connect(dl, 0); sp.connect(dr, 1); dl.connect(mg, 0, 0); dr.connect(mg, 0, 1); mg.connect(output);
      let d = 12, side = 'r';
      const apply = () => { ramp(ctx, dl.delayTime, side === 'l' ? d / 1000 : 0, 0.05); ramp(ctx, dr.delayTime, side === 'r' ? d / 1000 : 0, 0.05); };
      return { input, output, set(k, v) { if (k === 'delay') d = v; if (k === 'side') side = v; apply(); } };
    },
  },
  {
    id: 'crossfeed', cat: 'space', name: '헤드폰 크로스피드', desc: '좌우를 자연스럽게 섞어 귀의 피로 감소 (bs2b)',
    params: [R('fcut', '차단 주파수', 300, 2000, 700, 'Hz', 10), R('feed', '섞임 정도', 1, 15, 4.5, 'dB', 0.5)],
    build(ctx) {
      let fc = 700, feed = 4.5;
      const sw = swapper(ctx, () => bs2b(ctx, fc, feed), { fade: 0.06 });
      return {
        input: sw.input, output: sw.output, dispose: sw.dispose,
        set(k, v) { if (k === 'fcut' && v !== fc) { fc = v; sw.update(); } if (k === 'feed' && v !== feed) { feed = v; sw.update(); } },
      };
    },
  },

  /* 잔향 · 에코 */
  {
    id: 'reverb', cat: 'reverb', name: '리버브', desc: '자연스러운 잔향 — 공간 크기 · 흡음을 돌려 맞춤',
    params: [R('room', '공간 크기', 0, 100, 60, '%'), R('damp', '흡음', 0, 100, 50, '%'), R('mix', '잔향 양', 0, 100, 30, '%'),
      R('width', '퍼짐', 0, 100, 100, '%'), R('predelay', '프리딜레이', 0, 200, 20, 'ms')],
    build(ctx, opt = {}) {
      const st = { room: 60, damp: 50, width: 100, predelay: 20 };
      const input = stereo(ctx), output = stereo(ctx), dry = gain(ctx, 1), wet = gain(ctx, 0.3);
      input.connect(dry).connect(output);
      const ir = () => {
        const r = st.room / 100;
        return synthIR(ctx, {
          decay: 0.35 + 3.4 * Math.pow(r, 1.35), lowMul: 1.2, highMul: 1 - 0.72 * (st.damp / 100), pre: st.predelay / 1000,
          er: [[0.006, 0.42], [0.0095, 0.36], [0.014, 0.3], [0.019, 0.26], [0.026, 0.2], [0.034, 0.15]].map(([t, g]) => [t * (0.6 + 1.6 * r), g]),
          width: st.width / 100, maxLen: opt.maxIR || 5, seed: 3, channels: opt.light ? 1 : 2,
        });
      };
      const sw = swapper(ctx, () => convo(ctx, ir()), { fade: 0.18, debounce: 110, power: true });
      input.connect(sw.input); sw.output.connect(wet).connect(output);
      return {
        input, output, dispose: sw.dispose,
        set(k, v) {
          if (k === 'mix') { const m = v / 100; ramp(ctx, wet.gain, m * 0.9); ramp(ctx, dry.gain, 1 - 0.25 * m); return; }
          if (k in st && st[k] !== v) { st[k] = v; sw.update(); }
        },
      };
    },
  },
  {
    id: 'hall', cat: 'reverb', name: '공간 시뮬레이션', desc: '콘서트홀 · 대성당 등 실제 공간의 울림',
    params: [S('space', '공간', Object.entries(SPACES).map(([k, s]) => [k, s.label]), 'hall'),
      R('size', '울림 길이', 40, 200, 100, '%'), R('mix', '잔향 양', 0, 100, 25, '%')],
    build(ctx, opt = {}) {
      let space = 'hall', size = 100;
      const input = stereo(ctx), output = stereo(ctx), dry = gain(ctx, 1), wet = gain(ctx, 0.3);
      input.connect(dry).connect(output);
      const sw = swapper(ctx, () => convo(ctx, makeIR(ctx, space, size / 100, opt.maxIR || 5, opt.light ? 1 : 2)), { fade: 0.22, debounce: 140, power: true });
      input.connect(sw.input); sw.output.connect(wet).connect(output);
      return {
        input, output, dispose: sw.dispose,
        set(k, v) {
          if (k === 'space' && v !== space) { space = SPACES[v] ? v : 'hall'; sw.update(); }
          if (k === 'size' && v !== size) { size = v; sw.update(); }
          if (k === 'mix') { const m = v / 100; ramp(ctx, wet.gain, m * 1.05); ramp(ctx, dry.gain, 1 - 0.25 * m); }
        },
      };
    },
  },
  {
    id: 'echo', cat: 'reverb', name: '에코 · 딜레이', desc: '메아리처럼 반복되는 소리',
    params: [R('time', '간격', 20, 1500, 320, 'ms', 5), R('feedback', '반복', 0, 90, 35, '%'), R('mix', '에코 양', 0, 100, 25, '%'),
      R('tone', '톤', 1000, 16000, 6000, 'Hz', 100), T('pingpong', '좌우 핑퐁', true)],
    build(ctx) {
      const input = stereo(ctx), output = stereo(ctx), dry = gain(ctx, 1), wet = gain(ctx, 0.25);
      input.connect(dry).connect(output);
      const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      input.connect(sp);
      const dL = ctx.createDelay(2), dR = ctx.createDelay(2);
      dL.delayTime.value = dR.delayTime.value = 0.32;
      const tL = biquad(ctx, 'lowpass', 6000), tR = biquad(ctx, 'lowpass', 6000);
      const inL = gain(ctx, 0), inR = gain(ctx, 0), inPP = gain(ctx, 0.5);
      const fLL = gain(ctx, 0), fRR = gain(ctx, 0), fLR = gain(ctx, 0.35), fRL = gain(ctx, 0.35);
      sp.connect(inL, 0); sp.connect(inR, 1); sp.connect(inPP, 0); sp.connect(inPP, 1);
      inL.connect(dL); inR.connect(dR); inPP.connect(dL);
      dL.connect(tL); dR.connect(tR);
      tL.connect(fLL).connect(dL); tR.connect(fRR).connect(dR); tL.connect(fLR).connect(dR); tR.connect(fRL).connect(dL);
      tL.connect(mg, 0, 0); tR.connect(mg, 0, 1); mg.connect(wet).connect(output);
      const st = { time: 320, feedback: 35, pingpong: true };
      const apply = () => {
        const f = st.feedback / 100, pp = st.pingpong;
        ramp(ctx, fLL.gain, pp ? 0 : f); ramp(ctx, fRR.gain, pp ? 0 : f);
        ramp(ctx, fLR.gain, pp ? f : 0); ramp(ctx, fRL.gain, pp ? f : 0);
        ramp(ctx, inL.gain, pp ? 0 : 1); ramp(ctx, inR.gain, pp ? 0 : 1); ramp(ctx, inPP.gain, pp ? 0.5 : 0);
        ramp(ctx, dL.delayTime, st.time / 1000, 0.08); ramp(ctx, dR.delayTime, st.time / 1000, 0.08);
      };
      return {
        input, output,
        set(k, v) {
          if (k === 'mix') return ramp(ctx, wet.gain, v / 100 * 1.2);
          if (k === 'tone') { ramp(ctx, tL.frequency, v); ramp(ctx, tR.frequency, v); return; }
          st[k] = v; apply();
        },
      };
    },
  },

  /* 음색 · 저음 */
  {
    id: 'bass', cat: 'tone', name: '베이스 부스트', desc: '저음을 단단하게 키움',
    params: [R('gain', '세기', 0, 18, 6, 'dB', 0.5), R('freq', '주파수', 30, 250, 80, 'Hz')],
    build(ctx) {
      const st = { gain: 6, freq: 80 };
      const input = stereo(ctx), f = biquad(ctx, 'lowshelf', 80, 0.7071, 6), output = stereo(ctx);
      input.connect(f).connect(output);
      return {
        input, output,
        set(k, v) { st[k] = v; if (k === 'gain') ramp(ctx, f.gain, v); if (k === 'freq') ramp(ctx, f.frequency, v); },
        resp: fr => rbjDb('lowshelf', st.freq, 0.7071, st.gain, fr, ctx.sampleRate),
      };
    },
  },
  {
    id: 'vbass', cat: 'tone', name: '가상 저음', desc: '작은 스피커 · 이어폰에서도 묵직한 저음감',
    params: [R('amount', '세기', 0, 100, 50, '%'), R('cutoff', '기준 주파수', 50, 250, 110, 'Hz')],
    build(ctx) {
      // MaxxBass 방식: 아주 낮은 저음을 뽑아 배음(2 · 3배)을 만들어 더함 → 작은 스피커로도 그 음이 들리는 것처럼
      const input = stereo(ctx), output = stereo(ctx);
      input.connect(output);
      const m = mono(ctx), l1 = biquad(ctx, 'lowpass', 110), l2 = biquad(ctx, 'lowpass', 110), sh = ctx.createWaveShaper();
      const h1 = biquad(ctx, 'highpass', 121), h2 = biquad(ctx, 'highpass', 121), l3 = biquad(ctx, 'lowpass', 495), amt = gain(ctx, 0);
      sh.curve = makeCurve(x => Math.abs(x) + 0.5 * Math.tanh(x * 3) / 3, 1, 4096); sh.oversample = '2x';
      input.connect(m).connect(l1).connect(l2).connect(sh).connect(h1).connect(h2).connect(l3).connect(amt).connect(output);
      return {
        input, output,
        set(k, v) {
          if (k === 'amount') ramp(ctx, amt.gain, v / 100 * 3.2);
          if (k === 'cutoff') { ramp(ctx, l1.frequency, v); ramp(ctx, l2.frequency, v); ramp(ctx, h1.frequency, v * 1.1); ramp(ctx, h2.frequency, v * 1.1); ramp(ctx, l3.frequency, v * 4.5); }
        },
      };
    },
  },
  {
    id: 'subharm', cat: 'tone', name: '초저음 생성', desc: '한 옥타브 아래 저음을 만들어 더함',
    params: [R('amount', '세기', 0, 100, 40, '%'), R('cutoff', '감지 주파수', 40, 160, 90, 'Hz')],
    build: wk('ul-subharm', { amount: ['amount', pct], cutoff: ['cutoff'] }),
  },
  {
    id: 'treble', cat: 'tone', name: '트레블', desc: '고음 높이기 · 줄이기',
    params: [R('gain', '세기', -12, 12, 4, 'dB', 0.5, { center: 0 }), R('freq', '주파수', 2000, 16000, 7000, 'Hz', 100)],
    build(ctx) {
      const st = { gain: 4, freq: 7000 };
      const input = stereo(ctx), f = biquad(ctx, 'highshelf', 7000, 0.7071, 4), output = stereo(ctx);
      input.connect(f).connect(output);
      return {
        input, output,
        set(k, v) { st[k] = v; if (k === 'gain') ramp(ctx, f.gain, v); if (k === 'freq') ramp(ctx, f.frequency, v); },
        resp: fr => rbjDb('highshelf', st.freq, 0.7071, st.gain, fr, ctx.sampleRate),
      };
    },
  },
  {
    id: 'loudness', cat: 'tone', name: '라우드니스', desc: '볼륨을 낮출수록 저음 · 고음을 더 채워 줌 (등청감 곡선)',
    params: [R('amount', '세기', 0, 100, 50, '%')],
    build(ctx) {
      // 사람 귀는 작은 소리에서 저음 · 고음을 덜 듣는다(ISO 226 등청감 곡선) → 볼륨을 낮춘 만큼 더 채운다
      const input = stereo(ctx), lo = biquad(ctx, 'lowshelf', 100), hi = biquad(ctx, 'highshelf', 9000), output = stereo(ctx);
      input.connect(lo).connect(hi).connect(output);
      let amount = 0.5, att = 0, gl = 0, gh = 0;
      const apply = (tc = 0.06) => {
        const a = -att;
        gl = amount * Math.min(12, 3 + 0.42 * a); gh = amount * Math.min(6, 1.5 + 0.14 * a);
        ramp(ctx, lo.gain, gl, tc); ramp(ctx, hi.gain, gh, tc);
      };
      apply();
      return {
        input, output,
        set(k, v) { if (k === 'amount') { amount = v / 100; apply(); } },
        setListening(attDb) { att = Math.min(0, attDb); apply(0.25); },
        resp: fr => rbjDb('lowshelf', 100, 0.7071, gl, fr, ctx.sampleRate) + rbjDb('highshelf', 9000, 0.7071, gh, fr, ctx.sampleRate),
      };
    },
  },
  {
    id: 'crystal', cat: 'tone', name: '크리스탈라이저', desc: '압축 음원의 생기와 선명도 회복',
    params: [R('intensity', '세기', 0, 100, 30, '%')],
    build(ctx) {
      // y = x + k·(x − x[n−1]) : 고음으로 갈수록 살짝 올라가는 1차 강조 (샘플 차분)
      const input = stereo(ctx), output = stereo(ctx), d1 = ctx.createDelay(0.01), kp = gain(ctx, 0), kn = gain(ctx, 0);
      d1.delayTime.value = 1 / ctx.sampleRate;
      input.connect(output); input.connect(kp).connect(output); input.connect(d1).connect(kn).connect(output);
      let k = 0;
      return {
        input, output,
        set(key, v) { if (key === 'intensity') { k = v / 100 * 1.5; ramp(ctx, kp.gain, k); ramp(ctx, kn.gain, -k); } },
        resp: fr => { const w = 2 * Math.PI * fr / ctx.sampleRate, re = 1 + k * (1 - Math.cos(w)), im = k * Math.sin(w); return 10 * Math.log10(re * re + im * im); },
      };
    },
  },
  {
    id: 'exciter', cat: 'tone', name: '익사이터', desc: '고음 배음을 더해 또렷하게',
    params: [R('amount', '세기', 0, 100, 40, '%'), R('freq', '시작 주파수', 1000, 10000, 3500, 'Hz', 100)],
    build(ctx) {
      // 고음만 뽑아 살짝 포화시켜 생긴 배음을 더함 (2배 오버샘플링 — 거친 접힘 소리 없음)
      const input = stereo(ctx), output = stereo(ctx);
      input.connect(output);
      const h1 = biquad(ctx, 'highpass', 3500), h1b = biquad(ctx, 'highpass', 3500), sh = ctx.createWaveShaper(), h2 = biquad(ctx, 'highpass', 3500), amt = gain(ctx, 0);
      sh.curve = makeCurve(u => { const t = Math.tanh(10 * u); return t + 0.3 * t * t; }, 1, 8192); sh.oversample = '2x';
      input.connect(h1).connect(h1b).connect(sh).connect(h2).connect(amt).connect(output);
      return {
        input, output,
        set(k, v) {
          if (k === 'amount') ramp(ctx, amt.gain, v / 100 * 0.126);
          if (k === 'freq') { ramp(ctx, h1.frequency, v); ramp(ctx, h1b.frequency, v); ramp(ctx, h2.frequency, v); }
        },
      };
    },
  },
  {
    id: 'warm', cat: 'tone', name: '진공관 웜', desc: '부드럽고 따뜻한 아날로그 질감',
    params: [R('drive', '드라이브', 0, 100, 40, '%'), R('mix', '적용량', 0, 100, 100, '%')],
    build(ctx) {
      const dw = dryWet(ctx), RANGE = 6;
      const pre = gain(ctx, 1 / RANGE), sh = ctx.createWaveShaper(), dc = biquad(ctx, 'highpass', 15), lp = biquad(ctx, 'lowpass', 15000), post = gain(ctx, 1);
      sh.curve = makeCurve(x => Math.tanh(x + 0.28 * x * x), RANGE, 8192); sh.oversample = '2x';
      dw.input.connect(pre).connect(sh).connect(dc).connect(lp).connect(post).connect(dw.wet);
      return {
        input: dw.input, output: dw.output,
        set(k, v) {
          if (k === 'drive') { const d = 1 + v / 100 * 3; ramp(ctx, pre.gain, d / RANGE); ramp(ctx, post.gain, Math.pow(d, -0.85)); }
          if (k === 'mix') dw.mix(v / 100);
        },
      };
    },
  },

  /* 음량 · 다이내믹 */
  {
    id: 'compressor', cat: 'dyn', name: '컴프레서', desc: '음량 차이를 줄여 단단하고 꽉 찬 소리',
    params: [R('threshold', '기준 레벨', -60, 0, -24, 'dB'), R('ratio', '압축 비율', 1, 20, 4, ':1', 0.5), R('attack', '어택', 0, 200, 10, 'ms'),
      R('release', '릴리즈', 20, 1000, 250, 'ms', 10), R('output', '출력', -12, 12, 0, 'dB', 0.5, { center: 0 })],
    build(ctx) {
      const input = stereo(ctx), c = ctx.createDynamicsCompressor(), output = stereo(ctx);
      c.knee.value = 6;
      input.connect(c).connect(output);
      return {
        input, output, latency: 0.006,
        set(k, v) {
          if (k === 'threshold') ramp(ctx, c.threshold, v, 0.05);
          if (k === 'ratio') ramp(ctx, c.ratio, v, 0.05);
          if (k === 'attack') ramp(ctx, c.attack, v / 1000, 0.05);
          if (k === 'release') ramp(ctx, c.release, v / 1000, 0.05);
          if (k === 'output') ramp(ctx, output.gain, db(v));
        },
      };
    },
  },
  {
    id: 'night', cat: 'dyn', name: '야간 모드', desc: '큰 소리는 줄이고 작은 소리는 또렷하게',
    params: [R('amount', '세기', 0, 100, 60, '%')],
    build(ctx) {
      const input = stereo(ctx), ls = biquad(ctx, 'lowshelf', 90), c = ctx.createDynamicsCompressor(), output = stereo(ctx);
      c.knee.value = 12; c.attack.value = 0.004; c.release.value = 0.3;
      input.connect(ls).connect(c).connect(output);
      return {
        input, output, latency: 0.006,
        set(k, v) {
          const a = v / 100;
          ramp(ctx, c.threshold, -18 - a * 30, 0.05); ramp(ctx, c.ratio, 3 + a * 9, 0.05);
          ramp(ctx, ls.gain, -a * 5); ramp(ctx, output.gain, db(a * 3));
        },
      };
    },
  },
  {
    id: 'leveler', cat: 'dyn', name: '볼륨 평준화', desc: '곡마다 다른 음량을 비슷하게 맞춤',
    params: [R('target', '목표 음량', -30, -6, -16, 'dB'), R('maxgain', '최대 증폭', 0, 24, 12, 'dB'),
      S('speed', '반응 속도', [[0, '느리게'], [1, '보통'], [2, '빠르게']], 1)],
    build: wk('ul-leveler', { target: ['target'], maxgain: ['maxgain'], speed: ['speed', Number] }),
  },
  {
    id: 'limiter', cat: 'dyn', name: '리미터', desc: '효과로 커진 소리가 찢어지지 않게 — 원음만 들을 때는 손대지 않아요',
    params: [R('ceiling', '최대 레벨', -6, 0, -1, 'dB', 0.1), R('release', '릴리즈', 10, 500, 80, 'ms')],
    build(ctx) {
      // 웹 오디오 압축기는 스스로 '메이크업 이득'((1/최대감쇠)^0.6)을 더해 기준 아래 소리까지 키운다 → 그만큼 되돌려
      // 기준 아래는 원음 그대로(1배), 넘는 봉우리만 최대 레벨 근처로 누른다. 압축기는 1ms 정도 늦게 반응해 아주 짧은
      // 순간음이 살짝 넘으므로 기준을 최대 레벨보다 1dB 낮게 → 그 뒤 엔진의 안전망(0.9 부터)은 거의 손대지 않음
      const input = stereo(ctx), c = ctx.createDynamicsCompressor(), comp = gain(ctx, 1), output = stereo(ctx);
      const R = 20;
      c.knee.value = 0; c.ratio.value = R; c.attack.value = 0.001; c.release.value = 0.08;
      const setCeil = (v, tc) => { const T = v - 1; ramp(ctx, c.threshold, T, tc); ramp(ctx, comp.gain, db(0.6 * T * (1 - 1 / R)), tc); };
      setCeil(-1, 0);
      input.connect(c).connect(comp).connect(output);
      return {
        input, output, latency: 0.006,
        set(k, v) {
          if (k === 'ceiling') setCeil(v, 0.05);
          if (k === 'release') ramp(ctx, c.release, v / 1000, 0.05);
        },
      };
    },
  },

  /* 보컬 */
  {
    id: 'karaoke', cat: 'vocal', name: '보컬 제거 (노래방)', desc: '가운데 목소리를 지우고 반주만',
    params: [R('strength', '제거 강도', 0, 100, 100, '%'), R('low', '저음 보존', 60, 400, 140, 'Hz', 5), R('high', '고음 보존', 3000, 15000, 9000, 'Hz', 100)],
    build(ctx) {
      // 가운데(M)를 빼고 좌우 차이(S)만 남기되, 저음 · 아주 높은 고음(가운데 있는 베이스 · 심벌)은 되살린다
      const input = stereo(ctx), output = stereo(ctx), dry = gain(ctx, 0), wet = gain(ctx, 1);
      input.connect(dry).connect(output);
      const { M, S: Sd } = msSplit(ctx, input);
      const l1 = biquad(ctx, 'lowpass', 140), l2 = biquad(ctx, 'lowpass', 140), h1 = biquad(ctx, 'highpass', 9000), h2 = biquad(ctx, 'highpass', 9000), hg = gain(ctx, 0.7), keep = mono(ctx);
      M.connect(l1).connect(l2).connect(keep); M.connect(h1).connect(h2).connect(hg).connect(keep);
      const Sx = mono(ctx), st = stereo(ctx); Sd.connect(Sx);
      msJoin(ctx, keep, Sx, st); st.connect(wet).connect(output);
      return {
        input, output,
        set(k, v) {
          if (k === 'strength') { const s = v / 100; ramp(ctx, wet.gain, s); ramp(ctx, dry.gain, 1 - s); }
          if (k === 'low') { ramp(ctx, l1.frequency, v); ramp(ctx, l2.frequency, v); }
          if (k === 'high') { ramp(ctx, h1.frequency, v); ramp(ctx, h2.frequency, v); }
        },
      };
    },
  },
  {
    id: 'vocal', cat: 'vocal', name: '보컬 강조', desc: '목소리를 앞으로 또렷하게',
    params: [R('amount', '세기', 0, 100, 60, '%')],
    build(ctx) {
      // 가운데(목소리)의 존재감 대역을 올리고 좌우 반주를 살짝 줄임
      const input = stereo(ctx), output = stereo(ctx), { M, S: Sd } = msSplit(ctx, input);
      const p1 = biquad(ctx, 'peaking', 1800, 0.6, 0), p2 = biquad(ctx, 'peaking', 3600, 1.0, 0), sg = gain(ctx, 1), Mx = mono(ctx), Sx = mono(ctx), norm = stereo(ctx);
      M.connect(p1).connect(p2).connect(Mx); Sd.connect(sg).connect(Sx);
      msJoin(ctx, Mx, Sx, norm); norm.connect(output);
      let a = 0;
      return {
        input, output,
        set(k, v) {
          if (k !== 'amount') return;
          a = v / 100;
          ramp(ctx, p1.gain, a * 8); ramp(ctx, p2.gain, a * 4); ramp(ctx, sg.gain, 1 - 0.35 * a); ramp(ctx, norm.gain, 1 / (1 + a * 0.35));
        },
        resp: fr => rbjDb('peaking', 1800, 0.6, a * 8, fr, ctx.sampleRate) + rbjDb('peaking', 3600, 1, a * 4, fr, ctx.sampleRate) + 20 * Math.log10(1 / (1 + a * 0.35)),
      };
    },
  },

  /* 변조 */
  {
    id: 'chorus', cat: 'mod', name: '코러스', desc: '여러 명이 함께 연주하는 듯 풍성하게',
    params: [R('rate', '속도', 0.05, 5, 0.8, 'Hz', 0.05), R('depth', '깊이', 0, 100, 50, '%'), R('mix', '적용량', 0, 100, 50, '%')],
    build(ctx) {
      const input = stereo(ctx), output = stereo(ctx), dry = gain(ctx, 0.75), wet = gain(ctx, 0.2);
      input.connect(dry).connect(output);
      const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2), wl = mono(ctx), wr = mono(ctx);
      input.connect(sp); wl.connect(mg, 0, 0); wr.connect(mg, 0, 1); mg.connect(wet).connect(output);
      const BASE = 0.016, voices = [[0, 1, 0], [0, 1.37, 2.1], [1, 1, 1.57], [1, 1.37, 3.67]];
      const parts = voices.map(([ch, bm, ph]) => {
        const d = ctx.createDelay(0.1), o = lfo(ctx, 0.8, ph), g = gain(ctx, 0);
        d.delayTime.value = BASE * bm;
        o.connect(g).connect(d.delayTime); sp.connect(d, ch); d.connect(ch ? wr : wl);
        return { d, o, g, bm };
      });
      return {
        input, output,
        set(k, v) {
          if (k === 'rate') parts.forEach(p => ramp(ctx, p.o.frequency, v, 0.1));
          if (k === 'depth') { const dep = v / 100 * 0.007; parts.forEach(p => { ramp(ctx, p.g.gain, dep, 0.06); ramp(ctx, p.d.delayTime, BASE * p.bm + dep, 0.06); }); }
          if (k === 'mix') { const m = v / 100; ramp(ctx, dry.gain, 1 - 0.5 * m); ramp(ctx, wet.gain, m * 0.4); }
        },
        dispose() { stopAll(parts.map(p => p.o)); },
      };
    },
  },
  {
    id: 'flanger', cat: 'mod', name: '플랜저', desc: '제트기 같은 휘어지는 소리',
    params: [R('rate', '속도', 0.02, 3, 0.25, 'Hz', 0.01), R('depth', '깊이', 0, 100, 70, '%'), R('feedback', '피드백', -95, 95, 50, '%', 1, { center: 0 }), R('mix', '적용량', 0, 100, 80, '%')],
    build(ctx) {
      // 되먹임이 있는 지연은 한 블록(128 샘플) 이상이어야 해서 2.9ms 부터 쓸어 올림
      const MIN = 0.0029;
      const input = stereo(ctx), output = stereo(ctx), dry = gain(ctx, 0.6), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2), wet = gain(ctx, 0.4);
      input.connect(dry).connect(output); input.connect(sp); mg.connect(wet).connect(output);
      const sides = [0, Math.PI / 2].map((ph, ch) => {
        const sum = mono(ctx), d = ctx.createDelay(0.05), fb = gain(ctx, 0.5), o = lfo(ctx, 0.25, ph), g = gain(ctx, 0);
        d.delayTime.value = MIN;
        sp.connect(sum, ch); sum.connect(d); d.connect(fb).connect(sum); d.connect(mg, 0, ch);
        o.connect(g).connect(d.delayTime);
        return { d, fb, o, g };
      });
      return {
        input, output,
        set(k, v) {
          if (k === 'rate') sides.forEach(s => ramp(ctx, s.o.frequency, v, 0.1));
          if (k === 'depth') { const span = v / 100 * 0.0045; sides.forEach(s => { ramp(ctx, s.g.gain, span / 2, 0.06); ramp(ctx, s.d.delayTime, MIN + span / 2, 0.06); }); }
          if (k === 'feedback') sides.forEach(s => ramp(ctx, s.fb.gain, v / 100 * 0.92));
          if (k === 'mix') { const m = v / 100; ramp(ctx, dry.gain, 1 - m * 0.5); ramp(ctx, wet.gain, m * 0.5); }
        },
        dispose() { stopAll(sides.map(s => s.o)); },
      };
    },
  },
  {
    id: 'phaser', cat: 'mod', name: '페이저', desc: '물결치듯 움직이는 소리',
    params: [R('rate', '속도', 0.02, 5, 0.4, 'Hz', 0.01), R('depth', '깊이', 0, 100, 70, '%'), R('feedback', '피드백', 0, 90, 40, '%'), R('mix', '적용량', 0, 100, 100, '%')],
    build(ctx) {
      // 올패스 필터 3단(1차 6단 효과)의 주파수를 LFO 로 지수적으로(detune, 센트) 쓸어 원음과 섞으면 홈이 움직임
      const FMIN = 180;
      const input = stereo(ctx), output = stereo(ctx), dry = gain(ctx, 0.5), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2), wet = gain(ctx, 0.5);
      input.connect(dry).connect(output); input.connect(sp); mg.connect(wet).connect(output);
      const sides = [0, 1.2].map((ph, ch) => {
        const aps = [0, 1, 2].map(() => biquad(ctx, 'allpass', 600, 0.6));
        const o = lfo(ctx, 0.4, ph), g = gain(ctx, 0);
        let node = sp, out = ch; for (const ap of aps) { node.connect(ap, out); node = ap; out = 0; o.connect(g); g.connect(ap.detune); }
        node.connect(mg, 0, ch);
        return { aps, o, g };
      });
      return {
        input, output,
        set(k, v) {
          if (k === 'rate') sides.forEach(s => ramp(ctx, s.o.frequency, v, 0.1));
          if (k === 'depth') {
            const ratio = Math.pow(2, 1 + v / 100 * 4.2), fc = FMIN * Math.sqrt(ratio), cents = 1200 * Math.log2(ratio) / 2;
            sides.forEach(s => { s.aps.forEach(ap => ramp(ctx, ap.frequency, fc, 0.06)); ramp(ctx, s.g.gain, cents, 0.06); });
          }
          if (k === 'feedback') sides.forEach(s => s.aps.forEach(ap => ramp(ctx, ap.Q, 0.5 + v / 100 * 3)));
          if (k === 'mix') { const m = v / 100; ramp(ctx, dry.gain, 1 - m * 0.5); ramp(ctx, wet.gain, m * 0.5); }
        },
        dispose() { stopAll(sides.map(s => s.o)); },
      };
    },
  },
  {
    id: 'tremolo', cat: 'mod', name: '트레몰로', desc: '음량이 규칙적으로 떨림',
    params: [R('rate', '속도', 0.5, 15, 5, 'Hz', 0.1), R('depth', '깊이', 0, 100, 50, '%')],
    build(ctx) {
      const input = stereo(ctx), output = stereo(ctx), g = gain(ctx, 0.75), o = lfo(ctx, 5, Math.PI / 2), lg = gain(ctx, 0.25);
      input.connect(g).connect(output); o.connect(lg).connect(g.gain);
      return {
        input, output,
        set(k, v) {
          if (k === 'rate') ramp(ctx, o.frequency, v, 0.08);
          if (k === 'depth') { const d = v / 100; ramp(ctx, g.gain, 1 - d / 2); ramp(ctx, lg.gain, d / 2); }
        },
        dispose() { stopAll([o]); },
      };
    },
  },
  {
    id: 'vibrato', cat: 'mod', name: '비브라토', desc: '음정이 규칙적으로 떨림',
    params: [R('rate', '속도', 0.5, 12, 5, 'Hz', 0.1), R('depth', '깊이', 0, 100, 30, '%')],
    build(ctx) {
      const input = stereo(ctx), output = stereo(ctx), d = ctx.createDelay(0.05), o = lfo(ctx, 5), g = gain(ctx, 0);
      d.delayTime.value = 0.005;
      input.connect(d).connect(output); o.connect(g).connect(d.delayTime);
      return {
        input, output,
        set(k, v) { if (k === 'rate') ramp(ctx, o.frequency, v, 0.08); if (k === 'depth') ramp(ctx, g.gain, v / 100 * 0.0035, 0.06); },
        dispose() { stopAll([o]); },
      };
    },
  },
  {
    id: 'autopan', cat: 'mod', name: '오토 팬', desc: '소리가 좌우로 천천히 오감',
    params: [R('rate', '속도', 0.02, 5, 0.3, 'Hz', 0.01), R('depth', '깊이', 0, 100, 80, '%')],
    build(ctx) {
      // 좌우 음량만 바꿈(채널을 섞지 않아 1 을 넘지 않음): LFO(−1~1) → 곡선(등전력 밸런스) → 왼쪽 · 오른쪽 게인
      const input = stereo(ctx), output = stereo(ctx), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      const gl = gain(ctx, 0), gr = gain(ctx, 0), o = lfo(ctx, 0.3), dep = gain(ctx, 0);
      const shL = ctx.createWaveShaper(), shR = ctx.createWaveShaper();
      shL.curve = makeCurve(p => Math.min(1, Math.cos((p + 1) * Math.PI / 4) * Math.SQRT2), 1, 1025);
      shR.curve = makeCurve(p => Math.min(1, Math.sin((p + 1) * Math.PI / 4) * Math.SQRT2), 1, 1025);
      input.connect(sp); sp.connect(gl, 0); sp.connect(gr, 1); gl.connect(mg, 0, 0); gr.connect(mg, 0, 1); mg.connect(output);
      o.connect(dep); dep.connect(shL).connect(gl.gain); dep.connect(shR).connect(gr.gain);
      return {
        input, output,
        set(k, v) { if (k === 'rate') ramp(ctx, o.frequency, v, 0.1); if (k === 'depth') ramp(ctx, dep.gain, v / 100, 0.06); },
        dispose() { stopAll([o]); },
      };
    },
  },
  {
    id: 'rotary', cat: 'mod', name: '로터리 스피커', desc: '회전 스피커 특유의 울렁임',
    params: [S('speed', '회전', [[0, '느리게'], [1, '빠르게']], 1), R('mix', '적용량', 0, 100, 100, '%')],
    build(ctx) {
      // 고음(혼): 도플러(지연 흔들림) + 음량 · 좌우 회전, 저음(드럼): 느린 음량 · 좌우 흔들림. 속도를 바꾸면 천천히 가속 · 감속
      const input = stereo(ctx), output = stereo(ctx), dry = gain(ctx, 0), wet = gain(ctx, 1.3), m = mono(ctx);
      input.connect(dry).connect(output); input.connect(m);
      const lo1 = biquad(ctx, 'lowpass', 800), lo2 = biquad(ctx, 'lowpass', 800), hi1 = biquad(ctx, 'highpass', 800), hi2 = biquad(ctx, 'highpass', 800);
      const hS = lfo(ctx, 6.7), hC = lfo(ctx, 6.7, Math.PI / 2), dS = lfo(ctx, 5.8), dC = lfo(ctx, 5.8, Math.PI / 2);
      const hd = ctx.createDelay(0.01), hdg = gain(ctx, 0.00035), ha = gain(ctx, 0.825), hag = gain(ctx, 0.175), hp = ctx.createStereoPanner(), hpg = gain(ctx, 0.4);
      hd.delayTime.value = 0.0015;
      m.connect(hi1).connect(hi2).connect(hd).connect(ha).connect(hp).connect(wet);
      hS.connect(hdg).connect(hd.delayTime); hC.connect(hag).connect(ha.gain); hS.connect(hpg).connect(hp.pan);
      const da = gain(ctx, 0.9), dag = gain(ctx, 0.1), dp = ctx.createStereoPanner(), dpg = gain(ctx, 0.2);
      m.connect(lo1).connect(lo2).connect(da).connect(dp).connect(wet);
      dC.connect(dag).connect(da.gain); dS.connect(dpg).connect(dp.pan);
      wet.connect(output);
      return {
        input, output,
        set(k, v) {
          if (k === 'speed') {
            const fast = Number(v) > 0.5;
            [hS, hC].forEach(o => ramp(ctx, o.frequency, fast ? 6.7 : 0.8, 0.7)); [dS, dC].forEach(o => ramp(ctx, o.frequency, fast ? 5.8 : 0.66, 2.5));
          }
          if (k === 'mix') { const mm = v / 100; ramp(ctx, dry.gain, 1 - mm); ramp(ctx, wet.gain, mm * 1.3); }
        },
        dispose() { stopAll([hS, hC, dS, dC]); },
      };
    },
  },

  /* 속도 · 키 */
  {
    id: 'speed', cat: 'pitch', name: '재생 속도', desc: '빠르게 · 느리게 (음정 유지 가능)', pseudo: true,
    params: [R('rate', '속도', 50, 200, 100, '%', 5), T('keep', '음정 유지', true)],
  },
  {
    id: 'pitch', cat: 'pitch', name: '키 조절', desc: '속도는 그대로, 음정만 올리고 내림 (Signalsmith Stretch 엔진)',
    params: [R('semitones', '반음', -12, 12, 0, '', 0.5, { center: 0 })],
    build(ctx, opt = {}) {
      const input = stereo(ctx), output = stereo(ctx);
      let node = null, semis = 0, dead = false;
      const ready = loadStretch()
        .then(SS => SS(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' }))
        .then(async n => {
          if (dead) { try { n.shutdown(); } catch (e) { /* noop */ } return; }
          node = n;
          await n.configure(opt.light ? { blockMs: 100, intervalMs: 40, splitComputation: true } : { blockMs: 120, intervalMs: 30, splitComputation: true });
          await n.schedule({ active: true, semitones: semis });          // 처리기가 받은 뒤에 연결 (오프라인 렌더에서도 확실히)
          input.connect(n); n.connect(output);
        });
      return {
        input, output, ready, latency: 0.15,
        set(k, v) { if (k === 'semitones') { semis = v; if (node) node.schedule({ semitones: v }); } },
        dispose() { dead = true; if (node) { try { input.disconnect(node); node.disconnect(); node.shutdown(); } catch (e) { /* noop */ } } },
      };
    },
  },

  /* 특수 효과 */
  {
    id: 'radio', cat: 'fun', name: '라디오 · 전화', desc: '오래된 라디오나 전화기 소리',
    params: [S('mode', '종류', [['phone', '전화'], ['am', 'AM 라디오'], ['mega', '확성기'], ['walkie', '무전기']], 'am'), R('mix', '적용량', 0, 100, 100, '%')],
    build(ctx) {
      const dw = dryWet(ctx), m = mono(ctx), h1 = biquad(ctx, 'highpass', 200), h2 = biquad(ctx, 'highpass', 200),
        l1 = biquad(ctx, 'lowpass', 4500), l2 = biquad(ctx, 'lowpass', 4500), pk = biquad(ctx, 'peaking', 2000, 1, 3),
        pre = gain(ctx, 2), sh = ctx.createWaveShaper(), post = gain(ctx, 0.7), up = stereo(ctx);
      sh.curve = makeCurve(x => Math.tanh(x), 1); sh.oversample = '2x';
      dw.input.connect(m).connect(h1).connect(h2).connect(l1).connect(l2).connect(pk).connect(pre).connect(sh).connect(post).connect(up).connect(dw.wet);
      const MODES = { phone: [350, 3400, 1500, 4, 3], am: [180, 4800, 2500, 3, 2], mega: [550, 4200, 2000, 8, 8], walkie: [450, 2800, 1600, 6, 14] };
      return {
        input: dw.input, output: dw.output,
        set(k, v) {
          if (k === 'mode') {
            const [hp, lp, pf, pg, drive] = MODES[v] || MODES.am;
            [h1, h2].forEach(b => ramp(ctx, b.frequency, hp)); [l1, l2].forEach(b => ramp(ctx, b.frequency, lp));
            ramp(ctx, pk.frequency, pf); ramp(ctx, pk.gain, pg); ramp(ctx, pre.gain, drive); ramp(ctx, post.gain, 0.75 / Math.tanh(drive));
          }
          if (k === 'mix') dw.mix(v / 100);
        },
      };
    },
  },
  {
    id: 'underwater', cat: 'fun', name: '수중', desc: '물속에서 듣는 듯 먹먹하게',
    params: [R('depth', '깊이', 0, 100, 60, '%'), R('wobble', '일렁임', 0, 100, 40, '%')],
    build(ctx) {
      const input = stereo(ctx), l1 = biquad(ctx, 'lowpass', 800, 2.5), l2 = biquad(ctx, 'lowpass', 800, 0.7), output = stereo(ctx, 0.9);
      input.connect(l1).connect(l2).connect(output);
      const osc = lfo(ctx, 0.27), og = gain(ctx, 0);
      osc.connect(og); og.connect(l1.frequency); og.connect(l2.frequency);
      let cut = 800, wob = 0.4;
      const apply = () => { ramp(ctx, l1.frequency, cut); ramp(ctx, l2.frequency, cut); ramp(ctx, og.gain, cut * 0.35 * wob); };
      return { input, output, set(k, v) { if (k === 'depth') cut = 1600 * Math.pow(0.15, v / 100); if (k === 'wobble') wob = v / 100; apply(); }, dispose() { stopAll([osc]); } };
    },
  },
  {
    id: 'lofi', cat: 'fun', name: '로파이 · 비트크러셔', desc: '옛날 게임기 · 저음질 디지털 소리',
    params: [R('bits', '비트', 2, 16, 8, 'bit'), R('down', '샘플 줄이기', 1, 32, 4, '×'), R('mix', '적용량', 0, 100, 100, '%')],
    build(ctx) {
      let bits = 8;
      const dw = dryWet(ctx), l1 = biquad(ctx, 'lowpass', 6000, 0.9), l2 = biquad(ctx, 'lowpass', 6000, 0.6);
      const sw = swapper(ctx, () => {
        const sh = ctx.createWaveShaper(), s = Math.pow(2, Math.round(bits) - 1);
        sh.curve = makeCurve(u => Math.round(u * s) / s, 1, Math.min(65536, Math.max(4096, s * 16)));
        return { input: sh, output: sh };
      }, { fade: 0.05 });
      dw.input.connect(sw.input); sw.output.connect(l1).connect(l2).connect(dw.wet);
      return {
        input: dw.input, output: dw.output, dispose: sw.dispose,
        set(k, v) {
          if (k === 'bits' && Math.round(v) !== Math.round(bits)) { bits = v; sw.update(); }
          if (k === 'down') { const f = Math.min(ctx.sampleRate * 0.45, ctx.sampleRate / (2 * Math.max(1, v))); ramp(ctx, l1.frequency, f); ramp(ctx, l2.frequency, f); }
          if (k === 'mix') dw.mix(v / 100);
        },
      };
    },
  },
  {
    id: 'vinyl', cat: 'fun', name: 'LP 레코드', desc: '지글거림과 아날로그 감성',
    params: [R('crackle', '지글거림', 0, 100, 50, '%'), R('noise', '잡음', 0, 100, 30, '%'), R('wow', '흔들림', 0, 100, 30, '%'), R('tone', '오래된 정도', 0, 100, 50, '%')],
    build(ctx) {
      const input = stereo(ctx), output = stereo(ctx), hp = biquad(ctx, 'highpass', 45), lp = biquad(ctx, 'lowpass', 9500, 0.6), d = ctx.createDelay(0.05);
      d.delayTime.value = 0.004;
      input.connect(hp).connect(lp).connect(d).connect(output);
      const w1 = lfo(ctx, 0.55), w1g = gain(ctx, 0), w2 = lfo(ctx, 6.5), w2g = gain(ctx, 0);
      w1.connect(w1g).connect(d.delayTime); w2.connect(w2g).connect(d.delayTime);
      const nb = vinylNoise(ctx);
      const mk = buf => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
      const hiss = mk(nb.hiss), sparse = mk(nb.sparse), dense = mk(nb.dense);
      const hg = gain(ctx, 0), sg = gain(ctx, 0), dg = gain(ctx, 0);
      hiss.connect(hg).connect(output); sparse.connect(sg).connect(output); dense.connect(dg).connect(output);
      return {
        input, output,
        set(k, v) {
          const a = v / 100;
          if (k === 'tone') ramp(ctx, lp.frequency, 16000 * Math.pow(0.35, a));
          if (k === 'noise') ramp(ctx, hg.gain, a * 0.012);
          if (k === 'crackle') { ramp(ctx, sg.gain, Math.min(1, a * 2) * (0.4 + a)); ramp(ctx, dg.gain, Math.max(0, a * 2 - 1) * (0.4 + a)); }
          if (k === 'wow') { ramp(ctx, w1g.gain, a * 0.0011, 0.1); ramp(ctx, w2g.gain, a * 0.00012, 0.1); }
        },
        dispose() { stopAll([w1, w2, hiss, sparse, dense]); },
      };
    },
  },
  {
    id: 'overdrive', cat: 'fun', name: '오버드라이브', desc: '기타 앰프처럼 거칠게',
    params: [R('drive', '드라이브', 0, 100, 50, '%'), R('tone', '톤', 500, 12000, 4000, 'Hz', 100), R('mix', '적용량', 0, 100, 100, '%')],
    build(ctx) {
      const dw = dryWet(ctx), RANGE = 40, hp = biquad(ctx, 'highpass', 80), pre = gain(ctx, 1 / RANGE), sh = ctx.createWaveShaper(),
        lp = biquad(ctx, 'lowpass', 4000), post = gain(ctx, 0.5);
      sh.curve = makeCurve(x => Math.tanh(x), RANGE, 8192); sh.oversample = '4x';
      dw.input.connect(hp).connect(pre).connect(sh).connect(lp).connect(post).connect(dw.wet);
      return {
        input: dw.input, output: dw.output,
        set(k, v) {
          if (k === 'drive') { const d = 1 + Math.pow(v / 100, 1.5) * 39; ramp(ctx, pre.gain, d / RANGE); ramp(ctx, post.gain, 1.0 / Math.sqrt(d)); }
          if (k === 'tone') ramp(ctx, lp.frequency, v);
          if (k === 'mix') dw.mix(v / 100);
        },
      };
    },
  },

  /* 채널 */
  {
    id: 'balance', cat: 'util', name: '좌우 밸런스', desc: '왼쪽 · 오른쪽 음량 조절',
    params: [R('balance', '밸런스', -100, 100, 0, '', 1, { center: 0, fmt: v => v === 0 ? '가운데' : v < 0 ? `왼쪽 ${-v}` : `오른쪽 ${v}` })],
    build(ctx) {
      const input = stereo(ctx), output = stereo(ctx), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2), gl = gain(ctx), gr = gain(ctx);
      input.connect(sp); sp.connect(gl, 0); sp.connect(gr, 1); gl.connect(mg, 0, 0); gr.connect(mg, 0, 1); mg.connect(output);
      return { input, output, set(k, v) { const b = v / 100; ramp(ctx, gl.gain, b > 0 ? 1 - b : 1); ramp(ctx, gr.gain, b < 0 ? 1 + b : 1); } };
    },
  },
  {
    id: 'mono', cat: 'util', name: '모노', desc: '좌우를 하나로 (한쪽 이어폰 사용 시)', params: [],
    build(ctx) { const input = mono(ctx), output = stereo(ctx); input.connect(output); return { input, output, set() {} }; },
  },
  {
    id: 'swap', cat: 'util', name: '좌우 바꾸기', desc: '왼쪽과 오른쪽 채널 교환', params: [],
    build(ctx) {
      const input = stereo(ctx), output = stereo(ctx), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      input.connect(sp); sp.connect(mg, 0, 1); sp.connect(mg, 1, 0); mg.connect(output);
      return { input, output, set() {} };
    },
  },
];

/** bs2b 크로스피드 (Boris Mikhaylov 의 공식, MIT): 반대쪽에 저역(1차 저역 통과)을, 같은 쪽은 고역 쉘프로 */
function bs2b(ctx, fc, feed) {
  const sr = ctx.sampleRate;
  const GB_lo = feed * -5 / 6 - 3, GB_hi = feed / 6 - 3;
  const G_lo = Math.pow(10, GB_lo / 20), G_hi = 1 - Math.pow(10, GB_hi / 20);
  const Fc_hi = fc * Math.pow(2, (GB_lo - 20 * Math.log10(G_hi)) / 12);
  const g = 1 / (1 - G_hi + G_lo);
  const xl = Math.exp(-2 * Math.PI * fc / sr), xh = Math.exp(-2 * Math.PI * Math.min(Fc_hi, sr * 0.45) / sr);
  const input = stereo(ctx), output = stereo(ctx);
  const hi = ctx.createIIRFilter([(1 - G_hi * (1 - xh)) * g, -xh * g], [1, -xh]);
  const lo = ctx.createIIRFilter([G_lo * (1 - xl) * g], [1, -xl]);
  const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
  input.connect(hi).connect(output);
  input.connect(lo).connect(sp); sp.connect(mg, 0, 1); sp.connect(mg, 1, 0); mg.connect(output);
  return { input, output };
}

/** LP 잡음 버퍼 (컨텍스트마다 한 번): 쉬익 소리 · 드문 지글거림 · 잦은 지글거림 */
const noiseCache = new WeakMap();
function vinylNoise(ctx) {
  let c = noiseCache.get(ctx);
  if (c) return c;
  const sr = ctx.sampleRate, n = Math.round(sr * 6.1);
  let s = 12345;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const hiss = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) { const d = hiss.getChannelData(ch); let lp = 0; for (let i = 0; i < n; i++) { lp += ((rnd() * 2 - 1) - lp) * 0.35; d[i] = lp; } }
  const pops = prob => {
    const b = ctx.createBuffer(2, Math.round(sr * (prob < 0.0002 ? 7.3 : 5.7)), sr), L = b.getChannelData(0), R = b.getChannelData(1);
    let cl = 0, cr = 0;
    for (let i = 0; i < L.length; i++) {
      if (rnd() < prob) { const a = (0.04 + 0.45 * Math.pow(rnd(), 3)) * (rnd() < 0.5 ? -1 : 1), w = rnd(); cl += a * (0.5 + w * 0.5); cr += a * (1 - w * 0.5); }
      cl *= 0.55; cr *= 0.55; L[i] = cl; R[i] = cr;
    }
    return b;
  };
  c = { hiss, sparse: pops(0.00012), dense: pops(0.0006) };
  noiseCache.set(ctx, c);
  return c;
}

/** 신호가 지나가는 순서: 보컬 → 음색 → 다이내믹 → 변조 → 키 → 특수 → 공간 → 잔향 → 입체(헤드폰) → 채널 → 리미터 */
export const ORDER = ['eq', 'karaoke', 'vocal', 'bass', 'vbass', 'subharm', 'treble', 'loudness', 'crystal', 'exciter', 'warm',
  'compressor', 'night', 'leveler', 'chorus', 'flanger', 'phaser', 'tremolo', 'vibrato', 'autopan', 'rotary', 'pitch',
  'radio', 'underwater', 'lofi', 'vinyl', 'overdrive', 'wide', 'haas', 'surround', 'echo', 'reverb', 'hall',
  'virtualizer', 'rotate8d', 'crossfeed', 'mono', 'swap', 'balance', 'limiter'];

export const FX_BY_ID = Object.fromEntries(FX.map(f => [f.id, f]));

export function defaultParams(def) {
  const o = {};
  for (const p of def.params) o[p.k] = p.def;
  return o;
}

/* ---------- 빠른 조절 (음장 효과 화면 맨 위의 휠) ----------
 * 휠 하나가 효과 하나의 대표 값을 움직임: 0(또는 가운데)이면 효과를 끄고, 돌리면 켠다 */
export const MACROS = [
  { id: 'bass', label: '저음', fx: 'bass', k: 'gain', min: 0, max: 12, step: 0.5, unit: 'dB' },
  { id: 'treble', label: '고음', fx: 'treble', k: 'gain', min: -8, max: 8, step: 0.5, unit: 'dB', center: 0 },
  { id: 'space', label: '울림', fx: 'hall', k: 'mix', min: 0, max: 60, step: 1, unit: '%' },
  { id: 'surround', label: '입체감', fx: 'surround', k: 'depth', min: 0, max: 100, step: 1, unit: '%' },
  { id: 'clarity', label: '선명도', fx: 'exciter', k: 'amount', min: 0, max: 100, step: 1, unit: '%' },
  { id: 'vocal', label: '보컬', fx: 'vocal', k: 'amount', min: 0, max: 100, step: 1, unit: '%' },
];

/* ---------- 10밴드 그래픽 EQ ---------- */
export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_SHAPE = EQ_FREQS.map((f, i) => (i === 0 ? ['lowshelf', 45] : i === EQ_FREQS.length - 1 ? ['highshelf', 12000] : ['peaking', f]));
export function buildEQ(ctx) {
  const input = stereo(ctx), pre = gain(ctx, 1);
  const g = EQ_FREQS.map(() => 0);
  const bands = EQ_SHAPE.map(([type, f]) => biquad(ctx, type, f, 1.1, 0));
  input.connect(pre);
  let node = pre;
  for (const b of bands) { node.connect(b); node = b; }
  const output = stereo(ctx);
  node.connect(output);
  return {
    input, output, bands,
    set(k, v) {
      if (k === 'preamp') return ramp(ctx, pre.gain, db(v));
      const i = +k.slice(1);
      if (bands[i]) { g[i] = v; ramp(ctx, bands[i].gain, v, 0.02); }
    },
    resp: fr => { let s = 0; for (let i = 0; i < bands.length; i++) if (g[i]) s += rbjDb(EQ_SHAPE[i][0], EQ_SHAPE[i][1], 1.1, g[i], fr, ctx.sampleRate); return s; },
  };
}
