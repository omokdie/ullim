#!/usr/bin/env node
/* 자동 싱크 단위 테스트 (데이터셋 없이, 빠르고 결과가 늘 같음) — node test/autosync_test.mjs */
import assert from 'node:assert/strict';
import { syllables, isHeader, applyAnchors, align, estimateWithoutAudio, featuresFromPCM, autoSync, plan } from '../web/js/autosync.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok -', name); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

t('음절 수', () => {
  assert.equal(syllables('퇴사할게여'), 5);
  assert.equal(syllables('내가 바보라서 그래'), 8);
  assert.equal(syllables('hello world'), 3);
  assert.equal(syllables('make'), 1);
  assert.equal(syllables('2024'), 4);
  assert.equal(syllables('사랑해 baby!'), 5);
  near(syllables('ありがとう'), 4.5, 1e-9, '가나');
  assert.equal(syllables('...!?'), 0);
});

t('머리말 줄', () => {
  for (const s of ['[Chorus]', '(Verse 2)', 'Narr.', '(Narr. 기안84)', '[Hook: 빈지노]', 'Verse 1:', '*', '***', '♪', '후렴', '[후렴]', '(x2)', 'Chorus'])
    assert.equal(isHeader(s), true, s);
  for (const s of ['내가 바보라서 그래', '(oh oh oh)', '(I love you)', 'Break my heart', '퇴사할게여 회사 그만둘래', 'Intro to my heart', ''])
    assert.equal(isHeader(s), false, s);
});

t('기준점: 하나면 그만큼 밀기 · 둘이면 사이를 비율대로', () => {
  const times = [0, 10, 20, 30, null, 40];
  assert.deepEqual(applyAnchors(times, [{ i: 1, t: 12 }]), [2, 12, 22, 32, null, 42]);
  assert.deepEqual(applyAnchors(times, [{ i: 1, t: 12 }, { i: 3, t: 28 }]), [2, 12, 20, 28, null, 38]);
  // 시간이 거꾸로 가는 기준점은 버림 · 결과는 늘 단조 증가
  const r = applyAnchors(times, [{ i: 1, t: 12 }, { i: 3, t: 5 }]);
  assert.deepEqual(r, [2, 12, 22, 32, null, 42]);
  assert.deepEqual(applyAnchors(times, []), times);
});

// 합성 활동 곡선: 전주 12초, 줄마다 (음절 × 0.3 + 0.25)초 노래 + 0.4초 쉼, 문단 사이 6초
function synth(paraSizes, syl = 8) {
  const lines = [], truth = [];
  let t = 12;
  const word = '가'.repeat(syl);
  paraSizes.forEach((n, p) => {
    if (p) { lines.push(''); t += 6; }
    for (let k = 0; k < n; k++) { lines.push(word); truth.push([t, t + syl * 0.3 + 0.25]); t += syl * 0.3 + 0.25 + 0.4; }
  });
  const dur = t + 15, hop = 0.1, v = new Float32Array(Math.floor(dur / hop)).fill(-0.8);
  for (const [a, b] of truth) for (let i = Math.round(a / hop); i < Math.round(b / hop); i++) v[i] = 0.8;
  return { lines, truth, dur, feat: { hop, v } };
}

t('합성 곡선에서 줄 시작 찾기', () => {
  const { lines, truth, dur, feat } = synth([4, 4, 4]);
  const out = align(lines, feat, dur);
  const got = out.filter((x, i) => lines[i]);
  assert.equal(got.length, truth.length);
  got.forEach((x, k) => near(x, truth[k][0], 0.6, `줄 ${k}`));
  assert.ok(out.confidence >= 0 && out.confidence <= 1);
  lines.forEach((l, i) => { if (!l) assert.equal(out[i], null, '빈 줄은 null'); });
});

t('머리말은 다음 줄 시간 · 빈 줄은 null', () => {
  const { lines, dur, feat } = synth([3, 3]);
  const withHead = ['[Verse 1]', ...lines.slice(0, 3), '', '(Chorus)', ...lines.slice(4)];
  const out = align(withHead, feat, dur);
  assert.equal(out[0], out[1]);
  assert.equal(out[4], null);
  assert.equal(out[5], out[6]);
  assert.equal(plan(withHead).length, 6);
});

