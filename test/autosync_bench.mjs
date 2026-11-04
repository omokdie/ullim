#!/usr/bin/env node
/*
 * 자동 싱크 정확도 측정 — JamendoLyrics (CC 라이선스 79곡, 줄마다 시작 · 끝 시간 정답)
 *   node test/autosync_bench.mjs [데이터셋 폴더] [--feat '{"qth":0.4}'] [--align '{"beta":0.6}'] [--cache /tmp/jl8k] [--only 이름]
 *   데이터셋: git clone https://github.com/f90/jamendolyrics (음악은 저장소에 넣지 않음 — 측정용으로만)
 *   ffmpeg 로 8000Hz 스테레오로 풀어서 featuresFromPCM + align 결과를 정답 시작 시간과 비교한다.
 *   나눠서 봄: 영어 + 스페인어(맞춤용) / 독일어 + 프랑스어(처음 보는 곡 — 과적합 확인)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { featuresFromPCM, align, estimateWithoutAudio } from '../web/js/autosync.js';

const FFMPEG = process.env.FFMPEG || (fs.existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg');
export const SR = 8000;

function csvRows(text) {             // 따옴표 없는 간단한 CSV
  const [head, ...rest] = text.trim().split(/\r?\n/);
  const keys = head.split(',');
  return rest.map(line => { const v = line.split(','); return Object.fromEntries(keys.map((k, i) => [k, v[i]])); });
}
export function loadSongs(ds) {
  const meta = csvRows(fs.readFileSync(path.join(ds, 'JamendoLyrics.csv'), 'utf8'));
  return meta.map(m => {
    const name = m.Filepath.replace(/\.mp3$/, '');
    const ann = fs.readFileSync(path.join(ds, 'annotations/lines', name + '.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map(l => {
      const a = l.split(','); return { s: Number(a[0]), e: Number(a[1]), text: a.slice(2).join(',') };
    });
    const lines = fs.readFileSync(path.join(ds, 'lyrics', name + '.txt'), 'utf8').replace(/\r/g, '').split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const nonBlank = lines.filter(l => l.trim());
    const breaks = nonBlank.length === ann.length;          // 빈 줄(문단) 위치를 쓸 수 있는지
    return { name, lang: m.Language, genre: m.Genre, mp3: path.join(ds, 'mp3', m.Filepath), ann, lines: breaks ? lines : ann.map(a => a.text) };
  });
}
export function decode(song, cacheDir) {
  const c = cacheDir && path.join(cacheDir, song.name + '.s16');
  let L, R;
  if (c && fs.existsSync(c)) {
    const b = fs.readFileSync(c), n = b.length >> 2;
    const i16 = new Int16Array(b.buffer, b.byteOffset, n * 2);
    L = new Float32Array(n); R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = i16[2 * i] / 32768; R[i] = i16[2 * i + 1] / 32768; }
  } else {
    const r = spawnSync(FFMPEG, ['-nostdin', '-loglevel', 'error', '-i', song.mp3, '-ac', '2', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr);
    const f = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 2);
    const n = f.length >> 1;
    L = new Float32Array(n); R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
  }
  return { L, R, duration: L.length / SR };
}
export function score(pred, song) {
  const p = song.lines.map((l, i) => pred[i]).filter((x, i) => song.lines[i].trim());
  return song.ann.map((a, k) => Math.abs((p[k] ?? 0) - a.s));
}
/** 노래하는 동안(첫 줄 ~ 마지막 줄) 화면에 켜진 줄이 실제로 부르는 줄과 같은 시간 비율 (같음 / ±1줄) */
export function timeHit(pred, song, step = 0.1) {
  const p = song.lines.map((l, i) => pred[i]).filter((x, i) => song.lines[i].trim());
  const gt = song.ann.map(a => a.s);
  const idx = (arr, t) => { let k = -1; for (let i = 0; i < arr.length; i++) if (arr[i] != null && arr[i] <= t) k = i; return k; };
  let n = 0, ex = 0, near = 0;
  for (let t = gt[0]; t < song.ann[song.ann.length - 1].e; t += step) {
    const g = idx(gt, t), q = idx(p, t);
    n++; if (g === q) ex++; if (Math.abs(g - q) <= 1) near++;
  }
  return { n, ex, near };
}
export function summary(errs) {
  const a = Float64Array.from(errs).sort();
  const pct = th => (100 * a.filter(x => x <= th).length / a.length).toFixed(1);
  return { n: a.length, mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), median: +a[a.length >> 1].toFixed(2), in05: +pct(0.5), in1: +pct(1), in2: +pct(2) };
}
const fmt = s => `n=${s.n} 평균 ${s.mean}s 중앙 ${s.median}s · 0.5s 안 ${s.in05}% · 1s 안 ${s.in1}% · 2s 안 ${s.in2}%`;
export const TUNE = new Set(['English', 'Spanish']);

