"""음장 프리셋 음량 · 찌그러짐 시험 (오프라인 렌더, 앱 엔진과 같은 효과 · 자동 여유 음량 · 안전망)

  python3 test/preset_level_test.py [http://127.0.0.1:8766] [-v]

시험 음악 두 가지를 만들어 각 프리셋을 통과시킨다:
  loud  — 요즘 가요처럼 꽉 채운 마스터 (약 -9 LUFS, 봉우리 -0.3 dBFS)
  quiet — 재즈 · 클래식처럼 여유 있는 마스터 (약 -20 LUFS)
재는 것: 원음 대비 음량 차이(LU), 최종 봉우리, 안전망 앞 봉우리, 안전망이 소리를 누른 비율(%) = 찌그러짐 정도.
통과 기준: 최종 봉우리 ≤ 1.0, 안전망이 누른 비율이 아주 작음, 원음과 음량 차이가 너무 크지 않음,
          '원음'(리미터만 켬)은 원음과 비트 단위로 같음.
"""
import json, sys
from playwright.sync_api import sync_playwright

BASE = next((a for a in sys.argv[1:] if a.startswith('http')), 'http://127.0.0.1:8766')
VERBOSE = '-v' in sys.argv

JS = r"""
async () => {
  const E = await import('/web/js/effects.js');
  const EN = await import('/web/js/engine.js');
  const P = await import('/web/js/presets.js');
  const sr = 48000, secs = 8;

  /* ---------- 시험 음악: 킥 · 스네어 · 하이햇 · 베이스 · 가운데 멜로디(포먼트) · 넓은 패드 ---------- */
  async function song(seed) {
    const ctx = new OfflineAudioContext(2, sr * secs, sr);
    const bus = ctx.createGain(); bus.gain.value = 0.5; bus.connect(ctx.destination);
    let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const nb = ctx.createBuffer(1, sr, sr); { const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1; }
    const env = (g, t, a, peak, dec) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.setTargetAtTime(0, t + a, dec / 4); };
    const pan = (node, p) => { const sp = ctx.createStereoPanner(); sp.pan.value = p; node.connect(sp); sp.connect(bus); };
    const beat = 0.5, roots = [55, 43.65, 65.41, 49], mel = [440, 493.88, 523.25, 587.33, 659.25, 587.33, 523.25, 493.88];
    const chords = [[220, 261.63, 329.63], [174.61, 220, 261.63], [261.63, 329.63, 392], [196, 246.94, 293.66]];
    for (let b = 0; b * beat < secs; b++) {
      const t = b * beat, bar = Math.floor(b / 4) % 4;
      { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); env(g, t, 0.002, 1.0, 0.35); o.connect(g); pan(g, 0); o.start(t); o.stop(t + 0.6); }
      if (b % 2 === 1) { const n = ctx.createBufferSource(); n.buffer = nb; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.7; const g = ctx.createGain(); env(g, t, 0.001, 0.8, 0.2); n.connect(f).connect(g); pan(g, 0.05); n.start(t, rnd() * 0.5); n.stop(t + 0.3); }
      for (const off of [0, beat / 2]) { const n = ctx.createBufferSource(); n.buffer = nb; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000; const g = ctx.createGain(); env(g, t + off, 0.001, 0.25, 0.05); n.connect(f).connect(g); pan(g, 0.35); n.start(t + off, rnd() * 0.5); n.stop(t + off + 0.1); }
      { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = roots[bar]; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 350; const g = ctx.createGain(); env(g, t, 0.005, 0.5, 0.4); o.connect(f).connect(g); pan(g, 0); o.start(t); o.stop(t + beat); }
      { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mel[b % 8]; const v = ctx.createOscillator(), vg = ctx.createGain(); v.frequency.value = 5.5; vg.gain.value = 4; v.connect(vg).connect(o.frequency);
        const g = ctx.createGain(); env(g, t, 0.03, 0.22, 0.45);
        for (const [fq, q, a] of [[700, 4, 1], [1150, 6, 0.6], [2600, 8, 0.3]]) { const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = fq; f.Q.value = q; const fg = ctx.createGain(); fg.gain.value = a * 3; o.connect(f).connect(fg).connect(g); }
        pan(g, 0); o.start(t); v.start(t); o.stop(t + beat); v.stop(t + beat); }
    }
    for (let bar = 0; bar * 2 < secs; bar++) {
      const t = bar * 2;
      chords[bar % 4].forEach(fq => { for (const [det, p] of [[-6, -0.7], [6, 0.7]]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fq; o.detune.value = det; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2200; const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 0.3); g.gain.setValueAtTime(0.05, t + 1.7); g.gain.linearRampToValueAtTime(0, t + 2); o.connect(f).connect(g); pan(g, p); o.start(t); o.stop(t + 2); } });
    }
    return await ctx.startRendering();
  }

  /* ---------- 음량 (ITU-R BS.1770, 48kHz K-가중, 400ms 블록 게이트) ---------- */
  function kw(x) {
    const y = new Float32Array(x.length);
    const st = [[1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585], [1, -2, 1, -1.99004745483398, 0.99007225036621]];
    let src = x;
    for (const [b0, b1, b2, a1, a2] of st) { let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < src.length; i++) { const v = src[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; } src = y.slice(); }
    return y;
  }
  function lufs(L, R) {
    const a = kw(L), b = kw(R), blk = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), z = [];
    for (let i = 0; i + blk <= a.length; i += hop) { let s = 0; for (let j = i; j < i + blk; j++) s += a[j] * a[j] + b[j] * b[j]; z.push(s / blk); }
    const ld = v => -0.691 + 10 * Math.log10(v + 1e-20);
    let g = z.filter(v => ld(v) > -70); if (!g.length) return -99;
    const rel = ld(g.reduce((p, v) => p + v, 0) / g.length) - 10; g = g.filter(v => ld(v) > rel);
    return ld(g.reduce((p, v) => p + v, 0) / g.length);
  }
  /* ---------- 마스터링 (미리보기 1.5ms 리미터) ---------- */
  function limit(buf, drive, ceil) {
    const n = buf.length, L0 = buf.getChannelData(0), R0 = buf.getChannelData(1), la = Math.round(0.0015 * sr), rel = 1 - Math.exp(-1 / (0.06 * sr));
    const gt = new Float32Array(n); for (let i = 0; i < n; i++) { const p = Math.max(Math.abs(L0[i]), Math.abs(R0[i])) * drive; gt[i] = p > ceil ? ceil / p : 1; }
    const L = new Float32Array(n), R = new Float32Array(n); let g = 1;
    for (let i = 0; i < n; i++) { let m = 1; for (let j = i; j < Math.min(n, i + la); j++) if (gt[j] < m) m = gt[j]; g = m < g ? m : g + (m - g) * rel; if (g > m) g = m;
      L[i] = Math.max(-ceil, Math.min(ceil, L0[i] * drive * g)); R[i] = Math.max(-ceil, Math.min(ceil, R0[i] * drive * g)); }
    return [L, R];
  }
  function master(buf, target, ceil) {
    let lo = 0.05, hi = 40, LR = null;
    for (let k = 0; k < 14; k++) { const d = Math.sqrt(lo * hi); LR = limit(buf, d, ceil); if (lufs(LR[0], LR[1]) < target) lo = d; else hi = d; }
    const out = new AudioBuffer({ length: buf.length, numberOfChannels: 2, sampleRate: sr }); out.copyToChannel(LR[0], 0); out.copyToChannel(LR[1], 1);
    return out;
  }

  /* ---------- 앱 엔진과 같은 사슬: 자동 여유 음량 → 효과(ORDER 순서) → 안전망 ---------- */
  async function chain(input, fx, { volume = 0.8, light = false } = {}) {
    const ids = EN.liveIds(id => !!(fx[id] && fx[id].on), false);
    if (!ids.length) {   // 엔진도 원음 경로(direct) — 그대로
      const out = new AudioBuffer({ length: input.length, numberOfChannels: 4, sampleRate: sr });
      for (let c = 0; c < 4; c++) out.copyToChannel(input.getChannelData(c % 2), c);
      return { out, hr: 0, n: 0, direct: true };
    }
    const ctx = new OfflineAudioContext(4, input.length, sr);
    ctx.destination.channelInterpretation = 'discrete';
    await ctx.audioWorklet.addModule('/web/js/fx-worklet.js');
    const src = ctx.createBufferSource(); src.buffer = input;
    const head = ctx.createGain(); head.channelCount = 2; head.channelCountMode = 'explicit';
    src.connect(head);
    let node = head; const mods = [];
    for (const id of ids) {
      const st = fx[id], def = E.FX_BY_ID[id];
      const m = def.build(ctx, { light, maxIR: light ? 1.8 : 5 });
      for (const [k, v] of Object.entries(st.p)) m.set(k, v);
      if (m.setListening) m.setListening(volume > 0 ? 40 * Math.log10(volume) : -60);
      if (m.ready) await m.ready;
      node.connect(m.input); node = m.output; mods.push(m);
    }
    const hr = EN.headroomFor(mods); head.gain.value = Math.pow(10, hr / 20);
    const sIn = ctx.createGain(); sIn.gain.value = 0.5; const sh = ctx.createWaveShaper(); sh.curve = EN.safetyCurve(); sh.oversample = '2x';
    const mg = ctx.createChannelMerger(4), s1 = ctx.createChannelSplitter(2), s2 = ctx.createChannelSplitter(2);
    node.connect(sIn).connect(sh).connect(s1); s1.connect(mg, 0, 0); s1.connect(mg, 1, 1);
    node.connect(s2); s2.connect(mg, 0, 2); s2.connect(mg, 1, 3);
    mg.connect(ctx.destination); src.start();
    return { out: await ctx.startRendering(), hr, n: mods.length };
  }
  function stats(r, ref) {
    const b = r.out, L = b.getChannelData(0), R = b.getChannelData(1), pL = b.getChannelData(2), pR = b.getChannelData(3);
    const skip = Math.floor(0.5 * sr), n = L.length - skip;
    let peak = 0, pre = 0, soft = 0, hard = 0, diff = 0;
    const rL = ref.getChannelData(0), rR = ref.getChannelData(1);
    for (let i = skip; i < L.length; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i])), q = Math.max(Math.abs(pL[i]), Math.abs(pR[i]));
      if (a > peak) peak = a; if (q > pre) pre = q; if (q > 0.9) soft++; if (q > 1) hard++;
      diff = Math.max(diff, Math.abs(L[i] - rL[i]), Math.abs(R[i] - rR[i]));
    }
    if (r.direct) soft = hard = 0;   // 원음 경로에는 안전망이 없다
    return { lu: +(lufs(L.subarray(skip), R.subarray(skip)) - lufs(rL.subarray(skip), rR.subarray(skip))).toFixed(2), peak: +peak.toFixed(4), pre: +pre.toFixed(3),
      soft: +(soft / n * 100).toFixed(3), hard: +(hard / n * 100).toFixed(3), hr: +r.hr.toFixed(2), diff };
  }

  const raw = await song(12345);
  const masters = { loud: master(raw, -9, 0.966), quiet: master(raw, -20, 0.5) };
  const res = { masters: {} };
  for (const [k, m] of Object.entries(masters)) { let pk = 0; for (let c = 0; c < 2; c++) for (const v of m.getChannelData(c)) pk = Math.max(pk, Math.abs(v)); res.masters[k] = { lufs: +lufs(m.getChannelData(0), m.getChannelData(1)).toFixed(2), peak: +pk.toFixed(3) }; }
  const LIM = { on: true, p: E.defaultParams(E.FX_BY_ID.limiter) };
  const presets = [{ id: 'limiter-only', fx: {} }, ...P.SOUND_PRESETS.filter(p => p.id !== 'off')];
  for (const pr of presets) {
    const fx = { limiter: LIM };
    for (const [id, p] of Object.entries(pr.fx)) fx[id] = { on: true, p: { ...E.defaultParams(E.FX_BY_ID[id]), ...p } };
    res[pr.id] = {};
    for (const [k, m] of Object.entries(masters)) res[pr.id][k] = stats(await chain(m, fx), m);
  }
  return res;
}
"""

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE + '/test/dsp-test.html')
    r = pg.evaluate(JS)
    b.close()

