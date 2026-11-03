/* 울림 — 이퀄라이저 프리셋 · 음장 프리셋 */

// 31 62 125 250 500 1k 2k 4k 8k 16k (dB)
export const EQ_PRESETS = [
  ['flat', '플랫', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['pop', '팝', [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2]],
  ['rock', '록', [5, 4, 3, 1, -1, -1, 1, 3, 4, 5]],
  ['ballad', '발라드', [3, 2, 1, 0, 1, 2, 2, 1, 1, 2]],
  ['dance', '댄스 · EDM', [6, 5, 2, 0, 0, -2, -1, 1, 4, 5]],
  ['hiphop', '힙합', [6, 5, 2, 3, -1, -1, 1, 0, 2, 3]],
  ['rnb', 'R&B', [3, 6, 5, 1, -2, -1, 1, 2, 3, 4]],
  ['jazz', '재즈', [3, 2, 1, 2, -1, -1, 0, 1, 2, 3]],
  ['classic', '클래식', [4, 3, 2, 1, -1, -1, 0, 2, 3, 4]],
  ['acoustic', '어쿠스틱', [4, 3, 2, 1, 2, 2, 3, 3, 2, 1]],
  ['vocal', '보컬', [-2, -2, -1, 1, 3, 4, 4, 2, 0, -1]],
  ['bass', '저음 강화', [7, 6, 5, 3, 1, 0, 0, 0, 0, 0]],
  ['treble', '고음 강화', [0, 0, 0, 0, 0, 1, 3, 5, 6, 7]],
  ['vshape', 'V자형', [5, 4, 2, 0, -2, -2, 0, 2, 4, 5]],
  ['headphone', '헤드폰', [3, 2, 0, -1, -1, 0, 1, 2, 3, 2]],
  ['small', '소형 스피커', [-4, -2, 3, 4, 2, 0, 0, 1, 2, 1]],
  ['loud', '작은 볼륨', [6, 4, 2, 0, 0, 0, 0, 1, 3, 4]],
  ['speech', '말소리 · 강의', [-6, -4, -2, 1, 3, 4, 4, 3, 0, -2]],
];

/**
 * 음장 프리셋: fx = { 효과id: 파라미터(일부) }, eq = EQ 프리셋 id (선택)
 * 적용 시 limiter 를 제외한 효과는 모두 꺼지고 목록의 효과만 켜진다.
 */
export const SOUND_PRESETS = [
  { id: 'off', name: '원음', fx: {}, eqOff: true },
  { id: 'hall', name: '콘서트홀', fx: { hall: { space: 'hall', size: 110, mix: 30 }, wide: { width: 130 } } },
  { id: 'live', name: '라이브', fx: { reverb: { room: 55, damp: 40, mix: 25, predelay: 25 }, wide: { width: 140 }, exciter: { amount: 25 }, compressor: { threshold: -20, ratio: 2.5 } } },
  { id: 'club', name: '클럽', fx: { bass: { gain: 8, freq: 60 }, vbass: { amount: 40 }, compressor: { threshold: -20, ratio: 4 }, reverb: { room: 40, mix: 14 }, wide: { width: 125 } } },
  { id: 'cinema', name: '영화관', fx: { surround: { depth: 70, delay: 20 }, hall: { space: 'arena', size: 90, mix: 18 }, bass: { gain: 5, freq: 70 }, loudness: { amount: 35 } } },
  { id: 'phones', name: '헤드폰 최적화', fx: { crossfeed: { fcut: 700, feed: 4.5 }, vbass: { amount: 30 }, exciter: { amount: 20 } } },
  { id: 'space3d', name: '3D 입체', fx: { surround: { depth: 80, delay: 18 }, haas: { delay: 9 }, reverb: { room: 50, mix: 15 } } },
  { id: 'eight', name: '8D 오디오', fx: { rotate8d: { period: 10, mix: 100 }, reverb: { room: 62, mix: 22 } } },
  { id: 'virt', name: '가상 서라운드', fx: { virtualizer: { angle: 35, rear: 55, mix: 100 } } },
  { id: 'vocal', name: '보컬 강조', fx: { vocal: { amount: 70 }, compressor: { threshold: -22, ratio: 2.5 }, exciter: { amount: 20 } } },
  { id: 'karaoke', name: '노래방', fx: { karaoke: { strength: 100 }, reverb: { room: 50, mix: 22 }, echo: { time: 140, feedback: 20, mix: 12 } } },
  { id: 'bassup', name: '저음 강화', fx: { bass: { gain: 9, freq: 75 }, vbass: { amount: 50 }, subharm: { amount: 30 } } },
  { id: 'clear', name: '선명하게', fx: { crystal: { intensity: 35 }, exciter: { amount: 40 }, treble: { gain: 3 } } },
  { id: 'night', name: '야간 감상', fx: { night: { amount: 70 }, leveler: { target: -18 } } },
  { id: 'lp', name: 'LP 감성', fx: { vinyl: { crackle: 45, noise: 25, wow: 25, tone: 40 }, warm: { drive: 30 } } },
  { id: 'radio', name: '라디오', fx: { radio: { mode: 'am' } } },
  { id: 'water', name: '수중', fx: { underwater: { depth: 65, wobble: 40 } } },
  { id: 'lofi', name: '로파이', fx: { lofi: { bits: 8, down: 3, mix: 100 }, vinyl: { crackle: 25, noise: 15, wow: 15, tone: 35 } } },
];