async function main() {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const featOpt = JSON.parse(opt('--feat') || '{}'), alignOpt = JSON.parse(opt('--align') || '{}');
  const cache = opt('--cache'), only = opt('--only'), quiet = args.includes('--quiet');
  const ds = args.find(a => !a.startsWith('--')) || '/home/claude/f90/jamendolyrics';
  if (!fs.existsSync(path.join(ds, 'JamendoLyrics.csv'))) { console.log('데이터셋이 없어요 — 건너뜀:', ds); return; }
  let songs = loadSongs(ds);
  if (only) songs = songs.filter(s => s.name.includes(only));
  const all = { audio: [], text: [] }, split = { tune: { audio: [], text: [] }, held: { audio: [], text: [] } };
  const th = { audio: { n: 0, ex: 0, near: 0 }, text: { n: 0, ex: 0, near: 0 }, tap: { n: 0, ex: 0, near: 0 } };
  const tapErr = [];
  const addT = (o, x) => { o.n += x.n; o.ex += x.ex; o.near += x.near; };
  const per = [];
  let tFeat = 0, tAlign = 0;
  for (const song of songs) {
    const { L, R, duration } = decode(song, cache);
    let t0 = performance.now();
    const feat = featuresFromPCM([L, R], SR, featOpt);
    let t1 = performance.now();
    const pred = align(song.lines, feat, duration, alignOpt);
    let t2 = performance.now();
    tFeat += t1 - t0; tAlign += t2 - t1;
    const base = estimateWithoutAudio(song.lines, duration);
    const ea = score(pred, song), eb = score(base, song);
    addT(th.audio, timeHit(pred, song)); addT(th.text, timeHit(base, song));
    // 사용자가 6줄마다 한 번씩 '지금 이 줄'을 누른 경우 (기준점으로 다시 맞추기)
    const idx = song.lines.map((l, i) => (l.trim() ? i : -1)).filter(i => i >= 0);
    const anchors = idx.filter((_, k) => k % 6 === 0).map(i => ({ i, t: song.ann[idx.indexOf(i)].s }));
    const tapped = align(song.lines, feat, duration, { ...alignOpt, anchors, confidence: false });
    tapErr.push(...score(tapped, song)); addT(th.tap, timeHit(tapped, song));
    all.audio.push(...ea); all.text.push(...eb);
    const g = TUNE.has(song.lang) ? split.tune : split.held;
    g.audio.push(...ea); g.text.push(...eb);
    const s = summary(ea);
    per.push({ name: song.name, lang: song.lang, mean: s.mean, in1: s.in1, base: summary(eb).mean, rate: pred.rate, conf: pred.confidence });
    if (!quiet) console.log(`${song.name.slice(0, 38).padEnd(38)} ${song.lang.slice(0, 2)} 평균 ${String(s.mean).padStart(6)}s 1s안 ${String(s.in1).padStart(5)}% | 글자만 ${String(summary(eb).mean).padStart(6)}s | rate ${pred.rate ?? '-'} conf ${pred.confidence != null ? pred.confidence.toFixed(2) : '-'} | ${(t1 - t0).toFixed(0)}+${(t2 - t1).toFixed(0)}ms`);
  }
  console.log('\n== 전체 (음악 분석)  ', fmt(summary(all.audio)));
  console.log('== 전체 (글자만)     ', fmt(summary(all.text)));
  console.log('== 맞춤용 EN+ES 분석 ', fmt(summary(split.tune.audio)), ' | 글자만', fmt(summary(split.tune.text)));
  console.log('== 처음 보는 DE+FR   ', fmt(summary(split.held.audio)), ' | 글자만', fmt(summary(split.held.text)));
  const tf = o => `켜진 줄이 맞는 시간 ${(100 * o.ex / o.n).toFixed(1)}% · ±1줄 ${(100 * o.near / o.n).toFixed(1)}%`;
  console.log('== 시간 기준 (분석)  ', tf(th.audio), ' | 글자만', tf(th.text));
  console.log('== 6줄마다 누른 경우 ', fmt(summary(tapErr)), ' |', tf(th.tap));
  console.log(`== 곡당 시간: 분석 ${(tFeat / songs.length).toFixed(0)}ms + 맞추기 ${(tAlign / songs.length).toFixed(0)}ms`);
  per.sort((a, b) => b.mean - a.mean);
  console.log('== 가장 많이 어긋난 곡:', per.slice(0, 6).map(p => `${p.name.slice(0, 28)}(${p.lang.slice(0, 2)}) ${p.mean}s`).join(' · '));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
