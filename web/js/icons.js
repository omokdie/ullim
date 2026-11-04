/* 울림 — 아이콘 (24×24, currentColor) */
const S = (d, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${d}</svg>`;
const st = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS = {
  play: S('<path fill="currentColor" d="M8 5.6v12.8c0 .8.9 1.3 1.6.9l10.2-6.4a1 1 0 0 0 0-1.8L9.6 4.7C8.9 4.3 8 4.8 8 5.6z"/>'),
  pause: S('<rect fill="currentColor" x="6.5" y="5" width="4" height="14" rx="1.2"/><rect fill="currentColor" x="13.5" y="5" width="4" height="14" rx="1.2"/>'),
  prev: S('<rect fill="currentColor" x="5" y="5.5" width="2.4" height="13" rx="1"/><path fill="currentColor" d="M19 6.6v10.8c0 .8-.9 1.3-1.5.8l-8-5.4a1 1 0 0 1 0-1.6l8-5.4c.6-.5 1.5 0 1.5.8z"/>'),
  next: S('<rect fill="currentColor" x="16.6" y="5.5" width="2.4" height="13" rx="1"/><path fill="currentColor" d="M5 6.6v10.8c0 .8.9 1.3 1.5.8l8-5.4a1 1 0 0 0 0-1.6l-8-5.4C5.9 5.3 5 5.8 5 6.6z"/>'),
  shuffle: S(`<path ${st} d="M3 7h3.2c4.2 0 6.4 10 10.6 10H21M3 17h3.2c1.5 0 2.7-1.3 3.7-3M14.1 10c1-1.7 2.2-3 3.7-3H21M18 4l3 3-3 3M18 14l3 3-3 3"/>`),
  repeat: S(`<path ${st} d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20M17 3l3 3-3 3M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4M7 21l-3-3 3-3"/>`),
  repeatOne: S(`<path ${st} d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20M17 3l3 3-3 3M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4M7 21l-3-3 3-3"/><path fill="currentColor" d="M11.2 10.2l1.6-.9h1v5.4h-1.4v-3.8l-1.2.6z"/>`),
  vol: S(`<path fill="currentColor" d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"/><path ${st} d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>`),
  mute: S(`<path fill="currentColor" d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"/><path ${st} d="M16 9.5l5 5M21 9.5l-5 5"/>`),
  note: S('<path fill="currentColor" d="M18 3.2v11.3a3.3 3.3 0 1 1-2-3V7.4l-7 1.6v7.5a3.3 3.3 0 1 1-2-3V6.7c0-.5.3-.9.8-1l9-2.2c.6-.1 1.2.3 1.2 1z"/>'),
  plus: S(`<path ${st} d="M12 5v14M5 12h14"/>`),
  file: S(`<path ${st} d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14h6"/>`),
  folder: S(`<path ${st} d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5"/>`),
  library: S(`<path ${st} d="M4 4v16M8 4v16M12.5 4.5l4.8 15.3"/><path ${st} d="M15 4.5l2.6-.8 4.8 15.3-2.6.8z" opacity="0"/>`),
  search: S(`<circle ${st} cx="11" cy="11" r="6.5"/><path ${st} d="M20 20l-4.3-4.3"/>`),
  more: S('<circle fill="currentColor" cx="5.5" cy="12" r="1.7"/><circle fill="currentColor" cx="12" cy="12" r="1.7"/><circle fill="currentColor" cx="18.5" cy="12" r="1.7"/>'),
  close: S(`<path ${st} d="M6 6l12 12M18 6L6 18"/>`),
  list: S(`<path ${st} d="M8 6h12M8 12h12M8 18h8M4 6h.01M4 12h.01M4 18h.01"/>`),
  fx: S(`<path ${st} d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/><circle fill="currentColor" cx="12" cy="12" r="1.6"/>`),
  eq: S(`<path ${st} d="M6 4v5M6 13v7M12 4v11M12 19v1M18 4v2M18 10v10"/><circle ${st} cx="6" cy="11" r="2"/><circle ${st} cx="12" cy="17" r="2"/><circle ${st} cx="18" cy="8" r="2"/>`),
  gear: S(`<circle ${st} cx="12" cy="12" r="3"/><path ${st} d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  save: S(`<path ${st} d="M12 4v10M8 10l4 4 4-4M5 19h14"/>`),
  sort: S(`<path ${st} d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3"/>`),
  trash: S(`<path ${st} d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>`),
  moon: S(`<path ${st} d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>`),
  power: S(`<path ${st} d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0"/>`),
  chev: S(`<path ${st} d="M9 6l6 6-6 6"/>`),
  chevLeft: S(`<path ${st} d="M15 6l-6 6 6 6"/>`),
  chevDown: S(`<path ${st} d="M6 9l6 6 6-6"/>`),
  back: S(`<path ${st} d="M19 12H5M11 6l-6 6 6 6"/>`),
  home: S(`<path ${st} d="M4 10.5L12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>`),
  check: S(`<path ${st} d="M5 12.5l4.2 4.2L19 7"/>`),
  edit: S(`<path ${st} d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4"/>`),
  copy: S(`<rect ${st} x="8.5" y="8.5" width="11" height="11" rx="2"/><path ${st} d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>`),
  export: S(`<path ${st} d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>`),
  import: S(`<path ${st} d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>`),
  listAdd: S(`<path ${st} d="M4 6.5h11M4 11.5h11M4 16.5h7M17.5 14v6M14.5 17h6"/>`),
  grip: S(`<path ${st} d="M5 9h14M5 15h14"/>`),
  up: S(`<path ${st} d="M12 19V5M6 11l6-6 6 6"/>`),
  lyrics: S(`<path ${st} d="M4 6h12M4 10.5h9M4 15h6"/><path fill="currentColor" d="M20.5 9.2v7.1a2.4 2.4 0 1 1-1.6-2.3V11.4l-3.1.7v5.5a2.4 2.4 0 1 1-1.6-2.3V10.3c0-.4.3-.8.7-.9l4.7-1c.5-.1.9.3.9.8z"/>`),
};
export const icon = (name, cls = '') => {
  const s = document.createElement('span');
  s.className = 'i ' + cls;
  s.innerHTML = ICONS[name] || '';
  return s;
};
