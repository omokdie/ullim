/*
 * 울림 — 자동 싱크 (싱크 없는 일반 가사에 줄마다 시간 붙이기)
 *   1) 음악을 8000Hz 로 조금씩(chunkdec.js, 약 15초씩) 풀어서 '가운데에서 나오는 중음역 소리'(= 대개 목소리)의 크기를 잰다
 *      (곡 전체를 한 번에 풀지 않아 메모리를 거의 쓰지 않음 — 예전에는 4분 곡에 순간 100MB 넘게)
 *   2) 줄마다 음절 수로 길이를 어림하고, 목소리가 나오는 구간에 줄이 놓이도록 DP 로 맞춘다
 *   3) 결과는 IndexedDB 에 곡별로 저장 → 다음부터는 계산하지 않는다 (배터리)
 *   사용자가 줄을 눌러 '지금 이 줄' 이라고 알려 주면(기준점) 저장해 둔 목소리 곡선으로 다시 맞춘다 (음악을 다시 풀지 않음)
 *   정확도(JamendoLyrics 79곡): 줄 시작 1초 안 약 26% · 켜진 줄이 실제 줄 ±1줄 안인 시간 약 58% → 화면에는 '대략'으로 보여 주고,
 *   기준점 몇 개면 크게 좋아진다 (6줄마다 하나씩 누르면 1초 안 약 72% · ±1줄 95%) — test/autosync_bench.mjs
 */

import { decodeChunks, Unsupported } from './chunkdec.js';

