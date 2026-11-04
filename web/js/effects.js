/*
 * 울림 — 음장 효과 정의
 * 각 효과: { id, cat, name, desc, params[], build(ctx) → { input, output, set(k, v) } }
 * 값은 화면 단위(%, dB, Hz …)로 받고 build 안에서 DSP 값으로 바꾼다.
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

/* ---------- node helpers ---------- */
const now = ctx => ctx.currentTime;
function stereo(ctx, gain = 1) {
  const g = ctx.createGain();
  g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
  g.gain.value = gain;
  return g;
}
function mono(ctx, gain = 1) {
  const g = ctx.createGain();
  g.channelCount = 1; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
  g.gain.value = gain;
  return g;
}
function gain(ctx, v = 1) { const g = ctx.createGain(); g.gain.value = v; return g; }
function biquad(ctx, type, f, q = 0.7071, g = 0) {
  const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g; return b;
}
function ramp(ctx, param, v, tc = 0.03) {
  param.cancelScheduledValues(now(ctx));
  param.setTargetAtTime(v, now(ctx), tc);
}
const db = v => Math.pow(10, v / 20);

function makeCurve(fn, range = 1, n = 4096) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = fn(x * range); }
  return c;
}

/** Dry/wet wrapper: input → dry → output, input → [effect] → wet → output */
function dryWet(ctx) {
  const input = stereo(ctx), output = stereo(ctx), dry = gain(ctx, 1), wet = gain(ctx, 1);
  input.connect(dry).connect(output); wet.connect(output);
  return {
    input, output, dry, wet,
    mix(m) { // equal-ish loudness
      ramp(ctx, dry.gain, Math.cos(m * Math.PI / 2) ** 0.8);
      ramp(ctx, wet.gain, Math.sin(m * Math.PI / 2) ** 0.8);
    },
  };
}

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

/** Worklet-backed effect. map: uiKey → [workletParam, transform?] */
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
        prm.setValueAtTime(t[1] ? t[1](v) : v, now(ctx));
      },
      dispose() { try { node.port.postMessage('stop'); node.port.close(); } catch (e) { /* noop */ } },   // 처리기를 멈춰야 스레드에서 빠짐
    };
  };
  fn.worklet = name;
  return fn;
}
const pct = v => v / 100;

/* ---------- convolution IR synthesis ---------- */
export const SPACES = {
  room: { label: '룸', decay: 0.7, pre: 0.004, bright: 0.65, er: [[0.007, 0.5], [0.011, 0.4], [0.017, 0.3], [0.023, 0.25]] },
  studio: { label: '스튜디오', decay: 0.45, pre: 0.002, bright: 0.75, er: [[0.005, 0.4], [0.009, 0.3], [0.013, 0.2]] },
  hall: { label: '콘서트홀', decay: 2.3, pre: 0.022, bright: 0.5, er: [[0.019, 0.45], [0.027, 0.38], [0.035, 0.32], [0.043, 0.26], [0.052, 0.22]] },
  church: { label: '대성당', decay: 5.2, pre: 0.04, bright: 0.35, er: [[0.035, 0.4], [0.051, 0.35], [0.067, 0.3], [0.083, 0.25]] },
  arena: { label: '아레나', decay: 3.4, pre: 0.06, bright: 0.45, er: [[0.06, 0.5], [0.09, 0.4], [0.12, 0.3]] },
  plate: { label: '플레이트', decay: 1.8, pre: 0, bright: 0.85, er: [] },
  cave: { label: '동굴', decay: 4.0, pre: 0.03, bright: 0.3, er: [[0.05, 0.6], [0.11, 0.5], [0.17, 0.4], [0.23, 0.3]] },
};
export function makeIR(ctx, key, mul = 1) {
  const sp = SPACES[key] || SPACES.hall, sr = ctx.sampleRate;
  const decay = sp.decay * mul, len = Math.ceil((sp.pre + decay * 1.15) * sr);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let s = ch ? 0x2545f491 : 0x9e3779b9, lp = 0;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const pre = Math.round(sp.pre * sr);
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const a = sp.bright * (0.22 + 0.78 * Math.exp(-3 * t / decay));
      lp += a * ((rnd() * 2 - 1) - lp);
      const fadeIn = Math.min(1, (i - pre) / (0.002 * sr));
      d[i] = lp * Math.exp(-6.9 * t / decay) * fadeIn;
    }
    for (const [tm, g] of sp.er) {
      const idx = Math.round((sp.pre + tm * Math.sqrt(mul) + (ch ? 0.0011 : 0)) * sr);
      if (idx < len) d[idx] += g * (ch ? 0.92 : 1) * (rnd() < 0.5 ? -1 : 1);
    }
  }
  return buf;
}

