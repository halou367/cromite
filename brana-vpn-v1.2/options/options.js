// Brana VPN · 控制中心：主要（概览 / 节点）与 更多（ProxyIP / 分流 / 设置 / 核心 / 日志 / 帮助）分开
import { h, $, $$, icon, tip, rpc, readAll, toast, act, copyText, fmtDur, fmtAgo, fmtBytes, fmtRate, msClass, kindLabel, shortPip, maskSecret, tweenNumber, sparkline, applyTheme, modal, confirmBox, flag, ccName, ccSort, orbEl, switchEl, segEl, segSet, ring, latBar, downloadBlob, downloadInstaller, platformOs, STATUS_TEXT, needsCoreNode } from '../shared/ui.js';
import { SOURCE_PRESETS, DEFAULT_SETTINGS } from '../bg/store.js';
import { normDomain, parsePoolLine } from '../shared/links.js';
import { coreSetup, CORE_LATEST, verLt } from '../shared/coresetup.js';
import { importBox, importResult, KIND_IC } from '../shared/importbox.js';
import { CITIES, parseCidr } from '../bg/bestip.js';

const S = { settings: {}, nodes: [], subs: [], pool: { items: {}, sources: [], src: {} }, stats: { nodes: {}, routes: {} }, logs: [], bestip: null, rt: null };
const EXT_ID = chrome.runtime.id;
const VERSION = chrome.runtime.getManifest().version;
const rt = () => S.rt || { status: 'off', health: {}, core: {} };
const st = () => ({ ...DEFAULT_SETTINGS, ...(S.settings || {}) });
const nodeStat = n => (needsCoreNode(n) ? S.stats.nodes?.[n.id] : S.stats.routes?.[n.id + '|']) || null;
const itemCc = e => (e && (e.cc || e.hint)) || '';
// 1.2.5：ProxyIP 质量标签
const Q_LABEL = { residential: '住宅', mobile: '移动', isp: 'ISP', business: '商业', datacenter: '机房', unknown: '未知' };
const Q_CLS = { residential: 'ok', mobile: 'ok', isp: 'accent', business: 'info', datacenter: 'warn', unknown: '' };
const isHomeQ = q => !!q && ['residential', 'mobile', 'isp'].includes(q.type);
// 1.2.8：IPPure 高风险（系数超过上限 / 被 Cloudflare 拦截）→ 自动拉黑
const riskyQ = q => { const pq = st().pipQuality || {}; const max = pq.maxRisk ?? 50; return pq.enabled !== false && !!q && q.fraud != null && max < 100 && (!!q.chal || q.fraud > max); };
const pureBand = f => (f <= 25 ? ['ok', '安全'] : f <= 50 ? ['info', '轻度风险'] : f <= 70 ? ['warn', '中度风险'] : ['err', '高度风险']);
function qPill(e) {
  const q = e.q;
  if (!q) return h('span', { class: 'pill xs', 'data-tip': '尚未检测 IP 质量（每轮优选时自动检测）' }, '—');
  const pureT = q.fraud != null ? (q.chal ? 'IPPure：查询被 Cloudflare 人机验证拦截（该 IP 已被 Cloudflare 标记）' : `IPPure 系数 ${q.fraud}%（${pureBand(q.fraud)[1]}）· ${q.bc ? '广播 IP' : '原生 IP'}`) + '\n' : '';
  const tipT = `${Q_LABEL[q.type] || q.type} IP${q.isp ? ' · ' + q.isp : ''}\n${pureT}纯净度 ${q.purity}/100${q.fraud != null ? '（= 100 − IPPure 系数）' : q.risk != null ? '（proxycheck 风险分 ' + q.risk + '）' : '（仅 ip-api，无风险分）'}${e.mbps ? '\nCloudflare 网站实测 ' + e.mbps + ' Mbps' : ''}\n数据源：${q.src || 'ip-api'}`;
  if (riskyQ(q)) return h('span', { class: 'pill xs err', 'data-tip': tipT + '\n风险过高，已自动拉黑（不参与选线）' }, q.chal ? 'CF 拦截' : `高风险 ${q.fraud}%`);
  const cls = q.purity < 40 && q.type !== 'datacenter' ? 'warn' : Q_CLS[q.type] || '';
  return h('span', { class: 'pill xs ' + cls, 'data-tip': tipT }, `${Q_LABEL[q.type] || '?'} ${q.purity}`);
}
const usable = () => S.nodes.filter(n => n.enabled !== false && !n.unsupported);
const coreNeeded = () => usable().some(needsCoreNode);
const err = e => toast(e.message || String(e), e.user ? 'warn' : 'err', 5000);
const statusOf = () => (st().enabled ? rt().status : (rt().status === 'connecting' ? 'connecting' : 'off'));
const save = patch => rpc('saveSettings', { patch });

const PAGES = [
  ['overview', '概览', 'home', 1],
  ['nodes', '节点', 'server', 1],
  ['bestip', '优选 IP', 'target', 0],
  ['proxyip', 'ProxyIP', 'pin', 0],
  ['rules', '分流', 'route', 0],
  ['settings', '设置', 'sliders', 0],
  ['core', '核心', 'cpu', 0],
  ['logs', '日志', 'file', 0],
  ['help', '帮助', 'help', 0],
];
let current = null;

// ───────────── 启动 ─────────────
async function init() {
  Object.assign(S, await readAll());
  S.settings ||= {}; S.nodes ||= []; S.subs ||= []; S.logs ||= [];
  S.pool ||= { items: {}, sources: [], src: {} }; S.stats ||= { nodes: {}, routes: {} };
  applyTheme(st().theme);
  $('#ver').textContent = 'v' + VERSION;
  $('#openWizard').append(icon('wand', 16), h('span', null, '设置向导'));
  $('#openWizard').addEventListener('click', () => { location.href = chrome.runtime.getURL('setup/setup.html'); });
  buildNav();
  route();
  window.addEventListener('hashchange', route);
  try { const port = chrome.runtime.connect({ name: 'ui' }); port.onMessage.addListener(() => {}); } catch {}
  chrome.storage.onChanged.addListener((changes, area) => {
    for (const [k, c] of Object.entries(changes)) {
      if (area === 'session' && k === 'rt') S.rt = c.newValue || null;
      if (area === 'local' && k in S) S[k] = c.newValue ?? (Array.isArray(S[k]) ? [] : S[k]);
    }
    if (changes.settings) applyTheme(st().theme);
    schedule();
  });
  setInterval(() => { current?.tick?.(); renderSide(); }, 1000);
  if (!S.rt) rpc('ping').catch(() => {});
}

let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; renderSide(); renderNav(); try { current?.update?.(); } catch (e) { console.error(e); } });
}

function buildNav() {
  const item = ([id, label, ic]) => h('button', { dataset: { id }, onclick: () => { location.hash = id; } }, icon(ic, 17), h('span', null, label), h('span', { class: 'badge hidden' }));
  $('#nav').replaceChildren(
    h('div', { class: 'nav-group' }, PAGES.filter(p => p[3]).map(item)),
    h('div', { class: 'nav-cap' }, '更多'),
    h('div', { class: 'nav-group minor' }, PAGES.filter(p => !p[3]).map(item)));
  renderNav();
}
function renderNav() {
  const id = (location.hash.slice(1) || 'overview').split('/')[0];
  for (const b of $$('#nav button')) {
    b.classList.toggle('on', b.dataset.id === id || (id === 'welcome' && b.dataset.id === 'overview'));
    const badge = b.querySelector('.badge');
    let t = '', cls = '';
    if (b.dataset.id === 'nodes') t = S.nodes.length ? String(S.nodes.length) : '';
    if (b.dataset.id === 'proxyip') { const ok = Object.values(S.pool.items || {}).filter(e => e.ok === true && !e.ban).length; t = ok ? String(ok) : ''; }
    if (b.dataset.id === 'bestip') { const a = S.bestip?.active; const on = st().bestip?.enabled !== false; t = on && a?.main?.length ? (a.period === 'day' ? '☀' : '☾') + a.main.length : ''; if (S.bestip?.running) t = '…'; }
    if (b.dataset.id === 'core') { const c = rt().core || {}; if (c.up) { t = '●'; cls = 'ok'; } else if (coreNeeded()) { t = c.installed === false ? '!' : '○'; cls = c.installed === false ? 'err' : 'warn'; } }
    badge.textContent = t;
    badge.className = 'badge ' + cls + (t ? '' : ' hidden');
  }
}

function route() {
  const id = (location.hash.slice(1) || 'overview').split('/')[0];
  const make = { overview: pageOverview, welcome: pageOverview, nodes: pageNodes, proxyip: pageProxyIp, bestip: pageBestip, rules: pageRules, settings: pageSettings, core: pageCore, logs: pageLogs, help: pageHelp }[id] || pageOverview;
  current?.destroy?.();
  const p = make();
  current = p;
  $('#content').replaceChildren(p.el);
  p.update?.();
  renderNav();
  renderSide();
  window.scrollTo({ top: 0 });
}

// 侧栏迷你状态
function renderSide() {
  const box = $('#sideStatus');
  const s = statusOf();
  const r = rt();
  const cc = r.exit?.cf?.loc || r.exit?.std?.cc || '';
  const dot = s === 'on' ? 'ok live' : s === 'connecting' || s === 'switching' ? 'busy' : s === 'degraded' ? 'warn' : s === 'error' ? 'err' : '';
  const sig = [s, cc, Math.floor((Date.now() - (r.since || 0)) / 1000)].join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const btn = h('button', { class: 'pw ' + s, 'data-tip': s === 'off' ? '连接' : '断开', 'aria-label': s === 'off' ? '连接' : '断开' }, icon('power', 17));
  btn.addEventListener('click', () => act(btn, togglePower, { quiet: true }));
  box.replaceChildren(btn,
    h('div', { class: 'ss-t' },
      h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'sdot ' + dot }), h('b', null, STATUS_TEXT[s] || s)),
      h('div', { class: 'dim ss-sub' }, s === 'on' ? `${cc ? flag(cc) + ' ' : ''}${fmtDur(Date.now() - (r.since || Date.now()))}` : s === 'off' ? (S.nodes.length ? '点击连接' : '先导入节点') : (r.phase || '…'))));
}

async function togglePower() {
  if (!S.nodes.length) { location.href = chrome.runtime.getURL('setup/setup.html'); return; }
  try {
    if (st().enabled && rt().status !== 'off') await rpc('disconnect');
    else await rpc('connect');
  } catch (e) { err(e); }
}

// ───────────── 通用构件 ─────────────
function head(title, tipText, ...actions) {
  return h('div', { class: 'page-head' }, h('h1', null, title, tipText ? tip(tipText, 16) : null), actions.length ? h('div', { class: 'row head-acts' }, actions) : null);
}
function sec(title, ic, tipText, ...extra) {
  return h('div', { class: 'sec-head' }, h('h2', null, ic ? icon(ic, 16) : null, title, tipText ? tip(tipText) : null), extra.length ? h('div', { class: 'row' }, extra) : null);
}
function btn(label, ic, onClick, kind = '', okMsg) {
  const b = h('button', { class: 'btn ' + kind }, ic ? icon(ic, 15) : null, label ? h('span', null, label) : null);
  b.addEventListener('click', () => act(b, onClick, okMsg ? { ok: okMsg } : {}));
  return b;
}
function ibtn(ic, tipText, onClick, cls = '', okMsg) {
  const b = h('button', { class: 'icon-btn ' + cls, 'data-tip': tipText, 'aria-label': tipText }, icon(ic, 16));
  b.addEventListener('click', e => { e.stopPropagation(); act(b, onClick, okMsg ? { ok: okMsg } : {}); });
  return b;
}
const tmp = (el, sig, build) => { if (el.dataset.sig === sig) return false; el.dataset.sig = sig; build(); return true; };

