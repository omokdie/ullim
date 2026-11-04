/* 울림 — 돌리는 휠(노브) 조절기
 *  - 마우스: 위아래(또는 좌우)로 끌기 · 마우스 휠 · 화살표 키. Shift 를 누르고 끌면 4배 정밀
 *  - 손가락: 좌우로 밀어 돌림 (위아래로 밀면 목록이 스크롤됨)
 *  - 두 번 누르면(더블 클릭 · 더블 탭) 기본값
 *  - 가운데가 0 인 값(center)은 12시 방향에서 양쪽으로 채워짐
 *  - role="slider" 로 화면 낭독기에서도 값 조절
 */
const SVG = 'http://www.w3.org/2000/svg';
const A0 = -135, A1 = 135;                       // 최소 · 최대 각도 (12시 = 0°)
const polar = (r, deg) => { const a = (deg - 90) * Math.PI / 180; return [32 + r * Math.cos(a), 32 + r * Math.sin(a)]; };
function arc(r, d0, d1) {
  if (Math.abs(d1 - d0) < 0.01) return '';
  const [x0, y0] = polar(r, d0), [x1, y1] = polar(r, d1);
  const large = Math.abs(d1 - d0) > 180 ? 1 : 0, sweep = d1 > d0 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function svg(tag, attrs) { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; }

/**
 * @param {{ min:number, max:number, step?:number, value:number, def?:number, center?:number, label:string, fmt?:(v:number)=>string,
 *           onInput:(v:number)=>void, size?:'s'|'m'|'l', onStart?:()=>void, onEnd?:()=>void }} o
 * @returns {HTMLElement & { setValue(v:number):void }}
 */
export function knob(o) {
  const { min, max, label } = o, step = o.step || 1, fmt = o.fmt || (v => String(v));
  const def = o.def != null ? o.def : (o.center != null ? o.center : min);
  const root = document.createElement('div');
  root.className = 'knob' + (o.size ? ' ' + o.size : '');
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', label);
  root.setAttribute('aria-valuemin', min); root.setAttribute('aria-valuemax', max);
  const s = svg('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true', class: 'kn-svg' });
  const track = svg('path', { class: 'kn-track', d: arc(27, A0, A1) });
  const val = svg('path', { class: 'kn-val', d: '' });
  const face = svg('circle', { class: 'kn-face', cx: 32, cy: 32, r: 20 });
  const ptr = svg('line', { class: 'kn-ptr', x1: 32, y1: 32, x2: 32, y2: 16 });
  s.append(track, val, face, ptr);
  const vEl = document.createElement('div'); vEl.className = 'kn-v num';
  const lEl = document.createElement('div'); lEl.className = 'kn-l'; lEl.textContent = label;
  root.append(s, vEl, lEl);

  let v = clampStep(o.value);
  function clampStep(x) { x = Math.min(max, Math.max(min, x)); x = Math.round((x - min) / step) * step + min; return +x.toFixed(6); }
  const angle = x => A0 + (x - min) / (max - min) * (A1 - A0);
  function paint() {
    const a = angle(v), c = o.center != null ? angle(o.center) : A0;
    val.setAttribute('d', arc(27, Math.min(c, a), Math.max(c, a)));
    ptr.setAttribute('transform', `rotate(${a.toFixed(1)} 32 32)`);
    const t = fmt(v);
    vEl.textContent = t;
    root.setAttribute('aria-valuenow', v); root.setAttribute('aria-valuetext', t);
    root.classList.toggle('zero', o.center != null ? v === o.center : v === min);
  }
  function set(nv, fire = true) {
    nv = clampStep(nv);
    if (nv === v) return;
    v = nv; paint();
    if (fire) o.onInput(v);
  }
  // 끌기: 위아래 · 좌우 이동 합(오른쪽 · 위 = 올림), 끝까지 180px
  let drag = null;
  root.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    root.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, v, id: e.pointerId };
    root.classList.add('drag'); root.focus({ preventScroll: true });
    if (o.onStart) o.onStart();
    e.preventDefault();
  });
  root.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    // 손가락: 좌우로 밀어 돌림 (위아래는 화면 스크롤에 양보 — touch-action: pan-y), 마우스: 위아래 · 좌우 모두
    const d = e.pointerType === 'touch' ? (e.clientX - drag.x) * 1.15 : (drag.y - e.clientY) + (e.clientX - drag.x);
    if (Math.abs(d) > 3) drag.moved = true;
    const k = e.shiftKey ? 0.25 : 1;
    set(drag.v + d / 180 * (max - min) * k);
  });
  // 두 번 누르면 기본값 (터치는 dblclick 이 안 올 수 있어 직접 셈 — 움직이지 않은 짧은 누름만)
  let lastTap = 0;
  const end = e => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const tap = !drag.moved && e && e.type === 'pointerup' && e.pointerType === 'touch';
    drag = null; root.classList.remove('drag'); if (o.onEnd) o.onEnd();
    if (tap) { const t = performance.now(); if (t - lastTap < 320) { set(def); lastTap = 0; } else lastTap = t; }
  };
  root.addEventListener('pointerup', end); root.addEventListener('pointercancel', end); root.addEventListener('lostpointercapture', () => end());
  // 마우스 휠: 한 칸에 1 step (트랙패드처럼 잘게 오면 모아서)
  let acc = 0;
  root.addEventListener('wheel', e => {
    e.preventDefault();
    acc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const n = Math.trunc(acc / 50);
    if (n) { acc -= n * 50; set(v - n * step * (e.shiftKey ? 1 : Math.max(1, Math.round((max - min) / step / 60)))); }
  }, { passive: false });
  root.addEventListener('keydown', e => {
    const big = Math.max(step, (max - min) / 10);
    const k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowRight') set(v + step);
    else if (k === 'ArrowDown' || k === 'ArrowLeft') set(v - step);
    else if (k === 'PageUp') set(v + big); else if (k === 'PageDown') set(v - big);
    else if (k === 'Home') set(min); else if (k === 'End') set(max);
    else return;
    e.preventDefault();
  });
  root.addEventListener('dblclick', () => set(def));
  paint();
  root.setValue = nv => set(nv, false);
  return root;
}
