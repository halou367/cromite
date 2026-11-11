// 共享界面工具：元素构建、图标、消息调用、提示、格式化、动画
export { flag, ccName, ccLabel, ccSort } from './geo.js';

// DOM 的 append / replaceChildren 会把 null 变成文字 "null"，这里统一过滤掉空值
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const m of ['append', 'replaceChildren']) {
    const orig = proto[m];
    proto[m] = function (...kids) { return orig.apply(this, kids.filter(k => k != null && k !== false)); };
  }
}

export function h(tag, props, ...kids) {
  const el = tag === 'frag' ? document.createDocumentFragment() : document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const P = {
  power: '<path d="M12 3v9"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  rotate: '<path d="M3 12a9 9 0 0 1 15.36-6.36L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.36 6.36L3 16"/><path d="M3 21v-5h5"/>',
  gauge: '<path d="M12 14 15.5 9.5"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  play: '<path d="m5 3 14 9-14 9z"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  radar: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  puzzle: '<path d="M19.44 7.85c-.05.32.06.65.29.88l1.57 1.57c.47.47.7 1.09.7 1.7s-.23 1.23-.7 1.7l-1.61 1.61a.98.98 0 0 1-.84.28c-.47-.07-.8-.48-.97-.93a2.5 2.5 0 1 0-3.21 3.21c.45.17.86.5.93.97a.98.98 0 0 1-.28.84l-1.61 1.61a2.4 2.4 0 0 1-3.4 0l-1.57-1.57a1.03 1.03 0 0 0-.88-.29c-.49.07-.84.5-1.02.97a2.5 2.5 0 1 1-3.24-3.24c.46-.18.9-.53.97-1.02a1.03 1.03 0 0 0-.29-.88l-1.57-1.57a2.4 2.4 0 0 1 0-3.4L4.23 8.77c.24-.24.58-.35.92-.3.51.08.88.53 1.07 1.01a2.5 2.5 0 1 0 3.26-3.26c-.48-.2-.93-.56-1.01-1.07-.05-.34.06-.68.3-.92l1.53-1.53a2.4 2.4 0 0 1 3.4 0l1.57 1.57c.23.23.56.34.88.29.49-.07.84-.5 1.02-.97a2.5 2.5 0 1 1 3.24 3.24c-.46.18-.9.53-.97 1.02z"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  keyboard: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
  signal: '<path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4v16"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  pushpin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/>',
  arrowR: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  arrowL: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  pointer: '<path d="m4 4 7.07 17 2.51-7.39L21 11.07z"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>',
  timer: '<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
  browser: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20M6 6.5h.01M9 6.5h.01"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  hub: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  flaskOk: '<path d="M9 3h6M10 3v6.5L4.6 18.2A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-2.8L14 9.5V3"/><path d="M7 15h10"/>',
};
export function icon(name, size = 18, cls = '') {
  const span = document.createElement('span');
  span.className = 'ico ' + cls;
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.info}</svg>`;
  return span;
}

// 后台调用
export async function rpc(cmd, args = {}) {
  let res;
  try { res = await chrome.runtime.sendMessage({ cmd, ...args }); } catch (e) { throw new Error('扩展后台未响应：' + e.message); }
  if (!res) throw new Error('扩展后台未响应');
  if (!res.ok) { const err = new Error(res.error || '操作失败'); err.user = res.user; throw err; }
  return res.data;
}

export async function readAll() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['settings', 'nodes', 'subs', 'pool', 'stats', 'logs', 'bestip']),
    chrome.storage.session.get('rt'),
  ]);
  return { ...local, rt: session.rt || null };
}

// 提示
let toastWrap = null;
export function toast(text, type = 'info', ms = 3200) {
  if (!toastWrap) { toastWrap = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastWrap); }
  const ic = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' }[type] || 'info';
  const el = h('div', { class: `toast t-${type}` }, icon(ic, 16), h('span', null, text));
  toastWrap.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const kill = () => { el.classList.remove('in'); el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  setTimeout(kill, ms);
  el.addEventListener('click', kill);
  return el;
}

// 按钮执行：自动 loading / 成功失败提示
export async function act(btn, fn, { ok, quiet = false } = {}) {
  if (btn && btn.classList.contains('loading')) return;
  btn?.classList.add('loading');
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'ok');
    return r;
  } catch (e) {
    if (!quiet) toast(e.message || String(e), e.user ? 'warn' : 'err', 4600);
    return undefined;
  } finally {
    btn?.classList.remove('loading');
    if (btn) btn.disabled = false;
  }
}

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, t);
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); return true; } catch { return false; } finally { ta.remove(); }
  }
}

// 格式化
export const fmtMs = ms => (ms ? `${Math.round(ms)}` : '—');
export const msClass = ms => !ms ? 'q-none' : ms < 180 ? 'q-good' : ms < 450 ? 'q-ok' : ms < 900 ? 'q-mid' : 'q-bad';
export function fmtBytes(b) {
  b = +b || 0;
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return (b >= 100 ? b.toFixed(0) : b >= 10 ? b.toFixed(1) : b.toFixed(2)) + ' ' + u[i];
}
export const fmtRate = b => fmtBytes(b) + '/s';
export function fmtAgo(t) {
  if (!t) return '从未';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return '刚刚';
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}
export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
export const kindLabel = k => ({ vless: 'VLESS', trojan: 'Trojan', http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' })[k] || String(k || '').toUpperCase();
export const maskSecret = s => { s = String(s || ''); return s.length <= 8 ? '••••' : s.slice(0, 4) + '••••' + s.slice(-4); };
export const shortPip = pip => /^(socks5?|https?|turn|sstp):\/\//i.test(pip) ? pip.replace(/\/\/[^@/]*@/, '//') : pip;

// 数字补间动画
const tweens = new WeakMap();
export function tweenNumber(el, to, { dur = 520, dec = 0 } = {}) {
  if (to == null || isNaN(to)) { el.textContent = '—'; tweens.delete(el); return; }
  const from = tweens.get(el) ?? (parseFloat(el.textContent) || 0);
  tweens.set(el, to);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(to - from) < 0.001) { el.textContent = to.toFixed(dec); return; }
  const t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = (from + (to - from) * e).toFixed(dec);
    if (k < 1 && tweens.get(el) === to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// 迷你折线图（延迟历史，null 表示失败）
export function sparkline(values, { w = 120, h = 32, cls = 'spark' } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', cls);
  svg.setAttribute('preserveAspectRatio', 'none');
  const vals = values.slice(-30);
  const nums = vals.filter(v => v != null);
  if (nums.length < 2) return svg;
  const max = Math.max(...nums) * 1.15, min = Math.min(...nums) * 0.85;
  const n = vals.length;
  const X = i => (i / (n - 1)) * w;
  const Y = v => h - 3 - ((v - min) / Math.max(1, max - min)) * (h - 6);
  let d = '', area = '', started = false, lastX = 0;
  vals.forEach((v, i) => {
    if (v == null) { started = false; return; }
    const x = X(i), y = Y(v);
    d += (started ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    if (!started) area += `M${x.toFixed(1)} ${h}L${x.toFixed(1)} ${y.toFixed(1)}`; else area += `L${x.toFixed(1)} ${y.toFixed(1)}`;
    started = true; lastX = x;
  });
  area += `L${lastX.toFixed(1)} ${h}Z`;
  const gid = 'g' + Math.random().toString(36).slice(2, 7);
  svg.innerHTML = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".35"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>`
    + `<path d="${area}" fill="url(#${gid})" stroke="none"/><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`;
  vals.forEach((v, i) => { if (v == null) { const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', X(i)); c.setAttribute('cy', h - 3); c.setAttribute('r', '1.8'); c.setAttribute('class', 'spark-fail'); svg.append(c); } });
  return svg;
}

export function applyTheme(theme) {
  const t = theme === 'light' || theme === 'dark' ? theme : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = t;
}

// 简易模态框
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => { back.classList.remove('in'); setTimeout(() => back.remove(), 220); onClose?.(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'icon-btn', 'aria-label': '关闭', onclick: close }, icon('x', 18))),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions.map(a => h('button', { class: 'btn ' + (a.kind || ''), onclick: async e => { const r = await a.onClick?.(e, close); if (r !== false && a.close !== false) close(); } }, a.icon ? icon(a.icon, 16) : null, a.label))) : null);
  const back = h('div', { class: 'modal-back', onclick: e => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => back.classList.add('in'));
  return { close, box };
}

