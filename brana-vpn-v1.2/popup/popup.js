// Brana VPN · 弹窗：只放最常用的操作（连接 / 线路 / 地区 / 优选 / 换 IP / 测速），其余进控制中心
import { h, $, $$, icon, tip, rpc, readAll, toast, act, copyText, fmtDur, msClass, kindLabel, shortPip, tweenNumber, sparkline, applyTheme, flag, ccName, ccSort, orbEl, segEl, segSet, latBar, STATUS_TEXT, needsCoreNode } from '../shared/ui.js';

const S = { settings: null, nodes: [], subs: [], pool: { items: {}, sources: [] }, stats: { nodes: {}, routes: {} }, bestip: null, rt: null };
let tabHost = '';
let lastNoticeAt = 0;
let dismissedNotice = 0;
let lastFlagCc = null;
let sheetKind = '';
let orb = null, scopeSeg = null;

const rt = () => S.rt || { status: 'off', health: {}, core: {} };
const st = () => S.settings || {};
const nodeById = id => S.nodes.find(n => n.id === id);
const nodeStat = n => (needsCoreNode(n) ? S.stats.nodes?.[n.id] : S.stats.routes?.[n.id + '|']) || null;
const itemCc = e => (e && (e.cc || e.hint)) || '';
const usable = () => S.nodes.filter(n => n.enabled !== false && !n.unsupported);
const coreNeeded = () => usable().some(needsCoreNode);
const statusOf = () => (st().enabled ? rt().status : (rt().status === 'connecting' ? 'connecting' : 'off'));
// 需要引导：没有节点，或节点需要核心但核心未安装
const setupNeed = () => {
  if (!S.nodes.length) return 'import';
  const c = rt().core || {};
  if (coreNeeded() && !c.up && c.installed === false && statusOf() !== 'on') return 'core';
  return '';
};

// ───────────── 初始化 ─────────────
async function init() {
  $$('[data-ico]').forEach(el => el.append(icon(el.dataset.ico, 19)));
  $('#openOptions').append(icon('settings', 18));
  $('#coreBtn').prepend(icon('cpu', 18));
  orb = orbEl(146);
  $('#orbBox').replaceWith(orb.el);
  Object.assign(S, await readAll());
  S.nodes ||= []; S.subs ||= []; S.pool ||= { items: {}, sources: [] }; S.stats ||= { nodes: {}, routes: {} };
  S.settings ||= {};
  applyTheme(st().theme);
  try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); const u = new URL(tab?.url || ''); if (/^https?:$/.test(u.protocol)) tabHost = u.hostname; } catch {}
  scopeSeg = segEl([['global', '全局', 'globe', '全局：所有网站走代理（局域网除外）'], ['rules', '名单', 'list', '名单：只有「代理名单」里的网站走代理']], st().scope || 'global',
    v => rpc('saveSettings', { patch: { scope: v } }).catch(e => toast(e.message, 'err')), 'mini');
  $('#scopeBox').replaceWith(scopeSeg);
  bind();
  render();
  document.body.classList.add('ready');
  try { const port = chrome.runtime.connect({ name: 'ui' }); port.onMessage.addListener(() => {}); } catch {}
  chrome.storage.onChanged.addListener((changes, area) => {
    for (const [k, c] of Object.entries(changes)) {
      if (area === 'session' && k === 'rt') S.rt = c.newValue || null;
      if (area === 'local' && k in S) S[k] = c.newValue ?? S[k];
    }
    if (changes.settings) applyTheme(st().theme);
    schedule();
  });
  setInterval(tick, 1000);
  if (!S.rt) rpc('ping').catch(() => {});
  // 核心状态未知（本次浏览器会话还没检测过）且节点需要核心：探测一次，引导卡片据此判断是否提示安装
  else if (coreNeeded() && !rt().core?.up && rt().core?.installed == null) rpc('coreCheck').catch(() => {});
}

let raf = 0;
function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); if (sheetKind) refreshSheet(); }); }
function tick() {
  const s = statusOf();
  if (s === 'on' || s === 'degraded' || s === 'error') renderSub();
  renderNotice();
}

function bind() {
  orb.btn.addEventListener('click', onPower);
  $('#openOptions').addEventListener('click', () => openPage('options/options.html'));
  $('#coreBtn').addEventListener('click', () => (rt().core?.up || !coreNeeded() ? openPage('options/options.html#core') : openPage('setup/setup.html#core')));
  $('#btnOptimize').addEventListener('click', e => act(e.currentTarget, () => rpc('optimize'), { ok: r => r?.message || '已切到最优线路' }));
  $('#btnNextIp').addEventListener('click', e => act(e.currentTarget, () => rpc('nextIp'), { ok: r => r?.message || '已更换出口 IP' }));
  $('#btnSpeed').addEventListener('click', () => { rpc('speedTest').then(r => toast(`下载 ${r.mbps} Mbps`, 'ok')).catch(e => toast(e.message, 'warn')); });
  $('#siteRule').addEventListener('click', openSiteMenu);
  $('#sheetBack').addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetKind) { e.preventDefault(); closeSheet(); } });
}

