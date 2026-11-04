"""코덱 엔진 시험 (FFmpeg wasm → FLAC fMP4 → MediaSource → <audio>)

  python3 test/codec_test.py [http://127.0.0.1:8766] [--no-jspi]

ffmpeg 로 시험 파일(WavPack · TTA · ALAC · WMA · AIFF · AC3 · MP2 · CAF)과 DSD(DSF, 직접 만듦)를 만들어
  1) 브라우저 엔진이 원래 못 푸는지, 2) 코덱 엔진으로 재생 · 길이 · 탐색 · 끝 이벤트가 맞는지,
  3) 나오는 소리가 원본과 같은 주파수인지(왼쪽 1kHz · 오른쪽 440Hz), 4) 태그 읽기(probe)가 되는지 본다.
"""
import json, os, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

BASE = next((a for a in sys.argv[1:] if a.startswith('http')), 'http://127.0.0.1:8766')
NO_JSPI = '--no-jspi' in sys.argv
D = tempfile.mkdtemp(prefix='ullim-codec-')
SRC = os.path.join(D, 'src.wav')
# 왼쪽 1kHz · 오른쪽 440Hz, 6초 (주파수로 왼쪽 · 오른쪽 · 시간 위치를 확인)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=1000:d=6:sample_rate=44100', '-f', 'lavfi', '-i', 'sine=f=440:d=6:sample_rate=44100',
                '-filter_complex', '[0][1]amerge=inputs=2,volume=0.5', '-metadata', 'title=코덱 시험', '-metadata', 'artist=울림', SRC], check=True)
FILES = {
    'wv': ['-c:a', 'wavpack'], 'tta': ['-c:a', 'tta'], 'm4a': ['-c:a', 'alac'], 'wma': ['-c:a', 'wmav2', '-b:a', '192k'],
    'aiff': [], 'ac3': ['-c:a', 'ac3', '-b:a', '192k'], 'mp2': ['-c:a', 'mp2', '-b:a', '256k'], 'caf': ['-c:a', 'pcm_s24le'],
    'hr.wv': ['-ar', '192000', '-sample_fmt', 's32p', '-c:a', 'wavpack'],                          # 24bit · 192kHz 고해상도
    '51.ac3': ['-af', 'pan=5.1(side)|FL=c0|FR=c1|FC=0.2*c0+0.2*c1|LFE=0*c0|SL=c0|SR=c1', '-c:a', 'ac3', '-b:a', '384k'],   # 5.1 → 스테레오로 섞기
}
paths = {}
for ext, args in FILES.items():
    p = os.path.join(D, f'test_{ext}.{ext.split(".")[-1]}')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', SRC] + args + [p], check=True)
    paths[ext] = p
dsf = os.path.join(D, 'test_dsf.dsf')
subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'make_dsf.mjs'), dsf, '6'], check=True)
paths['dsf'] = dsf