print('시험 음악', json.dumps(r.pop('masters')))
fails = []
print(f"{'프리셋':<14}{'곡':<6}{'음량차LU':>9}{'봉우리':>8}{'안전망앞':>9}{'눌림%':>8}{'넘침%':>8}{'여유dB':>8}")
for pid, d in r.items():
    for k, s in d.items():
        print(f"{pid:<14}{k:<6}{s['lu']:>9}{s['peak']:>8}{s['pre']:>9}{s['soft']:>8}{s['hard']:>8}{s['hr']:>8}")
        if s['peak'] > 1.0: fails.append(f'{pid}/{k}: 최종 봉우리 {s["peak"]} > 1.0')
        if s['soft'] > 0.5: fails.append(f'{pid}/{k}: 안전망이 {s["soft"]}% 를 누름 (찌그러짐)')
        if pid == 'limiter-only' and s['diff'] > 0: fails.append(f'limiter-only/{k}: 원음과 다름 (최대 차이 {s["diff"]:.2e})')
        if pid not in ('limiter-only', 'radio', 'water', 'lofi', 'night', 'karaoke') and not (-4.5 <= s['lu'] <= 4.0): fails.append(f'{pid}/{k}: 음량 차이 {s["lu"]} LU')
print('\n'.join(['실패: ' + f for f in fails]) if fails else '모두 통과')
if errs: print('page errors', errs[:3])
sys.exit(1 if fails or errs else 0)