export function confirmBox(title, text, okLabel = '确定', danger = false) {
  return new Promise(resolve => {
    let done = false;
    modal({
      title,
      body: h('p', { class: 'muted' }, text),
      actions: [
        { label: '取消', kind: 'ghost', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}


// ───────────── ⓘ 说明气泡（替代大段文字：悬停 / 聚焦 / 点击显示）─────────────
// 任意元素加 data-tip="文字" 即可获得气泡；tip(text) 生成一个圆圈 i 按钮。
export function tip(text, size = 14) {
  return h('button', { class: 'tip', type: 'button', 'aria-label': '说明：' + text, 'data-tip': text }, icon('info', size));
}
let tipEl = null, tipFor = null, tipTimer = 0;
function showTip(t) {
  const text = t.dataset.tip;
  if (!text || !t.isConnected) return;
  if (!tipEl) { tipEl = h('div', { class: 'tip-bubble', role: 'tooltip' }); document.body.append(tipEl); }
  tipFor = t;
  tipEl.textContent = text;
  tipEl.classList.remove('in');
  tipEl.style.left = '0px'; tipEl.style.top = '0px';
  const r = t.getBoundingClientRect();
  const b = tipEl.getBoundingClientRect();
  const m = 8;
  let top = r.top - b.height - 9, side = 'top';
  if (top < m) { top = r.bottom + 9; side = 'bottom'; }
  if (side === 'bottom' && top + b.height > innerHeight - m) { top = Math.max(m, innerHeight - b.height - m); }
  const left = Math.max(m, Math.min(innerWidth - b.width - m, r.left + r.width / 2 - b.width / 2));
  tipEl.style.left = left + 'px';
  tipEl.style.top = top + 'px';
  tipEl.style.setProperty('--ax', Math.max(12, Math.min(b.width - 12, r.left + r.width / 2 - left)) + 'px');
  tipEl.dataset.side = side;
  requestAnimationFrame(() => tipEl && tipFor === t && tipEl.classList.add('in'));
}
export function hideTip() { clearTimeout(tipTimer); tipFor = null; tipEl?.classList.remove('in'); }
if (typeof document !== 'undefined') {
  document.addEventListener('pointerover', e => {
    const t = e.target.closest?.('[data-tip]');
    if (!t || t === tipFor) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(t), t.classList.contains('tip') ? 80 : 420);
  });
  document.addEventListener('pointerout', e => {
    const t = e.target.closest?.('[data-tip]');
    if (t && !t.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener('focusin', e => { const t = e.target.closest?.('.tip'); if (t) showTip(t); });
  document.addEventListener('focusout', e => { if (e.target.closest?.('.tip')) hideTip(); });
  document.addEventListener('click', e => {
    const t = e.target.closest?.('.tip');
    if (!t) { if (tipFor && !e.target.closest?.('[data-tip]')) hideTip(); return; }
    e.preventDefault(); e.stopPropagation();
    if (tipFor === t && tipEl?.classList.contains('in')) hideTip(); else showTip(t);
  }, true);
  addEventListener('scroll', hideTip, true);
  addEventListener('blur', hideTip);
  addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
}

// 开关
export function switchEl(checked, onChange, label = '') {
  const input = h('input', { type: 'checkbox', checked: !!checked, 'aria-label': label || null });
  input.addEventListener('change', () => onChange?.(input.checked, input));
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }));
}

// 分段控件：items = [[value, label, iconName?, tipText?], …]
export function segEl(items, value, onChange, cls = '') {
  const seg = h('div', { class: 'seg ' + cls, role: 'tablist' }, h('span', { class: 'thumb' }),
    items.map(([v, label, ic, tp]) => h('button', { type: 'button', dataset: { v }, 'data-tip': tp || null, role: 'tab' }, ic ? icon(ic, 14) : null, label ? h('span', null, label) : null)));
  segBind(seg, onChange);
  segSet(seg, value);
  return seg;
}
export function segBind(seg, onChange) {
  seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !seg.contains(b) || b.classList.contains('on')) return;
    segSet(seg, b.dataset.v);
    onChange?.(b.dataset.v);
  });
}
export function segSet(seg, v) {
  const btns = $$('button', seg);
  btns.forEach(b => { b.classList.toggle('on', b.dataset.v === v); b.setAttribute('aria-selected', b.dataset.v === v ? 'true' : 'false'); });
  const on = btns.find(b => b.dataset.v === v) || btns[0];
  const th = seg.querySelector('.thumb');
  const place = () => { if (!on || !th) return; th.style.left = on.offsetLeft + 'px'; th.style.width = on.offsetWidth + 'px'; };
  requestAnimationFrame(place);
  if (!seg.isConnected) setTimeout(place, 60);
}

// 环形进度（donut）：parts = [{ v, cls }]
export function ring(parts, { size = 64, stroke = 8, label = '' } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const total = parts.reduce((a, p) => a + (p.v || 0), 0) || 1;
  let off = 0;
  const segs = parts.filter(p => p.v > 0).map(p => {
    const len = (p.v / total) * c;
    const el = `<circle class="${p.cls}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-dasharray="${Math.max(0, len - (parts.length > 1 ? 1.5 : 0))} ${c}" stroke-dashoffset="${-off}" stroke-linecap="butt"/>`;
    off += len;
    return el;
  }).join('');
  const box = h('div', { class: 'ring', style: { width: size + 'px', height: size + 'px' } });
  box.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="transform:rotate(-90deg)"><circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>${segs}</svg>`;
  if (label) box.append(h('div', { class: 'ring-label' }, label));
  return box;
}

// 延迟条（越短越好：按 1000ms 归一）
export function latBar(ms, ok = true) {
  const pct = !ok || !ms ? 0 : Math.max(8, Math.min(100, 100 - (ms / 1000) * 92));
  return h('div', { class: 'latbar ' + (ok && ms ? msClass(ms) : 'q-none') }, h('i', { style: { width: pct + '%' } }));
}

export async function platformOs() {
  try { return (await chrome.runtime.getPlatformInfo()).os; } catch {}
  return /Win/i.test(navigator.platform) ? 'win' : /Mac/i.test(navigator.platform) ? 'mac' : 'linux';
}

export function downloadBlob(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// 一键安装：下载「自带核心」的安装脚本（Windows: .cmd 双击；macOS/Linux: .sh 终端运行）
export const INSTALLER = {
  win: { file: 'core/install-windows.cmd', name: 'BranaVPN-Setup.cmd' },
  unix: { file: 'core/install-mac-linux.sh', name: 'brana-core-setup.sh', cmd: 'bash ~/Downloads/brana-core-setup.sh' },
};
export async function downloadInstaller(os) {
  const it = os === 'win' ? INSTALLER.win : INSTALLER.unix;
  const res = await fetch(chrome.runtime.getURL(it.file));
  if (!res.ok) throw new Error('安装脚本缺失：' + it.file);
  downloadBlob(it.name, await res.blob());
  return it;
}

export const STATUS_TEXT = { off: '未连接', connecting: '正在连接', on: '已连接', switching: '切换线路中', degraded: '已直连兜底', error: '线路异常' };
export const needsCoreNode = n => n.kind === 'vless' || n.kind === 'trojan' || (n.kind === 'socks5' && !!n.user);

// 光球（弹窗 / 向导）：返回 { el, btn }
export function orbEl(size = 150, ariaLabel = '连接 / 断开') {
  const btn = h('button', { class: 'orb-btn', 'aria-label': ariaLabel });
  btn.innerHTML = `<svg class="orb-ico" viewBox="0 0 24 24" width="${Math.round(size * 0.27)}" height="${Math.round(size * 0.27)}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v9"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/></svg>`;
  const el = h('div', { class: 'orb', dataset: { st: 'off' }, style: { '--orb': size + 'px' } },
    h('div', { class: 'orb-halo' }), h('div', { class: 'orb-wave' }), h('div', { class: 'orb-wave' }), h('div', { class: 'orb-wave' }));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'orb-ring'); svg.setAttribute('viewBox', '0 0 160 160'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs><circle class="track" cx="80" cy="80" r="72"/><circle class="arc" cx="80" cy="80" r="72"/>';
  el.append(svg, btn);
  return { el, btn };
}
