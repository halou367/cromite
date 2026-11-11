// Brana VPN · 新手设置向导：① 核心 → ② 导入 → ③ 连接 → ④ 完成（卡片式，一步一步，自动前进）
import { h, $, icon, tip, rpc, readAll, toast, copyText, msClass, kindLabel, applyTheme, flag, ccName, orbEl, switchEl, latBar, STATUS_TEXT, needsCoreNode } from '../shared/ui.js';
import { importBox, importResult, KIND_IC } from '../shared/importbox.js';
import { coreSetup } from '../shared/coresetup.js';

const S = { settings: {}, nodes: [], subs: [], stats: { nodes: {}, routes: {} }, pool: { items: {} }, rt: null };
const rt = () => S.rt || { status: 'off', core: {}, health: {} };
const st = () => S.settings || {};
const statusOf = () => (st().enabled ? rt().status : (rt().status === 'connecting' ? 'connecting' : 'off'));
const usableNodes = () => S.nodes.filter(n => n.enabled !== false && !n.unsupported);
const coreNeeded = () => !S.nodes.length || usableNodes().some(needsCoreNode);
let skippedCore = sessionStorage.getItem('brana-skip-core') === '1';

const TIP = {
  core: 'Chrome 只能直接使用 HTTP / SOCKS 代理。\n本地核心在本机把浏览器流量转成 VLESS / Trojan。\n只装一次，之后随浏览器自动启动、自动退出。',
  skip: '只用 HTTP / HTTPS / SOCKS5 代理节点时，不需要核心。',
  import: '支持一次粘贴多行：\n· 订阅地址（http / https 链接）\n· vless:// trojan:// 节点（WebSocket）\n· http:// https:// socks5:// 代理\n暂不支持 VMess / Shadowsocks / Hysteria 等。',
  connect: '自动测试全部节点与 ProxyIP，\n按「连通性 → 延迟 → 速度」选出最优线路，\n异常时自动切换，全程无需操作。',
  pin: '点击浏览器右上角的拼图图标 🧩，\n在 Brana VPN 旁点图钉 📌，\n图标就会常驻工具栏。',
  auto: '打开浏览器时自动连接上次的最佳线路。\n关闭后：每次启动都保持断开。',
  keys: 'Alt + Shift + V：一键连接 / 断开\nAlt + Shift + N：更换出口 IP\n可在 chrome://extensions/shortcuts 修改',
};

const STEPS = [
  { id: 'core', label: '核心', icon: 'cpu', make: stepCore },
  { id: 'import', label: '导入', icon: 'link', make: stepImport },
  { id: 'connect', label: '连接', icon: 'plug', make: stepConnect },
  { id: 'done', label: '完成', icon: 'rocket', make: stepDone },
];
function doneOf(id) {
  if (id === 'core') return !!rt().core?.up || skippedCore || (S.nodes.length > 0 && !coreNeeded());
  if (id === 'import') return S.nodes.length > 0;
  if (id === 'connect') return statusOf() === 'on';
  return !!st().setupDone;
}

let cur = -1;
let view = null;

// ───────────── 启动 ─────────────
async function init() {
  Object.assign(S, await readAll());
  S.settings ||= {}; S.nodes ||= []; S.subs ||= []; S.stats ||= { nodes: {}, routes: {} }; S.pool ||= { items: {} };
  applyTheme(st().theme);
  try { const port = chrome.runtime.connect({ name: 'ui' }); port.onMessage.addListener(() => {}); } catch {}
  chrome.storage.onChanged.addListener((changes, area) => {
    for (const [k, c] of Object.entries(changes)) {
      if (area === 'session' && k === 'rt') S.rt = c.newValue || null;
      if (area === 'local' && k in S) S[k] = c.newValue ?? (Array.isArray(S[k]) ? [] : S[k]);
    }
    if (changes.settings) applyTheme(st().theme);
    schedule();
  });
  if (!S.rt) await rpc('ping').catch(() => {});
  $('#later').addEventListener('click', () => { location.href = chrome.runtime.getURL('options/options.html'); });
  const want = STEPS.findIndex(s => s.id === location.hash.slice(1));
  go(want >= 0 ? want : firstTodo(), 0);
  window.addEventListener('hashchange', () => { const i = STEPS.findIndex(s => s.id === location.hash.slice(1)); if (i >= 0) go(i); });
  setInterval(() => view?.tick?.(), 1000);
}
function firstTodo() {
  const i = STEPS.findIndex(s => s.id !== 'done' && !doneOf(s.id));
  return i < 0 ? 3 : i;
}