// ───────────── 概览 ─────────────
function pageOverview() {
  const el = h('div', { class: 'page' });
  const orb = orbEl(112);
  orb.btn.addEventListener('click', () => togglePower());
  const title = h('div', { class: 'st-title hero-title' });
  const sub = h('div', { class: 'hero-sub' });
  const chain = h('div', { class: 'chain' });
  const bOpt = h('button', { class: 'qa primary', 'data-tip': '重新测试全部线路，切到最优' }, h('span', { class: 'qa-ico' }, icon('zap', 18)), h('b', null, '优选'));
  bOpt.addEventListener('click', () => act(bOpt, () => rpc('optimize'), { ok: r => r?.message || '已切到最优线路' }));
  const bNext = h('button', { class: 'qa', 'data-tip': '换一个同地区的出口 IP' }, h('span', { class: 'qa-ico' }, icon('rotate', 18)), h('b', null, '换 IP'));
  bNext.addEventListener('click', () => act(bNext, () => rpc('nextIp'), { ok: r => r?.message || '已更换出口 IP' }));
  const bSpeed = h('button', { class: 'qa', 'data-tip': '测试当前线路下载速度' }, h('span', { class: 'qa-ico' }, icon('gauge', 18)), h('b', null, '测速'));
  bSpeed.addEventListener('click', () => act(bSpeed, () => rpc('speedTest'), { ok: r => `下载 ${r.mbps} Mbps` }));
  const hero = h('section', { class: 'hero card' }, orb.el, h('div', { class: 'hero-mid' }, title, sub, chain), h('div', { class: 'qas' }, bOpt, bNext, bSpeed));

  const metric = (ic, label, tipText, unit) => {
    const n = h('span', { class: 'm-n' }, '—');
    const u = h('small', null, unit);
    const s = h('div', { class: 'm-s' });
    const chart = h('div', { class: 'm-chart' });
    const box = h('div', { class: 'metric card' }, h('div', { class: 'm-k' }, h('span', { class: 'm-ico' }, icon(ic, 15)), label, tipText ? tip(tipText, 13) : null), h('div', { class: 'm-v' }, n, u), s, chart);
    return { el: box, n, u, s, chart, v: box.querySelector('.m-v') };
  };
  const mLat = metric('activity', '延迟', '健康检查实测（每 30 秒一次）', 'ms');
  const mSpd = metric('gauge', '速度', '最近一次测速结果', 'Mbps');
  const mDown = metric('down', '实时', '当前经核心转发的下载 / 上传速率', '/s');
  const mGuard = metric('shieldCheck', '守护', '核心内无感切换次数 · 当前连接数', '次');
  const exitBox = h('div', { class: 'exits' });
  const checklist = h('div');
  el.append(head('概览', null), checklist, hero, h('div', { class: 'metrics' }, mLat.el, mSpd.el, mDown.el, mGuard.el),
    h('section', { class: 'card sec' }, sec('出口 IP', 'globe', 'Cloudflare 托管的网站经 ProxyIP 访问，看到 ProxyIP 的 IP；\n其他网站由节点（Worker）直接访问，看到节点的 IP。', ibtn('refresh', '重新检测出口', () => rpc('refreshExit'))), exitBox));

  const node3 = (ic, label, val, state, tipText) => h('div', { class: 'ch-node ' + state, 'data-tip': [tipText, val && val !== '—' ? val : ''].filter(Boolean).join('\n') || null }, h('span', { class: 'ch-dot' }, typeof ic === 'string' ? icon(ic, 17) : ic), h('b', null, label), h('small', { class: 'ellipsis' }, val || '—'));
  const link = state => h('span', { class: 'ch-link ' + state });

  const update = () => {
    const s = statusOf();
    const r = rt();
    const live = s === 'on' || s === 'switching';
    orb.el.dataset.st = s;
    title.textContent = r.busy === 'optimize' && s === 'on' ? '正在优选' : STATUS_TEXT[s] || s;
    title.className = 'st-title hero-title ' + s;
    updSub();
    bNext.disabled = s !== 'on' || !r.active?.viaCore;
    bSpeed.disabled = s !== 'on';
    bOpt.disabled = !usable().length;

    // 链路可视化：浏览器 → 核心 → 节点 → ProxyIP → 出口
    const a = live ? r.active : null;
    const ex = r.exit || {};
    const cc = ex.cf?.loc || ex.std?.cc || a?.hint || '';
    const viaCore = a ? a.viaCore : coreNeeded();
    const on = live ? 'on' : '';
    const csig = [s, a?.key, cc, ex.cf?.ip, r.core?.up, viaCore].join('|');
    tmp(chain, csig, () => chain.replaceChildren(
      node3('browser', '浏览器', 'Chrome', on || 'idle', '只接管浏览器流量，系统其他程序不受影响'),
      link(viaCore ? on : 'skip'),
      node3('cpu', '核心', viaCore ? (r.core?.up ? '127.0.0.1:' + (r.core.port || '') : '待命') : '无需', viaCore ? (live ? 'on' : r.core?.up ? 'ready' : 'idle') : 'skip', '本地核心：把浏览器流量转成 VLESS / Trojan'),
      link(on),
      node3('server', '节点', a ? (a.nodeName || a.name) : (st().mode === 'manual' ? '手动' : '自动'), on || 'idle', a ? `${kindLabel(a.kind)} 节点` : '自动选择最优节点'),
      link(viaCore ? on : 'skip'),
      node3('pin', 'ProxyIP', a ? (a.viaCore ? (a.pip ? shortPip(a.pip) : '节点默认') : '不适用') : (st().region ? flag(st().region) + ' 自动' : '自动'), a && !a.viaCore ? 'skip' : on || 'idle', 'Cloudflare 网站的落地出口'),
      link(on),
      node3(cc && live ? h('span', { class: 'flag ch-flag' }, flag(cc)) : 'globe', '出口', live ? (ex.cf?.ip || ex.std?.ip || '检测中') : '—', on || 'idle', cc ? ccName(cc) : '')));

    // 指标
    const ms = live ? (r.health?.ms || r.active?.ms || 0) : 0;
    tweenNumber(mLat.n, ms || null);
    mLat.v.className = 'm-v ' + (ms ? msClass(ms) : '');
    mLat.s.textContent = live ? (r.health?.at ? '检测于 ' + fmtAgo(r.health.at) : '—') + (r.health?.fail ? ` · 失败 ${r.health.fail}` : '') : '未连接';
    const hist = live ? (r.health?.hist || []).map(x => x.ms) : [];
    tmp(mLat.chart, hist.join(','), () => mLat.chart.replaceChildren(sparkline(hist, { w: 300, h: 38 })));
    const mbps = live ? (r.speed?.mbps || r.active?.mbps || 0) : 0;
    tweenNumber(mSpd.n, mbps || null, { dec: mbps >= 100 ? 0 : 1 });
    mSpd.s.textContent = r.speed?.running ? `测速中 ${r.speed.mbps || 0} Mbps` : r.speed?.at && live ? '测于 ' + fmtAgo(r.speed.at) : live ? '点「测速」测量' : '—';
    const tr = r.traffic;
    const fresh = tr && Date.now() - (tr.at || 0) < 10000 && live;
    mDown.n.textContent = fresh ? fmtBytes(tr.rateDown || 0) : '—';
    mDown.u.textContent = fresh ? '/s' : '';
    mDown.s.textContent = fresh ? `↑ ${fmtRate(tr.rateUp || 0)} · 累计 ${fmtBytes((tr.down || 0) + (tr.up || 0))}` : (live && !r.active?.viaCore ? '浏览器直连代理' : '—');
    mGuard.n.textContent = fresh ? String(tr.failovers || 0) : '—';
    mGuard.u.textContent = fresh ? '次' : '';
    mGuard.s.textContent = fresh ? `${tr.conns || 0} 个连接${tr.direct ? ' · 兜底 ' + tr.direct : ''}` : '—';

    // 出口
    const esig = [live, ex.cf?.ip, ex.cf?.loc, ex.cf?.colo, ex.std?.ip, ex.std?.cc, ex.pure?.isp, ex.ipp?.fraud, r.riskRelax, a?.viaCore, a?.uni, r.uniMiss, st().uniform?.enabled].join('|');
    tmp(exitBox, esig, () => {
      if (!live) { exitBox.replaceChildren(h('div', { class: 'empty' }, icon('globe', 26), '连接后显示出口')); return; }
      const one = (label, e, extra, tipText) => h('div', { class: 'exit' },
        h('span', { class: 'big-flag flag' }, (e?.loc || e?.cc) ? flag(e.loc || e.cc) : '🌐'),
        h('div', { class: 'grow' },
          h('div', { class: 'dim ex-k' }, label, tipText ? tip(tipText, 12) : null),
          h('div', { class: 'ex-ip mono' }, e?.ip || '检测中…', e?.ip ? h('button', { class: 'icon-btn xs', 'data-tip': '复制', onclick: () => copyText(e.ip).then(() => toast('已复制', 'ok', 1200)) }, icon('copy', 12)) : null),
          h('div', { class: 'row', style: { gap: '5px', flexWrap: 'wrap', marginTop: '4px' } }, (e?.loc || e?.cc) ? h('span', { class: 'pill' }, ccName(e.loc || e.cc)) : null, extra)));
      exitBox.replaceChildren(
        one('Cloudflare 网站', ex.cf, [ex.cf?.colo ? h('span', { class: 'pill' }, ex.cf.colo) : null, ex.ipp && ex.ipp.ip === ex.cf?.ip ? h('span', { class: 'pill ' + pureBand(ex.ipp.fraud)[0], 'data-tip': `IPPure 系数 ${ex.ipp.fraud}%（${pureBand(ex.ipp.fraud)[1]}）\n${ex.ipp.res ? '住宅 IP' : '机房 IP'} · ${ex.ipp.bc ? '广播 IP' : '原生 IP'}${ex.ipp.org ? '\n' + ex.ipp.org : ''}` }, `IPPure ${ex.ipp.fraud}%`) : ex.pure ? h('span', { class: 'pill ' + (ex.pure.proxy ? 'warn' : ex.pure.hosting ? 'info' : 'ok'), 'data-tip': ex.pure.isp || '' }, ex.pure.proxy ? '代理 IP' : ex.pure.hosting ? '机房 IP' : '住宅 IP') : null,
          r.riskRelax ? h('span', { class: 'pill warn', 'data-tip': '所有可用 ProxyIP 的 IPPure 风险系数都超过上限，已临时使用风险最低的（连通性优先）；后台会继续寻找低风险 IP' }, '临时放宽') : null], a?.viaCore ? 'ProxyIP 出口' : ''),
        one('其他网站', ex.std, [
          a?.uni && ex.cf?.ip && ex.std?.ip ? (ex.cf.ip === ex.std.ip ? h('span', { class: 'pill ok', 'data-tip': '所有 HTTPS 网站都从同一个 IP 出去' }, '统一出口 ✓') : h('span', { class: 'pill warn' }, '出口不一致')) : null,
          !a?.uni && a?.viaCore && st().uniform?.enabled ? h('span', { class: 'pill warn', 'data-tip': '还没有找到可用的「通用转发」ProxyIP，可在 ProxyIP 页点「扫描通用」' }, '统一出口未生效') : null,
          ex.std?.isp ? h('span', { class: 'pill ellipsis', style: { maxWidth: '200px' } }, ex.std.isp) : null], a?.uni ? '统一出口：经同一个 ProxyIP 转发' : a?.viaCore ? '节点（Worker）出口' : ''));
    });

    // 设置进度
    const c = r.core || {};
    const coreOk = !!c.up || (S.nodes.length > 0 && !coreNeeded());
    const steps = [['core', 'cpu', '核心', coreOk], ['import', 'link', '导入', S.nodes.length > 0], ['connect', 'plug', '连接', s === 'on' || !!st().setupDone]];
    const need = !steps.every(x => x[3]) && !st().setupDone || !S.nodes.length;
    tmp(checklist, need + steps.map(x => +x[3]).join(''), () => {
      if (!need) { checklist.replaceChildren(); return; }
      const nextId = steps.find(x => !x[3])?.[0] || 'connect';
      checklist.replaceChildren(h('section', { class: 'card checklist' },
        h('div', { class: 'ico-tile' }, icon('wand', 22)),
        h('div', { class: 'cl-steps' }, steps.map(([id, ic, label, done], i) => h('a', { class: 'cl-step' + (done ? ' done' : '') + (id === nextId ? ' cur' : ''), href: chrome.runtime.getURL('setup/setup.html#' + id) }, h('span', { class: 'cl-dot' }, icon(done ? 'check' : ic, 15)), `${i + 1} ${label}`))),
        h('a', { class: 'btn primary', href: chrome.runtime.getURL('setup/setup.html#' + nextId) }, icon('rocket', 15), h('span', null, '继续设置'))));
    });
  };
  const updSub = () => {
    const s = statusOf();
    const r = rt();
    let parts;
    if (r.phase && (s === 'connecting' || s === 'switching' || r.busy)) parts = [h('span', { class: 'phase-dots' }, r.phase)];
    else if (s === 'on') parts = [h('span', { class: 'sub-chip' }, icon('clock', 12), h('span', { class: 'mono' }, fmtDur(Date.now() - (r.since || Date.now())))),
      h('span', { class: 'sub-chip' }, icon(st().mode === 'manual' ? 'pointer' : 'sparkles', 12), st().mode === 'manual' ? '手动' : '智能优选'),
      st().region ? h('span', { class: 'sub-chip' }, flag(st().region), ccName(st().region)) : null,
      st().strict ? h('span', { class: 'sub-chip' }, icon('lock', 12), '防泄漏') : null];
    else if (s === 'degraded' || s === 'error') parts = [h('span', { class: 'warn-t' }, r.notice?.text || '线路暂不可用，稍后自动重试')];
    else parts = [h('span', { class: 'dim' }, S.nodes.length ? '点击光球连接' : '先完成设置向导')];
    sub.replaceChildren(...parts);
  };
  return { el, update, tick: () => { const s = statusOf(); if (s === 'on' || s === 'degraded') updSub(); } };
}