function openPage(path) {
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
}

async function onPower() {
  const need = setupNeed();
  if (need) { openPage('setup/setup.html#' + need); return; }
  orb.btn.animate([{ transform: 'scale(.92)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  try {
    if (st().enabled && rt().status !== 'off') await rpc('disconnect');
    else await rpc('connect');
  } catch (e) { toast(e.message, e.user ? 'warn' : 'err', 5200); }
}

// ───────────── 渲染 ─────────────
function render() {
  const need = setupNeed();
  $('#app').classList.toggle('needs-setup', !!need);
  renderCore();
  renderNotice();
  renderHero();
  renderSetup(need);
  $('#routeCard').classList.toggle('hidden', !!need);
  $('#regionsWrap').classList.toggle('hidden', !!need);
  $('#tiles').classList.toggle('hidden', !!need);
  $('#foot').classList.toggle('hidden', !!need);
  if (!need) { renderRoute(); renderRegions(); renderTiles(); renderFoot(); }
}

function renderCore() {
  const c = rt().core || {};
  const dot = $('#coreDot');
  const need = coreNeeded();
  let cls = '', text;
  if (c.up) { cls = 'ok live'; text = `核心已就绪 · ${c.via === 'native' ? '自动托管' : '手动运行'}${c.version ? ' · v' + c.version : ''}`; }
  else if (!need) { cls = ''; text = '核心：当前节点无需核心'; }
  else if (c.installed === false) { cls = 'err'; text = '核心未安装 · 点击一键安装'; }
  else { cls = 'warn'; text = '核心待命（连接时自动启动）'; }
  dot.className = 'sdot ' + cls;
  $('#coreBtn').dataset.tip = text;
}

function renderNotice() {
  const n = rt().notice;
  const el = $('#notice');
  const fresh = n && n.at > dismissedNotice && (Date.now() - n.at < (n.lv === 'ok' || n.lv === 'info' ? 7000 : 120000));
  $('#app').classList.toggle('has-notice', !!fresh);
  if (!fresh) { el.classList.add('hidden'); return; }
  if (n.at === lastNoticeAt && !el.classList.contains('hidden')) return;
  lastNoticeAt = n.at;
  el.className = 'notice lv-' + n.lv;
  el.replaceChildren(icon({ ok: 'checkCircle', info: 'info', warn: 'alert', err: 'alert' }[n.lv] || 'info', 16), h('div', { class: 'grow' }, n.text),
    h('button', { class: 'icon-btn x', 'aria-label': '关闭', onclick: () => { dismissedNotice = n.at; el.classList.add('hidden'); $('#app').classList.remove('has-notice'); } }, icon('x', 14)));
  if (n.lv === 'ok' || n.lv === 'info') setTimeout(() => { if (lastNoticeAt === n.at) { el.classList.add('hidden'); $('#app').classList.remove('has-notice'); } }, Math.max(0, 7000 - (Date.now() - n.at)));
}

function renderHero() {
  const s = statusOf();
  const r = rt();
  orb.el.dataset.st = setupNeed() ? 'off' : s;
  const title = $('#stTitle');
  title.textContent = r.busy === 'optimize' && s === 'on' ? '正在优选' : STATUS_TEXT[s] || s;
  title.className = 'st-title ' + s;
  orb.btn.setAttribute('aria-label', s === 'off' ? '连接' : '断开');
  renderSub();
}

function renderSub() {
  const r = rt();
  const s = statusOf();
  const sub = $('#stSub');
  if ((s === 'connecting' || s === 'switching' || r.busy) && r.phase) { sub.replaceChildren(h('span', { class: 'phase-dots' }, r.phase)); return; }
  if (s === 'on') {
    sub.replaceChildren(h('span', { class: 'sub-chip' }, icon('clock', 12), h('span', { class: 'mono' }, fmtDur(Date.now() - (r.since || Date.now())))),
      st().strict ? h('span', { class: 'sub-chip', 'data-tip': '严格防泄漏：线路异常时阻断而不直连' }, icon('lock', 12), '防泄漏') : null,
      st().mode === 'manual' ? h('button', { class: 'sub-chip btnlike', 'data-tip': '当前为手动线路，点此恢复智能优选', onclick: () => rpc('setMode', { mode: 'auto' }).then(() => toast('已恢复智能优选', 'ok', 1600)).catch(e => toast(e.message, 'err')) }, icon('undo', 12), '手动') : null);
    return;
  }
  if (s === 'degraded' || s === 'error') {
    const left = Math.max(0, Math.round(((r.retryAt || 0) - Date.now()) / 1000));
    if (r.conflict) { sub.textContent = r.conflict === 'not_controllable' ? '代理被系统策略锁定' : '代理被其他扩展占用'; return; }
    sub.replaceChildren(h('span', { class: 'sub-chip' }, icon(s === 'degraded' ? 'globe' : 'lock', 12), s === 'degraded' ? '直连保持畅通' : '已阻断防泄漏'),
      h('span', { class: 'sub-chip' }, icon('refresh', 12), left ? `${left}s 后重试` : '即将重试'));
    return;
  }
  const need = setupNeed();
  sub.textContent = need === 'import' ? '完成 3 步设置后一键连接' : need === 'core' ? '安装核心后即可连接' : '点击连接';
}

// 未配置：3 步引导卡（核心 / 导入 / 连接）
function renderSetup(need) {
  const box = $('#setupCard');
  if (!need) { box.classList.add('hidden'); box.dataset.sig = ''; return; }
  const c = rt().core || {};
  const coreOk = !!c.up || (S.nodes.length > 0 && !coreNeeded());
  const steps = [
    ['core', 'cpu', '核心', coreOk],
    ['import', 'link', '导入', S.nodes.length > 0],
    ['connect', 'plug', '连接', false],
  ];
  const next = steps.find(x => !x[3])?.[0] || 'connect';
  const sig = steps.map(x => +x[3]).join('') + next;
  box.classList.remove('hidden');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const go = h('button', { class: 'btn primary go' }, icon(need === 'core' ? 'download' : 'rocket', 16), h('span', null, need === 'core' ? '一键安装核心' : S.nodes.length || coreOk ? '继续设置' : '开始设置'));
  go.addEventListener('click', () => openPage('setup/setup.html#' + next));
  box.replaceChildren(
    h('div', { class: 'setup-h' }, h('b', null, need === 'core' ? '还差一步' : '3 步开始使用'), tip(need === 'core' ? 'VLESS / Trojan 节点需要本地核心。\n一键安装，只需一次，之后随浏览器自动启动。' : '① 安装本地核心（VLESS/Trojan 需要）\n② 导入订阅或节点\n③ 自动测速并连接最优线路')),
    h('div', { class: 'msteps' }, ...steps.map(([id, ic, label, done], i) => h('button', { class: 'mstep' + (done ? ' done' : '') + (id === next ? ' cur' : ''), onclick: () => openPage('setup/setup.html#' + id) },
      h('span', { class: 'ms-dot' }, icon(done ? 'check' : ic, 17)), h('span', { class: 'ms-lbl' }, `${i + 1} ${label}`)))),
    go);
}

function poolCounts() {
  let ok = 0, total = 0;
  for (const e of Object.values(S.pool.items || {})) { if (e.ban || e.gone) continue; total++; if (e.ok === true) ok++; }
  return { ok, total };
}

// 线路卡：出口（国旗 / IP / 延迟）+ 节点 / ProxyIP 选择 + 延迟曲线
let R = null;
function renderRoute() {
  const card = $('#routeCard');
  const r = rt();
  const s = statusOf();
  const live = s === 'on' || s === 'switching';
  if (!R) {
    R = {};
    R.flag = h('div', { class: 'r-flag flag' }, '🌐');
    R.place = h('span', { class: 'ellipsis' });
    R.colo = h('span', { class: 'r-colo mono' });
    R.ipText = h('span', { class: 'ellipsis' });
    R.ip = h('button', { class: 'r-ip mono', 'data-tip': '复制出口 IP', onclick: async () => { const ip = R.ipText.textContent; if (ip && await copyText(ip)) toast('已复制 ' + ip, 'ok', 1500); } }, R.ipText, icon('copy', 11));
    R.tags = h('span', { class: 'r-tags' });
    R.ms = h('b', null, '—');
    R.msBox = h('div', { class: 'r-ms', 'data-tip': '当前线路延迟（健康检查实测）' }, R.ms, h('small', null, 'ms'));
    R.node = h('button', { class: 'pick', onclick: () => openSheet('nodes') });
    R.pip = h('button', { class: 'pick', onclick: () => openSheet('pips') });
    R.spark = h('div', { class: 'r-spark' });
    R.head = h('div', { class: 'r-head' }, R.flag, h('div', { class: 'r-info' }, h('div', { class: 'r-place' }, R.place, R.colo), h('div', { class: 'r-sub' }, R.ip, R.tags)), R.msBox);
    card.replaceChildren(R.head, h('div', { class: 'picks' }, R.node, R.pip), R.spark);
  }
  card.classList.toggle('live', live);
  const ex = r.exit || {};
  const cc = live ? (ex.cf?.loc || ex.std?.cc || r.active?.hint || '') : '';
  const reg = st().region || '';
  const flagKey = live ? 'L' + cc : s === 'off' && reg ? 'R' + reg : 'S' + s;
  if (lastFlagCc !== flagKey) {
    R.flag.textContent = live ? (cc ? flag(cc) : '🌐') : s === 'off' && reg ? flag(reg) : s === 'degraded' ? '🛟' : '🌐';
    if (lastFlagCc !== null) { R.flag.classList.remove('swap'); void R.flag.offsetWidth; R.flag.classList.add('swap'); }
    lastFlagCc = flagKey;
  }
  if (live) {
    const ip = ex.cf?.ip || ex.std?.ip || '';
    R.place.textContent = cc ? ccName(cc) : '检测出口中…';
    R.colo.textContent = ex.cf?.colo || '';
    R.ipText.textContent = ip;
    R.ip.classList.toggle('hidden', !ip);
    const tags = [];
    const pure = ex.pure;
    if (pure) tags.push(h('span', { class: 'pill xs ' + (pure.proxy ? 'warn' : pure.hosting ? 'info' : 'ok'), 'data-tip': pure.isp || '' }, pure.proxy ? '代理' : pure.hosting ? '机房' : pure.mobile ? '移动' : '住宅'));
    if (ex.std?.ip && ex.cf?.ip && ex.std.ip !== ex.cf.ip) tags.push(h('span', { class: 'pill xs', 'data-tip': `Cloudflare 网站看到：${ex.cf.ip}（ProxyIP）\n其他网站看到：${ex.std.ip} ${ex.std.cc || ''}（节点）` }, '双出口'));
    const ba = S.bestip?.active;
    if (r.active?.viaCore && ba?.main?.length && st().bestip?.enabled !== false) {
      const v6 = ba.main.filter(ip => ip.includes(':')).length;
      tags.push(h('span', { class: 'pill xs info', 'data-tip': `优选 IP（${ba.period === 'day' ? '白天' : '夜晚'}${ba.borrowed ? '，暂用另一时段结果' : ''}）：${ba.main.length} 个主用${v6 ? `，IPv6 ${v6}` : ''}${ba.main.length - v6 ? `，IPv4 ${ba.main.length - v6}` : ''}${ba.backup?.length ? `，${ba.backup.length} 个备用` : ''}\n${ba.main.join('\n')}` }, (ba.period === 'day' ? '☀ ' : '☾ ') + '优选×' + ba.main.length));
    }
    if (r.active?.cfFail) tags.push(h('span', { class: 'pill xs warn', 'data-tip': '当前 ProxyIP 不可用，Cloudflare 网站可能打不开' }, 'CF 受限'));
    const tsig = tags.map(t => t.className + t.textContent).join('|');
    if (R.tags.dataset.sig !== tsig) { R.tags.dataset.sig = tsig; R.tags.replaceChildren(...tags); }
    const ms = r.health?.ms || r.active?.ms || 0;
    R.msBox.className = 'r-ms ' + msClass(ms);
    R.msBox.classList.remove('hidden');
    tweenNumber(R.ms, ms || null);
  } else {
    const man = st().mode === 'manual' && st().manual?.nodeId;
    R.place.textContent = s === 'degraded' ? '直连兜底中' : s === 'error' ? '已阻断' : man ? '手动线路' : reg ? `智能优选 · ${ccName(reg)}` : '智能优选';
    R.colo.textContent = '';
    R.ipText.textContent = '';
    R.ip.classList.add('hidden');
    const pc = poolCounts();
    const okNodes = usable().filter(n => nodeStat(n)?.ok).length;
    const tsig = `${usable().length}|${okNodes}|${pc.ok}|${pc.total}`;
    if (R.tags.dataset.sig !== tsig) {
      R.tags.dataset.sig = tsig;
      R.tags.replaceChildren(
        h('span', { class: 'pill xs', 'data-tip': `${usable().length} 个节点，${okNodes} 个测试可用` }, icon('server', 11), `${okNodes}/${usable().length}`),
        pc.total ? h('span', { class: 'pill xs', 'data-tip': `ProxyIP：${pc.ok} 个已验证 / 共 ${pc.total}` }, icon('pin', 11), `${pc.ok}/${pc.total}`) : null);
    }
    R.msBox.classList.add('hidden');
  }
  // 节点 / ProxyIP 选择器
  const a = live ? r.active : null;
  const manual = st().mode === 'manual' && st().manual?.nodeId;
  let nodeLabel, nodeSub, pipLabel, pipSub;
  if (a) {
    const n = nodeById(a.nodeId);
    const ns = n ? nodeStat(n) : null;
    nodeLabel = a.nodeName || a.name; nodeSub = ns?.ms ? ns.ms + 'ms' : kindLabel(a.kind);
    pipLabel = a.viaCore ? (a.pip ? shortPip(a.pip) : '节点默认') : '不适用';
    const ps = a.pip ? S.stats.routes?.[a.key] : null;
    pipSub = a.viaCore ? (ps?.ms ? ps.ms + 'ms' : 'ProxyIP') : 'ProxyIP';
  } else if (manual) {
    const n = nodeById(st().manual.nodeId);
    nodeLabel = n ? n.name : '已删除'; nodeSub = '手动';
    pipLabel = st().manual.pip ? shortPip(st().manual.pip) : '节点默认'; pipSub = 'ProxyIP';
  } else {
    nodeLabel = '自动'; nodeSub = '最优节点';
    pipLabel = st().region ? `${flag(st().region)} 自动` : '自动'; pipSub = 'ProxyIP';
  }
  const pick = (el, ic, label, sub, cls = '') => {
    const sig = label + '|' + sub + '|' + cls;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.className = 'pick ' + cls;
    el.replaceChildren(h('span', { class: 'pk-ico' }, icon(ic, 15)), h('span', { class: 'pk-t' }, h('b', { class: 'ellipsis' }, label), h('small', { class: 'ellipsis' }, sub)), icon('chevR', 14));
  };
  const nms = a ? (nodeStat(nodeById(a.nodeId) || {})?.ms || 0) : 0;
  pick(R.node, 'server', nodeLabel, nodeSub, nms ? msClass(nms) : '');
  pick(R.pip, 'pin', pipLabel, pipSub, a && !a.viaCore ? 'dis' : '');
  R.node.dataset.tip = '选择节点';
  R.pip.dataset.tip = a && !a.viaCore ? 'HTTP / SOCKS 节点不使用 ProxyIP' : 'ProxyIP：Cloudflare 网站看到的出口';
  // 延迟曲线
  const hist = live ? (r.health?.hist || []).map(x => x.ms) : [];
  const hsig = hist.join(',');
  if (R.spark.dataset.sig !== hsig) { R.spark.dataset.sig = hsig; R.spark.replaceChildren(sparkline(hist, { w: 340, h: 24 })); }
}

function regionList() {
  const m = new Map();
  for (const e of Object.values(S.pool.items || {})) {
    if (e.ban || e.gone) continue;
    const cc = itemCc(e);
    if (!cc || !/^[A-Z]{2}$/.test(cc)) continue;
    const x = m.get(cc) || { cc, ok: 0, total: 0 };
    x.total++; if (e.ok === true) x.ok++;
    m.set(cc, x);
  }
  return [...m.values()].sort((a, b) => (b.ok > 0) - (a.ok > 0) || ccSort(a.cc, b.cc));
}

let regionBusy = '';
function renderRegions() {
  const wrap = $('#regions');
  const cur = st().region || '';
  const list = regionList().slice(0, 16);
  if (cur && !list.some(x => x.cc === cur)) list.unshift({ cc: cur, ok: 0, total: 0 });
  const chips = [h('button', { class: 'chip' + (!cur ? ' on' : '') + (regionBusy === '_' ? ' busy' : ''), 'data-tip': '不限地区：自动选最快', onclick: () => pickRegion('') }, icon('zap', 14), '最快')];
  for (const x of list) {
    chips.push(h('button', { class: 'chip' + (cur === x.cc ? ' on' : '') + (!x.ok ? ' empty' : '') + (regionBusy === x.cc ? ' busy' : ''), 'data-tip': `${ccName(x.cc)} · ${x.ok}/${x.total} 可用`, onclick: () => pickRegion(x.cc) },
      h('span', { class: 'flag' }, flag(x.cc)), x.cc, x.ok ? h('span', { class: 'n' }, x.ok) : null));
  }
  $('#regionsWrap').classList.toggle('hidden', !list.length && !cur);
  const sig = chips.map(c => c.className + c.textContent).join('|');
  if (wrap.dataset.sig === sig) return;
  wrap.dataset.sig = sig;
  const scroll = wrap.scrollLeft;
  wrap.replaceChildren(...chips);
  wrap.scrollLeft = scroll;
}

async function pickRegion(cc) {
  if ((st().region || '') === cc) return;
  regionBusy = cc || '_';
  renderRegions();
  try {
    const r = await rpc('setRegion', { cc });
    if (!st().enabled) toast(cc ? `出口地区：${flag(cc)} ${ccName(cc)}（连接后生效）` : '自动选择最快线路', 'info', 2200);
    else if (r?.same) toast('当前线路已在该地区', 'info', 1800);
  } catch (e) { toast(e.message, e.user ? 'warn' : 'err', 5000); }
  regionBusy = '';
  renderRegions();
}

function renderTiles() {
  const r = rt();
  const on = statusOf() === 'on';
  const bo = $('#btnOptimize'), bn = $('#btnNextIp'), bs = $('#btnSpeed');
  const setLbl = (b, t) => { const l = b.querySelector('.t-lbl'); if (l.textContent !== t) l.textContent = t; };
  const optimizing = r.busy === 'optimize';
  bo.classList.toggle('running', optimizing);
  setLbl(bo, optimizing ? '优选中' : '优选');
  bo.disabled = !usable().length;
  const nextBusy = r.busy === 'next-ip';
  bn.classList.toggle('running', nextBusy);
  setLbl(bn, nextBusy ? '更换中' : '换 IP');
  bn.disabled = !on || !r.active?.viaCore;
  bn.dataset.tip = !on ? '连接后可用' : !r.active?.viaCore ? 'HTTP / SOCKS 节点没有 ProxyIP' : '换一个同地区的出口 IP';
  const sp = r.speed;
  const running = !!sp?.running && Date.now() - (sp.at || 0) < 20000;
  bs.classList.toggle('running', running);
  bs.style.setProperty('--p', running ? Math.round((sp.progress || 0) * 100) + '%' : '0%');
  const mbps = on ? (sp?.mbps || r.active?.mbps || 0) : 0;
  setLbl(bs, running ? (sp.mbps ? sp.mbps + ' M' : '测速中') : mbps ? `${mbps} Mbps` : '测速');
  bs.classList.toggle('has-val', !running && !!mbps);
  bs.disabled = !on;
}

function renderFoot() {
  segSet(scopeSeg, st().scope || 'global');
  const b = $('#siteRule');
  if (!tabHost) { b.replaceChildren(h('span', { class: 'dim' }, `v${chrome.runtime.getManifest().version}`)); b.disabled = true; return; }
  const s = st();
  const match = list => (list || []).some(d => tabHost === d || tabHost.endsWith('.' + d));
  const state = match(s.directList) ? 'direct' : match(s.proxyList) ? 'proxy' : 'default';
  const label = { direct: ['直连', 'warn', 'globe'], proxy: ['代理', 'ok', 'shield'], default: [s.scope === 'rules' ? '默认直连' : '默认代理', '', 'route'] }[state];
  const sig = tabHost + state + s.scope;
  if (b.dataset.sig === sig) return;
  b.dataset.sig = sig;
  b.dataset.tip = '本网站的分流规则';
  b.replaceChildren(h('span', { class: 'host' }, tabHost), h('span', { class: 'pill xs ' + label[1] }, icon(label[2], 11), label[0]), icon('chevD', 13));
}

function openSiteMenu(e) {
  if (!tabHost) return;
  const base = tabHost.split('.').slice(-2).join('.');
  const host = /^\d+\.\d+\.\d+\.\d+$/.test(tabHost) ? tabHost : base;
  const rect = e.currentTarget.getBoundingClientRect();
  const s = st();
  const match = list => (list || []).some(d => tabHost === d || tabHost.endsWith('.' + d));
  const cur = match(s.directList) ? 'direct' : match(s.proxyList) ? 'proxy' : 'default';
  const menu = h('div', { class: 'menu', style: { right: '12px', bottom: (innerHeight - rect.top + 6) + 'px' } },
    h('div', { class: 'menu-cap' }, host + ' 及子域名'),
    ...[['default', '跟随全局', 'route'], ['proxy', '始终代理', 'shield'], ['direct', '始终直连', 'globe']].map(([v, label, ic]) =>
      h('button', { class: cur === v ? 'on' : '', onclick: async () => { close(); try { await rpc('siteRule', { host, action: v }); toast(`${host} · ${label}`, 'ok', 1600); } catch (err) { toast(err.message, 'err'); } } }, icon(ic, 15), h('span', { class: 'grow' }, label), cur === v ? icon('check', 14) : null)));
  const close = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); };
  const outside = ev => { if (!menu.contains(ev.target)) close(); };
  document.body.append(menu);
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}