/* ---------- 글자 → 음절 수 ---------- */
const VOWELS = /[aeiouyàáâãäåæèéêëìíîïòóôõöøœùúûüýÿ]+/gi;
function latinSyl(w) {
  const lw = w.toLowerCase().replace(/'/g, '');
  let n = (lw.match(VOWELS) || []).length;
  if (n > 1 && /[^aeiouy]e$/.test(lw) && !/[^aeiouy]le$/.test(lw)) n--;   // make, rose 의 끝 e 는 소리 안 남
  if (n > 1 && /[^aeiouy]es$/.test(lw) && !/(ses|zes|ches|shes|ges|ces|xes)$/.test(lw)) n--;
  return Math.max(1, n);
}
export function syllables(text) {
  const s = String(text || '').normalize('NFC');
  let n = 0;
  n += (s.match(/[가-힣]/g) || []).length;                                   // 한글 한 글자 = 한 음절
  n += (s.match(/[぀-ヿ㐀-䶿一-鿿]/g) || []).length * 0.9;   // 가나 · 한자
  for (const w of s.match(/[a-zà-ÿœæß']+/gi) || []) n += latinSyl(w);
  n += (s.match(/\d/g) || []).length;                                                 // 숫자 한 자 ≈ 한 음절
  return n;
}

/* ---------- 머리말 줄 ([Chorus], (Verse 2), Narr. …) — 시간을 따로 잡지 않음 ---------- */
const SECTION = '(?:verse|chorus|pre-?chorus|post-?chorus|hook|bridge|intro|outro|refrain|interlude|rap|narr(?:ation|\\.)?|spoken|instrumental|break|drop|repeat|' +
  'x\\s*\\d+|\\d+\\s*x|후렴|벌스|브릿지|브리지|인트로|아웃트로|간주|랩|나레이션|내레이션|코러스|훅|반복|전주|후주|\\d+\\s*절)';
const HEADER_BR = new RegExp(`^[\\[(（【<]\\s*${SECTION}(?![\\p{L}\\p{N}])[^\\])）】>]{0,40}[\\])）】>]\\s*:?$`, 'iu');   // 한글 뒤에서도 낱말 경계
const HEADER_BARE = new RegExp(`^${SECTION}\\s*\\d*\\s*(?:[:：].{0,30})?$`, 'iu');
export function isHeader(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/^[*\-–—_=~♪♬#.·•\s]+$/.test(s)) return true;          // *** · ♪ · ---
  if (s.length <= 48 && HEADER_BR.test(s)) return true;
  if (s.length <= 40 && HEADER_BARE.test(s) && !/[가-힣]{4,}/.test(s.replace(/나레이션|내레이션|브릿지|브리지|인트로|아웃트로/g, ''))) return true;
  return false;
}
// '오오 · 우우 · la la · yeah' 처럼 낱말이 아닌 소리 — 음절 수로 길이를 어림할 수 없어 길이를 넉넉히 허용
const VOCABLE = /^(?:o+h*|u+h*|a+h*|ah+|oh+|ooh+|uoo+|aah+|la+|na+|da+|doo+|dum|ba+|pa+|sha+|ya+|yeah+|ye+|yea+|hey+|ey+|ay+|eh+|uh+|huh|woo+|wo+h*|whoa+|wow|mm+|hm+|ha+|lala+|nana+|yo|ho+|hoo+|오+|우+|아+|예+|워+|라+|나+|음+|흠+|후+|하+|헤이|예이|야+|랄+라*|우워+|오워+|으+|오예|워어+|어+)$/i;
function isVocable(text) {
  const w = String(text || '').toLowerCase().normalize('NFC').match(/[\p{L}]+/gu) || [];
  if (!w.length) return false;
  return w.filter(x => VOCABLE.test(x)).length / w.length >= 0.7;
}

/* ---------- 음악 → 목소리 활동 곡선 ---------- */
const FEAT = { hp: 250, frame: 0.02, smooth: 0.2, hop: 0.1, qlo: 0.1, qhi: 0.9, qth: 0.4, scale: 0.25 };
function hpCoef(f0, sr, q) {                     // 2차 고역 통과 (RBJ)
  const w = 2 * Math.PI * f0 / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
}
/** 조금씩 받은 PCM 으로 목소리 활동 곡선 만들기 — 곡 전체 PCM 을 메모리에 두지 않음 (줄마다 20ms 에너지만 남김).
    한 번에 다 넣어도(featuresFromPCM) 같은 계산이라 결과가 똑같다 */
export class FeatStream {
  constructor(sampleRate, opt = {}) {
    const o = this.o = { ...FEAT, ...opt };
    this.step = sampleRate > 12000 ? Math.floor(sampleRate / 8000) : 1;   // 너무 촘촘하면 솎아서 (평균) 계산량을 줄임
    this.sr = sampleRate / this.step;
    this.fl = Math.max(1, Math.round(o.frame * this.sr));
    this.c1 = hpCoef(o.hp, this.sr, 0.5412); this.c2 = hpCoef(o.hp, this.sr, 1.3066);   // 4차 버터워스: 베이스 · 킥 빼기
    this.z = new Float64Array(8);
    this.dl = 0; this.dr = 0; this.dn = 0; this.k = 0; this.a = 0; this.b = 0;
    this.eM = new Float64Array(4096); this.eS = new Float64Array(4096); this.nf = 0;
  }
  push(L, R = L) {
    const fr = Math.fround, z = this.z, step = this.step, fl = this.fl;
    const [p0, p1, p2, p3, p4] = this.c1, [q0, q1, q2, q3, q4] = this.c2;
    let { dl, dr, dn, k, a, b } = this;
    for (let j = 0; j < L.length; j++) {
      dl += L[j]; dr += R[j];
      if (++dn < step) continue;
      // 가운데(L+R) · 옆(L-R) — 4바이트 실수로 저장하던 예전 계산과 같게 반올림
      let m = fr((dl + dr) / (2 * step)), s = fr((dl - dr) / (2 * step));
      dl = 0; dr = 0; dn = 0;
      let y = p0 * m + z[0]; z[0] = p1 * m - p3 * y + z[1]; z[1] = p2 * m - p4 * y; m = fr(y);
      y = q0 * m + z[2]; z[2] = q1 * m - q3 * y + z[3]; z[3] = q2 * m - q4 * y; m = fr(y);
      y = p0 * s + z[4]; z[4] = p1 * s - p3 * y + z[5]; z[5] = p2 * s - p4 * y; s = fr(y);
      y = q0 * s + z[6]; z[6] = q1 * s - q3 * y + z[7]; z[7] = q2 * s - q4 * y; s = fr(y);
      a += m * m; b += s * s;
      if (++k === fl) {
        if (this.nf === this.eM.length) { const g = n => { const x = new Float64Array(n.length * 2); x.set(n); return x; }; this.eM = g(this.eM); this.eS = g(this.eS); }
        this.eM[this.nf] = a / fl; this.eS[this.nf] = b / fl; this.nf++;
        k = 0; a = 0; b = 0;
      }
    }
    Object.assign(this, { dl, dr, dn, k, a, b });
  }
  /** 들어온 만큼의 길이(초) */
  get seconds() { return this.nf * this.fl / this.sr; }
  finish() { return featuresFromEnergy(this.eM.subarray(0, this.nf), this.eS.subarray(0, this.nf), this.fl, this.sr, this.o); }
}
/** chans: Float32Array 1~2개 (가능하면 8000Hz). 돌려줌: { hop(초), v(-1~1, 클수록 목소리), raw(dB) }
    가운데(L+R) 중음역 에너지에서 옆(L-R) 에너지를 뺀 값 — 가운데에 놓이는 목소리를 잡고, 넓게 퍼진 악기 · 베이스 · 킥은 덜어 낸다 */
export function featuresFromPCM(chans, sampleRate, opt = {}) {
  const fs = new FeatStream(sampleRate, opt);
  fs.push(chans[0], chans[1] || chans[0]);
  return fs.finish();
}
function featuresFromEnergy(eM, eS, fl, sr, o) {
  const nf = eM.length;
  const sm = Math.max(1, Math.round(o.smooth / o.frame)), h = sm >> 1;
  const box = x => {                                              // 이동 평균
    const y = new Float64Array(x.length); let acc = 0;
    for (let i = 0; i < x.length + h; i++) {
      if (i < x.length) acc += x[i];
      if (i - sm >= 0) acc -= x[i - sm];
      const c = i - h; if (c >= 0 && c < x.length) y[c] = acc / Math.min(sm, i + 1);
    }
    return y;
  };
  const m = box(eM), s = box(eS);
  const per = Math.max(1, Math.round(o.hop / o.frame)), T = Math.floor(nf / per);
  let peak = 0;
  for (let i = 0; i < nf; i++) if (m[i] > peak) peak = m[i];
  const floor = peak * 1e-6 + 1e-12, raw = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    let a = 0;
    for (let k = 0; k < per; k++) { const i = t * per + k; a += Math.max(m[i] - s[i], 0); }
    raw[t] = 10 * Math.log10(a / per + floor);
  }
  return { hop: per * fl / sr, raw, v: normalize(raw, o) };
}
function quantile(arr, q) {
  const a = Float32Array.from(arr).sort();
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
}
/** dB 곡선 → -1~1 (곡마다 기준을 따로: 아래 40% 쯤을 '목소리 없음' 쪽으로) */
export function normalize(raw, o = {}) {
  o = { ...FEAT, ...o };
  const lo = quantile(raw, o.qlo), hi = quantile(raw, o.qhi), th = quantile(raw, o.qth);
  const sc = Math.max(1.5, (hi - lo) * o.scale);
  const v = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) v[i] = Math.tanh((raw[i] - th) / sc);
  return v;
}

/* ---------- 줄 정리 ---------- */
export function plan(lines) {
  const items = [];             // 시간을 잡을 줄: { i, syl, brk(문단 첫 줄), voc('오오' 줄) }
  let brk = true;
  lines.forEach((text, i) => {
    const s = String(text || '').trim();
    if (!s || isHeader(s)) { brk = true; return; }
    items.push({ i, syl: Math.max(1, syllables(s)), brk, voc: isVocable(s) });
    brk = false;
  });
  return items;
}
function fill(lines, items, starts) {          // 줄마다 시간 (빈 줄 = null, 머리말 = 다음 줄 시간)
  const out = new Array(lines.length).fill(null);
  items.forEach((it, k) => { out[it.i] = starts[k]; });
  let next = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = String(lines[i] || '').trim();
    if (out[i] != null) next = out[i];
    else if (s && isHeader(s)) out[i] = next;
  }
  return out;
}
function monotonic(arr) {
  let last = -Infinity;
  for (let i = 0; i < arr.length; i++) { if (arr[i] == null) continue; if (arr[i] < last) arr[i] = last; last = arr[i]; }
  return arr;
}

/* ---------- 맞추기 (DP) ----------
   비용 = Σ줄(-목소리 + 길이 벌점) + Σ빈 구간(목소리 × lam + 길이당 벌점)
   줄 길이 어림 = 음절 × 빠르기 + 줄마다 더하는 몫, 빠르기 = (목소리가 나온 시간) / 음절 수.
   빈 구간은 '최솟값 끌고 가기'로 한 번에 계산 → 줄 수 × 칸 수 × 줄 길이 범위 */
export const ALIGN = {
  hop: 0.2,                              // DP 시간 간격 (초)
  perLine: 0.25,                         // 줄마다 더해지는 길이 (숨 · 끝음)
  fill: 1.1,                             // 빠르기 어림에 쓰는 '목소리 시간' 보정
  muls: [1],                             // 문단마다 빠르기 배율 후보 (여러 개 주면 문단마다 고름 — 측정해 보니 [1]이 가장 나음)
  gamma: 2,                              // 배율 벌점 (ln² 배)
  dmin: 0.45, dmax: 2.2,                 // 줄 길이: 어림값의 몇 배까지
  vocMax: 8,                             // '오오 · la la' 줄은 몇 배까지
  beta: 3,                               // 길이가 어림값과 다를 때 벌점 (ln² 배)
  gapIn: 0.4, gapBreak: 0.01, gapIntro: 0.005, gapOutro: 0.005,   // 빈 구간 1칸당 벌점 (문단 안 · 문단 사이 · 앞 · 뒤)
  lam: 0.5,                              // 빈 구간에 목소리가 있으면 벌점 (악기를 목소리로 잘못 잡는 일이 많아 줄보다 약하게)
  lamIntro: 0.2,                         // 전주는 더 약하게 — 전주의 악기 때문에 첫 줄을 너무 일찍 놓지 않도록
  fixW: 20,                              // 기준점(사용자가 누른 줄)에서 1칸 벗어날 때 벌점
};
const INF = 1e18;
function lineStep(G, pre, T, E, P, voc) {     // 한 줄: G(시작 비용) → C(끝 비용), 고른 길이
  const d0 = Math.max(1, Math.floor(E * P.dmin * (voc ? 0.6 : 1)));
  const d1 = Math.max(d0 + 1, Math.ceil(E * (voc ? P.vocMax : P.dmax)) + 1);
  const C = new Float64Array(T + 1).fill(INF), bd = new Int32Array(T + 1);
  const lnE = Math.log(E), b = voc ? P.beta * 0.25 : P.beta;
  for (let e = d0; e <= T; e++) {
    let best = INF, bdd = 0;
    const dm = Math.min(d1, e), pe = pre[e];
    for (let d = d0; d <= dm; d++) {
      const g = G[e - d];
      if (g >= INF) continue;
      const r = Math.log(d) - lnE;
      const c = g - (pe - pre[e - d]) + b * r * r;
      if (c < best) { best = c; bdd = d; }
    }
    C[e] = best; bd[e] = bdd;
  }
  return { C, bd };
}
function gapStep(C, pre, T, mu, lam) {        // 빈 구간: G'[s] = lam*pre[s] + mu*s + min_{e<=s}(C[e] - lam*pre[e] - mu*e)
  const G = new Float64Array(T + 1).fill(INF), be = new Int32Array(T + 1);
  let m = INF, me = -1;
  for (let s = 0; s <= T; s++) {
    if (C[s] < INF) { const x = C[s] - lam * pre[s] - mu * s; if (x < m) { m = x; me = s; } }
    if (me >= 0) { G[s] = lam * pre[s] + mu * s + m; be[s] = me; }
  }
  return { G, be };
}
function dpAlign(items, v, hop, rate, P) {
  const T = v.length, N = items.length;
  const pre = new Float64Array(T + 1);
  for (let i = 0; i < T; i++) pre[i + 1] = pre[i] + v[i];
  const paras = [];
  items.forEach((it, l) => { if (it.brk || !paras.length) paras.push([]); paras[paras.length - 1].push(l); });
  let G = new Float64Array(T + 1);
  for (let s = 0; s <= T; s++) G[s] = P.lamIntro * pre[s] + P.gapIntro * s;   // 전주
  const trace = [];
  let C = null;
  for (let k = 0; k < paras.length; k++) {
    const ls = paras[k];
    const Cbest = new Float64Array(T + 1).fill(INF), pick = new Int8Array(T + 1).fill(-1), per = [];
    P.muls.forEach((m, mi) => {
      const pen = P.gamma * Math.log(m) ** 2;
      let g = G, c = null;
      const bds = [], bes = [];
      ls.forEach((l, j) => {
        const a = P.fixed && P.fixed[l];
        if (a != null) {                       // 기준점: 이 줄은 거의 이 시간에 시작
          const f = a / hop, g2 = new Float64Array(T + 1);
          for (let s = 0; s <= T; s++) g2[s] = g[s] + P.fixW * Math.min(Math.abs(s - f), 200);
          g = g2;
        }
        const E = Math.max(1, (items[l].syl * rate * m + P.perLine) / hop);
        const r = lineStep(g, pre, T, E, P, items[l].voc);
        bds.push(r.bd); c = r.C;
        if (j < ls.length - 1) { const q = gapStep(c, pre, T, P.gapIn, P.lam); bes.push(q.be); g = q.G; }
      });
      per.push({ bds, bes });
      for (let e = 0; e <= T; e++) { const x = c[e] + pen; if (x < Cbest[e]) { Cbest[e] = x; pick[e] = mi; } }
    });
    C = Cbest;
    const tr = { per, pick, beNext: null };
    trace.push(tr);
    if (k < paras.length - 1) { const q = gapStep(C, pre, T, P.gapBreak, P.lam); tr.beNext = q.be; G = q.G; }
  }
  let best = INF, bestE = -1;
  for (let e = 0; e <= T; e++) {
    if (C[e] >= INF) continue;
    const c = C[e] + P.lam * (pre[T] - pre[e]) + P.gapOutro * (T - e);   // 후주
    if (c < best) { best = c; bestE = e; }
  }
  if (bestE < 0) return null;
  const starts = new Array(N), ends = new Array(N);
  let e = bestE;
  for (let k = paras.length - 1; k >= 0; k--) {
    const ls = paras[k], tr = trace[k], { bds, bes } = tr.per[tr.pick[e]];
    for (let j = ls.length - 1; j >= 0; j--) {
      const d = bds[j][e];
      ends[ls[j]] = e; starts[ls[j]] = e - d;
      e -= d;
      if (j > 0) e = bes[j - 1][e];
    }
    if (k > 0) e = trace[k - 1].beNext[e];
  }
  return { cost: best, starts, ends };
}
export function resample(v, hop, to) {          // 활동 곡선을 DP 간격으로 (평균)
  if (Math.abs(to - hop) < 1e-9) return Float32Array.from(v);
  const k = to / hop, T = Math.floor(v.length / k), out = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const a = Math.floor(t * k), b = Math.max(a + 1, Math.floor((t + 1) * k));
    let s = 0; for (let i = a; i < b; i++) s += v[i];
    out[t] = s / (b - a);
  }
  return out;
}
function anchorMap(items, anchors) {          // 사용자 기준점(입력 줄 번호) → DP 줄 번호 (머리말을 누르면 다음 줄)
  const fixed = {}, exact = [];
  for (const a of anchors || []) {
    if (!a || !isFinite(a.t)) continue;
    const l = items.findIndex(it => it.i >= a.i);
    if (l >= 0) { fixed[l] = Math.max(0, a.t); exact.push([l, Math.max(0, a.t)]); }
  }
  return { fixed, exact };
}
/** lines: 가사 줄 배열('' = 빈 줄). feat: { hop, v }. opt.anchors: [{ i, t }]
    돌려줌: 줄마다 시작 시간(초) 배열 — 빈 줄은 null, 머리말은 다음 줄 시간. 배열에 .rate · .confidence(0~1) */
export function align(lines, feat, duration, opt = {}) {
  const P = { ...ALIGN, ...opt };
  const items = plan(lines);
  if (!items.length) return lines.map(() => null);
  const v = resample(feat.v, feat.hop, P.hop);
  if (v.length < 10) return estimateWithoutAudio(lines, duration, opt.anchors);
  // 빠르기 = (목소리가 나온 시간 - 줄마다 더하는 몫) / 음절 수 ('오오' 줄은 빼고 셈)
  let voiced = 0, decisive = 0;
  for (let i = 0; i < v.length; i++) { if (v[i] > 0) voiced++; if (Math.abs(v[i]) > 0.5) decisive++; }
  const lex = items.filter(it => !it.voc);
  const syl = (lex.length ? lex : items).reduce((a, it) => a + it.syl, 0);
  const rateOf = f => Math.min(0.6, Math.max(0.12, (voiced * P.hop * f - items.length * P.perLine) / syl));
  const { fixed, exact } = anchorMap(items, opt.anchors);
  const Q = { ...P, fixed: Object.keys(fixed).length ? fixed : null };
  const rate = rateOf(P.fill);
  const top = dpAlign(items, v, P.hop, rate, Q);
  if (!top) return estimateWithoutAudio(lines, duration, opt.anchors);
  const starts = top.starts.map(s => s * P.hop);
  for (const [l, t] of exact) starts[l] = t;                  // 기준점은 정확히 그 시간
  const out = monotonic(fill(lines, items, starts));
  out.rate = +rate.toFixed(3);
  // 믿을 만한 정도: 목소리 곡선이 분명한지(±0.5 넘는 칸 비율) × 빠르기를 조금 바꿔도 결과가 그대로인지
  let conf = Math.min(1, Math.max(0, (decisive / v.length - 0.62) / 0.16));
  if (opt.confidence !== false) {
    let diff = 0;
    for (const f of [0.85, 1.15]) {
      const r2 = dpAlign(items, v, P.hop, rateOf(P.fill * f), Q);
      if (r2) for (let l = 0; l < items.length; l++) diff += Math.abs(r2.starts[l] - top.starts[l]) * P.hop / 2;
      else diff += 99 * items.length / 2;
    }
    const stab = diff / items.length;
    conf *= stab < 1 ? 1 : stab < 4 ? 0.7 : 0.4;
  }
  if (exact.length) conf = Math.max(conf, Math.min(0.95, 0.35 + 0.12 * exact.length));
  out.confidence = +conf.toFixed(2);
  if (opt.debug) out.cost = top.cost;
  return out;
}

/* ---------- 음악 없이 어림 (분석 실패 · 너무 큰 파일) ---------- */
export function estimateWithoutAudio(lines, duration, anchors) {
  const items = plan(lines);
  if (!items.length || !(duration > 0)) return lines.map(() => null);
  const intro = Math.min(20, Math.max(4, duration * 0.08)), outro = Math.min(20, Math.max(4, duration * 0.07));
  const span = Math.max(duration * 0.5, duration - intro - outro);
  let total = 0;
  items.forEach((it, k) => { total += (k > 0 && it.brk ? 6 : 0) + it.syl + 1.5; });
  let acc = 0;
  const starts = items.map((it, k) => {
    if (k > 0 && it.brk) acc += 6;
    const t = intro + span * acc / total;
    acc += it.syl + 1.5;
    return t;
  });
  let out = fill(lines, items, starts);
  if (anchors && anchors.length) out = applyAnchors(out, anchors);
  out.confidence = anchors && anchors.length ? Math.min(0.8, 0.2 + 0.1 * anchors.length) : 0;
  return out;
}

/* ---------- 사용자가 맞춘 기준점 (음악 곡선 없이 늘이고 줄이기만) ---------- */
/** anchors: [{ i: 줄 번호, t: 그 줄이 시작하는 시간 }] — 기준점 사이는 비율대로, 바깥은 그만큼 민다 */
export function applyAnchors(times, anchors) {
  const out = times.slice();
  const A = (anchors || []).filter(a => a && times[a.i] != null && isFinite(a.t))
    .sort((a, b) => a.i - b.i)
    .filter((a, k, arr) => k === 0 || (a.t > arr[k - 1].t && a.i > arr[k - 1].i));   // 시간 순서가 뒤집힌 기준점은 버림
  if (!A.length) return out;
  for (let i = 0; i < times.length; i++) {
    const x = times[i];
    if (x == null) continue;
    let k = 0;
    while (k < A.length && A[k].i <= i) k++;                       // A[k-1].i <= i < A[k].i
    const a = A[k - 1], b = A[k];
    if (a && a.i === i) { out[i] = a.t; continue; }
    if (a && b) {
      const xa = times[a.i], xb = times[b.i];
      out[i] = xb > xa ? a.t + (x - xa) * (b.t - a.t) / (xb - xa) : a.t + (b.t - a.t) * (i - a.i) / (b.i - a.i);
    } else if (a) out[i] = x + (a.t - times[a.i]);
    else out[i] = x + (b.t - times[b.i]);
  }
  return monotonic(out);
}

/* ---------- 브라우저: 음악 분석 + 저장 ---------- */
const DB = 'ullim-sync', STORE = 'sync', SR = 8000, MAX_BYTES = 60 * 1024 * 1024, MAX_DUR = 15 * 60;
export function hashLines(lines) {              // 가사가 바뀌면 다시 계산하도록
  let h = 2166136261;
  const s = (lines || []).map(x => String(x || '').trim()).join('\n');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
const recKey = (key, lines, duration) => `${key}|${hashLines(lines)}|${Math.round(duration || 0)}`;
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE); };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  }).catch(e => { dbp = null; throw e; });
  return dbp;
}
async function idb(mode, fn) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode), st = tx.objectStore(STORE);
      const rq = fn(st);
      tx.oncomplete = () => resolve(rq && 'result' in rq ? rq.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } catch (e) { return undefined; }            // 저장소를 못 쓰면 저장 없이 계속
}
const abortError = () => (typeof DOMException !== 'undefined' ? new DOMException('Aborted', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' }));
const aborted = signal => { if (signal && signal.aborted) throw abortError(); };
const idle = () => new Promise(r => setTimeout(r, 0));       // 오래 걸리는 계산 사이에 화면이 멈추지 않게
const packV = v => { const q = new Int8Array(v.length); for (let i = 0; i < v.length; i++) q[i] = Math.round(Math.max(-1, Math.min(1, v[i])) * 127); return q; };
const unpackV = q => { const v = new Float32Array(q.length); for (let i = 0; i < q.length; i++) v[i] = q[i] / 127; return v; };
/** 음악 → 목소리 활동 곡선. 조금씩 풀어 바로 줄이고, 모르는 형식은 짧은 곡(100초 이하)만 통째로 */
async function analyze(url, duration, signal) {
  const fs = new FeatStream(SR);
  try {
    const r = await decodeChunks(url, { duration, signal, onChunk: (L, R) => fs.push(L, R) });
    return { feat: fs.finish(), dur: r.seconds || duration };
  } catch (e) {
    if ((e && e.name === 'AbortError') || !(e instanceof Unsupported) || duration > 100) throw e;
    const pcm = await decodePCM(url, duration, signal);
    return { feat: featuresFromPCM(pcm.chans, pcm.sr), dur: pcm.dur || duration };
  }
}
async function decodePCM(url, duration, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok && res.status !== 206) throw new Error('fetch ' + res.status);
  const len = Number(res.headers.get('content-length')) || 0;
  if (len > MAX_BYTES) throw new Error('too big');
  const buf = await res.arrayBuffer();
  aborted(signal);
  if (buf.byteLength > MAX_BYTES) throw new Error('too big');
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('no OfflineAudioContext');
  const ctx = new Ctx(2, Math.max(SR, Math.ceil((duration || 60) * SR)), SR);   // 8000Hz 로 풀면 메모리 · 계산이 1/5
  const ab = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buf, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  aborted(signal);
  return { chans: ab.numberOfChannels > 1 ? [ab.getChannelData(0), ab.getChannelData(1)] : [ab.getChannelData(0)], sr: ab.sampleRate, dur: ab.duration };
}
const round2 = out => Array.from(out, x => (x == null ? null : Math.round(x * 100) / 100));
/** 곡 하나의 자동 싱크. { key: 곡 키, url: 음악 주소, lines: 가사 줄, duration: 길이(초), signal }
    → { times, method: 'audio' | 'text', anchors, confidence }  (저장해 둔 결과가 있으면 바로) */
export async function autoSync({ key, url, lines, duration, signal }) {
  const id = recKey(key, lines, duration);
  const rec = await idb('readonly', st => st.get(id));
  if (rec && rec.times) return { times: rec.times, method: rec.method, anchors: rec.anchors || [], confidence: rec.confidence ?? 0 };
  aborted(signal);
  let out = null, method = 'text', vq = null;
  if (url && duration > 0 && duration <= MAX_DUR) {
    try {
      const { feat, dur } = await analyze(url, duration, signal);
      await idle(); aborted(signal);
      out = align(lines, feat, dur || duration);
      vq = packV(resample(feat.v, feat.hop, ALIGN.hop));
      method = 'audio';
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      out = null;                               // 풀 수 없는 형식 · 너무 큰 파일 → 글자로만 어림
    }
  }
  if (!out) out = estimateWithoutAudio(lines, duration);
  const result = { times: round2(out), method, anchors: [], confidence: out.confidence ?? 0 };
  aborted(signal);
  await idb('readwrite', st => st.put({ ...result, autoConf: result.confidence, v: vq, hop: ALIGN.hop, at: Date.now() }, id));
  return result;
}
/** 사용자가 누른 기준점 저장 + 다시 맞추기 (저장해 둔 목소리 곡선으로 — 음악을 다시 풀지 않음)
    anchors: [{ i: 줄 번호, t: 시작 시간 }] 전체 목록 (빈 배열이면 기준점 지우기) → autoSync 와 같은 모양 */
export async function saveAnchors(key, lines, duration, anchors) {
  const id = recKey(key, lines, duration);
  const rec = (await idb('readonly', st => st.get(id))) || {};
  const A = (anchors || []).filter(a => a && Number.isInteger(a.i) && isFinite(a.t)).map(a => ({ i: a.i, t: Math.round(a.t * 100) / 100 }));
  const out = rec.v && rec.v.length
    ? align(lines, { hop: rec.hop || ALIGN.hop, v: unpackV(rec.v) }, duration, { anchors: A, confidence: false })
    : estimateWithoutAudio(lines, duration, A);
  if (!A.length) out.confidence = rec.autoConf ?? out.confidence;          // 기준점을 모두 지우면 처음 확신도로
  const result = { times: round2(out), method: rec.method || 'text', anchors: A, confidence: out.confidence ?? 0 };
  await idb('readwrite', st => st.put({ ...rec, ...result, at: Date.now() }, id));
  return result;
}
/** 이 곡의 자동 싱크 기록을 모두 지움 (가사를 바꿨거나 처음부터 다시) */
export async function forgetSync(key) {
  await idb('readwrite', st => st.delete(IDBKeyRange.bound(key + '|', key + '|￿')));
}