t('기준점을 주면 그 줄은 정확히 · 나머지도 따라옴', () => {
  const { lines, truth, dur, feat } = synth([4, 4]);
  const shifted = { hop: feat.hop, v: new Float32Array(feat.v.length).fill(0) };     // 정보 없는 곡선
  const idx = lines.map((l, i) => (l ? i : -1)).filter(i => i >= 0);
  const out = align(lines, shifted, dur, { anchors: [{ i: idx[0], t: truth[0][0] }, { i: idx[4], t: truth[4][0] }] });
  assert.equal(out[idx[0]], truth[0][0]);
  assert.equal(out[idx[4]], truth[4][0]);
  assert.ok(out.confidence >= 0.35);
  for (let k = 1; k < idx.length; k++) assert.ok(out[idx[k]] >= out[idx[k - 1]], '단조 증가');
});

t('음악 없이 어림: 범위 안 · 단조 증가', () => {
  const lines = ['하나 둘 셋', '넷 다섯', '', '[Chorus]', '여섯 일곱 여덟 아홉', '열'];
  const out = estimateWithoutAudio(lines, 200);
  assert.equal(out.length, lines.length);
  assert.equal(out[2], null);
  assert.equal(out[3], out[4]);
  const vals = out.filter(x => x != null);
  vals.forEach((x, k) => { assert.ok(x >= 0 && x <= 200); if (k) assert.ok(x >= vals[k - 1]); });
  assert.equal(out.confidence, 0);
  assert.deepEqual(estimateWithoutAudio(['', ''], 100), [null, null]);
});

t('PCM → 가운데 목소리 구간이 더 높게', () => {
  const sr = 8000, dur = 40, n = sr * dur;
  const L = new Float32Array(n), R = new Float32Array(n);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const voiced = s => (s >= 10 && s < 20) || (s >= 26 && s < 34);
  for (let i = 0; i < n; i++) {
    const s = i / sr;
    const bed = 0.08 * rnd(), bedR = 0.08 * rnd();               // 넓게 퍼진 반주 (좌우가 다름)
    let voice = 0;
    if (voiced(s)) {
      const f0 = 220, env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * s);   // 음절처럼 4Hz 로 출렁임
      voice = 0.25 * env * (Math.sin(2 * Math.PI * f0 * s) + 0.6 * Math.sin(2 * Math.PI * 2 * f0 * s) + 0.4 * Math.sin(2 * Math.PI * 3 * f0 * s));
    }
    L[i] = bed + voice; R[i] = bedR + voice;
  }
  const f = featuresFromPCM([L, R], sr);
  let a = 0, na = 0, b = 0, nb = 0;
  f.v.forEach((x, k) => { const s = k * f.hop; if (voiced(s) && voiced(s - 0.3) && voiced(s + 0.3)) { a += x; na++; } else if (!voiced(s) && !voiced(s - 0.3) && !voiced(s + 0.3)) { b += x; nb++; } });
  assert.ok(a / na - b / nb > 0.8, `목소리 ${(a / na).toFixed(2)} vs 반주 ${(b / nb).toFixed(2)}`);
  near(f.hop, 0.1, 1e-9, 'hop');
  // 모노 파일도 동작
  const fm = featuresFromPCM([L], sr);
  assert.equal(fm.v.length, f.v.length);
});

t('시간: 80줄 · 5분 곡 맞추기', () => {
  const lines = [];
  for (let p = 0; p < 10; p++) { if (p) lines.push(''); for (let k = 0; k < 8; k++) lines.push('가나다라 마바사 아자차 ' + 'ㅋ'.repeat(k)); }
  const hop = 0.1, v = new Float32Array(3000);
  let seed = 3; for (let i = 0; i < v.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; v[i] = Math.sin(i / 37) * 0.7 + (seed / 0x7fffffff - 0.5) * 0.6; }
  align(lines, { hop, v }, 300);                                   // JIT 예열
  const t0 = performance.now();
  const out = align(lines, { hop, v }, 300);
  const ms = performance.now() - t0;
  console.log(`   (80줄 · 300초: ${ms.toFixed(0)}ms, 확신도 계산 포함)`);
  assert.ok(ms < 300, `너무 느림 ${ms}ms`);
  assert.equal(out.filter(x => x != null).length, 80);
});

// 브라우저 기능(OfflineAudioContext · IndexedDB)이 없으면 글자로만 어림 (Node)
const lines = ['첫 줄이에요', '둘째 줄', '', '셋째 줄입니다'];
const r = await autoSync({ key: 'test-key', url: 'data:audio/mpeg;base64,AAAA', lines, duration: 120 });
assert.equal(r.method, 'text');
assert.equal(r.times.length, lines.length);
assert.equal(r.times[2], null);
assert.deepEqual(r.anchors, []);
pass++; console.log('ok - 브라우저 기능 없이 autoSync → 글자 어림');

console.log(`\n${pass}개 통과`);