// ───────────── 底部抽屉：节点 / ProxyIP ─────────────
let sheetFilter = { q: '', cc: '' };
function openSheet(kind) {
  sheetKind = kind;
  sheetFilter = { q: '', cc: kind === 'pips' ? (st().region || rt().active?.hint || '') : '' };
  const acts = $('#sheetActions');
  const tools = $('#sheetTools');
  acts.replaceChildren();
  tools.replaceChildren();
  const search = h('div', { class: 'search' }, icon('search', 15), h('input', { class: 'input', placeholder: kind === 'nodes' ? '搜索节点' : '搜索 IP / 地区 / 机房', oninput: e => { sheetFilter.q = e.target.value.trim().toLowerCase(); refreshSheet(); } }));
  const auto = h('button', { class: 'btn sm ghost', 'data-tip': '恢复智能优选：自动选择并维持最优线路' }, icon('sparkles', 14), h('span', null, '自动'));
  auto.addEventListener('click', () => { closeSheet(); rpc('setMode', { mode: 'auto' }).then(() => rpc('optimize')).then(r => toast(r?.message || '已恢复智能优选', 'ok')).catch(e => toast(e.message, 'warn')); });
  if (kind === 'nodes') {
    $('#sheetTitle').textContent = '选择节点';
    const tb = h('button', { class: 'icon-btn', 'data-tip': '测试全部节点' }, icon('activity', 16));
    tb.addEventListener('click', () => act(tb, () => rpc('testNodes', {}), { ok: '节点测试完成' }));
    acts.append(st().mode === 'manual' ? auto : null, tb, h('button', { class: 'icon-btn', 'data-tip': '管理节点', onclick: () => openPage('options/options.html#nodes') }, icon('settings', 16)));
    tools.append(search);
  } else {
    $('#sheetTitle').textContent = '选择 ProxyIP';
    const tb = h('button', { class: 'icon-btn', 'data-tip': '检测当前地区的 ProxyIP' }, icon('radar', 16));
    tb.addEventListener('click', () => act(tb, () => rpc('testPool', { region: sheetFilter.cc, limit: 24 }), { ok: r => `检测 ${r.tested} 个，可用 ${r.ok} 个` }));
    acts.append(st().mode === 'manual' ? auto : null, tb, h('button', { class: 'icon-btn', 'data-tip': '管理 ProxyIP', onclick: () => openPage('options/options.html#proxyip') }, icon('settings', 16)));
    tools.append(h('div', { class: 'f-chips', id: 'pipChips' }), search);
  }
  refreshSheet();
  $('#sheetBack').classList.add('in');
  $('#sheet').classList.add('in');
  setTimeout(() => search.querySelector('input')?.focus({ preventScroll: true }), 300);
}
function closeSheet() {
  sheetKind = '';
  $('#sheetBack').classList.remove('in');
  $('#sheet').classList.remove('in');
}
function refreshSheet() {
  if (sheetKind === 'nodes') renderNodeList();
  else if (sheetKind === 'pips') renderPipList();
}