// ───────────── 节点 ─────────────
function pageNodes() {
  const el = h('div', { class: 'page' });
  const filt = { q: '', f: 'all' };
  const q = h('input', { class: 'input', placeholder: '搜索名称 / 地址' });
  q.addEventListener('input', () => { filt.q = q.value.trim().toLowerCase(); renderNodes(); });
  const fseg = segEl([['all', '全部'], ['ok', '可用'], ['fail', '不通'], ['untested', '未测'], ['disabled', '停用']], 'all', v => { filt.f = v; renderNodes(); }, 'f-seg');
  const subsBox = h('div', { class: 'subs' });
  const grid = h('div', { class: 'ncards' });
  const bImport = h('button', { class: 'btn primary' }, icon('plus', 16), h('span', null, '导入'));
  bImport.addEventListener('click', openImport);
  const bTest = btn('测速', 'activity', () => rpc('testNodes', {}), '', '节点测试完成');
  bTest.dataset.tip = '测试全部启用的节点';
  const bAdd = ibtn('edit', '手动添加节点', () => editNode(null));
  const bClean = ibtn('trash', '删除全部不通的节点', async () => {
    const bad = S.nodes.filter(n => { const s = nodeStat(n); return s && !s.ok; });
    if (!bad.length) { toast('没有不通的节点', 'info'); return; }
    if (await confirmBox('删除不通的节点', `删除 ${bad.length} 个测试不通的节点？`, '删除', true)) { await rpc('removeNodes', { ids: bad.map(n => n.id) }); toast(`已删除 ${bad.length} 个`, 'ok'); }
  });
  el.append(
    head('节点', '支持 VLESS / Trojan（WebSocket，TLS 或明文）与 HTTP / HTTPS / SOCKS5 代理。\n订阅每 12 小时自动更新。', bTest, bImport),
    subsBox,
    h('div', { class: 'toolbar' }, h('div', { class: 'search grow' }, icon('search', 15), q), fseg, bAdd, bClean),
    grid);

  function renderSubs() {
    const sig = JSON.stringify(S.subs.map(s => [s.id, s.name, s.count, s.at, s.err, s.unsupported]));
    tmp(subsBox, sig, () => {
      if (!S.subs.length) { subsBox.replaceChildren(); return; }
      subsBox.replaceChildren(...S.subs.map(sub => {
        let host = sub.url;
        try { const u = new URL(sub.url); host = u.host + (u.pathname.length > 1 ? '/' + maskSecret(u.pathname.slice(1)) : ''); } catch {}
        const name = h('b', { class: 'ellipsis', 'data-tip': '点击重命名', style: { cursor: 'pointer' } }, sub.name);
        name.addEventListener('click', async () => { const v = prompt('订阅名称', sub.name); if (v != null && v.trim()) await rpc('renameSub', { id: sub.id, name: v.trim() }).catch(err); });
        return h('div', { class: 'sub card' },
          h('div', { class: 'ico-tile soft' }, icon('link', 18)),
          h('div', { class: 'grow sub-t' }, name, h('small', { class: 'mono ellipsis dim', 'data-tip': sub.url }, host)),
          h('div', { class: 'sub-meta' },
            h('span', { class: 'pill ' + (sub.err ? 'err' : sub.at ? 'ok' : ''), 'data-tip': sub.err || ((sub.at ? '更新于 ' + fmtAgo(sub.at) : '待更新') + (sub.entries && sub.entries > sub.count ? `\n${sub.count} 个节点（订阅里 ${sub.entries} 个条目，同一 Host 已合并）` : '')) }, sub.err ? icon('alert', 11) : icon('server', 11), sub.count || 0),
            h('small', { class: 'dim' }, fmtAgo(sub.at))),
          ibtn('refresh', '更新订阅', () => rpc('updateSub', { id: sub.id }), '', r => `已更新：${r.count} 个节点`),
          ibtn('trash', '删除订阅及其节点', async () => { if (await confirmBox('删除订阅', `删除「${sub.name}」及其 ${sub.count || 0} 个节点？`, '删除', true)) await rpc('removeSub', { id: sub.id }); }));
      }));
    });
  }

  function visible() {
    return S.nodes.filter(n => {
      if (filt.q && !`${n.name} ${n.address} ${n.kind} ${n.prefAddr || ''}`.toLowerCase().includes(filt.q)) return false;
      const s = nodeStat(n);
      if (filt.f === 'ok') return s?.ok;
      if (filt.f === 'fail') return s && !s.ok;
      if (filt.f === 'untested') return !s;
      if (filt.f === 'disabled') return n.enabled === false;
      return true;
    });
  }

  function renderNodes() {
    const list = visible();
    const a = rt().active;
    const live = statusOf() === 'on';
    const sig = JSON.stringify([filt, list.map(n => [n.id, n.name, n.enabled, n.prefAddr, nodeStat(n)?.ms, nodeStat(n)?.ok, nodeStat(n)?.at]), a?.nodeId, live]);
    if (grid.dataset.sig === sig) return;
    grid.dataset.sig = sig;
    if (!list.length) {
      grid.replaceChildren(h('div', { class: 'empty wide' }, h('div', { class: 'ico-tile soft lg' }, icon('server', 26)), S.nodes.length ? '没有匹配的节点' : '还没有节点',
        !S.nodes.length ? h('button', { class: 'btn primary', onclick: openImport }, icon('plus', 15), h('span', null, '导入节点')) : null));
      return;
    }
    const subName = id => S.subs.find(s => s.id === id)?.name;
    grid.replaceChildren(...list.slice(0, 400).map((n, i) => {
      const s = nodeStat(n);
      const cur = a?.nodeId === n.id && live;
      const sw = switchEl(n.enabled !== false, v => rpc('toggleNode', { id: n.id, enabled: v }).catch(err), '启用');
      sw.dataset.tip = n.enabled !== false ? '已启用' : '已停用';
      const use = h('button', { class: 'btn xs use-btn' + (cur ? ' on-use' : '') }, cur ? icon('check', 12) : icon('play', 11), cur ? '使用中' : '使用');
      use.disabled = cur || n.unsupported;
      use.addEventListener('click', () => act(use, () => rpc('selectRoute', { nodeId: n.id, pip: needsCoreNode(n) && a?.viaCore ? a.pip : '' }), { ok: `已切换到 ${n.name}` }));
      const acts = h('div', { class: 'nc-acts' },
        use,
        h('span', { class: 'grow' }),
        ibtn('activity', '测试', () => rpc('testNodes', { ids: [n.id] }), 'xs'),
        needsCoreNode(n) && n.tls ? ibtn('radar', n.prefAddr ? `已优选 ${n.prefAddr}，点击重新扫描` : '扫描 Cloudflare 优选 IP', () => rpc('scanNode', { id: n.id }), 'xs', r => r.list?.length ? `找到 ${r.list.length} 个优选 IP` : '未找到更优 IP') : null,
        ibtn('copy', '复制分享链接', async () => { const l = await rpc('nodeLink', { id: n.id }); await copyText(l); toast('已复制链接', 'ok', 1400); }, 'xs'),
        ibtn('edit', '编辑', () => editNode(n), 'xs'),
        ibtn('trash', '删除', async () => { if (await confirmBox('删除节点', `删除「${n.name}」？`, '删除', true)) await rpc('removeNodes', { ids: [n.id] }); }, 'xs'));
      const sn = subName(n.subId);
      return h('div', { class: 'ncard card' + (cur ? ' cur' : '') + (n.enabled === false ? ' dis' : '') + (n.unsupported ? ' unsup' : ''), style: { animationDelay: Math.min(i, 16) * 18 + 'ms' } },
        h('div', { class: 'nc-top' },
          h('span', { class: 'pill kind accent' }, icon(KIND_IC[n.kind] || 'server', 10), kindLabel(n.kind)),
          n.tls ? h('span', { class: 'pill kind' }, 'TLS') : null,
          n.prefAddr ? h('span', { class: 'pill kind ok', 'data-tip': `已启用优选 IP：${n.prefAddr}` }, '优选') : null,
          n.et >= 2 ? h('span', { class: 'pill kind info', 'data-tip': `edgetunnel 订阅里的 ${n.et} 个条目是同一个节点（同 Host + UUID），已合并为一个。\n连接地址使用「优选 IP」，订阅里的地址只作最后备用。` }, `合并 ${n.et}`) : null,
          sn ? h('span', { class: 'pill kind', 'data-tip': '来自订阅：' + sn }, icon('link', 10)) : null,
          h('span', { class: 'grow' }), sw),
        h('div', { class: 'nc-name ellipsis', 'data-tip': n.name.length > 22 ? n.name : null }, n.name),
        h('div', { class: 'nc-addr mono ellipsis', 'data-tip': n.et >= 2 ? `连接地址由「优选 IP」提供（端口 ${n.port}）\n订阅地址作备用：${[n.address, ...(n.altAddrs || [])].slice(0, 6).join('、')}` : null }, n.et >= 2 ? `优选 IP : ${n.port} · ${n.host || n.sni}` : `${n.address}:${n.port}`),
        h('div', { class: 'nc-lat' }, latBar(s?.ok ? s.ms : 0, !!s?.ok),
          s?.ok ? h('b', { class: 'lat ' + msClass(s.ms) }, s.ms + 'ms') : s ? h('span', { class: 'pill xs err', 'data-tip': s.err || '' }, '不通') : h('span', { class: 'pill xs' }, n.unsupported ? '不支持' : '未测')),
        acts);
    }));
  }

  function openImport() {
    const result = h('div', { class: 'imp-result' });
    let m = null;
    const box = importBox({ compact: true, onDone: res => { setTimeout(() => { result.replaceChildren(importResult(res, S.nodes)); setTimeout(() => m?.close(), 1500); }, 150); } });
    m = modal({ title: '导入节点', body: h('div', { class: 'col', style: { gap: '12px' } }, box.el, result), wide: true });
    setTimeout(() => box.focus(), 200);
  }

  return { el, update: () => { renderSubs(); renderNodes(); } };
}

function editNode(n) {
  const isNew = !n;
  const v = n ? { ...n } : { kind: 'vless', name: '', address: '', port: 443, uuid: '', password: '', tls: true, sni: '', host: '', path: '/?ed=2560', insecure: false, user: '', pass: '' };
  const f = {};
  const inp = (key, ph = '', type = 'text') => (f[key] = h('input', { class: 'input' + (type === 'number' ? ' mono' : ''), type, value: v[key] ?? '', placeholder: ph }));
  const sw = key => { f[key] = h('input', { type: 'checkbox', checked: !!v[key] }); return h('label', { class: 'switch' }, f[key], h('span', { class: 'track' })); };
  f.kind = h('select', { class: 'input' }, ...['vless', 'trojan', 'https', 'http', 'socks5'].map(k => h('option', { value: k, selected: v.kind === k }, kindLabel(k))));
  const wsBox = h('div', null,
    h('div', { class: 'field ws-uuid' }, h('label', null, 'UUID'), inp('uuid', 'xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx')),
    h('div', { class: 'field ws-pass' }, h('label', null, 'Trojan 密码'), inp('password', '密码')),
    h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, 'Host（WS 域名）'), inp('host', 'xxx.workers.dev')), h('div', { class: 'field' }, h('label', null, 'Path'), inp('path', '/?ed=2560'))),
    h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, 'SNI'), inp('sni', '留空 = Host')), h('div', { class: 'field' }, h('label', null, '选项'), h('div', { class: 'row', style: { height: '34px', gap: '14px' } }, h('span', { class: 'row' }, sw('tls'), 'TLS'), h('span', { class: 'row' }, sw('insecure'), '跳过证书验证')))));
  const pxBox = h('div', null, h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, '用户名（可选）'), inp('user')), h('div', { class: 'field' }, h('label', null, '密码（可选）'), inp('pass', '', 'password'))));
  const sync = () => {
    const k = f.kind.value;
    const ws = k === 'vless' || k === 'trojan';
    wsBox.classList.toggle('hidden', !ws);
    pxBox.classList.toggle('hidden', ws);
    wsBox.querySelector('.ws-uuid').classList.toggle('hidden', k !== 'vless');
    wsBox.querySelector('.ws-pass').classList.toggle('hidden', k !== 'trojan');
  };
  f.kind.addEventListener('change', () => { if (!f.port.value || ['443', '80', '1080'].includes(f.port.value)) f.port.value = { socks5: 1080, http: 80 }[f.kind.value] || 443; sync(); });
  const body = h('div', null,
    h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, '类型'), f.kind), h('div', { class: 'field' }, h('label', null, '名称'), inp('name', '例如：香港'))),
    h('div', { class: 'grid3' }, h('div', { class: 'field' }, h('label', null, '地址'), inp('address', '域名或 IP')), h('div', { class: 'field' }, h('label', null, '端口'), inp('port', '443', 'number')), h('div')),
    wsBox, pxBox);
  sync();
  modal({
    title: isNew ? '添加节点' : '编辑节点', body, wide: true,
    actions: [
      { label: '取消', kind: 'ghost' },
      { label: '保存', kind: 'primary', icon: 'check', onClick: async () => {
        const node = { ...(n || {}), kind: f.kind.value, name: f.name.value.trim(), address: f.address.value.trim().replace(/^\[|\]$/g, ''), port: +f.port.value || 443 };
        if (node.kind === 'vless' || node.kind === 'trojan') Object.assign(node, { uuid: f.uuid.value.trim(), password: f.password.value, host: f.host.value.trim(), path: f.path.value.trim() || '/', sni: f.sni.value.trim(), tls: f.tls.checked, insecure: f.insecure.checked });
        else Object.assign(node, { user: f.user.value, pass: f.pass.value });
        delete node.unsupported;
        try { await rpc('saveNode', { node }); toast(isNew ? '已添加' : '已保存', 'ok'); } catch (e) { err(e); return false; }
      } },
    ],
  });
}