let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; renderStepper(); try { view?.update?.(); } catch (e) { console.error(e); } });
}

function renderStepper() {
  const nav = $('#stepper');
  if (!nav.children.length) {
    nav.append(...STEPS.map((s, i) => h('button', { class: 'st', dataset: { i }, onclick: () => go(i) },
      h('span', { class: 'st-dot' }, h('span', { class: 'st-ico' }, icon(s.icon, 19)), h('span', { class: 'st-ok' }, icon('check', 19))),
      h('span', { class: 'st-lbl' }, s.label))));
  }
  [...nav.children].forEach((b, i) => {
    const done = doneOf(STEPS[i].id) && i !== cur;
    b.classList.toggle('cur', i === cur);
    b.classList.toggle('done', done || (i < cur && doneOf(STEPS[i].id)));
    b.classList.toggle('reach', i <= cur);
    b.setAttribute('aria-current', i === cur ? 'step' : 'false');
  });
}

function go(i, dir) {
  i = Math.max(0, Math.min(STEPS.length - 1, i));
  if (i === cur) return;
  const d = dir ?? (i > cur ? 1 : -1);
  view?.destroy?.();
  const old = $('#stage').firstElementChild;
  cur = i;
  history.replaceState(null, '', '#' + STEPS[i].id);
  view = STEPS[i].make();
  view.el.classList.add(d > 0 ? 'in-r' : d < 0 ? 'in-l' : 'in-0');
  if (old) {
    old.classList.add(d > 0 ? 'out-l' : 'out-r');
    old.style.position = 'absolute';
    setTimeout(() => old.remove(), 260);
  }
  $('#stage').append(view.el);
  renderStepper();
  view.update?.();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 通用卡片骨架
function card(ic, title, sub, body, foot, tileCls = '') {
  return h('section', { class: 'card step' },
    h('div', { class: 'ico-tile xl ' + tileCls }, icon(ic, 38)),
    h('h2', null, title),
    sub ? h('div', { class: 'sub' }, sub) : null,
    h('div', { class: 'step-body' }, body),
    foot);
}
function footer(left = [], right = []) {
  return h('div', { class: 'step-foot' }, h('div', { class: 'row' }, left), h('div', { class: 'row' }, right));
}
function nextBtn(label = '下一步', onClick) {
  const b = h('button', { class: 'btn primary' }, h('span', null, label), icon('arrowR', 16));
  b.addEventListener('click', onClick);
  return b;
}
function backBtn() {
  return h('button', { class: 'btn ghost', onclick: () => go(cur - 1) }, icon('arrowL', 16), h('span', null, '上一步'));
}

// ───────────── ① 核心 ─────────────
function stepCore() {
  let auto = null;
  const cs = coreSetup({
    getCore: () => rt().core,
    onReady: () => { auto = setTimeout(() => { if (STEPS[cur].id === 'core') go(1); }, 1500); },
  });
  const next = nextBtn('下一步', () => go(1));
  const skip = h('button', { class: 'btn ghost' }, icon('arrowR', 15), h('span', null, '跳过'));
  skip.addEventListener('click', () => { skippedCore = true; sessionStorage.setItem('brana-skip-core', '1'); go(1); });
  const el = card('cpu', '安装本地核心', h('span', { class: 'row', style: { gap: '2px' } }, 'VLESS / Trojan 节点必需', tip(TIP.core)), cs.el,
    footer([skip, tip(TIP.skip)], [next]));
  return {
    el,
    update: () => { cs.update(); next.disabled = !rt().core?.up && !(S.nodes.length && !coreNeeded()); },
    destroy: () => { cs.destroy(); clearTimeout(auto); },
  };
}

// ───────────── ② 导入 ─────────────
function stepImport() {
  const result = h('div', { class: 'imp-result' });
  const existing = h('div', { class: 'have' });
  let showForm = !S.nodes.length;
  let advanceTimer = 0;
  const box = importBox({
    onDone: res => {
      // 等存储同步后再显示（节点类型统计取最新列表）
      setTimeout(() => {
        result.replaceChildren(importResult(res, S.nodes));
        if (S.nodes.length) advanceTimer = setTimeout(() => { if (STEPS[cur].id === 'import') go(2); }, 1600);
      }, 120);
    },
  });
  const next = nextBtn('下一步', () => go(2));
  const el = card('link', '导入节点', h('span', { class: 'row', style: { gap: '2px' } }, '订阅链接 / 节点链接', tip(TIP.import)),
    h('div', { class: 'imp' }, existing, box.el, result),
    footer([backBtn()], [next]));

  const update = () => {
    next.disabled = !S.nodes.length;
    if (S.nodes.length && !showForm) {
      const by = {};
      for (const n of S.nodes) by[n.kind] = (by[n.kind] || 0) + 1;
      const sig = S.nodes.length + '|' + S.subs.length + '|' + JSON.stringify(by);
      if (existing.dataset.sig !== sig) {
        existing.dataset.sig = sig;
        existing.replaceChildren(h('div', { class: 'res-card' },
          h('div', { class: 'ico-tile soft' }, icon('server', 20)),
          h('div', { class: 'grow' },
            h('b', null, `已有 ${S.nodes.length} 个节点`),
            h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '5px', marginTop: '6px' } },
              S.subs.length ? h('span', { class: 'pill accent' }, icon('link', 11), `订阅 ${S.subs.length}`) : null,
              ...Object.entries(by).map(([k, v]) => h('span', { class: 'pill' }, icon(KIND_IC[k] || 'server', 11), `${kindLabel(k)} ${v}`)))),
          h('button', { class: 'btn sm', onclick: () => { showForm = true; update(); box.focus(); } }, icon('plus', 14), h('span', null, '再导入'))));
      }
      existing.classList.remove('hidden');
      box.el.classList.add('hidden');
    } else {
      existing.classList.add('hidden');
      box.el.classList.remove('hidden');
    }
  };
  setTimeout(() => { if (!S.nodes.length) box.focus(); }, 400);
  return { el, update, destroy: () => clearTimeout(advanceTimer) };
}

