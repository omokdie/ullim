"""음장 효과 켜고 끌 때 끊김(소리가 비는 구간) · 틱(샘플이 튀는 곳) · 버퍼 부족을 실제 재생으로 잼
   python3 test/fx_glitch_test.py [주소=http://127.0.0.1:8766/web/index.html]
   330Hz 사인 → 엔진 → 녹음 워클릿. 효과 10개를 하나씩 켜고(0.6초) 끄기(0.6초), 프리셋 바꾸기 4번, 공간 · 리버브 값 돌리기."""
import json, sys, time, math
from playwright.sync_api import sync_playwright

BASE = next((a for a in sys.argv[1:] if a.startswith('http')), 'http://127.0.0.1:8766/web/index.html')
SETUP = r"""
async () => {
  const E = __ullim.engine, ctx = E.ctx;
  await ctx.resume();
  await ctx.audioWorklet.addModule('/test/recorder-worklet.js');
  const rec = new AudioWorkletNode(ctx, 'ul-rec', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
  window.__rec = [];
  rec.port.onmessage = e => window.__rec.push(Array.from(e.data));
  E.switcher.connect(rec);
  const osc = ctx.createOscillator(); osc.frequency.value = 330;
  const g = ctx.createGain(); g.gain.value = 0.25; osc.connect(g).connect(E.mix); osc.start();
  window.__osc = osc; window.__recNode = rec;
  window.__t0 = ctx.currentTime;
  return { sr: ctx.sampleRate, t0: ctx.currentTime, stats: ctx.playbackStats ? { u: ctx.playbackStats.underrunEvents } : null };
}
"""
IDS = ['bass', 'compressor', 'wide', 'reverb', 'chorus', 'crystal', 'eq', 'hall', 'surround', 'exciter']
fails = []
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE); pg.wait_for_function('window.__ullim && window.__ullim.engine')
    pg.evaluate("__ullim.applySoundPreset({id:'off', name:'원음', fx:{}, eqOff:true})")
    info = pg.evaluate(SETUP)
    sr = info['sr']
    time.sleep(0.8)
    marks = []
    t0 = info['t0']                      # 녹음 시작(엔진 시각) — 표시 시각을 녹음 위치에 맞춤
    def mark(label): marks.append((label, pg.evaluate('__ullim.engine.ctx.currentTime') - t0))
    for fid in IDS:
        mark('on ' + fid); pg.evaluate(f"__ullim.engine.setEnabled('{fid}', true)"); time.sleep(0.6)
        mark('off ' + fid); pg.evaluate(f"__ullim.engine.setEnabled('{fid}', false)"); time.sleep(0.6)
    for pid in ['hall', 'club', 'cinema', 'off']:
        mark('preset ' + pid)
        pg.evaluate(f"(async () => {{ const {{ SOUND_PRESETS }} = await import(new URL('js/presets.js', location.href).href); __ullim.applySoundPreset(SOUND_PRESETS.find(x => x.id === '{pid}')); }})()")
        time.sleep(0.8)
    # 값 돌리기: 리버브 방 크기 · 공간 바꾸기 (예전에는 잔향을 통째로 바꿔 끊김)
    mark('knobs'); pg.evaluate("__ullim.engine.setEnabled('hall', true)"); time.sleep(0.4)
    for sp in ['church', 'room', 'arena', 'hall']:
        pg.evaluate(f"__ullim.engine.setParam('hall', 'space', '{sp}')"); time.sleep(0.35)
    for v in range(40, 201, 20):
        pg.evaluate(f"__ullim.engine.setParam('hall', 'size', {v})"); time.sleep(0.05)
    time.sleep(0.6)
    mark('end')
    st = pg.evaluate("__ullim.engine.ctx.playbackStats ? { u: __ullim.engine.ctx.playbackStats.underrunEvents, d: __ullim.engine.ctx.playbackStats.underrunDuration } : null")
    pg.evaluate("__recNode.port.postMessage('stop')"); time.sleep(0.2)
    rec = pg.evaluate('window.__rec')
    b.close()

x = [v for chunk in rec for v in chunk]
# 기준 크기: 처음 0.5초 (원음 사인 0.25)
W = int(sr * 0.005)
def rms(a): return math.sqrt(sum(v * v for v in a) / max(1, len(a)))
start = next((i for i, v in enumerate(x) if abs(v) > 0.05), 0)
base = rms(x[start + W * 4:start + W * 60])
dips, dip_ms, cur = 0, 0, 0
for i in range(start + W * 4, len(x) - W, W):
    r = rms(x[i:i + W])
    if r < base * 0.25:                     # 12dB 넘게 줄어든 5ms 구간 = 끊김
        dip_ms += 5; cur += 1
    else:
        if cur: dips += 1
        cur = 0
jump_at = [i for i in range(start + 1, len(x)) if abs(x[i] - x[i - 1]) > 0.09]
jumps = len(jump_at)
# 어디서 났는지: 표시(mark) 시각은 녹음 시작 기준이 아니라 엔진 시각 → 녹음 첫 샘플 시각을 모르므로 상대 위치만 대략
dip_at, cur2 = [], 0
for i in range(start + W * 4, len(x) - W, W):
    r = rms(x[i:i + W])
    if r < base * 0.25:
        if not cur2: dip_at.append(i)
        cur2 = 1
    else: cur2 = 0
def near(i):
    t = i / sr
    lab = None
    for name, mt in marks:
        if mt - 0.05 <= t: lab = (name, round(t - mt, 3))
    return lab
R = {'url': BASE, 'seconds': round(len(x) / sr, 1), 'base_rms': round(base, 3), 'dips': dips, 'dip_ms': dip_ms, 'jumps': jumps, 'underruns': st, 'errors': errs[:3]}
if '-vv' in sys.argv and dip_at:
    i0 = dip_at[0]
    env = [round(rms(x[j:j + int(sr * 0.002)]), 3) for j in range(i0 - int(sr * 0.06), i0 + int(sr * 0.06), int(sr * 0.002))]
    R['env_around_dip'] = env
if '-v' in sys.argv: R['where'] = {'dips': [near(i) for i in dip_at][:20], 'jumps': [near(i) for i in jump_at][:20]}
print(json.dumps(R, ensure_ascii=False))