/* ---------- effect list ---------- */
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
      const ll = gain(ctx), lr = gain(ctx), rl = gain(ctx), rr = gain(ctx);
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
    build: wk('ul-surround', { depth: ['depth', pct], delay: ['delay'] }),
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
      return {
        input: dw.input, output: dw.output,
        set(k, v) {
          if (k === 'angle') { setPos(fl, -v); setPos(fr, v); }
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
      const real = new Float32Array([0, 1]), imag = new Float32Array([0, 0]);
      const cosW = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
      const sinW = ctx.createPeriodicWave(imag, real, { disableNormalization: true });
      const oc = ctx.createOscillator(), os = ctx.createOscillator();
      oc.setPeriodicWave(sinW); os.setPeriodicWave(cosW);
      const gx = gain(ctx, 1), gz = gain(ctx, -1);
      if (p.positionX) {
        p.positionX.value = 0; p.positionZ.value = 0;
        oc.connect(gx).connect(p.positionX); os.connect(gz).connect(p.positionZ);
      }
      const t0 = ctx.currentTime + 0.02; oc.start(t0); os.start(t0);
      return {
        input: dw.input, output: dw.output,
        set(k, v) {
          if (k === 'period') { const f = 1 / v; oc.frequency.setValueAtTime(f, now(ctx)); os.frequency.setValueAtTime(f, now(ctx)); }
          if (k === 'mix') dw.mix(v / 100);
        },
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
      const apply = () => {
        dl.delayTime.setTargetAtTime(side === 'l' ? d / 1000 : 0, now(ctx), 0.02);
        dr.delayTime.setTargetAtTime(side === 'r' ? d / 1000 : 0, now(ctx), 0.02);
      };
      return { input, output, set(k, v) { if (k === 'delay') d = v; if (k === 'side') side = v; apply(); } };
    },
  },
  {
    id: 'crossfeed', cat: 'space', name: '헤드폰 크로스피드', desc: '좌우를 자연스럽게 섞어 귀의 피로 감소 (bs2b)',
    params: [R('fcut', '차단 주파수', 300, 2000, 700, 'Hz', 10), R('feed', '섞임 정도', 1, 15, 4.5, 'dB', 0.5)],
    build: wk('ul-crossfeed', { fcut: ['fcut'], feed: ['feed'] }),
  },

  /* 잔향 · 에코 */
  {
    id: 'reverb', cat: 'reverb', name: '리버브', desc: '자연스러운 알고리즘 잔향 (Freeverb)',
    params: [R('room', '공간 크기', 0, 100, 60, '%'), R('damp', '흡음', 0, 100, 50, '%'), R('mix', '잔향 양', 0, 100, 30, '%'),
      R('width', '퍼짐', 0, 100, 100, '%'), R('predelay', '프리딜레이', 0, 200, 20, 'ms')],
    build: wk('ul-freeverb', { room: ['room', pct], damp: ['damp', pct], mix: ['mix', pct], width: ['width', pct], predelay: ['predelay'] }),
  },
  {
    id: 'hall', cat: 'reverb', name: '공간 시뮬레이션', desc: '콘서트홀 · 대성당 등 실제 공간의 울림',
    params: [S('space', '공간', Object.entries(SPACES).map(([k, s]) => [k, s.label]), 'hall'),
      R('size', '울림 길이', 40, 200, 100, '%'), R('mix', '잔향 양', 0, 100, 25, '%')],
    build(ctx) {
      const dw = dryWet(ctx), conv = ctx.createConvolver();
      dw.input.connect(conv).connect(dw.wet);
      let space = 'hall', size = 100, timer = 0;
      const regen = () => { clearTimeout(timer); timer = setTimeout(() => { conv.buffer = makeIR(ctx, space, size / 100); }, 120); };
      conv.buffer = makeIR(ctx, space, 1);
      return {
        input: dw.input, output: dw.output,
        dispose() { clearTimeout(timer); },
        set(k, v) {
          if (k === 'space') { if (v !== space) { space = v; regen(); } }
          if (k === 'size') { if (v !== size) { size = v; regen(); } }
          if (k === 'mix') { ramp(ctx, dw.dry.gain, 1); ramp(ctx, dw.wet.gain, (v / 100) * 1.4); }
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
        dL.delayTime.setTargetAtTime(st.time / 1000, now(ctx), 0.05);
        dR.delayTime.setTargetAtTime(st.time / 1000, now(ctx), 0.05);
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
      const input = stereo(ctx), f = biquad(ctx, 'lowshelf', 80, 0.7071, 6), output = stereo(ctx);
      input.connect(f).connect(output);
      return { input, output, set(k, v) { if (k === 'gain') { ramp(ctx, f.gain, v); ramp(ctx, output.gain, db(-v * 0.25)); } if (k === 'freq') ramp(ctx, f.frequency, v); } };
    },
  },
  {
    id: 'vbass', cat: 'tone', name: '가상 저음', desc: '작은 스피커 · 이어폰에서도 묵직한 저음감',
    params: [R('amount', '세기', 0, 100, 50, '%'), R('cutoff', '기준 주파수', 50, 250, 110, 'Hz')],
    build: wk('ul-vbass', { amount: ['amount', pct], cutoff: ['cutoff'] }),
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
      const input = stereo(ctx), f = biquad(ctx, 'highshelf', 7000, 0.7071, 4), output = stereo(ctx);
      input.connect(f).connect(output);
      return { input, output, set(k, v) { if (k === 'gain') ramp(ctx, f.gain, v); if (k === 'freq') ramp(ctx, f.frequency, v); } };
    },
  },
  {
    id: 'loudness', cat: 'tone', name: '라우드니스', desc: '작은 볼륨에서도 저음 · 고음을 풍성하게',
    params: [R('amount', '세기', 0, 100, 50, '%')],
    build(ctx) {
      const input = stereo(ctx), lo = biquad(ctx, 'lowshelf', 90), hi = biquad(ctx, 'highshelf', 9000), output = stereo(ctx);
      input.connect(lo).connect(hi).connect(output);
      return { input, output, set(k, v) { const a = v / 100; ramp(ctx, lo.gain, a * 10); ramp(ctx, hi.gain, a * 6); ramp(ctx, output.gain, db(-a * 3)); } };
    },
  },
  {
    id: 'crystal', cat: 'tone', name: '크리스탈라이저', desc: '압축 음원의 생기와 선명도 회복',
    params: [R('intensity', '세기', 0, 100, 30, '%')],
    build: wk('ul-crystal', { intensity: ['intensity', v => v / 100 * 3] }),
  },
  {
    id: 'exciter', cat: 'tone', name: '익사이터', desc: '고음 배음을 더해 또렷하게',
    params: [R('amount', '세기', 0, 100, 40, '%'), R('freq', '시작 주파수', 1000, 10000, 3500, 'Hz', 100)],
    build: wk('ul-exciter', { amount: ['amount', pct], freq: ['freq'] }),
  },
  {
    id: 'warm', cat: 'tone', name: '진공관 웜', desc: '부드럽고 따뜻한 아날로그 질감',
    params: [R('drive', '드라이브', 0, 100, 40, '%'), R('mix', '적용량', 0, 100, 100, '%')],
    build(ctx) {
      const dw = dryWet(ctx), RANGE = 6;
      const pre = gain(ctx, 1 / RANGE), sh = ctx.createWaveShaper(), dc = biquad(ctx, 'highpass', 15), lp = biquad(ctx, 'lowpass', 15000), post = gain(ctx, 1);
      sh.curve = makeCurve(x => Math.tanh(x + 0.28 * x * x), RANGE); sh.oversample = '2x';
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
        input, output,
        set(k, v) {
          if (k === 'threshold') c.threshold.setValueAtTime(v, now(ctx));
          if (k === 'ratio') c.ratio.setValueAtTime(v, now(ctx));
          if (k === 'attack') c.attack.setValueAtTime(v / 1000, now(ctx));
          if (k === 'release') c.release.setValueAtTime(v / 1000, now(ctx));
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
        input, output,
        set(k, v) {
          const a = v / 100;
          c.threshold.setValueAtTime(-18 - a * 30, now(ctx)); c.ratio.setValueAtTime(3 + a * 9, now(ctx));
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
    id: 'limiter', cat: 'dyn', name: '리미터', desc: '찢어지는 소리(클리핑) 방지 — 켜 두는 것을 권장',
    params: [R('ceiling', '최대 레벨', -6, 0, -1, 'dB', 0.1), R('release', '릴리즈', 10, 500, 80, 'ms')],
    build(ctx) {
      const input = stereo(ctx), c = ctx.createDynamicsCompressor(), output = stereo(ctx);
      c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001; c.threshold.value = -1.5;
      // 안전용 소프트 클리퍼: 0.9 까지는 그대로, 그 위는 1.0 을 넘지 않게 부드럽게
      const pre = gain(ctx, 0.5), sh = ctx.createWaveShaper(), post = gain(ctx, 1);
      sh.curve = makeCurve(u => { const a = Math.abs(u); return a <= 0.9 ? u : Math.sign(u) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1)); }, 2, 8193);
      input.connect(c).connect(pre).connect(sh).connect(post).connect(output);
      return {
        input, output,
        set(k, v) {
          if (k === 'ceiling') { c.threshold.setValueAtTime(v - 0.6, now(ctx)); }
          if (k === 'release') c.release.setValueAtTime(v / 1000, now(ctx));
        },
      };
    },
  },

  /* 보컬 */
  {
    id: 'karaoke', cat: 'vocal', name: '보컬 제거 (노래방)', desc: '가운데 목소리를 지우고 반주만',
    params: [R('strength', '제거 강도', 0, 100, 100, '%'), R('low', '저음 보존', 60, 400, 140, 'Hz', 5), R('high', '고음 보존', 3000, 15000, 9000, 'Hz', 100)],
    build: wk('ul-karaoke', { strength: ['strength', pct], low: ['low'], high: ['high'] }),
  },
  {
    id: 'vocal', cat: 'vocal', name: '보컬 강조', desc: '목소리를 앞으로 또렷하게',
    params: [R('amount', '세기', 0, 100, 60, '%')],
    build: wk('ul-vocal', { amount: ['amount', pct] }),
  },

  /* 변조 */
  {
    id: 'chorus', cat: 'mod', name: '코러스', desc: '여러 명이 함께 연주하는 듯 풍성하게',
    params: [R('rate', '속도', 0.05, 5, 0.8, 'Hz', 0.05), R('depth', '깊이', 0, 100, 50, '%'), R('mix', '적용량', 0, 100, 50, '%')],
    build: wk('ul-chorus', { rate: ['rate'], depth: ['depth', pct], mix: ['mix', pct] }),
  },
  {
    id: 'flanger', cat: 'mod', name: '플랜저', desc: '제트기 같은 휘어지는 소리',
    params: [R('rate', '속도', 0.02, 3, 0.25, 'Hz', 0.01), R('depth', '깊이', 0, 100, 70, '%'), R('feedback', '피드백', -95, 95, 50, '%', 1, { center: 0 }), R('mix', '적용량', 0, 100, 80, '%')],
    build: wk('ul-flanger', { rate: ['rate'], depth: ['depth', pct], feedback: ['feedback', pct], mix: ['mix', pct] }),
  },
  {
    id: 'phaser', cat: 'mod', name: '페이저', desc: '물결치듯 움직이는 소리',
    params: [R('rate', '속도', 0.02, 5, 0.4, 'Hz', 0.01), R('depth', '깊이', 0, 100, 70, '%'), R('feedback', '피드백', 0, 90, 40, '%'), R('mix', '적용량', 0, 100, 100, '%')],
    build: wk('ul-phaser', { rate: ['rate'], depth: ['depth', pct], feedback: ['feedback', pct], mix: ['mix', pct] }),
  },
  {
    id: 'tremolo', cat: 'mod', name: '트레몰로', desc: '음량이 규칙적으로 떨림',
    params: [R('rate', '속도', 0.5, 15, 5, 'Hz', 0.1), R('depth', '깊이', 0, 100, 50, '%')],
    build: wk('ul-tremolo', { rate: ['rate'], depth: ['depth', pct] }),
  },
  {
    id: 'vibrato', cat: 'mod', name: '비브라토', desc: '음정이 규칙적으로 떨림',
    params: [R('rate', '속도', 0.5, 12, 5, 'Hz', 0.1), R('depth', '깊이', 0, 100, 30, '%')],
    build: wk('ul-vibrato', { rate: ['rate'], depth: ['depth', pct] }),
  },
  {
    id: 'autopan', cat: 'mod', name: '오토 팬', desc: '소리가 좌우로 천천히 오감',
    params: [R('rate', '속도', 0.02, 5, 0.3, 'Hz', 0.01), R('depth', '깊이', 0, 100, 80, '%')],
    build: wk('ul-autopan', { rate: ['rate'], depth: ['depth', pct] }),
  },
  {
    id: 'rotary', cat: 'mod', name: '로터리 스피커', desc: '회전 스피커 특유의 울렁임',
    params: [S('speed', '회전', [[0, '느리게'], [1, '빠르게']], 1), R('mix', '적용량', 0, 100, 100, '%')],
    build: wk('ul-rotary', { speed: ['speed', Number], mix: ['mix', pct] }),
  },

  /* 속도 · 키 */
  {
    id: 'speed', cat: 'pitch', name: '재생 속도', desc: '빠르게 · 느리게 (음정 유지 가능)', pseudo: true,
    params: [R('rate', '속도', 50, 200, 100, '%', 5), T('keep', '음정 유지', true)],
  },
  {
    id: 'pitch', cat: 'pitch', name: '키 조절', desc: '속도는 그대로, 음정만 올리고 내림',
    params: [R('semitones', '반음', -12, 12, 0, '', 0.5, { center: 0 })],
    build: wk('ul-pitch', { semitones: ['semitones'] }),
  },

  /* 특수 효과 */
  {
    id: 'radio', cat: 'fun', name: '라디오 · 전화', desc: '오래된 라디오나 전화기 소리',
    params: [S('mode', '종류', [['phone', '전화'], ['am', 'AM 라디오'], ['mega', '확성기'], ['walkie', '무전기']], 'am'), R('mix', '적용량', 0, 100, 100, '%')],
    build(ctx) {
      const dw = dryWet(ctx), m = mono(ctx), h1 = biquad(ctx, 'highpass', 200), h2 = biquad(ctx, 'highpass', 200),
        l1 = biquad(ctx, 'lowpass', 4500), l2 = biquad(ctx, 'lowpass', 4500), pk = biquad(ctx, 'peaking', 2000, 1, 3),
        pre = gain(ctx, 2), sh = ctx.createWaveShaper(), post = gain(ctx, 0.7), up = stereo(ctx);
      sh.curve = makeCurve(x => Math.tanh(x), 1);
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
      const osc = ctx.createOscillator(), og = gain(ctx, 0); osc.frequency.value = 0.27;
      osc.connect(og); og.connect(l1.frequency); og.connect(l2.frequency); osc.start();
      let cut = 800, wob = 0.4;
      const apply = () => { ramp(ctx, l1.frequency, cut); ramp(ctx, l2.frequency, cut); ramp(ctx, og.gain, cut * 0.35 * wob); };
      return { input, output, set(k, v) { if (k === 'depth') cut = 1600 * Math.pow(0.15, v / 100); if (k === 'wobble') wob = v / 100; apply(); } };
    },
  },
  {
    id: 'lofi', cat: 'fun', name: '로파이 · 비트크러셔', desc: '옛날 게임기 · 저음질 디지털 소리',
    params: [R('bits', '비트', 2, 16, 8, 'bit'), R('down', '샘플 줄이기', 1, 32, 4, '×'), R('mix', '적용량', 0, 100, 100, '%')],
    build: wk('ul-lofi', { bits: ['bits'], down: ['down'], mix: ['mix', pct] }),
  },
  {
    id: 'vinyl', cat: 'fun', name: 'LP 레코드', desc: '지글거림과 아날로그 감성',
    params: [R('crackle', '지글거림', 0, 100, 50, '%'), R('noise', '잡음', 0, 100, 30, '%'), R('wow', '흔들림', 0, 100, 30, '%'), R('tone', '오래된 정도', 0, 100, 50, '%')],
    build: wk('ul-vinyl', { crackle: ['crackle', pct], noise: ['noise', pct], wow: ['wow', pct], tone: ['tone', pct] }),
  },
  {
    id: 'overdrive', cat: 'fun', name: '오버드라이브', desc: '기타 앰프처럼 거칠게',
    params: [R('drive', '드라이브', 0, 100, 50, '%'), R('tone', '톤', 500, 12000, 4000, 'Hz', 100), R('mix', '적용량', 0, 100, 100, '%')],
    build(ctx) {
      const dw = dryWet(ctx), RANGE = 40, hp = biquad(ctx, 'highpass', 80), pre = gain(ctx, 1 / RANGE), sh = ctx.createWaveShaper(),
        lp = biquad(ctx, 'lowpass', 4000), post = gain(ctx, 0.5);
      sh.curve = makeCurve(x => Math.tanh(x), RANGE); sh.oversample = '4x';
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

/** 신호가 지나가는 순서 */
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

/* ---------- 10-band graphic EQ ---------- */
export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export function buildEQ(ctx) {
  const input = stereo(ctx), pre = gain(ctx, 1);
  const bands = EQ_FREQS.map((f, i) => {
    const type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
    return biquad(ctx, type, i === 0 ? 45 : i === EQ_FREQS.length - 1 ? 12000 : f, 1.1, 0);
  });
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
      if (bands[i]) ramp(ctx, bands[i].gain, v, 0.02);
    },
  };
}
