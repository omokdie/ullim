/*
 * 울림 — 리퀴드 글라스 (유리 재질)
 *
 * 모드 (html[data-glass])
 *   off   : 배터리 절약 — 흐림 · 굴절 없이 반투명 색만 (GPU 일 거의 없음)
 *   light : 휴대폰 기본 — 흐림 + 가벼운 굴절(아래 메뉴 · 미니 플레이어에만)
 *   rich  : PC 기본 — 흐림 + 굴절(왼쪽 메뉴 · 재생 막대 · 아래 메뉴)
 *   auto  : 설정값. 휴대폰은 light, PC 는 rich, 배터리 절약 모드 · 배터리 20% 이하(충전 중 아님) · '투명도 줄이기' 이면 off
 *
 * 굴절: 요소 크기에 맞춘 '변위 지도'(가장자리로 갈수록 안쪽 화면을 끌어와 볼록 렌즈처럼 휘어 보이게)를 만들어
 *       SVG feDisplacementMap 으로 backdrop-filter 에 건다 (Chromium: Electron · 안드로이드 WebView).
 *  - 지도는 크기가 바뀔 때만 반 해상도로 한 번 그린다. 움직이는 효과(애니메이션)는 없다.
 *  - 유리 위에서 자주 바뀌는 것(진행 막대)은 1초에 몇 번만 바꿔 다시 그리는 일을 줄인다 (app.js).
 */
const NS = 'http://www.w3.org/2000/svg';
let pref = 'auto', phone = false, saving = false, mode = 'light', seq = 0;
const items = new Map();          // 요소 → { id, w, h, key }
const reduceMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-transparency: reduce)') : null;

/** 둥근 사각형 가장자리에서 안쪽으로 끌어오는 변위 지도 (R = x, G = y, 128 = 그대로) */
export function lensMap(w, h, radius, bezel) {
  const s = 0.5, W = Math.max(2, Math.round(w * s)), H = Math.max(2, Math.round(h * s));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data;
  const R = Math.max(0, Math.min(radius, w / 2, h / 2)), hw = w / 2, hh = h / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = (x + 0.5) / s, py = (y + 0.5) / s;
      const qx = Math.abs(px - hw) - (hw - R), qy = Math.abs(py - hh) - (hh - R);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R;
      const dist = -outside;                                  // 가장자리에서 안쪽으로 떨어진 거리
      let dx = 0, dy = 0;
      if (dist < bezel) {
        const t = 1 - Math.max(0, dist) / bezel, mag = t * t * (3 - 2 * t);   // 가장자리일수록 세게 (부드러운 곡선)
        let nx, ny;
        if (qx > 0 && qy > 0) { const L = Math.hypot(qx, qy) || 1; nx = qx / L; ny = qy / L; }
        else if (qx > qy) { nx = 1; ny = 0; } else { nx = 0; ny = 1; }
        nx *= px < hw ? -1 : 1; ny *= py < hh ? -1 : 1;      // 바깥쪽 방향
        dx = -nx * mag; dy = -ny * mag;                       // → 안쪽 화면을 가져옴
      }
      const i = (y * W + x) * 4;
      d[i] = Math.round(128 + dx * 127); d[i + 1] = Math.round(128 + dy * 127); d[i + 2] = 128; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function lensOn(el) {
  if (mode === 'off') return false;
  if (mode === 'rich') return true;
  return el.dataset.lens === 'light';                         // 가벼운 모드: 표시된 요소만
}
function apply(el) {
  const it = items.get(el);
  if (!it) return;
  if (!lensOn(el)) {
    if (it.key) { el.style.backdropFilter = ''; el.style.webkitBackdropFilter = ''; it.key = ''; }
    return;
  }
  const r = el.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
  if (!w || !h) return;
  const key = `${w}x${h}:${mode}`;
  if (it.key === key) return;
  it.key = key;
  const rich = mode === 'rich';
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  const bezel = Math.max(6, Math.min(rich ? 24 : 16, h / 2, w / 2));
  const scale = rich ? 30 : 16, blur = rich ? 9 : 11, sat = rich ? 1.7 : 1.5;
  let f = document.getElementById(it.id);
  if (!f) { f = document.createElementNS(NS, 'filter'); f.id = it.id; f.setAttribute('color-interpolation-filters', 'sRGB'); document.querySelector('#lgDefs defs').append(f); }
  f.innerHTML = `<feImage href="${lensMap(w, h, radius, bezel)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>`
    + `<feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="soft"/>`
    + `<feDisplacementMap in="soft" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="bent"/>`
    + `<feColorMatrix in="bent" type="saturate" values="${sat}"/>`;
  el.style.backdropFilter = el.style.webkitBackdropFilter = `url(#${it.id})`;
}
const resized = new Set();
const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(es => {
  for (const e of es) resized.add(e.target);            // 여러 번 바뀌어도 바뀐 요소는 모두 (창을 대각선으로 끌 때)
  clearTimeout(ro.t);
  ro.t = setTimeout(() => { const els = [...resized]; resized.clear(); for (const el of els) apply(el); }, 120);
}) : null;

/** 굴절을 걸 요소 등록 (light 모드에도 걸려면 data-lens="light") */
export function lens(el, { light = false } = {}) {
  if (!el || items.has(el)) return;
  if (light) el.dataset.lens = 'light';
  items.set(el, { id: 'lg' + (++seq), key: '' });
  if (ro) ro.observe(el);
  apply(el);
}
function resolve() {
  const reduce = reduceMq && reduceMq.matches;
  const m = pref === 'auto' ? (saving || reduce ? 'off' : phone ? 'light' : 'rich') : pref;
  document.documentElement.classList.toggle('saving', saving);     // 배터리 절약 중: 재생 버튼 물결 움직임 등도 멈춤
  if (m !== mode || document.documentElement.dataset.glass !== m) {
    mode = m;
    document.documentElement.dataset.glass = m;
  }
  for (const el of items.keys()) apply(el);
  return mode;
}
/** 설정 · 화면 크기 바뀔 때 */
export function setGlass(p, isPhone) { pref = p || 'auto'; phone = !!isPhone; return resolve(); }
export function glassMode() { return mode; }
export function isSaving() { return saving; }

/** 배터리: 절약 모드(안드로이드) · 20% 이하이고 충전 중이 아니면 자동으로 끔 */
export function watchPower(powerSave) {
  const check = () => { const s = !!(powerSave && powerSave()); if (s !== saving) { saving = s; resolve(); } };
  if (typeof navigator !== 'undefined' && navigator.getBattery) {
    navigator.getBattery().then(b => {
      const upd = () => { const s = (!b.charging && b.level <= 0.2) || !!(powerSave && powerSave()); if (s !== saving) { saving = s; resolve(); } };
      b.addEventListener('levelchange', upd); b.addEventListener('chargingchange', upd); upd();
    }).catch(check);
  } else check();
  if (powerSave) document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  if (reduceMq && reduceMq.addEventListener) reduceMq.addEventListener('change', resolve);
}