function renderNodeList() {
  const list = $('#sheetList');
  const a = rt().active;
  const q = sheetFilter.q;
  let nodes = S.nodes.filter(n => !q || `${n.name} ${n.address} ${n.kind}`.toLowerCase().includes(q));
  const sc = n => { const s = nodeStat(n); return n.unsupported || n.enabled === false ? 3e9 : s?.ok ? s.ms : s ? 2e9 : 1e9; };
  nodes = nodes.sort((x, y) => sc(x) - sc(y));
  if (!nodes.length) { list.replaceChildren(h('div', { class: 'empty' }, icon('server', 28), S.nodes.length ? '没有匹配的节点' : '还没有节点')); return; }
  list.replaceChildren(...nodes.slice(0, 200).map((n, i) => {
    const s = nodeStat(n);
    const cur = a && a.nodeId === n.id && statusOf() === 'on';
    const dis = n.unsupported || n.enabled === false;
    const lat = s?.ok ? h('span', { class: 'lat ' + msClass(s.ms) }, s.ms + 'ms') : s ? h('span', { class: 'pill xs err', 'data-tip': s.err || '' }, '不通') : h('span', { class: 'pill xs' }, '未测');
    return h('button', { class: 'item' + (cur ? ' cur' : '') + (dis ? ' dis' : ''), style: { animationDelay: Math.min(i, 12) * 18 + 'ms' }, disabled: dis, onclick: () => chooseNode(n) },
      h('span', { class: 'pill kind accent' }, kindLabel(n.kind)),
      h('div', { class: 'i-main' }, h('div', { class: 'i-name' }, h('span', { class: 'ellipsis' }, n.name), cur ? icon('check', 14) : null), latBar(s?.ok ? s.ms : 0, !!s?.ok)),
      h('div', { class: 'i-right' }, lat));
  }));
}