// ───────────── ③ 连接 ─────────────
function stepConnect() {
  const orb = orbEl(168);
  const title = h('div', { class: 'st-title cn-title' });
  const sub = h('div', { class: 'cn-sub' });
  const tests = h('div', { class: 'tests' });
  const res = h('div', { class: 'cn-res' });
  let startedAt = 0, failText = '', autoTimer = 0, connecting = false;

  async function connect() {
    if (connecting) return;
    if (!S.nodes.length) { go(1); return; }
    connecting = true; failText = ''; startedAt = Date.now();
    update();
    try { await rpc('connect'); } catch (e) { failText = e.message; }
    connecting = false;
    update();
  }
  orb.btn.addEventListener('click', () => {
    const s = statusOf();
    if (s === 'on') return;
    connect();
  });

  const next = nextBtn('下一步', () => go(3));
  const el = card('plug', '连接', null, h('div', { class: 'cn' }, orb.el, title, sub, res, tests), footer([backBtn()], [next]));
  el.querySelector('.ico-tile').remove();
  el.querySelector('h2').remove();

  const update = () => {
    const s = connecting && statusOf() === 'off' ? 'connecting' : statusOf();
    const r = rt();
    orb.el.dataset.st = s === 'off' && failText ? 'error' : s;
    next.disabled = s !== 'on';
    title.className = 'st-title cn-title ' + s;
    if (s === 'on') title.textContent = '连接成功';
    else if (s === 'connecting' || s === 'switching') title.textContent = '正在连接';
    else if (failText || s === 'degraded' || s === 'error') title.textContent = '暂未连通';
    else title.textContent = '一键连接';
    if ((s === 'connecting' || s === 'switching') && r.phase) sub.replaceChildren(h('span', { class: 'phase-dots' }, r.phase));
    else if (s === 'on') sub.replaceChildren(h('span', { class: 'row', style: { gap: '4px' } }, icon('shieldCheck', 14), '自动优选 · 异常自动切换', tip(TIP.connect)));
    else if (failText || s === 'degraded' || s === 'error') sub.textContent = failText || r.notice?.text || '';
    else sub.replaceChildren(h('span', { class: 'row', style: { gap: '4px' } }, '点击光球，自动选出最优线路', tip(TIP.connect)));

    // 结果卡
    let resSig = s;
    if (s === 'on') {
      const ex = r.exit || {};
      const cc = ex.cf?.loc || ex.std?.cc || r.active?.hint || '';
      const ip = ex.cf?.ip || ex.std?.ip || '';
      const ms = r.health?.ms || r.active?.ms || 0;
      resSig += [cc, ip, ms, r.active?.nodeName].join('|');
      if (res.dataset.sig !== resSig) {
        res.dataset.sig = resSig;
        res.replaceChildren(h('div', { class: 'res-card ok exit-card pop' },
          h('span', { class: 'big-flag flag' }, cc ? flag(cc) : '🌐'),
          h('div', { class: 'grow' },
            h('b', null, cc ? ccName(cc) : '检测出口中…'),
            h('div', { class: 'mono dim', style: { fontSize: '12px' } }, ip || '—')),
          h('div', { class: 'exit-r' },
            ms ? h('div', { class: 'lat-big ' + msClass(ms) }, ms, h('small', null, 'ms')) : null,
            h('div', { class: 'dim ellipsis', style: { fontSize: '11.5px', maxWidth: '150px' } }, r.active?.nodeName || ''))));
      }
    } else if (!connecting && (failText || s === 'degraded' || s === 'error')) {
      resSig += failText + (r.notice?.at || '');
      if (res.dataset.sig !== resSig) {
        res.dataset.sig = resSig;
        const coreMissing = coreNeeded() && !rt().core?.up;
        res.replaceChildren(h('div', { class: 'fix-row' },
          h('button', { class: 'btn primary sm', onclick: connect }, icon('refresh', 14), h('span', null, '重试')),
          coreMissing ? h('button', { class: 'btn sm', onclick: () => go(0) }, icon('cpu', 14), h('span', null, '安装核心')) : null,
          h('button', { class: 'btn sm', onclick: () => go(1) }, icon('link', 14), h('span', null, '检查节点')),
          h('button', { class: 'btn ghost sm', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#logs') }) }, icon('file', 14), h('span', null, '日志'))));
      }
    } else if (res.dataset.sig !== resSig) { res.dataset.sig = resSig; res.replaceChildren(); }

    // 节点测试列表
    const busy = s === 'connecting' || s === 'switching';
    const list = usableNodes().slice();
    const stat = n => (needsCoreNode(n) ? S.stats.nodes?.[n.id] : S.stats.routes?.[n.id + '|'] || S.stats.nodes?.[n.id]) || null;
    const fresh = x => x && (!startedAt || (x.at || 0) >= startedAt - 1000);
    const rank = n => { const x = stat(n); return fresh(x) ? (x.ok ? x.ms : 9e8) : 9e9; };
    list.sort((a, b) => rank(a) - rank(b));
    const act = r.active?.nodeId;
    const rows = list.slice(0, 6).map(n => {
      const x = stat(n);
      const done = fresh(x);
      const testing = busy && !done;
      return h('div', { class: 'trow' + (act === n.id && s === 'on' ? ' cur' : '') + (testing ? ' testing' : '') },
        h('span', { class: 'kind-ic' }, icon(KIND_IC[n.kind] || 'server', 14)),
        h('span', { class: 'ellipsis t-name' }, n.name),
        testing ? h('div', { class: 'latbar shimmer' }, h('i')) : latBar(done && x.ok ? x.ms : 0, done && x.ok),
        h('span', { class: 't-ms ' + (done ? (x.ok ? msClass(x.ms) : 'q-bad') : 'q-none'), 'data-tip': done && !x.ok ? (x.err || '不通') : null }, testing ? '…' : done ? (x.ok ? x.ms + 'ms' : '✕') : '—'));
    });
    const tsig = rows.map(r => r.className + r.textContent).join('|');
    if (tests.dataset.sig !== tsig) {
      tests.dataset.sig = tsig;
      tests.replaceChildren(...rows);
      if (list.length > 6) tests.append(h('div', { class: 'dim t-more' }, `另有 ${list.length - 6} 个节点`));
    }
    tests.classList.toggle('hidden', !list.length || (s === 'off' && !failText && !startedAt));
  };

  if (statusOf() === 'off' && S.nodes.length) autoTimer = setTimeout(connect, 700);
  return { el, update, destroy: () => clearTimeout(autoTimer) };
}

// ───────────── ④ 完成 ─────────────
function stepDone() {
  rpc('saveSettings', { patch: { setupDone: true } }).catch(() => {});
  const auto = switchEl(st().autoStart !== false, v => rpc('saveSettings', { patch: { autoStart: v } }).then(() => toast(v ? '启动浏览器时自动连接' : '启动浏览器时保持断开', 'ok', 1600)).catch(e => toast(e.message, 'err')), '启动浏览器自动连接');
  const tile = (ic, label, tp, body) => h('div', { class: 'tile3' }, tip(tp, 13), h('div', { class: 'ico-tile soft' }, icon(ic, 20)), h('b', null, label), body);
  const exitChip = h('div', { class: 'done-exit' });
  const el = h('section', { class: 'card step done-step' },
    h('div', { class: 'burst' }, h('div', { class: 'ico-tile ok xl pop' }, icon('check', 42)), ...Array.from({ length: 10 }, (_, i) => h('i', { style: { '--a': i * 36 + 'deg', '--d': (i % 3) * 60 + 'ms' } }))),
    h('h2', null, '一切就绪'),
    exitChip,
    h('div', { class: 'tiles3' },
      tile('pushpin', '固定图标', TIP.pin, h('div', { class: 'pin-demo' }, icon('puzzle', 16), icon('arrowR', 13), icon('pushpin', 16))),
      tile('power', '启动自动连接', TIP.auto, auto),
      tile('keyboard', '快捷键', TIP.keys, h('div', { class: 'row', style: { gap: '4px' } }, h('span', { class: 'kbd' }, 'Alt'), h('span', { class: 'kbd' }, 'Shift'), h('span', { class: 'kbd' }, 'V')))),
    h('div', { class: 'step-foot' },
      h('div', { class: 'row' }, backBtn()),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { location.href = chrome.runtime.getURL('options/options.html'); } }, icon('grid', 15), h('span', null, '控制中心')),
        h('button', { class: 'btn primary', onclick: closeTab }, icon('check', 16), h('span', null, '完成')))));
  const update = () => {
    const s = statusOf();
    const r = rt();
    const cc = r.exit?.cf?.loc || r.exit?.std?.cc || '';
    const ms = r.health?.ms || r.active?.ms || 0;
    const sig = [s, cc, ms].join('|');
    if (exitChip.dataset.sig === sig) return;
    exitChip.dataset.sig = sig;
    exitChip.replaceChildren(s === 'on'
      ? h('span', { class: 'pill ok lgpill' }, h('span', { class: 'sdot ok live' }), cc ? `${flag(cc)} ${ccName(cc)}` : STATUS_TEXT.on, ms ? h('b', { class: 'mono' }, ms + 'ms') : null)
      : h('span', { class: 'pill lgpill' }, h('span', { class: 'sdot' }), STATUS_TEXT[s] || s));
    const sw = auto.querySelector('input');
    if (sw && document.activeElement !== sw) sw.checked = st().autoStart !== false;
  };
  return { el, update };
}

async function closeTab() {
  try { const t = await chrome.tabs.getCurrent(); if (t?.id != null) { await chrome.tabs.remove(t.id); return; } } catch {}
  window.close();
}

init().catch(e => { document.body.append(h('pre', { style: { color: '#f87171', padding: '16px', whiteSpace: 'pre-wrap' } }, String(e && e.stack || e))); });