// ───────────── ProxyIP ─────────────
// ───────────── 优选 IP（edgetunnel 连接地址自动优选）─────────────
function pageBestip() {
  const el = h('div', { class: 'page' });
  const MBs = 1048576;
  let V = null;           // 后台快照（时段、日出日落、节点覆盖、核心能力）
  let showP = '';         // 表格显示的时段：'' = 跟随当前
  let showMore = false;
  const B = () => S.bestip || {};
  const C = () => { const d = DEFAULT_SETTINGS.bestip, c = st().bestip || {}; return { ...d, ...c, th6: { ...d.th6, ...(c.th6 || {}) }, th4: { ...d.th4, ...(c.th4 || {}) }, geo: { ...d.geo, ...(c.geo || {}) } }; };
  const saveB = (patch, msg = '已保存') => save({ bestip: patch }).then(() => { toast(msg, 'ok', 1300); loadView(); }).catch(err);
  const hm = t => t ? new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  const until = t => { const s = Math.max(0, Math.round((t - Date.now()) / 1000)); return s < 60 ? s + ' 秒后' : s < 3600 ? Math.floor(s / 60) + ' 分钟后' : `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分后`; };
  const mbs = v => v == null ? '—' : (v / MBs).toFixed(v / MBs >= 100 ? 0 : 1);
  const spKey = u => { try { return new URL(u).host; } catch { return u || '—'; } };
  const loadView = async () => { try { V = await rpc('bestipView'); schedule(); } catch {} };

  // 正在使用：每 3 秒读取核心里活动线路的逐地址统计。核心 1.2.2+ 直接给出当前连接数；
  // 旧核心没有连接数，按「近 1 分钟有新的成功建连」推断
  let LIVE = null;
  const okHist = new Map(); // addr -> [{t, ok}]
  const normA = a => String(a || '').replace(/^\[|\]$/g, '').toLowerCase();
  const pollLive = async () => {
    if (document.visibilityState !== 'visible') return;
    let r = null;
    try { r = await rpc('bestipLive'); } catch { r = null; }
    const t = Date.now();
    for (const a of r?.addrs || []) {
      const k = normA(a.addr);
      let hist = okHist.get(k) || [];
      if (hist.length && a.ok < hist[hist.length - 1].ok) hist = []; // 核心重启 / 换线路：计数归零，重新开始
      hist.push({ t, ok: a.ok });
      okHist.set(k, hist.filter(x => t - x.t <= 65e3));
    }
    LIVE = r;
    renderLive(); renderTable();
  };
  const liveOf = ip => {
    const a = (LIVE?.addrs || []).find(x => normA(x.addr) === normA(ip));
    if (!a) return null;
    const hist = okHist.get(normA(ip)) || [];
    const recent = hist.length > 1 ? Math.max(0, a.ok - hist[0].ok) : 0;
    const tot = (LIVE.addrs || []).reduce((s, x) => s + (x.ok || 0), 0);
    const use = LIVE.live ? a.act > 0 : recent > 0;
    return { ...a, recent, share: tot ? a.ok / tot : 0, use, dn: a.down > Date.now() };
  };
  const liveTip = (x, role) => [
    LIVE.live ? `当前连接 ${x.act} 个` : `近 1 分钟新建连接 ${x.recent} 次`,
    `核心启动以来成功 ${x.ok} 次（占 ${Math.round(x.share * 100)}%），失败 ${x.fail} 次`,
    LIVE.live && x.bytes ? `流量 ${fmtBytes(x.bytes)}` : '',
    x.ms ? `建连耗时 ${x.ms} ms（经节点建立连接的用时，与表格里的 TCP 延迟是不同测量方式，不可比较）` : '',
    x.dn ? `已熔断：${x.err || '连续失败'}（${fmtAgo(x.down).replace('前', '后')}恢复）` : '',
    role === 'alt' ? '这是订阅里的原地址（优选 IP 全部不可用或尚无结果时才用）' : '',
  ].filter(Boolean).join('\n');

  // 顶部：开关 / 当前时段 / 日出日落 / 下次测试 / 立即测试
  const hero = h('section', { class: 'card bi-hero' });
  const enSw = switchEl(C().enabled, v => saveB({ enabled: v }, v ? '已开启优选 IP' : '已关闭优选 IP（节点恢复使用原地址）'), '优选 IP');
  const bRun = btn('立即测试', 'play', async () => { const r = await rpc('bestipRun'); const L = r.active; return L ? `完成：${L.main.length} 个主用 IP` : '完成'; }, 'primary', m => m);
  const bCancel = btn('取消', 'x', () => rpc('bestipCancel'), 'ghost');
  const prog = h('div', { class: 'bi-prog hidden' }, h('div', { class: 'bi-prog-t' }), h('div', { class: 'bi-bar' }, h('i')));
  const gate = h('section', { class: 'card sec bi-gate hidden' });
  const scopeNote = h('div', { class: 'bi-note hidden' });

  // 结果表：白天 / 夜晚
  const pSeg = segEl([['day', '白天', 'sun'], ['night', '夜晚', 'moon']], 'day', v => { showP = v; renderTable(); });
  const tableBox = h('div', { class: 'bi-table' });
  const tableMeta = h('div', { class: 'dim bi-meta' });
  const liveBox = h('div', { class: 'bi-live hidden' });
  const results = h('section', { class: 'card sec' }, sec('优选结果', 'target', '每个时段分别排名：达标的排前面，其次按综合分（延迟 × 丢包 + 速度）。\n主用 = 当前作为节点 address 的 IP；备用 = 主用全部不可用时才用的 IPv4。\n「使用中」= 此刻有连接正经过这个 IP。新连接会在延迟相近的主用 IP 之间分散，所以通常同时有几个在用。\n成绩按时段累计，越新的权重越高（半衰期 12 小时）。', pSeg), liveBox, tableMeta, tableBox);

  // 达标线：IPv6 / IPv4 分开
  const thCard = fam => {
    const key = fam === 6 ? 'th6' : 'th4';
    const f = (k, label, unit, min, max, step, tp) => {
      const i = h('input', { class: 'input num mono', type: 'number', min, max, step, value: C()[key][k] });
      i.addEventListener('change', () => saveB({ [key]: { [k]: +i.value } }));
      return { i, row: h('div', { class: 'opt' }, h('span', { class: 'grow' }, label, tp ? tip(tp, 13) : null), i, h('span', { class: 'dim unit' }, unit)) };
    };
    const a = f('ms', 'TCP 握手延迟低于', 'ms', 10, 2000, 1, '仅测量 TCP 握手（直连该 IP，多次取平均），不含 DNS / TLS / HTTP。\n与节点延迟、浏览器测速等其他模式的数值不可互相比较。');
    const b = f('mbs', '峰值速度不低于', 'MB/s', 0, 1000, 0.5, '直连该 IP 下载时 1 秒内的最高速度（MB/s，1 MB = 1024 KB）。\n设为 0 = 不要求速度。');
    const c = f('loss', '丢包不超过', '%', 0, 100, 1, '精测时握手失败的比例。');
    return { el: h('div', { class: 'card bi-th' }, h('div', { class: 'bi-th-h' }, h('span', { class: 'pill ' + (fam === 6 ? 'accent' : '') }, fam === 6 ? 'IPv6 · 主力' : 'IPv4 · 辅助'), tip(fam === 6 ? 'IPv6 网段的达标线。' : 'IPv4 一般延迟更高、稳定性更差，单独设置更宽松的达标线。\n本机没有 IPv6 时，全部使用 IPv4。', 13)), a.row, b.row, c.row), sync: () => { for (const [x, k] of [[a.i, 'ms'], [b.i, 'mbs'], [c.i, 'loss']]) if (document.activeElement !== x) x.value = C()[key][k]; } };
  };
  const th6 = thCard(6), th4 = thCard(4);

  // 基本设置
  const numOpt = (k, label, unit, min, max, tp) => {
    const i = h('input', { class: 'input num mono', type: 'number', min, max, value: C()[k] });
    i.addEventListener('change', () => saveB({ [k]: +i.value }));
    return { el: h('div', { class: 'opt' }, h('span', { class: 'grow' }, label, tp ? tip(tp, 13) : null), i, h('span', { class: 'dim unit' }, unit)), sync: () => { if (document.activeElement !== i) i.value = C()[k]; } };
  };
  const ivSeg = segEl([['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['6', '6'], ['12', '12']], String(C().intervalH), v => saveB({ intervalH: +v }), 'sm');
  const famSeg = segEl([['auto', '自动', null, 'IPv6 优先，IPv4 备用；本机没有 IPv6 时自动只用 IPv4'], ['v6', '仅 IPv6'], ['v4', '仅 IPv4']], C().family, v => saveB({ family: v }), 'sm');
  const perOpt = numOpt('perCidr', '每个网段抽样', '个', 5, 100, '每轮从每个网段随机抽取的 IP 数量（上轮入选的 IP 也会一起复测）。');
  const topOpt = numOpt('top', '每个时段保留前', '名', 1, 10, '白天、夜晚各保留前几名作为节点的连接地址。');
  const bkOpt = numOpt('backups', 'IPv4 备用', '个', 0, 5, 'IPv6 可用时，额外保留几个 IPv4 作为备用（主用全部不可用时才使用）。');
  const basic = h('section', { class: 'card sec' }, sec('测试计划', 'clock'),
    h('div', { class: 'opt' }, h('span', { class: 'grow' }, '测试间隔（小时）', tip('按本地时间整点对齐：3 小时 = 0、3、6、9、12、15、18、21 点各测一次。', 13)), ivSeg),
    h('div', { class: 'opt' }, h('span', { class: 'grow' }, '协议', tip('IPv6 为主、IPv4 为辅。', 13)), famSeg),
    perOpt.el, topOpt.el, bkOpt.el);

  // 网段
  const ta6 = h('textarea', { class: 'input', rows: 4, spellcheck: false, placeholder: '2606:4700:5a::/48' });
  const ta4 = h('textarea', { class: 'input', rows: 3, spellcheck: false, placeholder: '172.64.229.0/24' });
  const fillTa = () => { ta6.value = C().v6Cidrs.join('\n'); ta4.value = C().v4Cidrs.join('\n'); };
  fillTa();
  const bCidr = btn('保存网段', 'check', async () => {
    const lines = t => t.value.split(/[\s,，;；]+/).map(s => s.trim()).filter(Boolean);
    const bad = [...lines(ta6).filter(x => parseCidr(x)?.fam !== 6), ...lines(ta4).filter(x => parseCidr(x)?.fam !== 4)];
    if (bad.length) throw Object.assign(new Error('格式不正确：' + bad.slice(0, 3).join('，')), { user: true });
    await save({ bestip: { v6Cidrs: lines(ta6), v4Cidrs: lines(ta4) } });
    fillTa();
    loadView();
    return '已保存，1 分钟后自动重测';
  }, 'primary', m => m);
  const bCidrReset = btn('恢复默认', 'undo', async () => { await save({ bestip: { v6Cidrs: DEFAULT_SETTINGS.bestip.v6Cidrs, v4Cidrs: DEFAULT_SETTINGS.bestip.v4Cidrs } }); fillTa(); }, 'ghost', '已恢复默认网段');
  const cidrs = h('section', { class: 'card sec' }, sec('网段', 'grid', '一行一个 CIDR。每轮从每个网段随机抽样测试。'),
    h('div', { class: 'g2 grid bi-cidr' }, h('label', null, h('span', { class: 'dim' }, 'IPv6（主力）'), ta6), h('label', null, h('span', { class: 'dim' }, 'IPv4（辅助）'), ta4)),
    h('div', { class: 'row' }, bCidr, bCidrReset));

  // 白天 / 夜晚划分
  const geoSeg = segEl([['auto', '按系统时区'], ['manual', '选择城市'], ['fixed', '固定时刻']], C().geo.mode, v => saveB({ geo: { mode: v } }), 'sm');
  const citySel = h('select', { class: 'input' }, h('option', { value: '' }, '— 选择城市 —'), CITIES.map(([n]) => h('option', { value: n }, n)));
  citySel.addEventListener('change', () => { const c = CITIES.find(x => x[0] === citySel.value); if (c) saveB({ geo: { mode: 'manual', city: c[0], lat: c[1], lon: c[2] } }); });
  const latIn = h('input', { class: 'input num mono', type: 'number', step: 0.01, min: -90, max: 90, placeholder: '纬度' });
  const lonIn = h('input', { class: 'input num mono', type: 'number', step: 0.01, min: -180, max: 180, placeholder: '经度' });
  const saveLL = () => { if (latIn.value !== '' && lonIn.value !== '') saveB({ geo: { mode: 'manual', city: '', lat: +latIn.value, lon: +lonIn.value } }); };
  latIn.addEventListener('change', saveLL); lonIn.addEventListener('change', saveLL);
  const dsIn = h('input', { class: 'input num mono', type: 'number', min: 0, max: 23, step: 0.5 });
  const deIn = h('input', { class: 'input num mono', type: 'number', min: 0, max: 23.5, step: 0.5 });
  dsIn.addEventListener('change', () => saveB({ geo: { dayStart: +dsIn.value } }));
  deIn.addEventListener('change', () => saveB({ geo: { dayEnd: +deIn.value } }));
  const rowManual = h('div', { class: 'opt' }, h('span', { class: 'grow' }, '城市 / 经纬度', tip('选一个附近的城市即可；也可以直接填经纬度。', 13)), citySel, latIn, lonIn);
  const rowFixed = h('div', { class: 'opt' }, h('span', { class: 'grow' }, '白天时段（点）'), dsIn, h('span', { class: 'dim' }, '至'), deIn);
  const geoInfo = h('div', { class: 'dim bi-geo-info' });
  const geo = h('section', { class: 'card sec' }, sec('白天 / 夜晚', 'sun', '日出到日落为白天，其余为夜晚，按系统时间自动切换。\n网络高峰（晚上）与白天的最优 IP 往往不同，所以分开排名。'),
    h('div', { class: 'opt' }, h('span', { class: 'grow' }, '划分方式'), geoSeg), rowManual, rowFixed, geoInfo);

  // 高级
  const txtOpt = (k, label, tp) => { const i = h('input', { class: 'input mono', value: C()[k] }); i.addEventListener('change', () => saveB({ [k]: i.value.trim() })); return { el: h('div', { class: 'opt col-opt' }, h('span', null, label, tp ? tip(tp, 13) : null), i), sync: () => { if (document.activeElement !== i) i.value = C()[k]; } }; };
  const swOpt = (k, label, tp) => { const sw = switchEl(!!C()[k], v => saveB({ [k]: v }), label); return { el: h('div', { class: 'opt' }, h('span', { class: 'grow' }, label, tp ? tip(tp, 13) : null), sw), sync: () => { const i = sw.querySelector('input'); if (document.activeElement !== i) i.checked = !!C()[k]; } }; };
  const urlOpt = txtOpt('speedUrl', '测速地址', '直接连接被测 IP，用这个地址的域名做 SNI 下载，在测速时长内统计峰值。\n更换测速地址后，旧地址的速度数据不再参与排名（不同模式不可比较），1 分钟后自动重测。');
  const bChk = btn('检测测速地址', 'gauge', async () => {
    const r = await rpc('bestipCheckUrl');
    if (!r.ok) throw Object.assign(new Error(`测速地址不可用（经 ${r.ip}）：${r.err}${r.ctype ? '，类型 ' + r.ctype : ''}`), { user: true });
    return `可用：经 ${r.ip} 峰值 ${mbs(r.peak)} MB/s，平均 ${mbs(r.avg)} MB/s${r.colo ? '，机房 ' + r.colo : ''}`;
  }, 'sm', m => m);
  const secOpt = numOpt('speedSec', '每个 IP 测速时长', '秒', 2, 10);
  const spdOpt = numOpt('speedTop', '每轮最多测速 IP 数', '个', 2, 20, 'TCP 延迟最低的若干个 IP 才测速（逐个测，每两次之间间隔 45~75 秒，1 小时最多 8 次 —— 测速接口是「短时间内多次大下载」才限流）。\n近 12 小时同一时段测过、延迟没变差的 IP，以及延迟已不可能进入名单的新候选，会跳过测速（沿用上次速度）。\n测速消耗流量：峰值稳定后会提前结束，单个 IP 通常不超过 100 MB。');
  const dailyOpt = numOpt('speedDaily', '每日测速上限', '次', 6, 200, '一天内最多测速多少次（含手动测试、检测测速地址），超出后当天只测延迟/丢包。\n用来避免测速接口（speed.cloudflare.com）因请求太多而限流。\n被限流（429 等）时会自动停止测速，按服务器要求的时间暂停（默认 1 小时，反复被限流时加倍，最长 12 小时）。');
  const pingOpt = numOpt('pings', '精测握手次数', '次', 3, 20, '次数越多，丢包率越准，但耗时更长。');
  const idleOpt = swOpt('idleOnly', '大流量使用时推迟测速', '自动测试时若正在大量上传/下载（>1.5 MB/s），先等待；1 分钟后仍忙则本轮只测延迟。');
  const fillOpt = swOpt('fill', '达标 IP 不足时补足', '达标的 IP 不够时，用最接近达标的可用 IP 补足名额（推荐开启）。\n关闭则只用达标 IP；一个都不达标时节点使用原地址。');
  const scopeSeg = segEl([['auto', 'Cloudflare 节点'], ['all', '全部 VLESS/Trojan']], C().scope, v => saveB({ scope: v }), 'sm');
  const adv = h('details', { class: 'card fold' },
    h('summary', null, icon('sliders', 16), h('b', null, '高级'), h('span', { class: 'grow' }), icon('chevD', 16)),
    h('div', { class: 'fold-body' },
      h('div', { class: 'opt' }, h('span', { class: 'grow' }, '适用节点', tip('默认只对 Cloudflare（edgetunnel / workers / pages）节点使用优选 IP，自动识别。', 13)), scopeSeg),
      urlOpt.el, h('div', { class: 'row', style: { padding: '2px 0 8px' } }, bChk), secOpt.el, spdOpt.el, dailyOpt.el, pingOpt.el, idleOpt.el, fillOpt.el,
      h('div', { class: 'row' }, btn('重新识别节点', 'radar', () => rpc('bestipDetect'), 'sm', '已重新识别'), btn('清除全部测试数据', 'trash', async () => { if (!(await confirmBox('清除测试数据', '清除所有 IP 的白天/夜晚成绩与结果，节点恢复使用原地址，1 分钟后重新测试。', '清除', true))) return false; await rpc('bestipClear', { what: 'all' }); return true; }, 'sm danger', r => (r ? '已清除' : '已取消')))));

  // 测试记录
  const roundsBox = h('div', { class: 'logbox' });
  const rounds = h('details', { class: 'card fold' },
    h('summary', null, icon('file', 16), h('b', null, '测试记录'), h('span', { class: 'grow' }), h('span', { class: 'dim fold-n' }), icon('chevD', 16)),
    h('div', { class: 'fold-body' }, roundsBox));

  el.append(
    head('优选 IP', '为 edgetunnel 节点自动挑选 Cloudflare 优选 IP 作为连接地址（address）。\nUUID / Host / 路径 / ProxyIP 都不变，只换连接的 IP。\n每隔几小时自动测试（延迟、丢包、峰值速度），白天、夜晚分开保留前几名，按日出日落自动切换。'),
    gate, hero, scopeNote, results,
    h('div', { class: 'g2 grid bi-ths' }, th6.el, th4.el),
    basic, cidrs, geo, adv, rounds);

  function renderGate() {
    const c = rt().core || {};
    const feats = V?.coreFeatures || [];
    const old = c.up && c.version && (verLt(c.version, '1.2.0') || (V && !feats.includes('bestip')));
    const none = !c.up && c.installed === false;
    tmp(gate, [old, none, c.version].join('|'), () => {
      gate.classList.toggle('hidden', !old && !none);
      if (!old && !none) return;
      const b = h('button', { class: 'btn primary' }, icon('download', 16), h('span', null, none ? '下载核心安装脚本' : '下载新版核心安装脚本'));
      b.addEventListener('click', () => act(b, async () => { await downloadInstaller(await platformOs() === 'win' ? 'win' : 'unix'); }, { ok: '已下载：运行后到「核心」页点「重新检测」' }));
      gate.replaceChildren(h('div', { class: 'row', style: { gap: '14px', alignItems: 'center' } },
        h('div', { class: 'ico-tile warn' }, icon('alert', 22)),
        h('div', { class: 'grow' }, h('b', null, none ? '优选 IP 需要本地核心' : `本地核心 v${c.version} 过旧，优选 IP 需要 v1.2.0`), h('div', { class: 'dim' }, '重新运行安装脚本即可（覆盖旧版，节点与设置不受影响）。')), b));
    });
  }

  function renderHero() {
    const b = B(), c = C();
    const run = b.running;
    const per = V?.period || b.period || 'day';
    const act0 = b.active;
    const caps = b.caps;
    const today = (d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`)(new Date());
    const spd = b.spd && b.spd.d === today ? b.spd : { n: 0, bytes: 0 };
    const lim = b.lim && b.lim.until > Date.now() ? b.lim : null;
    const sig = JSON.stringify([c.enabled, per, act0, caps && [caps.v4, caps.v6], !!run, V && [V.rise, V.set, V.nextSwitch, V.geoSrc, V.using?.length, V.cfNodes], b.next, b.lastRun, spd, lim, c.speedDaily]);
    tmp(hero, sig, () => {
      const title = !c.enabled ? '优选 IP 已关闭' : act0?.main?.length ? `${per === 'day' ? '白天' : '夜晚'} · 使用 ${act0.main.length} 个优选 IP` : run ? '正在进行首次测试…' : '等待首次测试';
      hero.replaceChildren(
        h('div', { class: 'ico-tile lg ' + (c.enabled ? (per === 'day' ? 'bi-day' : 'bi-night') : 'mute') }, icon(per === 'day' ? 'sun' : 'moon', 26)),
        h('div', { class: 'hero-mid' },
          h('b', { class: 'hero-title' }, title),
          h('div', { class: 'hero-sub' },
            V ? h('span', { class: 'pill', 'data-tip': '位置来源：' + V.geoSrc }, icon('sun', 11), `日出 ${hm(V.rise)} · 日落 ${hm(V.set)}`) : null,
            V && c.enabled ? h('span', { class: 'pill', 'data-tip': '到时自动切换到另一时段的最优 IP' }, icon('clock', 11), `${hm(V.nextSwitch)} 切换为${per === 'day' ? '夜晚' : '白天'}`) : null,
            caps ? h('span', { class: 'pill ' + (caps.v6 ? 'ok' : 'warn'), 'data-tip': caps.v6 ? `本机 IPv6 可用${caps.v6iface ? '：' + caps.v6iface : ''}` : `本机没有可用的 IPv6（${caps.v6err || '不可达'}），只使用 IPv4 网段` }, caps.v6 ? 'IPv6 ✓' : 'IPv6 ✗') : null,
            caps ? h('span', { class: 'pill ' + (caps.v4 ? 'ok' : 'warn') }, caps.v4 ? 'IPv4 ✓' : 'IPv4 ✗') : null,
            act0?.borrowed ? h('span', { class: 'pill warn', 'data-tip': '当前时段还没有测试数据，暂用另一时段的结果' }, '借用另一时段') : null,
            c.enabled ? h('span', { class: 'pill' + (spd.n >= c.speedDaily ? ' warn' : ''), 'data-tip': `今日已测速 ${spd.n} 次，上限 ${c.speedDaily} 次（可在「高级」调整）\n今日测速流量 ${fmtBytes(spd.bytes || 0)}` }, icon('gauge', 11), `测速 ${spd.n}/${c.speedDaily}`) : null,
            lim ? h('button', { class: 'pill warn', style: { cursor: 'pointer' }, 'data-tip': `测速接口返回限流：${lim.err || 'HTTP ' + lim.status}${lim.ra ? `（要求 ${lim.ra} 秒后再试）` : ''}\n暂停期间只测延迟/丢包，速度沿用历史数据。\n点击可提前解除（可能延长限流）。`, onclick: async () => { if (await confirmBox('解除测速暂停', '测速接口刚刚返回过限流，提前恢复测速可能导致限流时间更长。确定要解除吗？', '解除', true)) { await rpc('bestipClear', { what: 'limit' }); toast('已解除测速暂停', 'ok', 1600); } } }, icon('alert', 11), `测速暂停 · ${hm(lim.until)} 恢复`) : null),
          h('div', { class: 'dim bi-when' }, h('span', { class: 'bi-next' }), b.lastRun ? h('span', null, ` · 上次测试 ${fmtAgo(b.lastRun)}`) : null),
          prog),
        h('div', { class: 'row', style: { gap: '10px' } }, run ? bCancel : bRun, enSw));
      tickHero();
    });
    // 进度
    prog.classList.toggle('hidden', !run);
    if (run) {
      prog.querySelector('.bi-prog-t').textContent = run.text || '测试中…';
      const order = ['prep', 'caps', 'ping', 'deep', 'wait', 'speed', 'verify'];
      const base = Math.max(0, order.indexOf(run.phase)) / order.length;
      const sub = run.total ? (run.done || 0) / run.total / order.length : 0;
      prog.querySelector('i').style.width = Math.min(100, Math.round((base + sub) * 100)) + '%';
    }
    const ei = enSw.querySelector('input'); if (document.activeElement !== ei) ei.checked = !!c.enabled;
    hero.classList.toggle('off', !c.enabled);
    // 节点覆盖提示
    const n = V ? V.cfNodes : null;
    tmp(scopeNote, JSON.stringify([c.enabled, V?.eligible, n, V?.using]), () => {
      const show = c.enabled && V && (V.eligible === 0 || n === 0 || (V.using?.length || 0) > 0);
      scopeNote.classList.toggle('hidden', !show);
      if (!show) return;
      if (V.eligible === 0) scopeNote.replaceChildren(icon('info', 14), h('span', null, '还没有 VLESS / Trojan 节点。导入 edgetunnel 节点后自动生效。'));
      else if (n === 0) scopeNote.replaceChildren(icon('alert', 14), h('span', null, '没有识别到 Cloudflare 节点（edgetunnel）。如果你的节点确实在 Cloudflare 上，可在「高级 → 适用节点」改为「全部 VLESS/Trojan」。'));
      else scopeNote.replaceChildren(icon('checkCircle', 14), h('span', null, `正在为 ${V.using.length} 个节点提供优选 IP：${V.using.slice(0, 4).join('、')}${V.using.length > 4 ? ' 等' : ''}`));
    });
  }
  function tickHero() {
    const nx = hero.querySelector('.bi-next');
    if (!nx) return;
    const b = B(), c = C();
    nx.textContent = !c.enabled ? '已关闭定时测试' : b.running ? '测试进行中' : b.next ? `下次测试 ${hm(b.next)}（${until(b.next)}）` : '';
  }

  function renderTable() {
    const b = B(), c = C();
    const per = showP || V?.period || b.period || 'day';
    segSet(pSeg, per);
    const L = b.lists?.[per];
    const act0 = b.active;
    const using = act0 && act0.period === per && !act0.borrowed;
    const lsig = (LIVE?.addrs || []).map(a => { const v = liveOf(a.addr); return v && [a.addr, v.use, v.act, v.recent > 0, v.dn]; });
    const sig = JSON.stringify([per, L, showMore, using, c.th6, c.th4, lsig, !!LIVE?.live]);
    tmp(tableBox, sig, () => {
      if (!L) {
        tableBox.replaceChildren(h('div', { class: 'empty sm' }, b.lists?.[per === 'day' ? 'night' : 'day'] ? `${per === 'day' ? '白天' : '夜晚'}还没有测试数据，到该时段会自动测试（期间暂用另一时段的结果）。` : '还没有测试数据。点上方「立即测试」，或等待定时测试。'));
        tableMeta.textContent = '';
        return;
      }
      tableMeta.textContent = `更新于 ${fmtAgo(L.at)} · 达标 IPv6 ${L.q6}/${L.n6}，IPv4 ${L.q4}/${L.n4}${using ? ' · 当前正在使用' : ''} · 延迟：仅 TCP 握手 · 测速：${spKey(c.speedUrl)}`;
      const mainSet = new Set(L.main.map(x => x.ip)), bkSet = new Set(L.backup.map(x => x.ip));
      const rest = L.all.filter(x => !mainSet.has(x.ip) && !bkSet.has(x.ip));
      const rows = [...L.main.map(x => [x, 'main']), ...L.backup.map(x => [x, 'backup']), ...(showMore ? rest.map(x => [x, '']) : [])];
      const thv = f => (f === 6 ? c.th6 : c.th4);
      const cell = (v, bad, cls = '') => h('span', { class: 'mono ' + cls + (bad ? ' bi-bad' : '') }, v);
      const row = ([x, role], i) => {
        const th = thv(x.f);
        const ipBtn = h('button', { class: 'bi-ip mono', 'data-tip': '复制', onclick: async () => { if (await copyText(x.ip)) toast('已复制 ' + x.ip, 'ok', 1400); } }, x.ip);
        return h('div', { class: 'brow' + (role === 'main' ? ' main' : role === 'backup' ? ' bk' : '') },
          h('span', { class: 'dim mono' }, role ? String(i + 1) : '·'),
          h('span', { class: 'bi-ipc' }, ipBtn, h('span', { class: 'pill xs ' + (x.f === 6 ? 'accent' : '') }, x.f === 6 ? 'v6' : 'v4'), liveTag(x.ip, role)),
          cell(x.ms ? x.ms + ' ms' : '—', !x.ms || x.ms >= th.ms, msClass(x.ms)),
          cell((x.loss * 100).toFixed(0) + '%', x.loss * 100 > th.loss),
          h('span', { class: 'mono' + (th.mbs > 0 && (x.pk == null || x.pk / MBs < th.mbs) ? ' bi-bad' : ''), 'data-tip': x.av != null ? `平均 ${mbs(x.av)} MB/s` : '' }, x.pk == null ? '—' : mbs(x.pk) + ' MB/s'),
          h('span', { class: 'mono dim' }, x.colo || '—'),
          h('span', null, x.q ? h('span', { class: 'pill xs ok' }, '达标') : h('span', { class: 'pill xs warn', 'data-tip': (x.why || []).join('\n') }, '未达标')),
          h('span', null, role === 'main' ? h('span', { class: 'pill xs info' }, '主用') : role === 'backup' ? h('span', { class: 'pill xs' }, '备用') : null));
      };
      const headRow = h('div', { class: 'brow bhead' }, h('span', null, '#'), h('span', null, 'IP'), h('span', { 'data-tip': '仅测量 TCP 握手延迟（直连该 IP，不含 DNS / TLS / HTTP）。\n与概览、节点页的延迟（经节点的 HTTP 请求）是不同模式，数值不可互相比较。' }, 'TCP 延迟'), h('span', null, '丢包'), h('span', { 'data-tip': '只统计与当前测速地址相同的测速数据' }, '峰值'), h('span', null, '机房'), h('span', null, '状态'), h('span', null, ''));
      let i = 0;
      const items = rows.map(r => row(r, r[1] ? i++ : 0));
      const more = rest.length ? h('div', { class: 'more-row' }, h('button', { class: 'btn ghost sm', onclick: () => { showMore = !showMore; renderTable(); } }, showMore ? '收起候选' : `显示其他 ${rest.length} 个候选`)) : null;
      tableBox.replaceChildren(headRow, ...items, more);
    });
  }

  function liveTag(ip, role) {
    if (!LIVE?.addrs) return null;
    const x = liveOf(ip);
    if (!x) return null;
    if (x.dn) return h('span', { class: 'pill xs err', 'data-tip': liveTip(x, role) }, '熔断');
    if (!x.use) return null;
    return h('span', { class: 'pill xs ok bi-use', 'data-tip': liveTip(x, role) }, h('i', { class: 'bi-dot' }), LIVE.live ? `使用中 ${x.act}` : '使用中');
  }
  function renderLive() {
    const show = C().enabled && LIVE;
    liveBox.classList.toggle('hidden', !show);
    if (!show) return;
    const act = B().active, mainS = new Set((act?.main || []).map(normA)), bkS = new Set((act?.backup || []).map(normA));
    const roleOf = a => mainS.has(normA(a)) ? 'main' : bkS.has(normA(a)) ? 'backup' : 'alt';
    const head = h('b', { class: 'bi-live-h' }, icon('activity', 13), '正在使用');
    let body;
    if (!LIVE.on) body = [h('span', { class: 'dim' }, '未连接。连接后这里会显示此刻正在使用的优选 IP。')];
    else if (!LIVE.viaCore) body = [h('span', { class: 'dim' }, `当前节点「${LIVE.node}」由浏览器直接连接（未经本地核心），不使用优选 IP。`)];
    else if (LIVE.coreDown) body = [h('span', { class: 'dim' }, '本地核心未运行，暂时无法读取。')];
    else if (!LIVE.addrs || !LIVE.addrs.length) body = [h('span', { class: 'dim' }, `当前节点「${LIVE.node}」没有使用优选 IP（只有一个连接地址）。`)];
    else {
      const xs = LIVE.addrs.map(a => ({ a: a.addr, v: liveOf(a.addr) })).filter(o => o.v);
      const inUse = xs.filter(o => o.v.use && !o.v.dn).sort((p, q) => (q.v.act - p.v.act) || (q.v.recent - p.v.recent) || (q.v.ok - p.v.ok));
      const dn = xs.filter(o => o.v.dn).length;
      const chip = o => {
        const role = roleOf(o.a);
        return h('span', { class: 'bi-chip' + (role === 'alt' ? ' alt' : ''), 'data-tip': liveTip(o.v, role) }, h('i', { class: 'bi-dot' }),
          h('span', { class: 'mono' }, o.a),
          h('span', { class: 'dim' }, (role === 'main' ? '主用' : role === 'backup' ? '备用' : '订阅原地址') + ' · ' + (LIVE.live ? `${o.v.act} 个连接` : `近 1 分钟 ${o.v.recent} 次`)));
      };
      body = inUse.length ? inUse.slice(0, 6).map(chip) : [h('span', { class: 'dim' }, LIVE.conns ? '有连接，但都是建立较早的长连接，暂时看不到具体 IP。' : '此刻没有经过节点的连接。')];
      if (inUse.length > 6) body.push(h('span', { class: 'dim' }, `等 ${inUse.length} 个`));
      const tail = [`${LIVE.node} · 共 ${LIVE.addrs.length} 个连接地址`, dn ? `熔断 ${dn} 个` : '', LIVE.live ? '' : '（核心 1.2.2 起可显示当前连接数，现按近 1 分钟新建连接推断）'].filter(Boolean).join(' · ');
      body.push(h('div', { class: 'dim bi-live-t' }, tail));
      if (inUse.length && inUse.every(o => roleOf(o.a) === 'alt')) body.push(h('div', { class: 'bi-live-t warn-t' }, '注意：正在用订阅原地址，说明优选 IP 暂时都不可用或还没有结果。'));
    }
    const sig = JSON.stringify(body.map(e => e.textContent));
    tmp(liveBox, sig, () => liveBox.replaceChildren(head, h('div', { class: 'bi-live-b' }, ...body)));
  }

  function renderRounds() {
    const list = B().rounds || [];
    rounds.querySelector('.fold-n').textContent = list.length ? String(list.length) : '';
    tmp(roundsBox, JSON.stringify(list.map(r => r.at + ':' + r.dur)), () => {
      if (!list.length) { roundsBox.replaceChildren(h('div', { class: 'empty sm' }, '暂无记录')); return; }
      roundsBox.replaceChildren(...list.map(r => h('div', { class: 'logline ' + (r.failed ? 'warn' : '') }, icon(r.period === 'day' ? 'sun' : 'moon', 13),
        h('span', { class: 't' }, new Date(r.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })),
        h('span', { class: 'm' }, r.failed ? `${r.manual ? '手动' : '定时'}测试未完成：${r.err}` :
          `${r.manual ? '手动' : '定时'} · 抽样 ${r.sampled}，可达 ${r.reach}，测速 ${r.speed}${r.bytes ? `（${fmtBytes(r.bytes)}）` : ''}${(r.spFresh || r.spHope) ? `，免测 ${(r.spFresh || 0) + (r.spHope || 0)}` : ''}${r.verified != null ? `，经节点验证通过 ${r.verified}` : ''} · 达标 IPv6 ${r.q6 ?? 0} / IPv4 ${r.q4 ?? 0} · ${Math.round((r.dur || 0) / 1000)} 秒${r.err ? ' · ' + r.err : ''}`))));
    });
  }

  function syncInputs() {
    const c = C();
    th6.sync(); th4.sync(); perOpt.sync(); topOpt.sync(); bkOpt.sync(); urlOpt.sync(); secOpt.sync(); spdOpt.sync(); dailyOpt.sync(); pingOpt.sync(); idleOpt.sync(); fillOpt.sync();
    segSet(ivSeg, String(c.intervalH)); segSet(famSeg, c.family); segSet(geoSeg, c.geo.mode); segSet(scopeSeg, c.scope);
    rowManual.classList.toggle('hidden', c.geo.mode !== 'manual');
    rowFixed.classList.toggle('hidden', c.geo.mode !== 'fixed');
    if (document.activeElement !== citySel) citySel.value = c.geo.city || '';
    if (document.activeElement !== latIn) latIn.value = c.geo.lat ?? '';
    if (document.activeElement !== lonIn) lonIn.value = c.geo.lon ?? '';
    if (document.activeElement !== dsIn) dsIn.value = c.geo.dayStart;
    if (document.activeElement !== deIn) deIn.value = c.geo.dayEnd;
    geoInfo.textContent = V ? `今天：日出 ${hm(V.rise)}，日落 ${hm(V.set)}（${V.geoSrc}）` : '';
  }

  let lastSig = '';
  const update = () => {
    // 设置或结果变化时刷新后台快照（时段/日出日落/节点覆盖）
    const s = JSON.stringify([st().bestip, B().lastRun, B().active, B().nodeCf, S.nodes.length, (rt().core || {}).version]);
    if (s !== lastSig) { const first = !lastSig; lastSig = s; if (!first) loadView(); }
    renderGate(); renderHero(); renderLive(); renderTable(); renderRounds(); syncInputs();
  };
  loadView();
  const iv = setInterval(loadView, 60e3);
  pollLive();
  const ivLive = setInterval(pollLive, 3000);
  return { el, update, tick: tickHero, destroy: () => { clearInterval(iv); clearInterval(ivLive); } };
}

function pageProxyIp() {
  const el = h('div', { class: 'page' });
  const filt = { cc: '', status: 'all', q: '', limit: 120 };
  const summary = h('section', { class: 'card pip-sum' });
  const regions = h('div', { class: 'rcards' });
  const listBox = h('div', { class: 'plist' });
  const more = h('div', { class: 'more-row hidden' });
  const qIn = h('input', { class: 'input', placeholder: '搜索 IP / 出口 / 机房' });
  qIn.addEventListener('input', () => { filt.q = qIn.value.trim().toLowerCase(); filt.limit = 120; renderList(); });
  const sseg = segEl([['all', '全部'], ['ok', '可用'], ['home', '住宅'], ['uni', '通用'], ['untested', '未测'], ['bad', '失败'], ['risk', '高风险'], ['ban', '屏蔽']], 'all', v => { filt.status = v; filt.limit = 120; renderList(); }, 'f-seg');
  const bTest = btn('检测', 'radar', async () => {
    const keys = visible().filter(([, e]) => !e.ban).slice(0, 60).map(([k]) => k);
    if (!keys.length) throw Object.assign(new Error('当前筛选下没有可检测的 ProxyIP'), { user: true });
    return rpc('testPool', { keys });
  }, 'primary', r => `检测 ${r.tested} 个，可用 ${r.ok} 个`);
  bTest.dataset.tip = '经当前（或最佳）节点检测筛选出的 ProxyIP';
  const bUni = btn('扫描通用', 'target', () => rpc('uniScan', { limit: 60 }), '', r => `扫描 ${r.tested} 个，新发现通用 ${r.ok} 个（共 ${r.total} 个可用）`);
  bUni.dataset.tip = '寻找「通用转发」ProxyIP：能转发任意 HTTPS 网站（不只是 Cloudflare），用于「统一出口」。\n每次扫描约 60 个，结果缓存 24 小时。';
  const bPure = btn('IPPure', 'shield', () => {
    const keys = visible().filter(([, e]) => !e.ban && e.ok === true).slice(0, 40).map(([k]) => k);
    if (!keys.length) throw Object.assign(new Error('当前筛选下没有已验证可用的 ProxyIP（先点「检测」）'), { user: true });
    return rpc('pureScan', { keys, force: true });
  }, '', r => `IPPure 检测 ${r.tested} 个，成功 ${r.ok || 0} 个，高风险 ${r.risky} 个`);
  bPure.dataset.tip = '经节点用各 ProxyIP 访问 IPPure，获取它们的风险系数（基于风险库与蜜罐记录）。\n系数超过上限（默认 ≥51）的自动拉黑。每轮优选也会自动检测，结果缓存 3 天。';
  const bRefresh = ibtn('refresh', '重新解析全部来源', () => rpc('refreshPool'), '', '来源已刷新');
  const bClean = ibtn('ban', '屏蔽全部失效 IP', () => rpc('poolClear', { what: 'bad' }).then(r => toast(`已屏蔽 ${r.removed} 个`, 'ok')));
  const bExport = ibtn('download', '导出可用 IP', async () => {
    const ok = visible().filter(([, e]) => e.ok === true).map(([k, e]) => `${k}#${itemCc(e) || ''}${e.ms ? ' ' + e.ms + 'ms' : ''}`);
    if (!ok.length) throw Object.assign(new Error('没有已验证可用的 ProxyIP'), { user: true });
    downloadBlob(`proxyip-${filt.cc || 'all'}-${new Date().toISOString().slice(0, 10)}.txt`, ok.join('\n') + '\n', 'text/plain;charset=utf-8');
  });

  // 来源（不常用，默认折叠）
  const ta = h('textarea', { class: 'input', rows: 6, spellcheck: false });
  ta.value = (S.pool.sources || []).join('\n');
  let dirty = false;
  ta.addEventListener('input', () => { dirty = true; });
  const bSave = btn('保存并解析', 'check', async () => {
    const lines = ta.value.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
    const r = await rpc('setSources', { lines });
    dirty = false;
    ta.value = (S.pool.sources || []).join('\n');
    return `来源 ${r.sources} 个，共 ${r.total} 个 IP${r.invalid ? `（${r.invalid} 行无效）` : ''}`;
  }, 'primary', m => m);
  const presets = h('div', { class: 'chips' }, ...SOURCE_PRESETS.map(p => h('button', { class: 'chip sm', 'data-tip': p.lines.join('\n'), onclick: () => {
    const cur = new Set(ta.value.split(/[\r\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean));
    const add = p.lines.filter(l => !cur.has(l.toLowerCase()));
    if (!add.length) { toast('已在列表中', 'info', 1500); return; }
    ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + add.join('\n');
    dirty = true;
    toast(`已添加 ${add.length} 个来源，点「保存并解析」生效`, 'info');
  } }, icon('plus', 12), p.label)));
  const srcList = h('div', { class: 'src-list' });
  const sources = h('details', { class: 'card fold' },
    h('summary', null, icon('link', 16), h('b', null, '来源'), tip('一行一个：域名（自动解析全部 IP）/ IP:端口 / socks5:// http:// 链式出口 / API 地址。\n域名每 3 小时自动重新解析。'), h('span', { class: 'grow' }), h('span', { class: 'dim fold-n' }), icon('chevD', 16)),
    h('div', { class: 'fold-body' }, ta, presets, h('div', { class: 'row' }, bSave), srcList));

  el.append(
    head('ProxyIP', 'ProxyIP 是 edgetunnel 类节点访问 Cloudflare 托管网站时的落地出口。\n选地区 = 选这些网站看到的 IP 所在地。\n每个 IP 都经节点真实检测，不可用的自动淘汰。', bRefresh, bClean, bExport, bPure, bUni, bTest),
    summary, regions,
    h('section', { class: 'card sec' }, h('div', { class: 'toolbar' }, h('div', { class: 'search grow' }, icon('search', 15), qIn), sseg), listBox, more),
    sources);

  function visible() {
    const t = Date.now();
    return Object.entries(S.pool.items || {}).filter(([k, e]) => {
      if (filt.cc && itemCc(e) !== filt.cc) return false;
      if (filt.status === 'ban') { if (!e.ban) return false; } else if (e.ban) return false;
      if (filt.status === 'ok' && e.ok !== true) return false;
      if (filt.status === 'home' && !isHomeQ(e.q)) return false;
      if (filt.status === 'uni' && !e.uni?.ok) return false;
      if (filt.status === 'risk' && !riskyQ(e.q)) return false;
      if (filt.status === 'untested' && !(e.ok == null)) return false;
      if (filt.status === 'bad' && e.ok !== false) return false;
      if (filt.q && !`${k} ${e.exitIp || ''} ${e.colo || ''} ${e.src || ''} ${itemCc(e)}`.toLowerCase().includes(filt.q)) return false;
      return true;
    }).sort((x, y) => { const r = e => (e.ok === true ? (riskyQ(e.q) ? 2 : 0) : e.ok == null ? 1 : 3); return r(x[1]) - r(y[1]) || (x[1].ms || 9e9) - (y[1].ms || 9e9) || ((y[1].cool || 0) > t) - ((x[1].cool || 0) > t); });
  }

  function renderSummary() {
    const items = Object.values(S.pool.items || {});
    const live = items.filter(e => !e.ban && !e.gone);
    const ok = live.filter(e => e.ok === true).length, un = live.filter(e => e.ok == null).length, bad = live.filter(e => e.ok === false).length, ban = items.filter(e => e.ban).length;
    const cur = st().region || '';
    tmp(summary, [ok, un, bad, ban, cur].join('|'), () => {
      const lg = (cls, label, n) => h('div', { class: 'lgd' }, h('i', { class: cls }), h('span', null, label), h('b', { class: 'mono' }, n));
      summary.replaceChildren(
        ring([{ v: ok, cls: 'r-ok' }, { v: un, cls: 'r-idle' }, { v: bad, cls: 'r-bad' }], { size: 76, stroke: 9, label: String(ok) }),
        h('div', { class: 'legend' }, lg('l-ok', '可用', ok), lg('l-idle', '未测', un), lg('l-bad', '失败', bad), lg('l-ban', '屏蔽', ban)),
        h('div', { class: 'grow' }),
        h('div', { class: 'cur-region' }, h('small', { class: 'dim' }, '出口地区', tip('连接时优先使用该地区的 ProxyIP；没有可用 IP 时临时用最快线路（连通性优先）。', 12)),
          h('div', { class: 'cr-v' }, cur ? h('span', { class: 'flag' }, flag(cur)) : icon('zap', 18), h('b', null, cur ? ccName(cur) : '最快')),
          cur ? h('button', { class: 'btn xs ghost', onclick: () => rpc('setRegion', { cc: '' }).then(() => toast('已改为自动最快', 'ok', 1500)).catch(err) }, icon('x', 12), '取消') : null));
    });
  }

  function renderRegions() {
    const regs = {};
    for (const e of Object.values(S.pool.items || {})) { if (e.ban || e.gone) continue; const cc = itemCc(e) || '??'; regs[cc] ||= { ok: 0, total: 0, best: 0 }; regs[cc].total++; if (e.ok === true) { regs[cc].ok++; if (!regs[cc].best || e.ms < regs[cc].best) regs[cc].best = e.ms; } }
    const list = Object.entries(regs).sort((x, y) => (y[1].ok > 0) - (x[1].ok > 0) || ccSort(x[0], y[0]));
    const cur = st().region || '';
    tmp(regions, JSON.stringify([list, filt.cc, cur]), () => {
      regions.replaceChildren(
        h('button', { class: 'rcard' + (!filt.cc ? ' on' : ''), onclick: () => { filt.cc = ''; filt.limit = 120; renderRegions(); renderList(); } }, h('span', { class: 'rc-flag' }, icon('grid', 20)), h('b', null, '全部'), h('small', { class: 'dim' }, `${list.reduce((a, x) => a + x[1].ok, 0)} 可用`)),
        ...list.slice(0, 40).map(([cc, v]) => h('button', { class: 'rcard' + (filt.cc === cc ? ' on' : '') + (!v.ok ? ' empty' : ''), onclick: () => { filt.cc = cc === '??' ? '' : cc; filt.limit = 120; renderRegions(); renderList(); } },
          cc !== '??' ? h('span', { class: 'rc-pin' + (cur === cc ? ' set' : ''), 'data-tip': cur === cc ? '当前出口地区' : '设为出口地区', onclick: e => { e.stopPropagation(); rpc('setRegion', { cc: cur === cc ? '' : cc }).then(() => toast(cur === cc ? '已改为自动最快' : `出口地区：${flag(cc)} ${ccName(cc)}`, 'ok', 1600)).catch(err); } }, icon('target', 13)) : null,
          h('span', { class: 'rc-flag flag' }, cc === '??' ? '🏳️' : flag(cc)),
          h('b', { class: 'ellipsis' }, cc === '??' ? '未知' : ccName(cc)),
          h('small', { class: 'dim mono' }, `${v.ok}/${v.total}`, v.best ? ` · ${v.best}ms` : ''),
          h('div', { class: 'latbar q-good' }, h('i', { style: { width: Math.round((v.ok / Math.max(1, v.total)) * 100) + '%' } })))));
    });
  }

  function renderList() {
    const list = visible();
    const a = rt().active;
    const live = statusOf() === 'on';
    const t = Date.now();
    const sig = JSON.stringify([filt, list.length, list.slice(0, filt.limit).map(([k, e]) => [k, e.ok, e.ms, e.ban, e.cool > t, e.at, e.q?.purity, e.q?.type, e.mbps, e.uni?.ok, e.q?.fraud, e.q?.chal]), a?.pip, live, st().pipQuality?.maxRisk]);
    if (listBox.dataset.sig === sig) return;
    listBox.dataset.sig = sig;
    if (!list.length) { listBox.replaceChildren(h('div', { class: 'empty' }, icon('pin', 26), Object.keys(S.pool.items || {}).length ? '没有匹配的 ProxyIP' : 'ProxyIP 池为空，展开下方「来源」添加')); more.classList.add('hidden'); return; }
    listBox.replaceChildren(...list.slice(0, filt.limit).map(([k, e]) => {
      const cc = itemCc(e);
      const isCur = a?.viaCore && a.pip === k && live;
      const cool = (e.cool || 0) > t;
      const use = h('button', { class: 'btn xs ' + (isCur ? 'on-use' : '') }, isCur ? '使用中' : '使用');
      use.disabled = isCur || e.ban;
      use.addEventListener('click', () => act(use, async () => {
        let nodeId = a?.viaCore ? a.nodeId : '';
        if (!nodeId) { const c = S.nodes.filter(n => needsCoreNode(n) && n.enabled !== false && !n.unsupported).sort((x, y) => (nodeStat(x)?.ok ? nodeStat(x).ms : 9e9) - (nodeStat(y)?.ok ? nodeStat(y).ms : 9e9)); nodeId = c[0]?.id; }
        if (!nodeId) throw Object.assign(new Error('ProxyIP 需要配合 VLESS / Trojan 节点使用'), { user: true });
        return rpc('selectRoute', { nodeId, pip: k });
      }, { ok: '已切换 ProxyIP' }));
      return h('div', { class: 'prow' + (isCur ? ' cur' : '') },
        h('span', { class: 'flag pr-flag', 'data-tip': cc ? ccName(cc) + (e.cc ? '（实测）' : '（来源提示）') : '未知' }, cc ? flag(cc) : '🏳️'),
        h('span', { class: 'mono pr-ip ellipsis' }, shortPip(k), e.chain ? h('span', { class: 'pill xs info' }, '链式') : null, e.uni?.ok ? h('span', { class: 'pill xs ok', 'data-tip': `通用转发：任意 HTTPS 网站都从 ${e.uni.ip || '它'} 出去${e.uni.http ? '（含 HTTP 80 端口）' : '（仅 HTTPS）'}` }, '通用') : null),
        h('span', { class: 'mono dim pr-exit ellipsis', 'data-tip': e.colo ? '机房 ' + e.colo : null }, e.exitIp || '—'),
        h('span', { class: 'pr-q' }, qPill(e)),
        h('span', { class: 'pr-lat' }, e.ok === true ? h('b', { class: 'lat ' + msClass(e.ms) }, e.ms + 'ms') : null),
        h('span', { class: 'pr-st' }, e.ban ? h('span', { class: 'pill xs warn' }, '屏蔽') : riskyQ(e.q) ? h('span', { class: 'pill xs err', 'data-tip': 'IPPure 风险过高，已自动拉黑（3 天后重新检测）' }, '拉黑') : cool ? h('span', { class: 'pill xs warn', 'data-tip': e.err || '' }, '冷却') : e.ok === true ? h('span', { class: 'pill xs ok', 'data-tip': e.succ != null ? `成功率 ${Math.round(e.succ * 100)}%` : '' }, '可用') : e.ok === false ? h('span', { class: 'pill xs err', 'data-tip': e.err || '' }, '失败') : h('span', { class: 'pill xs' }, '未测')),
        h('span', { class: 'pr-acts' }, use, ibtn(e.ban ? 'undo' : 'ban', e.ban ? '恢复' : '屏蔽', () => rpc('poolBan', { keys: [k], ban: !e.ban }), 'xs')));
    }));
    if (list.length > filt.limit) { more.classList.remove('hidden'); more.replaceChildren(h('button', { class: 'btn sm', onclick: () => { filt.limit += 300; renderList(); } }, `显示更多（${list.length - filt.limit}）`)); }
    else more.classList.add('hidden');
  }

  function renderSrc() {
    const src = S.pool.src || {};
    const lines = S.pool.sources || [];
    if (!dirty && document.activeElement !== ta) ta.value = lines.join('\n');
    sources.querySelector('.fold-n').textContent = lines.length + ' 个';
    tmp(srcList, JSON.stringify([lines, src]), () => srcList.replaceChildren(...lines.map(l => {
      const p = parsePoolLine(l);
      const x = src[p?.line || l] || {};
      return h('div', { class: 'src' },
        h('span', { class: 'pill xs' }, { domain: '域名', ip: 'IP', chain: '链式', api: 'API' }[p?.type] || '?'),
        p?.hint ? h('span', { class: 'flag' }, flag(p.hint)) : null,
        h('span', { class: 'mono ellipsis grow', 'data-tip': l.length > 50 ? l : null }, l),
        h('span', { class: 'mono dim' }, x.n ?? '—'),
        x.err ? h('span', { class: 'pill xs err', 'data-tip': x.err }, '失败') : x.at ? h('span', { class: 'sdot ok', 'data-tip': '解析于 ' + fmtAgo(x.at) }) : h('span', { class: 'sdot', 'data-tip': '待解析' }));
    })));
  }

  return { el, update: () => { renderSummary(); renderRegions(); renderList(); renderSrc(); } };
}

// ───────────── 分流 ─────────────
function pageRules() {
  const el = h('div', { class: 'page' });
  const scopeBox = h('div', { class: 'scope-cards' });
  const editor = (key, title, ic, cls, tipText) => {
    const chips = h('div', { class: 'dchips' });
    const input = h('input', { class: 'input', placeholder: '输入域名，回车添加（如 example.com）' });
    const add = async () => {
      const vals = input.value.split(/[\s,，]+/).map(normDomain).filter(Boolean);
      if (!vals.length) return;
      const list = [...new Set([...(st()[key] || []), ...vals])];
      await save({ [key]: list }).catch(err);
      input.value = '';
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    const box = h('section', { class: 'card sec dlist ' + cls }, sec(title, ic, tipText, h('span', { class: 'pill xs dl-n' })), h('div', { class: 'row' }, input, h('button', { class: 'btn', onclick: add }, icon('plus', 15))), chips);
    const render = () => {
      const list = st()[key] || [];
      box.querySelector('.dl-n').textContent = list.length;
      tmp(chips, list.join(','), () => chips.replaceChildren(...(list.length ? list.map(d => h('span', { class: 'dchip' }, h('span', { class: 'mono' }, d), h('button', { class: 'x', 'aria-label': '移除', onclick: () => save({ [key]: (st()[key] || []).filter(x => x !== d) }).catch(err) }, icon('x', 12)))) : [h('div', { class: 'empty sm' }, '暂无')])));
    };
    return { el: box, render };
  };
  const direct = editor('directList', '始终直连', 'globe', 'd-direct', '这些网站永远不走代理（如国内网站、内网服务）。\n局域网地址默认直连。');
  const proxy = editor('proxyList', '始终代理', 'shield', 'd-proxy', '这些网站永远走代理。\n「名单」模式下只有它们走代理。');
  el.append(head('分流', '决定哪些网站走代理。\n弹窗底部可一键为当前网站设置规则。'), scopeBox, h('div', { class: 'grid g2' }, direct.el, proxy.el));
  const update = () => {
    const sc = st().scope || 'global';
    tmp(scopeBox, sc, () => scopeBox.replaceChildren(...[['global', 'globe', '全局', '全部网站走代理', '除「始终直连」与局域网外，所有网站都走代理。'], ['rules', 'list', '名单', '仅名单走代理', '只有「始终代理」里的网站走代理，其余直连。']].map(([v, ic, t, d, tp]) =>
      h('button', { class: 'scope-card card' + (sc === v ? ' on' : ''), onclick: () => save({ scope: v }).catch(err) },
        h('div', { class: 'ico-tile ' + (sc === v ? '' : 'mute') }, icon(ic, 22)),
        h('div', { class: 'grow' }, h('b', null, t), h('small', { class: 'dim' }, d)),
        tip(tp), h('span', { class: 'radio' + (sc === v ? ' on' : '') })))));
    direct.render(); proxy.render();
  };
  return { el, update };
}

// ───────────── 设置 ─────────────
function pageSettings() {
  const el = h('div', { class: 'page' });
  const tog = (key, ic, title, tipText, warn = false) => {
    const sw = switchEl(!!st()[key], v => save({ [key]: v }).then(() => toast(`${title}：${v ? '开' : '关'}`, 'ok', 1300)).catch(err), title);
    const card = h('div', { class: 'tcard card' + (warn ? ' warn' : '') }, h('div', { class: 'ico-tile soft' }, icon(ic, 18)), h('div', { class: 'grow tc-t' }, h('b', null, title)), tip(tipText), sw);
    return { el: card, sync: () => { const i = sw.querySelector('input'); if (document.activeElement !== i) i.checked = !!st()[key]; card.classList.toggle('on', !!st()[key]); } };
  };
  // 嵌套设置（如 uniform.enabled）的开关
  const togSub = (sub, key, ic, title, tipText, warn = false) => {
    const get = () => !!st()[sub]?.[key];
    const sw = switchEl(get(), v => save({ [sub]: { [key]: v } }).then(() => toast(`${title}：${v ? '开' : '关'}`, 'ok', 1300)).catch(err), title);
    const card = h('div', { class: 'tcard card' + (warn ? ' warn' : '') }, h('div', { class: 'ico-tile soft' }, icon(ic, 18)), h('div', { class: 'grow tc-t' }, h('b', null, title)), tip(tipText), sw);
    return { el: card, sync: () => { const i = sw.querySelector('input'); if (document.activeElement !== i) i.checked = get(); card.classList.toggle('on', get()); } };
  };
  const toggles = [
    tog('autoStart', 'power', '启动自动连接', '打开浏览器时自动连接最佳线路。\n关闭后：每次启动都保持断开。'),
    tog('autoSwitch', 'sparkles', '自动换更优线路', '后台定期复测，发现明显更快的线路时无感切换。'),
    tog('autoRotate429', 'rotate', '限流自动换 IP', 'Cloudflare 网站返回 429（请求过多）时，自动换一个出口 IP。'),
    togSub('uniform', 'enabled', 'target', '统一出口', '让所有网站（Cloudflare 与非 Cloudflare）都看到同一个出口 IP。\n原理：只使用「通用转发」型 ProxyIP，核心把 HTTPS 连接都交给它按域名转发。\n限制：这类 ProxyIP 很少（约 5%），速度受它限制；非 443 端口 / 直接访问 IP 的连接无法统一。\n开启后会自动扫描并只在这些 IP 中选线。'),
    tog('notify', 'bell', '桌面通知', '线路降级、恢复等关键事件弹出系统通知。'),
    tog('badge', 'eye', '网页悬浮胶囊', '在网页右下角显示一个小胶囊：出口国旗、延迟，可一键换 IP。'),
  ];
  const safety = [
    tog('webrtc', 'shield', '阻止 WebRTC 泄露', '连接时禁止 WebRTC 暴露真实 IP。'),
    tog('directFallback', 'globe', '直连兜底', '某个连接的所有线路都失败时，改为直连发出（连通性第一）。\n代价：网站会看到你的真实 IP（AI 类网站可能因此风控），被墙的网站直连也打不开，并会破坏「统一出口」。\n建议保持关闭。'),
    togSub('uniform', 'strict', 'shield', '严格统一出口', '统一出口开启时：无法统一的连接（非 443 端口、直接访问 IP）直接拒绝（这类少数网站会打不开），保证网站只可能看到一个 IP。\n关闭时这些少量连接仍经节点发出，出口为 Worker IP。'),
    tog('strict', 'lock', '严格防泄漏', '任何情况下都不直连：线路异常时宁可断网也不暴露真实 IP。\n开启后「直连兜底」不再生效。', true),
  ];
  const all = [...toggles, ...safety];
  const theme = segEl([['auto', '自动', 'monitor'], ['dark', '深色', 'moon'], ['light', '浅色', 'sun']], st().theme || 'auto', v => save({ theme: v }).catch(err), 'lg');

  const num = (key, label, unit, min, max, tipText, sub) => {
    const cur = sub ? st()[sub]?.[key] : st()[key];
    const i = h('input', { class: 'input num mono', type: 'number', min, max, value: cur ?? '' });
    i.addEventListener('change', () => save(sub ? { [sub]: { [key]: +i.value } } : { [key]: +i.value }).then(() => toast('已保存', 'ok', 1200)).catch(err));
    return h('div', { class: 'opt' }, h('span', { class: 'grow' }, label, tipText ? tip(tipText, 13) : null), i, h('span', { class: 'dim unit' }, unit));
  };
  const txt = (key, label, tipText) => {
    const i = h('input', { class: 'input mono', value: st().test?.[key] || '' });
    i.addEventListener('change', () => save({ test: { [key]: i.value.trim() } }).then(() => toast('已保存', 'ok', 1200)).catch(err));
    return h('div', { class: 'opt col-opt' }, h('span', null, label, tipText ? tip(tipText, 13) : null), i);
  };
  const cfScan = switchEl(!!st().cfScan, v => save({ cfScan: v }).catch(err), 'Cloudflare 优选扫描');
  const qSel = h('select', { class: 'input' }, ...[['residential', '住宅纯净优先'], ['clean', '纯净优先（不限类型）'], ['off', '不参与选线（只显示）']].map(([v, t]) => h('option', { value: v, selected: (st().pipQuality?.prefer || 'residential') === v }, t)));
  qSel.addEventListener('change', () => save({ pipQuality: { prefer: qSel.value } }).then(() => toast('已保存，下次优选生效', 'ok', 1500)).catch(err));
  const qPrefSel = h('div', { class: 'opt' }, h('span', { class: 'grow' }, 'ProxyIP 质量偏好', tip('每轮优选时检测 ProxyIP 是住宅还是机房、纯净度多少（ip-api + proxycheck，结果缓存 7 天）。\n住宅纯净优先：住宅 / 移动 / 运营商线路且纯净、速度达标的 IP 优先，其次纯净的，最后才是机房。\n注意：只影响 Cloudflare 托管网站看到的 IP；其他网站看到的是 Worker 出口。', 13)), qSel);
  const qKeyIn = h('input', { class: 'input mono', type: 'password', placeholder: '选填', value: st().pipQuality?.pcKey || '' });
  qKeyIn.addEventListener('change', () => save({ pipQuality: { pcKey: qKeyIn.value.trim() } }).then(() => toast('已保存', 'ok', 1200)).catch(err));
  const qKey = h('div', { class: 'opt col-opt' }, h('span', null, 'proxycheck.io Key', tip('不填也能用（约 100 次/天，且公共 ProxyIP 的额度可能已被他人用完）。\n免费注册 proxycheck.io 可得 1000 次/天的 key。查不到时自动只用 ip-api 判断。', 13)), qKeyIn);
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try { const data = JSON.parse(await f.text()); const r = await rpc('importConfig', { data }); toast(`已导入：节点 ${r.nodesAdded}，订阅 ${r.subsAdded}`, 'ok'); } catch (e) { err(e); }
    fileIn.value = '';
  });
  el.append(
    head('设置', null),
    h('div', { class: 'group-cap' }, icon('star', 14), '常用'),
    h('div', { class: 'tgrid' }, toggles.map(t => t.el)),
    h('div', { class: 'group-cap' }, icon('shieldCheck', 14), '安全'),
    h('div', { class: 'tgrid' }, safety.map(t => t.el)),
    h('div', { class: 'group-cap' }, icon('palette', 14), '外观'),
    h('div', { class: 'tcard card theme-card' }, h('div', { class: 'ico-tile soft' }, icon('palette', 18)), h('div', { class: 'grow tc-t' }, h('b', null, '主题')), theme),
    h('details', { class: 'card fold' },
      h('summary', null, icon('sliders', 16), h('b', null, '高级参数'), tip('一般无需修改；默认值已兼顾连通性与资源占用。'), h('span', { class: 'grow' }), icon('chevD', 16)),
      h('div', { class: 'fold-body' },
        num('healthSec', '健康检查间隔', '秒', 30, 300, '每隔多久验证一次当前线路。'),
        num('optimizeMin', '后台复测间隔', '分钟', 5, 240, '每隔多久在后台复测全部线路，为自动切换做准备。'),
        num('subsHours', '订阅自动更新', '小时', 1, 168),
        num('pipPerTest', '每轮测试 ProxyIP', '个', 3, 24, '每轮优选测试的 ProxyIP 数量，越多越准但越慢。'),
        qPrefSel,
        num('minPurity', '纯净度门槛', '分', 0, 100, '纯净度不低于此值才算「纯净」，享受优先。\n有 IPPure 结果时：纯净度 = 100 − IPPure 系数；否则 = 100 − proxycheck 风险分，再扣代理 / 机房标记。', 'pipQuality'),
        num('maxRisk', 'IPPure 风险上限', '%', 0, 100, 'IPPure 系数超过此值（或查询被 Cloudflare 拦截）的 ProxyIP 自动拉黑不用。\n默认 50：中度（51–70）与高度（71–100）风险都拉黑。填 100 = 不拉黑。\n所有可用 IP 都超过上限时，临时使用风险最低的（连通性优先）。', 'pipQuality'),
        num('minMbps', '优先 IP 最低速度', 'Mbps', 0, 1000, '住宅纯净 IP 实测速度（经它访问 Cloudflare 网站）低于此值时不再优先，避免为了「干净」牺牲太多速度。', 'pipQuality'),
        qKey,
        num('speedSeconds', '测速时长', '秒', 3, 10, '', 'test'),
        h('div', { class: 'opt' }, h('span', { class: 'grow' }, 'Cloudflare 优选 IP 扫描', tip('节点地址被墙或很慢时，自动为 TLS 节点扫描可用的 Cloudflare IP。', 13)), cfScan),
        txt('latencyUrl', '延迟测试地址', '返回 204 的轻量地址，用于测试节点延迟。'),
        txt('cfUrl', 'ProxyIP 检测地址', 'Cloudflare 托管的 /cdn-cgi/trace，用于验证 ProxyIP 并获取出口。'),
        txt('speedUrl', '测速下载地址'))),
    h('div', { class: 'group-cap' }, icon('box', 14), '备份'),
    h('div', { class: 'card sec backup' },
      btn('导出配置', 'download', async () => { const d = await rpc('exportConfig'); downloadBlob(`brana-vpn-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(d, null, 2), 'application/json'); }),
      h('button', { class: 'btn', onclick: () => fileIn.click() }, icon('upload', 15), h('span', null, '导入配置')), fileIn,
      btn('清空测速数据', 'refresh', () => rpc('resetStats'), '', '已清空'),
      tip('导出的配置包含节点密钥（UUID / 密码），请妥善保管。'),
      h('span', { class: 'grow' }),
      (() => { const b = h('button', { class: 'btn danger' }, icon('trash', 15), h('span', null, '恢复出厂')); b.addEventListener('click', async () => { if (await confirmBox('恢复出厂设置', '清空全部节点、订阅、ProxyIP 与设置？此操作不可撤销。', '全部清空', true)) { await rpc('resetAll'); toast('已恢复出厂设置', 'ok'); setTimeout(() => location.reload(), 600); } }); return b; })()));
  const update = () => {
    all.forEach(t => t.sync());
    segSet(theme, st().theme || 'auto');
    safety[1].el.classList.toggle('muted-card', !!st().strict);
    const ci = cfScan.querySelector('input'); if (document.activeElement !== ci) ci.checked = !!st().cfScan;
  };
  return { el, update };
}

// ───────────── 核心 ─────────────
function pageCore() {
  const el = h('div', { class: 'page' });
  const hero = h('section', { class: 'card core-hero' });
  const cs = coreSetup({ getCore: () => rt().core });
  const installCard = h('section', { class: 'card sec core-install' }, sec('一键安装', 'download', '安装后由浏览器自动启动、自动退出，无需常驻窗口。\n仅当前用户，无需管理员。'), cs.el);
  const reinstall = h('details', { class: 'card fold' },
    h('summary', null, icon('download', 16), h('b', null, '重新安装 / 更新核心'), tip('扩展升级后如提示核心版本过旧，可在此重新安装。'), h('span', { class: 'grow' }), icon('chevD', 16)),
    h('div', { class: 'fold-body' }));
  const logBox = h('div', { class: 'logbox' }, h('div', { class: 'empty sm' }, '核心运行后可查看日志'));
  const portIn = h('input', { class: 'input num mono', type: 'number', min: 1024, max: 65535, value: st().core?.port || 17890 });
  portIn.addEventListener('change', () => save({ core: { port: +portIn.value } }).then(() => toast('已保存，重新连接后生效', 'ok')).catch(err));
  const nativeSw = switchEl(st().core?.native !== false, v => save({ core: { native: v } }).then(() => toast('已保存', 'ok', 1200)).catch(err), '自动托管');
  const loadLogs = async () => {
    try {
      const logs = await rpc('coreLogs');
      if (!logs?.length) { logBox.replaceChildren(h('div', { class: 'empty sm' }, rt().core?.up ? '暂无日志' : '核心运行后可查看日志')); return; }
      logBox.replaceChildren(...logs.slice().reverse().map(l => h('div', { class: 'logline ' + l.lv }, h('span', { class: 't' }, new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })), h('span', { class: 'm' }, l.msg))));
    } catch {}
  };
  const bRe = btn('重新检测', 'refresh', async () => { const c = await rpc('coreCheck', { force: true }); toast(c.up ? `核心已连接（${c.via === 'native' ? '自动托管' : '手动运行'}）` : (c.installed === false ? '未检测到核心' : c.err || '核心未运行'), c.up ? 'ok' : 'warn'); });
  bRe.dataset.tip = '重启并重新连接核心（会短暂中断经核心的连接）';
  el.append(
    head('本地核心', 'Chrome 的代理接口只支持 HTTP / HTTPS / SOCKS，无法直接使用 VLESS / Trojan。\n本地核心在 127.0.0.1 提供一个代理端口，把流量经 VLESS / Trojan 送到节点。\n只监听本机，外部无法访问。', bRe),
    hero, installCard, reinstall,
    h('details', { class: 'card fold' },
      h('summary', null, icon('sliders', 16), h('b', null, '核心设置'), h('span', { class: 'grow' }), icon('chevD', 16)),
      h('div', { class: 'fold-body' },
        h('div', { class: 'opt' }, h('span', { class: 'grow' }, '本地端口', tip('核心监听 127.0.0.1 的端口；被占用时自动顺延。', 13)), portIn),
        h('div', { class: 'opt' }, h('span', { class: 'grow' }, '自动托管（Native Messaging）', tip('由浏览器自动启动核心；关闭后需手动运行 core 文件夹里的 start-core 脚本。', 13)), nativeSw),
        h('div', { class: 'opt' }, h('span', { class: 'grow' }, '扩展 ID', tip('安装脚本已内置此 ID。', 13)), h('span', { class: 'mono dim' }, EXT_ID)))),
    h('details', { class: 'card fold', ontoggle: e => { if (e.target.open) loadLogs(); } },
      h('summary', null, icon('terminal', 16), h('b', null, '核心日志'), h('span', { class: 'grow' }), icon('chevD', 16)),
      h('div', { class: 'fold-body' }, h('div', { class: 'row' }, btn('刷新', 'refresh', loadLogs, 'sm')), logBox)));
  let reCs = null;
  const update = () => {
    const c = rt().core || {};
    const need = coreNeeded();
    const state = c.up ? 'ok' : c.installed === false ? (need ? 'err' : 'mute') : 'warn';
    tmp(hero, [state, c.version, c.via, c.port, c.err].join('|'), () => hero.replaceChildren(
      h('div', { class: 'ico-tile lg ' + state + (c.up ? '' : '') }, icon(c.up ? 'cpu' : c.installed === false ? 'download' : 'cpu', 28)),
      h('div', { class: 'grow' },
        h('b', { class: 'ch-title' }, c.up ? '运行中' : c.installed === false ? '未安装' : '待命'),
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginTop: '6px' } },
          c.up ? h('span', { class: 'pill ok' }, c.via === 'native' ? '自动托管' : '手动运行') : null,
          c.version ? h('span', { class: 'pill' }, 'v' + c.version) : null,
          c.up && c.version && verLt(c.version, CORE_LATEST) ? h('span', { class: 'pill warn', 'data-tip': `核心有新版本 v${CORE_LATEST}（不更新也能正常使用）。\n展开下方「重新安装 / 更新核心」即可更新。` }, icon('download', 11), '可更新') : null,
          c.port ? h('span', { class: 'pill mono' }, '127.0.0.1:' + c.port) : null,
          !c.up && !need ? h('span', { class: 'pill' }, '当前节点无需核心') : null,
          !c.up && c.installed !== false ? h('span', { class: 'pill', 'data-tip': '连接时由浏览器自动启动' }, '连接时自动启动') : null,
          !c.up && c.err && c.installed !== false ? h('span', { class: 'pill warn', 'data-tip': c.err }, icon('alert', 11), '上次错误') : null))));
    installCard.classList.toggle('hidden', !!c.up || c.installed !== false);
    reinstall.classList.toggle('hidden', !c.up && c.installed === false);
    if (!reCs && !reinstall.classList.contains('hidden')) {
      reCs = { el: h('div', { class: 'cs' }, h('div', { class: 'cs-cta' }, (() => { const b = h('button', { class: 'btn' }, icon('download', 16), h('span', null, '下载安装脚本')); b.addEventListener('click', () => act(b, async () => { await downloadInstaller(await platformOs() === 'win' ? 'win' : 'unix'); }, { ok: '已下载，运行后点「重新检测」' })); return b; })(), tip('重新运行安装脚本会覆盖旧版核心，不影响节点与设置。'))) };
      reinstall.querySelector('.fold-body').append(reCs.el);
    }
    cs.update();
  };
  return { el, update, destroy: cs.destroy };
}

// ───────────── 日志 ─────────────
function pageLogs() {
  const el = h('div', { class: 'page' });
  const box = h('div', { class: 'logbox big' });
  let lv = 'all';
  const seg = segEl([['all', '全部', 'list'], ['warn', '警告', 'alert'], ['error', '错误', 'xCircle']], 'all', v => { lv = v; update(); });
  el.append(head('日志', '连接、切换、容灾、订阅更新等事件（最近 300 条）。', seg,
    ibtn('download', '导出日志', async () => downloadBlob(`brana-vpn-log-${new Date().toISOString().slice(0, 10)}.txt`, (S.logs || []).map(l => `${new Date(l.t).toLocaleString('zh-CN', { hour12: false })} [${l.lv}] ${l.msg}`).join('\n'), 'text/plain;charset=utf-8')),
    ibtn('trash', '清空日志', () => rpc('clearLogs'), '', '已清空')),
  h('section', { class: 'card sec' }, box));
  const LV = { info: 'info', warn: 'alert', error: 'xCircle' };
  const update = () => {
    const logs = (S.logs || []).filter(l => lv === 'all' || (lv === 'warn' ? l.lv !== 'info' : l.lv === 'error')).slice().reverse();
    tmp(box, lv + logs.length + (logs[0]?.t || ''), () => {
      if (!logs.length) { box.replaceChildren(h('div', { class: 'empty' }, icon('file', 26), '暂无日志')); return; }
      box.replaceChildren(...logs.map(l => h('div', { class: 'logline ' + l.lv }, icon(LV[l.lv] || 'info', 13), h('span', { class: 't' }, new Date(l.t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })), h('span', { class: 'm' }, l.msg))));
    });
  };
  return { el, update };
}

// ───────────── 帮助 ─────────────
function pageHelp() {
  const el = h('div', { class: 'page' });
  const faq = (q, a) => h('details', { class: 'faq' }, h('summary', null, icon('chevR', 14), q), h('p', null, a));
  const f = (ic, t, d) => h('div', { class: 'f', 'data-tip': d }, h('div', { class: 'ico-tile soft' }, icon(ic, 20)), h('b', null, t));
  const arrow = () => h('div', { class: 'arrow' }, icon('arrowR', 16));
  el.append(
    head('帮助', null, h('a', { class: 'btn primary', href: chrome.runtime.getURL('setup/setup.html') }, icon('wand', 15), h('span', null, '设置向导'))),
    h('section', { class: 'card sec' }, sec('工作原理', 'route', '普通网站由节点（Cloudflare Worker）直接访问；\nCloudflare 托管的网站由于平台限制需经 ProxyIP 中转，因此会看到两个出口。'),
      h('div', { class: 'flow' }, f('browser', '浏览器', '只代理 Chrome 的流量'), arrow(), f('cpu', '本地核心', '127.0.0.1 · 失败无感重试'), arrow(), f('server', '节点', 'VLESS / Trojan · WS + TLS'), arrow(), f('pin', 'ProxyIP', 'Cloudflare 网站的落地出口'), arrow(), f('globe', '网站', '看到出口 IP'))),
    h('section', { class: 'card sec' }, sec('智能优选', 'shieldCheck', null),
      h('div', { class: 'pillars' },
        h('div', { class: 'pillar', 'data-tip': '线路必须真实打通（握手 + 访问测试地址）并经浏览器复验才会被采用。' }, h('div', { class: 'ico-tile ok' }, icon('plug', 18)), h('b', null, '① 连通性'), h('small', { class: 'dim' }, '第一标准')),
        h('div', { class: 'pillar', 'data-tip': '冷启动（含握手）与热延迟（纯往返）综合打分。' }, h('div', { class: 'ico-tile' }, icon('activity', 18)), h('b', null, '② 延迟'), h('small', { class: 'dim' }, '冷 + 热')),
        h('div', { class: 'pillar', 'data-tip': '前 3 名实测下载速度；历史成功率按衰减计入。' }, h('div', { class: 'ico-tile' }, icon('gauge', 18)), h('b', null, '③ 速度'), h('small', { class: 'dim' }, '与稳定性')),
        h('div', { class: 'pillar', 'data-tip': '① 核心内首字节前失败无感重试；② 连续失败自动熔断；③ 健康检查失败自动切换；全部不可用时直连兜底。' }, h('div', { class: 'ico-tile warn' }, icon('shield', 18)), h('b', null, '三层容灾'), h('small', { class: 'dim' }, '自动切换')))),
    h('section', { class: 'card sec' }, sec('常见问题', 'help', null),
      faq('浏览器关闭后，下次打开会自动连接吗？', '会。默认开启「启动自动连接」：打开浏览器即自动连上次的最佳线路，本地核心也随之自动启动。可在「设置 › 常用」关闭，关闭后每次启动都保持断开。'),
      faq('为什么 VLESS / Trojan 需要本地核心？', 'Chrome 扩展只能把流量交给 HTTP / SOCKS 代理，无法在浏览器内实现 VLESS / Trojan。核心只监听本机 127.0.0.1，由浏览器自动启动、随浏览器退出。'),
      faq('安装脚本被浏览器或系统拦截？', 'Chrome 提示「可能有害」时点「保留」；Windows 提示「无法验证发布者」点「运行」，提示「已保护你的电脑」点「更多信息 → 仍要运行」。也可直接双击扩展文件夹 core 里的 install-windows.cmd。'),
      faq('支持哪些节点？', '✅ VLESS / Trojan + WebSocket（TLS 或明文，如 edgetunnel）；✅ HTTP / HTTPS / SOCKS5（含账号密码）；❌ 暂不支持 VMess、Shadowsocks、Hysteria、TUIC 等。'),
      faq('会影响电脑上的其他软件吗？', '不会。只修改 Chrome 自己的代理设置；断开或停用扩展后立即恢复。'),
      faq('「直连兜底」和「严格防泄漏」怎么选？', '默认开启直连兜底：线路全不可用时临时直连，保证能上网。更在意隐私可开启严格防泄漏：宁可断网也不直连。'),
      faq('与 SwitchyOmega 等代理扩展冲突？', 'Chrome 同时只允许一个扩展控制代理。检测到冲突会提示你停用另一个扩展。')),
    h('section', { class: 'card sec about' }, h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, h('span', { class: 'pill accent' }, 'v' + VERSION), h('span', { class: 'pill mono', 'data-tip': '扩展 ID' }, EXT_ID), h('span', { class: 'dim', style: { fontSize: '12px' } }, '所有配置只保存在本机浏览器，不上传任何服务器。'))));
  return { el, update: () => {} };
}

init().catch(e => { document.body.append(h('pre', { style: { color: '#f87171', padding: '16px', whiteSpace: 'pre-wrap' } }, String(e && e.stack || e))); });