async function chooseNode(n) {
  const a = rt().active;
  const pip = needsCoreNode(n) ? (a?.viaCore ? a.pip : st().manual?.pip || '') : '';
  closeSheet();
  try { await rpc('selectRoute', { nodeId: n.id, pip }); } catch (e) { toast(e.message, e.user ? 'warn' : 'err', 5000); }
}

function renderPipList() {
  const list = $('#sheetList');
  const chips = $('#pipChips');
  const regs = regionList();
  const cur = sheetFilter.cc;
  if (chips) {
    chips.replaceChildren(
      h('button', { class: 'chip sm' + (!cur ? ' on' : ''), onclick: () => { sheetFilter.cc = ''; renderPipList(); } }, '全部'),
      ...regs.map(x => h('button', { class: 'chip sm' + (cur === x.cc ? ' on' : ''), onclick: () => { sheetFilter.cc = x.cc; renderPipList(); } }, h('span', { class: 'flag' }, flag(x.cc)), x.cc, x.ok ? h('span', { class: 'n' }, x.ok) : null)));
  }
  const a = rt().active;
  const q = sheetFilter.q;
  let items = Object.entries(S.pool.items || {}).filter(([k, e]) => !e.ban && !e.gone && (!cur || itemCc(e) === cur) && (!q || `${k} ${e.exitIp || ''} ${e.colo || ''} ${itemCc(e)}`.toLowerCase().includes(q)));
  const rank = e => (e.ok === true ? 0 : e.ok == null ? 1 : 2);
  items.sort((x, y) => rank(x[1]) - rank(y[1]) || (x[1].ms || 9e9) - (y[1].ms || 9e9));
  const rows = [];
  if (!q) {
    rows.push(h('button', { class: 'item' + (a?.viaCore && !a.pip && statusOf() === 'on' ? ' cur' : ''), onclick: () => choosePip('') },
      h('span', { class: 'i-flag' }, icon('settings', 18)),
      h('div', { class: 'i-main' }, h('div', { class: 'i-name' }, '节点默认'), h('div', { class: 'i-sub' }, '由节点（Worker）自行决定')),
      h('div', { class: 'i-right' })));
  }
  if (!items.length) rows.push(h('div', { class: 'empty' }, icon('pin', 28), Object.keys(S.pool.items || {}).length ? '该地区暂无 ProxyIP' : 'ProxyIP 池为空'));
  rows.push(...items.slice(0, 160).map(([k, e], i) => {
    const cc = itemCc(e);
    const isCur = a?.viaCore && a.pip === k && statusOf() === 'on';
    const lat = e.ok === true ? h('span', { class: 'lat ' + msClass(e.ms) }, e.ms + 'ms') : e.ok === false ? h('span', { class: 'pill xs err', 'data-tip': e.err || '' }, '失败') : h('span', { class: 'pill xs' }, '未测');
    return h('button', { class: 'item' + (isCur ? ' cur' : ''), style: { animationDelay: Math.min(i, 14) * 15 + 'ms' }, onclick: () => choosePip(k) },
      h('span', { class: 'i-flag flag', 'data-tip': cc ? ccName(cc) : '未知地区' }, cc ? flag(cc) : '🏳️'),
      h('div', { class: 'i-main' }, h('div', { class: 'i-name mono' }, h('span', { class: 'ellipsis' }, shortPip(k)), isCur ? icon('check', 14) : null), h('div', { class: 'i-sub mono' }, [e.exitIp ? '出口 ' + e.exitIp : '', e.colo].filter(Boolean).join(' · ') || ccName(cc) || '—')),
      h('div', { class: 'i-right' }, lat));
  }));
  list.replaceChildren(...rows);
}

async function choosePip(pip) {
  const a = rt().active;
  let nodeId = a?.viaCore ? a.nodeId : '';
  if (!nodeId) {
    const cands = S.nodes.filter(n => needsCoreNode(n) && n.enabled !== false && !n.unsupported);
    cands.sort((x, y) => (nodeStat(x)?.ok ? nodeStat(x).ms : 9e9) - (nodeStat(y)?.ok ? nodeStat(y).ms : 9e9));
    nodeId = cands[0]?.id;
  }
  if (!nodeId) { toast('ProxyIP 需要配合 VLESS / Trojan 节点使用', 'warn'); return; }
  closeSheet();
  try { await rpc('selectRoute', { nodeId, pip }); } catch (e) { toast(e.message, e.user ? 'warn' : 'err', 5000); }
}

init().catch(e => { document.body.append(h('pre', { style: { color: '#f87171', padding: '12px', whiteSpace: 'pre-wrap' } }, String(e && e.stack || e))); });