JS = r"""
async ([files, noJspi]) => {
  if (noJspi) globalThis.__ullimNoJSPI = true;
  const C = await import('/web/js/codec.js');
  const out = { supported: C.supported() };
  const ctx = new AudioContext();
  const code = "class R extends AudioWorkletProcessor { process(i) { const c = i[0]; if (c && c.length) this.port.postMessage([c[0].slice(), (c[1] || c[0]).slice()]); return true; } } registerProcessor('rec2', R);";
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  const freqAt = (buf, ch, sr) => {               // 가장 센 주파수 (단순 DFT 탐색)
    let best = 0, bf = 0;
    for (let f = 300; f <= 1200; f += 10) { let re = 0, im = 0; for (let i = 0; i < buf.length; i++) { const w = 2 * Math.PI * f * i / sr; re += buf[i] * Math.cos(w); im += buf[i] * Math.sin(w); } const m = re * re + im * im; if (m > best) { best = m; bf = f; } }
    return bf;
  };
  for (const [name, path] of Object.entries(files)) {
    const url = '/media?p=' + encodeURIComponent(path), r = { };
    // 1) 원래 엔진으로는?
    r.native = await new Promise(ok => { const a = new Audio(); const t = setTimeout(() => ok('timeout'), 4000); a.oncanplay = () => { clearTimeout(t); ok('ok'); }; a.onerror = () => { clearTimeout(t); ok('err'); }; a.src = url; });
    // 2) 코덱 엔진
    const a = new Audio(); let err = null, ended = false;
    const cs = new C.CodecSource(url, { onerror: e => { err = String(e); }, oninfo: (info, o) => { r.info = info; r.out = o; } });
    a.src = cs.attach(a);
    setTimeout(() => { r.jspi = cs.job && cs.job.jspi; }, 300);
    const src = ctx.createMediaElementSource(a), rec = new AudioWorkletNode(ctx, 'rec2', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    src.connect(rec);
    const chunks = []; rec.port.onmessage = e => chunks.push(e.data);
    a.addEventListener('ended', () => { ended = true; });
    await ctx.resume();
    const t0 = performance.now();
    try { await a.play(); } catch (e) { err = err || String(e); }
    await new Promise(ok => { const iv = setInterval(() => { if (a.currentTime > 1.2 || err || performance.now() - t0 > 10000) { clearInterval(iv); ok(); } }, 50); });
    r.startMs = Math.round(performance.now() - t0);
    r.dur = +(a.duration || 0).toFixed(3);
    // 녹음한 소리의 주파수 (왼쪽 1k, 오른쪽 440)
    let L = [], R = [];
    for (const c of chunks.slice(-200)) { if (c && c[0]) { L.push(...c[0]); R.push(...(c[1] || c[0])); } }
    const sr = ctx.sampleRate, mid = Math.max(0, L.length - Math.round(sr * 0.5));
    r.fL = freqAt(L.slice(mid, mid + 4096), 0, sr); r.fR = freqAt(R.slice(mid, mid + 4096), 1, sr);
    let pk = 0; for (const v of L.slice(mid)) pk = Math.max(pk, Math.abs(v)); r.peak = +pk.toFixed(3);
    // 3) 탐색: 4.0초로
    a.currentTime = 4.0;
    await new Promise(ok => { const t = setTimeout(ok, 8000); a.addEventListener('seeked', () => { clearTimeout(t); ok(); }, { once: true }); });
    const ts = performance.now();
    await new Promise(ok => { const iv = setInterval(() => { if (a.currentTime > 4.3 || err || performance.now() - ts > 8000) { clearInterval(iv); ok(); } }, 50); });
    r.afterSeek = +a.currentTime.toFixed(2);
    // 4) 끝까지 (빠르게: 5.6초로 가서 끝 이벤트)
    a.currentTime = Math.max(0, (a.duration || 6) - 0.4);
    await new Promise(ok => { const iv = setInterval(() => { if (ended || err || performance.now() - ts > 15000) { clearInterval(iv); ok(); } }, 50); });
    r.ended = ended; r.err = err; r.jspi = cs.job && cs.job.jspi;
    a.pause(); cs.dispose(); src.disconnect(); rec.disconnect();
    // 5) 태그 읽기
    try { const p = await C.probe(url); r.probe = { title: p.info.title, artist: p.info.artist, dur: p.info.dur, codec: p.info.codec }; } catch (e) { r.probe = String(e); }
    out[name] = r;
  }
  return out;
}
"""

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(BASE + '/test/dsp-test.html')
    r = pg.evaluate(JS, [paths, NO_JSPI])
    b.close()

fails = []
print('MSE FLAC 지원:', r.pop('supported'))
for name, x in r.items():
    info = x.get('info') or {}
    print(f"{name:<5} 원래엔진 {x['native']:<4} 코덱 {info.get('codec','?'):<16} {info.get('rate','?')}Hz/{info.get('bits','?')}bit → {x.get('out')} "
          f"JSPI {x.get('jspi')} 시작 {x['startMs']}ms 길이 {x['dur']} 주파수 L{x['fL']} R{x['fR']} 봉우리 {x['peak']} 탐색후 {x['afterSeek']} 끝 {x['ended']} 태그 {x['probe']} {x['err'] or ''}")
    if x['err']: fails.append(f'{name}: 오류 {x["err"]}')
    if not (5.8 <= x['dur'] <= 6.3): fails.append(f'{name}: 길이 {x["dur"]}')
    if abs(x['fL'] - 1000) > 20 or abs(x['fR'] - 440) > 20: fails.append(f'{name}: 주파수 L{x["fL"]} R{x["fR"]}')
    if not (4.0 <= x['afterSeek'] <= 5.5): fails.append(f'{name}: 탐색 뒤 위치 {x["afterSeek"]}')
    if not x['ended']: fails.append(f'{name}: 끝 이벤트 없음')
    if not isinstance(x['probe'], dict) or not x['probe'].get('codec'): fails.append(f'{name}: 태그 읽기 {x["probe"]}')
    if x['startMs'] > 4000: fails.append(f'{name}: 시작이 느림 {x["startMs"]}ms')
print('\n'.join('실패: ' + f for f in fails) if fails else '모두 통과')
if errs: print('콘솔 오류:', errs[:5])
sys.exit(1 if fails else 0)
