// 选路引擎：测试 → 打分 → 应用 → 验证 → 健康监测 → 自动容灾 / 复测优化
// 原则：连通性第一（必须真实打通才会被选中），其次延迟（热延迟 + 冷启动），再次速度与稳定性。
import * as store from './store.js';
import * as pool from './pool.js';
import * as px from './proxy.js';
import { Core } from './core.js';
import { renderIcon } from './icon.js';
import { withProxyIp, needsCore, parseTrace, parseImport, extractLinks, parseLink, nodeSig, collapseEt, uid, normDomain, parsePoolLine, isIPv4, CHAIN_RE } from '../shared/links.js';
import { flag, ccName } from '../shared/geo.js';
import { addrsFor } from './bestip.js';
import * as ipq from './ipq.js';

export class UserError extends Error {}

const NODE_TTL = 10 * 60e3;
const ROUTE_TTL = 8 * 60e3;
const SPEED_TTL = 30 * 60e3;
const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const log = (lv, msg) => store.log(lv, msg);

// ───────────── 运行时状态（会话存储，界面通过 storage.onChanged 实时刷新）─────────────
const RT0 = {
  status: 'off',          // off | connecting | on | switching | degraded | error
  phase: '',
  since: 0,
  active: null,           // { key, nodeId, pip, viaCore, kind, name, nodeName, ms, cold, mbps, hint }
  ranking: [],
  exit: null,             // { cf:{ip,loc,colo}, std:{ip,cc,isp,hosting,proxy}, pure:{...}, at }
  health: { ok: 0, fail: 0, at: 0, ms: 0, hist: [] },
  core: { up: false, via: '', version: '', port: 0, err: '', installed: null },
  busy: '',
  notice: null,           // { lv, text, at }
  conflict: '',
  speed: null,            // { running, mbps, at, progress }
  lastPlan: 0,
  retryAt: 0,
  retries: 0,
  regionMiss: '',
  traffic: null,
};
let rt = null;
let rtTimer = null;
let lastIconSig = '';

export async function loadRt() {
  if (rt) return rt;
  const r = await chrome.storage.session.get('rt');
  rt = { ...structuredClone(RT0), ...(r.rt || {}) };
  return rt;
}
export function getRt() { return rt; }

export function patchRt(p, { flush = false } = {}) {
  Object.assign(rt, p);
  clearTimeout(rtTimer);
  const save = () => { chrome.storage.session.set({ rt }).catch(() => {}); refreshIcon(); broadcastBadge(); };
  if (flush) save(); else rtTimer = setTimeout(save, 60);
}

function notice(lv, text) { patchRt({ notice: { lv, text, at: now() } }); }

async function notify(title, message) {
  const s = await store.get('settings');
  if (!s.notify) return;
  try { await chrome.notifications.create('brana-' + now(), { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 0 }); } catch {}
}

function exitCc() { return rt.exit?.cf?.loc || rt.exit?.std?.cc || rt.active?.hint || ''; }

function refreshIcon() {
  const st = rt.status;
  const cc = exitCc();
  const sig = st + '|' + cc;
  if (sig !== lastIconSig) {
    lastIconSig = sig;
    renderIcon({ status: st, cc: st === 'on' || st === 'switching' ? cc : '' }).catch(() => {});
  }
  const labels = { off: '未连接', connecting: '连接中…', on: '已连接', switching: '切换线路中…', degraded: '已降级直连（保持网络畅通）', error: '线路异常' };
  const parts = ['Brana VPN', labels[st] || st];
  if (st === 'on' && cc) parts.push(`${flag(cc)} ${ccName(cc)}`);
  if (st === 'on' && rt.exit?.cf?.ip) parts.push(rt.exit.cf.ip);
  if (st === 'on' && rt.health?.ms) parts.push(rt.health.ms + 'ms');
  chrome.action.setTitle({ title: parts.join(' · ') }).catch(() => {});
  const badge = st === 'connecting' || st === 'switching' ? '…' : st === 'degraded' ? '直' : st === 'error' ? '!' : '';
  chrome.action.setBadgeText({ text: badge }).catch(() => {});
  if (badge) chrome.action.setBadgeBackgroundColor({ color: st === 'error' ? '#ef4444' : '#f59e0b' }).catch(() => {});
}

let badgeTimer = null;
let badgeOn = false;
function broadcastBadge() {
  if (!badgeOn) return;
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    const msg = { type: 'brana-state', state: badgeState() };
    try {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (t.id >= 0) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
    } catch {}
  }, 300);
}
export function badgeState() {
  return { status: rt.status, cc: exitCc(), ip: rt.exit?.cf?.ip || rt.exit?.std?.ip || '', ms: rt.health?.ms || rt.active?.ms || 0, name: rt.active?.nodeName || '', pip: rt.active?.pip || '' };
}
export async function syncBadge() {
  const s = await store.get('settings');
  badgeOn = !!s.badge;
  const id = 'brana-badge';
  try {
    const ex = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (s.badge && !ex.length) await chrome.scripting.registerContentScripts([{ id, js: ['content/badge.js'], matches: ['http://*/*', 'https://*/*'], runAt: 'document_idle', persistAcrossSessions: true }]);
    if (!s.badge && ex.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch {}
  if (badgeOn) broadcastBadge();
  else {
    try { const tabs = await chrome.tabs.query({}); for (const t of tabs) if (t.id >= 0) chrome.tabs.sendMessage(t.id, { type: 'brana-badge-off' }).catch(() => {}); } catch {}
  }
}

// ───────────── 操作锁：避免连接 / 切换 / 优选互相打架 ─────────────
let opChain = Promise.resolve();
let opName = '';
function runOp(name, fn, { background = false } = {}) {
  if (background && opName) return Promise.resolve(null);
  const run = async () => {
    opName = name;
    patchRt({ busy: name });
    try {
      return await fn();
    } catch (e) {
      if (rt.status === 'connecting' || rt.status === 'switching') {
        const s = await store.get('settings').catch(() => ({}));
        patchRt({ status: rt.active ? 'on' : (s.enabled ? 'degraded' : 'off'), phase: '' });
      }
      throw e;
    } finally {
      opName = '';
      patchRt({ busy: '', phase: rt.status === 'connecting' || rt.status === 'switching' ? rt.phase : '' });
    }
  };
  const p = opChain.catch(() => {}).then(run);
  opChain = p;
  return p;
}
export const busy = () => opName;

// ───────────── 核心 ─────────────
export async function ensureCore() {
  const s = await store.get('settings');
  const ok = await Core.ensure({ native: s.core.native !== false, port: +s.core.port || 17890 });
  patchRt({ core: { up: ok, via: Core.via, version: Core.info?.version || '', port: Core.port || 0, err: ok ? '' : Core.lastErr, installed: Core.installed } });
  return ok;
}

Core.on('routeDown', d => {
  if (!rt || rt.status !== 'on' || !rt.active) return;
  if (d.key !== rt.active.key) return;
  log('warn', `核心报告主线路熔断：${d.err}`);
  (async () => {
    let st = null;
    try { st = await Core.call('status', {}, 4000); } catch {}
    if (st && await softPromote(st, '主线路连续失败')) return;
    await failover('核心检测到主线路连续失败');
  })().catch(() => {});
});
Core.on('down', err => {
  if (!rt) return;
  patchRt({ core: { ...rt.core, up: false, via: '', err: String(err || '') } });
  if (rt.status === 'on' && rt.active?.viaCore) {
    log('warn', '本地核心已断开：' + err);
    setTimeout(() => { coreRecover().catch(() => {}); }, 300);
  }
});
Core.on('stats', d => { if (rt) patchRt({ traffic: { up: d.up, down: d.down, rateUp: d.rateUp, rateDown: d.rateDown, conns: d.conns, failovers: d.failovers, direct: d.direct, at: now() } }); });

let recoverHits = [];
async function coreRecover() {
  if (rt.status !== 'on' || !rt.active?.viaCore) return;
  recoverHits = recoverHits.filter(t => now() - t < 120e3);
  recoverHits.push(now());
  if (recoverHits.length > 3) { await failover('本地核心反复退出'); return; }
  const ok = await ensureCore();
  if (ok) {
    const c = await resolveCand(rt.active.key);
    if (c && await tryApply(c, { reset: false, silent: true })) { log('info', '本地核心已自动恢复'); return; }
  }
  await failover('本地核心不可用');
}

// ───────────── 线路构建 ─────────────
export const routeKey = (nodeId, pip) => nodeId + '|' + (pip || '');

// ───────────── 统一出口（1.2.6）─────────────
// 「通用转发」ProxyIP 会按 SNI 转发任意 HTTPS 网站：让核心把 443 域名连接的目标改写成它，Cloudflare 与非 Cloudflare 网站就都从它出去
const UNI = { on: false, strict: false, ok: new Map() };
const UNI_TTL_OK = 24 * 3600e3, UNI_TTL_FAIL = 12 * 3600e3;
export async function syncUni() {
  const s = await store.get('settings');
  const p = await store.get('pool');
  UNI.on = !!s.uniform?.enabled;
  UNI.strict = !!s.uniform?.strict;
  UNI.ok = new Map(Object.entries(p.items).filter(([k, e]) => e.uni?.ok && !e.ban && !e.gone && uniAddr(k)).map(([k, e]) => [k, { http: !!e.uni.http }]));
  return { on: UNI.on, strict: UNI.strict, count: UNI.ok.size };
}
syncUni().catch(() => {});
export function uniAddr(pip) {
  if (!pip || CHAIN_RE.test(pip)) return '';
  const ip = ipq.ipOf(pip);
  if (!ip) return '';
  const m = /\]:(\d+)$/.exec(pip) || (!ip.includes(':') && /:(\d+)$/.exec(pip));
  const port = m ? +m[1] : 443;
  return ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
}
// 统一出口开启且有可用的通用转发 IP 时，候选只在它们之中挑
const uniOnly = () => (UNI.on && UNI.ok.size ? new Set(UNI.ok.keys()) : null);
function uniFor(pip) {
  if (!UNI.on || !pip) return {};
  const u = UNI.ok.get(pip);
  const a = u && uniAddr(pip);
  return a ? { uni: a, uniHttp: u.http, uniStrict: UNI.strict } : {};
}

export function buildRoute(n, pip) {
  if (n.kind === 'vless' || n.kind === 'trojan') {
    const sni = n.sni || (n.tls ? (n.host || (isIPv4(n.address) ? '' : n.address)) : '');
    return {
      key: routeKey(n.id, pip), kind: n.kind, name: n.name + (pip ? ' · ' + shortPip(pip) : ''),
      address: n.prefAddr || n.address, port: n.port, tls: !!n.tls, sni, host: n.host || n.sni || n.address,
      path: withProxyIp(n.path || '/', pip), uuid: n.uuid, password: n.password, insecure: !!n.insecure,
      ...bestipAddrs(n), ...uniFor(pip),
    };
  }
  return { key: routeKey(n.id, ''), kind: n.kind, name: n.name, address: n.address, port: n.port, user: n.user || '', pass: n.pass || '', insecure: !!n.insecure };
}
// 优选 IP：当前时段最优的若干 IP 作为连接地址（核心按健康度与延迟在其间分配、单 IP 熔断）
function bestipAddrs(n) {
  const b = addrsFor(n);
  if (b) return { address: b.addrs[0], addrs: b.addrs, addrsMain: b.main };
  // 优选 IP 还没有结果：合并后的 edgetunnel 节点先用订阅里的地址（核心在其间按健康度分配）
  if (n.et && n.altAddrs?.length) { const addrs = [...new Set([n.prefAddr || n.address, ...n.altAddrs].filter(Boolean))].slice(0, 12); return { address: addrs[0], addrs, addrsMain: addrs.length }; }
  return {};
}
export const shortPip = pip => CHAIN_RE.test(pip) ? pip.replace(/\/\/[^@/]*@/, '//') : pip;

async function nodesMap() { const list = await store.get('nodes'); return new Map(list.map(n => [n.id, n])); }

async function resolveCand(key) {
  const [nodeId, ...rest] = String(key).split('|');
  const pip = rest.join('|');
  const n = (await nodesMap()).get(nodeId);
  if (!n || n.unsupported) return null;
  const stats = await store.get('stats');
  return mkCand(n, pip, stats.routes[routeKey(n.id, pip)] || (pip ? null : stats.nodes[n.id]) || null);
}

function mkCand(n, pip, st) {
  const viaCore = needsCore(n);
  return { key: routeKey(n.id, pip), nodeId: n.id, pip: pip || '', viaCore, kind: n.kind, name: n.name, route: buildRoute(n, pip), st: st || null, hint: st?.exit?.loc || '' };
}

export function score(st) {
  if (!st || !st.ok) return Infinity;
  const lat = (st.ms || 300) + 0.25 * (st.cold || 0);
  const rel = 1 + 2.5 * (1 - (st.succ ?? 1));
  // 1.2.4：速度权重加大（实测同延迟的 ProxyIP 带宽可差 100 倍：4 Mbps vs 400 Mbps）
  // 5 Mbps → ×3，50 → ×1.41，100 → ×1，300+ → ×0.55；连续测速失败 ≥2 次按很慢处理
  const spd = (st.sFail || 0) >= 2 ? 2.5 : st.mbps ? clamp(Math.sqrt(100 / st.mbps), 0.55, 3) : 1.2;
  // 1.2.5：× IP 质量倍率（住宅且纯净且够快 ×0.2 … 不纯净 ×1～1.3，见 ipq.qMult）
  return lat * rel * spd * (st.cfFail ? 1.8 : 1) * ipq.qMult(st.q, st.mbps);
}
const fresh = (st, ttl) => !!st && now() - (st.at || 0) < ttl;

function mergeStat(prev, r, extra = {}) {
  const o = { ...(prev || {}), at: now(), n: ((prev && prev.n) || 0) + 1 };
  if (r.ok) {
    o.ok = true;
    o.ms = prev?.ok && prev.ms ? Math.round(prev.ms * 0.4 + r.ms * 0.6) : r.ms;
    o.cold = r.cold || o.cold || 0;
    o.succ = prev?.succ == null ? 1 : +(prev.succ * 0.7 + 0.3).toFixed(3);
    o.err = '';
    if (r.trace) o.exit = r.trace;
  } else {
    o.succ = prev?.succ == null ? 0 : +(prev.succ * 0.7).toFixed(3);
    o.fails = (prev?.fails || 0) + 1;
    o.ok = prev?.ok && o.succ > 0.5 && (o.fails || 0) < 2 ? true : false;
    o.err = String(r.err || '失败').slice(0, 140);
  }
  if (r.ok) o.fails = 0;
  return Object.assign(o, extra);
}

async function recordNodeResults(nodes, res) {
  await store.mutate('stats', st => {
    nodes.forEach((n, i) => { const r = res[i] || { ok: false, err: '无结果' }; st.nodes[n.id] = mergeStat(st.nodes[n.id], r); });
  });
}
async function recordRouteResults(items, res) {
  const pipRes = [];
  await store.mutate('stats', st => {
    items.forEach((it, i) => {
      const r = res[i] || { ok: false, err: '无结果' };
      st.routes[it.key] = mergeStat(st.routes[it.key], r);
      if (it.pip) pipRes.push({ pip: it.pip, ...r });
    });
    // 统计表瘦身
    const keys = Object.keys(st.routes);
    if (keys.length > 1500) keys.sort((a, b) => (st.routes[a].at || 0) - (st.routes[b].at || 0)).slice(0, keys.length - 1200).forEach(k => delete st.routes[k]);
  });
  await pool.recordProbes(pipRes);
}

// ───────────── 无核心时测试原生代理（临时 PAC 把专用探测域名分流到候选代理）─────────────
const PROBE_HOSTS = ['one.one.one.one', '1.0.0.1', 'cloudflare-dns.com', '1dot1dot1dot1.cloudflare-dns.com', 'cp.cloudflare.com', 'speed.cloudflare.com'];
async function timedFetch(url, timeout, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctl.signal, ...init });
    const text = init.noBody ? '' : await r.text();
    return { ok: true, status: r.status, text, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, err: e.name === 'AbortError' ? '超时' : (e.message || '失败'), ms: Math.round(performance.now() - t0) };
  } finally { clearTimeout(t); }
}

async function nativeProbe(nodes) {
  const s = await store.get('settings');
  const out = [];
  const restore = await currentPacFor(s);
  try {
    for (let i = 0; i < nodes.length; i += PROBE_HOSTS.length) {
      const batch = nodes.slice(i, i + PROBE_HOSTS.length);
      const probes = {};
      batch.forEach((n, j) => { probes[PROBE_HOSTS[j]] = px.proxyString(n.kind, n.address, n.port); });
      await px.applyPac(px.buildPac({ ...restore, probes }));
      await sleep(150);
      const res = await Promise.all(batch.map(async (n, j) => {
        const a = await timedFetch(`https://${PROBE_HOSTS[j]}/cdn-cgi/trace?b=${now()}`, 7000);
        if (!a.ok || a.status >= 500) return { ok: false, err: a.err || 'HTTP ' + a.status };
        const b = await timedFetch(`https://${PROBE_HOSTS[j]}/cdn-cgi/trace?b=${now()}w`, 5000);
        return { ok: true, ms: b.ok ? b.ms : a.ms, cold: a.ms, trace: parseTrace(a.text) };
      }));
      out.push(...res);
    }
  } finally {
    if (restore.active) await px.applyPac(px.buildPac(restore)); else await px.clearProxy();
  }
  return out;
}

async function currentPacFor(s) {
  const base = { strict: s.strict, scope: s.scope, directList: s.directList, proxyList: s.proxyList };
  if (rt.status === 'on' || rt.status === 'switching') {
    const p = await activeProxyString();
    if (p) return { ...base, proxy: p, active: true };
  }
  return { ...base, proxy: 'DIRECT', strict: true, active: false };
}

async function activeProxyString() {
  if (!rt.active) return '';
  if (rt.active.viaCore) return `SOCKS5 127.0.0.1:${Core.port || rt.core.port || 17890}`;
  const n = (await nodesMap()).get(rt.active.nodeId);
  return n ? px.proxyString(n.kind, n.address, n.port) : '';
}

// ───────────── 测试 ─────────────
export async function testNodes({ ids = null, force = true } = {}) {
  const s = await store.get('settings');
  let nodes = (await store.get('nodes')).filter(n => !n.unsupported && (ids ? ids.includes(n.id) : n.enabled !== false));
  const stats = await store.get('stats');
  if (!force) nodes = nodes.filter(n => !fresh(needsCore(n) ? stats.nodes[n.id] : stats.routes[routeKey(n.id, '')], NODE_TTL));
  if (!nodes.length) return { tested: 0 };
  const coreNodes = nodes.filter(needsCore);
  const nativeNodes = nodes.filter(n => !needsCore(n));
  const coreUp = (coreNodes.length || nativeNodes.length) ? await ensureCore() : false;
  if (coreNodes.length) {
    if (!coreUp) throw new UserError('测试 VLESS/Trojan 节点需要本地核心，请先安装或启动 Brana 核心');
    const res = await Core.call('probe', { routes: coreNodes.map(n => buildRoute(n, '')), url: s.test.latencyUrl, count: 2, timeout: 8000, concurrency: 6 }, 120000);
    await recordNodeResults(coreNodes, res);
  }
  if (nativeNodes.length) {
    const res = coreUp
      ? await Core.call('probe', { routes: nativeNodes.map(n => buildRoute(n, '')), url: s.test.cfUrl, count: 2, timeout: 8000, concurrency: 6 }, 120000)
      : await nativeProbe(nativeNodes);
    await recordRouteResults(nativeNodes.map(n => ({ key: routeKey(n.id, ''), pip: '' })), res);
    await store.mutate('stats', st => { nativeNodes.forEach(n => { st.nodes[n.id] = st.routes[routeKey(n.id, '')]; }); });
  }
  return { tested: nodes.length };
}

async function bestCoreNode(region) {
  const nodes = (await store.get('nodes')).filter(n => n.enabled !== false && !n.unsupported && needsCore(n));
  const stats = await store.get('stats');
  const ok = nodes.filter(n => stats.nodes[n.id]?.ok).sort((a, b) => score(stats.nodes[a.id]) - score(stats.nodes[b.id]));
  if (rt.active?.viaCore) { const cur = ok.find(n => n.id === rt.active.nodeId); if (cur) return cur; }
  return ok[0] || null;
}

// 检测 ProxyIP：经当前（或最佳）节点访问 Cloudflare trace，得到真实出口 IP / 地区 / 延迟
export async function testPool({ keys = null, region = '', limit = 24 } = {}) {
  const s = await store.get('settings');
  if (!(await ensureCore())) throw new UserError('检测 ProxyIP 需要本地核心（ProxyIP 必须经节点才能验证）');
  let node = await bestCoreNode(region);
  if (!node) { await testNodes({ force: false }).catch(() => {}); node = await bestCoreNode(region); }
  if (!node) throw new UserError('没有可用的 VLESS/Trojan 节点，无法检测 ProxyIP');
  const pd = await store.get('pool');
  if (!keys && !Object.keys(pd.items).length && pd.sources.length) await pool.refreshSources({ force: false }).catch(() => {});
  const pips = keys || await pool.candidates({ region, limit });
  if (!pips.length) return { tested: 0, ok: 0 };
  const items = pips.map(pip => ({ key: routeKey(node.id, pip), pip }));
  const res = await Core.call('probe', { routes: items.map(it => buildRoute(node, it.pip)), url: s.test.cfUrl, count: 2, timeout: 8000, concurrency: 8 }, 180000);
  await recordRouteResults(items, res);
  // 1.2.5：手动检测时顺带检测 IP 质量（可用的做深度查询）
  if (s.pipQuality?.enabled !== false) {
    ipq.setPrefs(s.pipQuality);
    const okPips = items.filter((it, i) => res[i]?.ok).map(it => it.pip).filter(Boolean);
    await pool.prescreen({ deepPips: okPips.slice(0, 40) }).catch(() => {});
    await pureScan({ pips: okPips, limit: 40, node }).catch(() => {});
  }
  return { tested: items.length, ok: res.filter(r => r && r.ok).length, node: node.name };
}

// 扫描「通用转发」ProxyIP：经节点让它分别转发 Cloudflare trace 与非 Cloudflare 的 ipinfo，两边出口一致才算通用；顺带测 80 端口转发
export async function uniScan({ limit = 40, force = false, keys = null, phase = () => {} } = {}) {
  const s = await store.get('settings');
  if (!(await ensureCore())) throw new UserError('扫描通用转发 ProxyIP 需要本地核心');
  if (!(await Core.call('hello', {}, 5000).catch(() => null))?.features?.includes('uni')) throw new UserError('本地核心版本过旧，不支持统一出口，请更新核心（1.2.4+）');
  let node = await bestCoreNode('');
  if (!node) { await testNodes({ force: false }).catch(() => {}); node = await bestCoreNode(''); }
  if (!node) throw new UserError('没有可用的 VLESS/Trojan 节点');
  const p = await store.get('pool');
  const t = now();
  let pick = keys;
  if (!pick) {
    const list = Object.entries(p.items).filter(([k, e]) => !e.ban && !e.gone && e.ok !== false && uniAddr(k)
      && (force || !e.uni || t - (e.uni.at || 0) > (e.uni.ok ? UNI_TTL_OK : UNI_TTL_FAIL)));
    // 已验证能转发 Cloudflare 的优先（通用转发一定也能转发 Cloudflare），其余随机
    list.sort(() => Math.random() - 0.5).sort((a, b) => (a[1].ok === true ? 0 : 1) - (b[1].ok === true ? 0 : 1));
    pick = list.slice(0, limit).map(([k]) => k);
  }
  if (!pick.length) { await syncUni(); return { tested: 0, ok: 0, total: UNI.ok.size }; }
  const out = new Map();
  let done = 0;
  const one = async pip => {
    const route = { ...buildRoute(node, pip), uni: uniAddr(pip), uniHttp: false, uniStrict: false };
    const r = await Core.call('trace', { route, timeout: 8000, cfUrl: s.test.cfUrl, stdUrl: 'https://ipinfo.io/json' }, 25000).catch(e => ({ err: e.message }));
    const cfIp = r?.cf?.ip || '', stdIp = r?.std?.ip || '';
    const ok = !!cfIp && cfIp === stdIp;
    let http = false;
    if (ok) {
      const r2 = await Core.call('trace', { route: { ...route, uniHttp: true }, timeout: 6000, cfUrl: s.test.cfUrl, stdUrl: 'http://ip-api.com/json/?fields=status,query,countryCode' }, 20000).catch(() => null);
      http = !!r2?.std?.ip && r2.std.ip === cfIp;
    }
    out.set(pip, { ok, http, ip: cfIp, std: stdIp, loc: r?.cf?.loc || '', at: now(), err: ok ? '' : (r?.err || r?.std?.err || r?.cf?.err || (cfIp && stdIp ? '出口不一致' : cfIp ? '只转发 Cloudflare' : '不可用')) });
    phase(`扫描通用转发 ProxyIP ${++done}/${pick.length}`);
  };
  const q = [...pick];
  await Promise.all(Array.from({ length: Math.min(6, q.length) }, async () => { while (q.length) await one(q.shift()); }));
  await store.mutate('pool', pd => {
    for (const [k, u] of out) { const e = pd.items[k]; if (!e) continue; e.uni = u; if (u.ok && u.loc && !e.cc) e.cc = u.loc; }
  });
  await syncUni();
  const ok = [...out.values()].filter(u => u.ok).length;
  if (ok) store.log('info', `统一出口：发现 ${ok} 个通用转发 ProxyIP（${[...out].filter(([, u]) => u.ok).map(([k]) => shortPip(k)).join('、')}）`);
  return { tested: out.size, ok, total: UNI.ok.size, node: node.name };
}
// 1.2.8 IPPure 风险系数：经节点 + 各 ProxyIP 访问 IPPure（托管在 Cloudflare 上，看到的就是该 ProxyIP 的出口），按出口 IP 缓存 3 天
// pips 可含 ''（不带 ProxyIP 的线路：Worker 默认出口）
export async function pureScan({ pips = null, limit = 16, force = false, node = null, phase = () => {} } = {}) {
  if (!(await ensureCore())) return { tested: 0, risky: 0 };
  node = node || await bestCoreNode('');
  if (!node) return { tested: 0, risky: 0 };
  const p = await store.get('pool');
  const qc = await store.get('ipq');
  const stats0 = await store.get('stats');
  const ipFor = k => (k ? ipq.ipOf(k, p.items[k]?.exitIp) : (stats0.routes[routeKey(node.id, '')]?.exit?.ip || ''));
  const list = [...new Set(pips || Object.keys(p.items))].filter(k => {
    const e = k ? p.items[k] : null;
    if (k && (!e || e.ban || e.gone)) return false;
    const ip = ipFor(k);
    return force || !ip || ipq.pureStale(qc[ip]?.pure);
  }).slice(0, limit);
  if (!list.length) return { tested: 0, risky: 0 };
  const ua = (globalThis.navigator && navigator.userAgent) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const map = {}, keyIp = new Map();
  let done = 0;
  const one = async pip => {
    const { uni, uniHttp, uniStrict, ...route } = buildRoute(node, pip);
    const res = await Core.call('fetch', { url: ipq.PURE_URL, route, via: 'tunnel', timeout: 10000, ua }, 25000).catch(e => ({ err: e.message }));
    const pr = ipq.parsePure(res);
    const ip = pr.ip || ipFor(pip);
    if (ip) { map[ip] = pr; if (pip) keyIp.set(pip, ip); }
    phase(`检测 IPPure 风险系数 ${++done}/${list.length}`);
  };
  const q = [...list];
  await Promise.all(Array.from({ length: Math.min(4, q.length) }, async () => { while (q.length) await one(q.shift()); }));
  await ipq.recordPure(map);
  const qc2 = await store.get('ipq');
  await store.mutate('pool', d => {
    for (const [k, ip] of keyIp) { const e = d.items[k]; const qq = ipq.slim(qc2[ip]); if (e && qq) { e.q = qq; e.qIp = ip; } }
  });
  const bad = Object.values(map).filter(pr => !pr.err && (pr.chal || pr.fraud > (ipq.prefs().maxRisk ?? 50))).length;
  return { tested: list.length, ok: Object.values(map).filter(pr => !pr.err).length, risky: bad, node: node.name };
}
// 线路的有效质量（按实测出口 IP 查缓存；没有出口记录时按 ProxyIP 本身）
function routeQ(c, qc) {
  const ip = c.st?.exit?.ip || ipq.ipOf(c.pip);
  return ip ? ipq.slim(qc[ip]) : null;
}

export async function onUniformChange() {
  const u = await syncUni();
  if (u.on && !u.count) await uniScan({ limit: 60 }).catch(e => store.log('warn', '统一出口扫描失败：' + e.message));
  if (rt.status === 'on') await optimize().catch(e => store.log('warn', '统一出口切换失败：' + e.message));
  return syncUni();
}

// ───────────── 选路规划 ─────────────
export async function plan({ force = false, quick = false, speed = true, region, exclude = new Set(), phase = () => {} } = {}) {
  const s = await store.get('settings');
  region = region ?? s.region;
  const nodes = (await store.get('nodes')).filter(n => n.enabled !== false && !n.unsupported);
  if (!nodes.length) throw new UserError('还没有可用节点，请先导入节点链接或订阅');
  const coreNodes = nodes.filter(needsCore);
  const nativeNodes = nodes.filter(n => !needsCore(n));
  let coreUp = false;
  if (coreNodes.length || nativeNodes.length) { phase('检查本地核心'); coreUp = await ensureCore(); }
  let stats = await store.get('stats');
  const cands = [];
  let coreNote = '';
  ipq.setPrefs(s.pipQuality);
  const qOn = s.pipQuality?.enabled !== false;

  if (coreNodes.length && !coreUp) coreNote = 'VLESS/Trojan 节点需要本地核心';
  if (coreUp && coreNodes.length) {
    const stale = coreNodes.filter(n => force || !fresh(stats.nodes[n.id], NODE_TTL));
    if (stale.length) {
      phase(`测试节点连通性 · ${stale.length} 个`);
      const res = await Core.call('probe', { routes: stale.map(n => buildRoute(n, '')), url: s.test.latencyUrl, count: 2, timeout: 8000, concurrency: 6 }, 120000);
      await recordNodeResults(stale, res);
      stats = await store.get('stats');
    }
    let okNodes = coreNodes.filter(n => stats.nodes[n.id]?.ok).sort((a, b) => score(stats.nodes[a.id]) - score(stats.nodes[b.id]));
    // 变通：所有节点都不通时，为 Cloudflare 节点扫描优选 IP 再试一次
    if (!okNodes.length && s.cfScan) {
      const scanable = coreNodes.filter(n => n.tls && (!n.prefTriedAt || now() - n.prefTriedAt > 3 * 3600e3)).slice(0, 2);
      for (const n of scanable) {
        phase(`节点不通，正在为「${n.name}」扫描 Cloudflare 优选 IP`);
        try { await scanNode(n.id, { silent: true }); } catch {}
      }
      if (scanable.length) {
        const again = (await store.get('nodes')).filter(n => scanable.some(x => x.id === n.id));
        const res = await Core.call('probe', { routes: again.map(n => buildRoute(n, '')), url: s.test.latencyUrl, count: 2, timeout: 8000, concurrency: 4 }, 60000);
        await recordNodeResults(again, res);
        stats = await store.get('stats');
        okNodes = coreNodes.filter(n => stats.nodes[n.id]?.ok);
      }
    }
    const nm = await nodesMap();
    const topNodes = okNodes.slice(0, quick ? 1 : 2).map(n => nm.get(n.id) || n);
    if (topNodes.length) {
      const pd = await store.get('pool');
      if (!Object.keys(pd.items).length && pd.sources.length) {
        phase('解析 ProxyIP 来源');
        await pool.refreshSources({ force: false, inUse: rt.active?.pip || '' }).catch(() => {});
      }
      // 1.2.5：先对池中 IP 做质量预筛（住宅 / 机房 + 纯净度，结果缓存 7 天），以便候选里给住宅纯净 IP 留名额
      if (qOn && !quick) { phase('检测 ProxyIP 纯净度'); await pool.prescreen().catch(() => {}); }
      // 1.2.6 统一出口：通用转发 IP 不足时先扫描一轮（约 5% 的 ProxyIP 是通用转发）
      await syncUni();
      if (UNI.on && UNI.ok.size < 2 && !quick) { phase('扫描通用转发 ProxyIP'); await uniScan({ limit: 40, phase }).catch(e => store.log('warn', '统一出口扫描失败：' + e.message)); }
      const only = uniOnly();
      if (UNI.on && !only) store.log('warn', '统一出口：暂未找到通用转发 ProxyIP，本次按普通模式连接');
      patchRt({ uniMiss: UNI.on && !only });
      const pips = await pool.candidates({ region, limit: quick ? Math.min(6, s.pipPerTest) : s.pipPerTest, only });
      const defKeySt = stats.routes[routeKey(topNodes[0].id, '')];
      if (!only && (!region || defKeySt?.exit?.loc === region)) pips.push('');
      if (rt.active?.viaCore && rt.active.pip && !pips.includes(rt.active.pip) && (!only || only.has(rt.active.pip))) pips.unshift(rt.active.pip);
      const items = [];
      for (const n of topNodes) for (const pip of pips) { const key = routeKey(n.id, pip); if (!exclude.has(key)) items.push({ n, pip, key }); }
      const staleR = items.filter(it => force || !fresh(stats.routes[it.key], ROUTE_TTL));
      if (staleR.length) {
        phase(`优选 ProxyIP · ${staleR.length} 条线路`);
        const res = await Core.call('probe', { routes: staleR.map(it => buildRoute(it.n, it.pip)), url: s.test.cfUrl, count: 2, timeout: 8000, concurrency: 6 }, 180000);
        await recordRouteResults(staleR, res);
        stats = await store.get('stats');
      }
      for (const it of items) { const st = stats.routes[it.key]; if (st?.ok) cands.push(mkCand(it.n, it.pip, st)); }
      // 1.2.5：对通过检测的候选做深度质量查询（proxycheck 风险分），并把质量写进线路记录供评分使用
      if (qOn) {
        const cp = [...new Set(cands.filter(c => c.pip).map(c => c.pip))];
        if (cp.length && !quick) { phase('检测 ProxyIP 纯净度'); await pool.prescreen({ deepPips: cp }).catch(() => {}); }
        // 1.2.8：IPPure 风险系数（只查缓存过期的；含不带 ProxyIP 的线路）
        if (!quick && cands.length) { phase('检测 IPPure 风险系数'); await pureScan({ pips: cands.map(c => c.pip), limit: 16, node: topNodes[0] }).catch(e => store.log('warn', 'IPPure 检测失败：' + e.message)); }
        const qc = await store.get('ipq');
        const pd2 = await store.get('pool');
        await store.mutate('stats', st => {
          for (const c of cands) { const q = routeQ(c, qc) || (c.pip && pd2.items[c.pip]?.q); const o = st.routes[c.key]; if (q && o) { o.q = q; c.st = o; } }
        });
        // 高风险（IPPure 系数超过上限 / 被 Cloudflare 拦截）自动拉黑；全部高风险时临时放宽，按风险从低到高
        const safe = cands.filter(c => !ipq.risky(c.st?.q));
        const relax = !safe.length && cands.length > 0;
        if (relax) {
          cands.sort((a, b) => (a.st?.q?.fraud ?? 100) - (b.st?.q?.fraud ?? 100));
          store.log('warn', `所有可用线路的 IPPure 风险系数都超过 ${ipq.prefs().maxRisk ?? 50}%，临时使用风险最低的（${cands[0].st?.q?.fraud ?? '?'}%）`);
        } else if (safe.length < cands.length) {
          store.log('info', `IPPure：已拉黑 ${cands.length - safe.length} 条高风险线路`);
          cands.splice(0, cands.length, ...safe);
        }
        patchRt({ riskRelax: relax });
      }
      if (!cands.length) {
        // 变通：Cloudflare 站点线路全部失败时，至少保证普通网站可用
        for (const n of okNodes.slice(0, 3)) if (!exclude.has(routeKey(n.id, ''))) cands.push(mkCand(nm.get(n.id) || n, '', { ...stats.nodes[n.id], cfFail: true }));
      }
    }
  }

  if (nativeNodes.length) {
    const stale = nativeNodes.filter(n => force || !fresh(stats.routes[routeKey(n.id, '')], ROUTE_TTL));
    if (stale.length) {
      phase(`测试代理节点 · ${stale.length} 个`);
      const res = coreUp
        ? await Core.call('probe', { routes: stale.map(n => buildRoute(n, '')), url: s.test.cfUrl, count: 2, timeout: 8000, concurrency: 6 }, 120000)
        : await nativeProbe(stale);
      await recordRouteResults(stale.map(n => ({ key: routeKey(n.id, ''), pip: '' })), res);
      stats = await store.get('stats');
    }
    for (const n of nativeNodes) { const key = routeKey(n.id, ''); const st = stats.routes[key]; if (st?.ok && !exclude.has(key)) cands.push(mkCand(n, '', st)); }
  }

  let ranked = cands;
  let regionMiss = '';
  if (region) {
    const inR = cands.filter(c => (c.st?.exit?.loc || '') === region);
    if (inR.length) ranked = inR; else if (cands.length) regionMiss = region;
  }

  if (speed && !quick && coreUp && ranked.length) {
    // 1.2.4：延迟相近的 ProxyIP 带宽可能天差地别 → 按评分取前 5 个「不同 ProxyIP」测速（同一 ProxyIP 只测一次）
    const seenP = new Set(), top = [];
    for (const c of [...ranked].sort((a, b) => score(a.st) - score(b.st))) {
      const k = c.pip || ('node:' + c.nodeId);
      if (seenP.has(k)) continue;
      seenP.add(k);
      if (force || !(c.st?.sAt && now() - c.st.sAt < SPEED_TTL)) top.push(c);
      if (seenP.size >= 5) break;
    }
    let i = 0;
    for (const c of top) {
      phase(`测速 ${++i}/${top.length} · ${c.name}${c.pip ? ' · ' + shortPip(c.pip) : ''}`);
      const r = await Core.call('speed', { route: c.route, url: s.test.speedUrl, seconds: Math.min(6, s.test.speedSeconds || 5) }, 30000).catch(e => ({ ok: false, err: e.message }));
      await store.mutate('stats', st => {
        const o = st.routes[c.key] || (st.routes[c.key] = { ...c.st });
        o.sAt = now();
        // 失败不再编造速度（旧版填 0.5 / 减半，界面会显示成「0.4 Mbps」之类的假数字）
        if (r.ok && r.mbps > 0) { o.mbps = o.mbps ? +(o.mbps * 0.3 + r.mbps * 0.7).toFixed(2) : r.mbps; o.sFail = 0; }
        else o.sFail = (o.sFail || 0) + 1;
        c.st = o;
      });
      if (c.pip && r.ok && r.mbps > 0) await pool.recordSpeed(c.pip, r.mbps).catch(() => {});
    }
  }

  ranked = ranked.filter(c => score(c.st) < Infinity).sort((a, b) => score(a.st) - score(b.st));
  patchRt({ lastPlan: now(), ranking: ranked.slice(0, 10).map(c => ({ key: c.key, viaCore: c.viaCore, score: Math.round(score(c.st)) })), regionMiss });
  return { ranked, regionMiss, coreUp, coreNote, all: cands };
}

// ───────────── 应用与验证 ─────────────
async function pickFallbacks(c) {
  const out = [];
  const seenPip = new Set([c.pip]);
  const seenNode = new Set([c.nodeId]);
  const list = [];
  for (const r of rt.ranking || []) { if (r.key === c.key) continue; const cc = await resolveCand(r.key); if (cc && cc.st?.ok) list.push(cc); }
  // 优先：不同节点 → 不同 ProxyIP
  for (const x of list) { if (out.length >= 3) break; if (!seenNode.has(x.nodeId) && (c.viaCore || !x.viaCore)) { out.push(x); seenNode.add(x.nodeId); seenPip.add(x.pip); } }
  for (const x of list) { if (out.length >= 3) break; if (!out.includes(x) && !seenPip.has(x.pip) && (c.viaCore || !x.viaCore)) { out.push(x); seenPip.add(x.pip); } }
  return out;
}

// verifying=true：只放主线路、关闭核心直连兜底与 PAC 的 DIRECT，确保验证结果真实反映这条线路
async function applyChrome(c, fallbacks, { verifying = false, reset = true } = {}) {
  const s = await store.get('settings');
  const base = { strict: verifying ? true : s.strict, scope: s.scope, directList: s.directList, proxyList: s.proxyList };
  if (c.viaCore) {
    const r = await Core.call('apply', {
      routes: verifying ? [c.route] : [c.route, ...fallbacks.map(f => f.route)],
      directFallback: verifying ? false : s.directFallback && !s.strict,
      strict: verifying ? true : s.strict,
      reset,
      resetStats: true,
    }, 10000);
    if (r?.errors?.length) log('warn', '部分线路配置无效：' + r.errors.join('；'));
    await px.applyPac(px.buildPac({ ...base, proxy: `SOCKS5 127.0.0.1:${r?.port || Core.port}` }));
  } else {
    const nm = await nodesMap();
    const list = verifying ? [c] : [c, ...fallbacks.filter(f => !f.viaCore)];
    const chain = list.map(x => nm.get(x.nodeId)).filter(Boolean).map(n => px.proxyString(n.kind, n.address, n.port));
    await px.applyPac(px.buildPac({ ...base, proxy: chain.join('; ') }));
  }
}

async function verify(c, timeout = 8000) {
  const s = await store.get('settings');
  const useCf = !c.st?.cfFail;
  const url = useCf ? s.test.cfUrl : s.test.latencyUrl;
  const sep = url.includes('?') ? '&' : '?';
  const a = await timedFetch(`${url}${sep}brana=${now()}`, timeout);
  if (!a.ok || a.status >= 500) {
    if (useCf) {
      // 变通：CF 验证失败时，检查普通网站是否可达
      const b = await timedFetch(`${s.test.latencyUrl}${s.test.latencyUrl.includes('?') ? '&' : '?'}brana=${now()}`, 6000);
      if (b.ok && b.status < 500) return { ok: true, ms: b.ms, cfFail: true };
    }
    return { ok: false, err: a.err || 'HTTP ' + a.status };
  }
  return { ok: true, ms: a.ms, trace: useCf ? parseTrace(a.text) : null };
}

async function tryApply(c, { reset = true, silent = false } = {}) {
  try {
    if (c.viaCore && !(await ensureCore())) return false;
    const fallbacks = await pickFallbacks(c);
    await applyChrome(c, [], { verifying: true, reset });
    await sleep(150);
    const v = await verify(c);
    if (v.ok) await applyChrome(c, fallbacks, { reset: false });
    if (!v.ok) {
      log('warn', `线路验证失败：${c.name}${c.pip ? ' · ' + shortPip(c.pip) : ''}（${v.err}）`);
      await store.mutate('stats', st => { const o = st.routes[c.key]; if (o) { o.succ = +((o.succ ?? 1) * 0.5).toFixed(3); o.fails = (o.fails || 0) + 1; if (o.fails >= 2) o.ok = false; o.err = '验证失败：' + v.err; o.at = now(); } });
      if (c.pip) await pool.cool(c.pip, 10, '验证失败');
      return false;
    }
    const s = await store.get('settings');
    const n = (await nodesMap()).get(c.nodeId);
    const exitCf = v.trace ? { ip: v.trace.ip, loc: v.trace.loc, colo: v.trace.colo } : null;
    patchRt({
      status: 'on',
      phase: '',
      since: rt.status === 'on' && rt.since ? rt.since : now(),
      active: { key: c.key, nodeId: c.nodeId, pip: c.pip, viaCore: c.viaCore, uni: !!c.route?.uni, kind: c.kind, name: c.name, nodeName: n?.name || c.name, ms: c.st?.ms || v.ms, cold: c.st?.cold || 0, mbps: c.st?.mbps || 0, hint: exitCf?.loc || c.hint || '', cfFail: !!(v.cfFail || c.st?.cfFail), at: now() },
      exit: exitCf ? { ...(rt.exit && rt.exit.cf?.ip === exitCf.ip ? rt.exit : {}), cf: exitCf, at: now() } : rt.exit,
      retries: 0,
      retryAt: 0,
      health: { ...rt.health, fail: 0, at: now(), ms: v.ms },
    }, { flush: true });
    await px.setWebRtcProtection(!!s.webrtc);
    await store.mutate('settings', st => { st.last = { key: c.key, viaCore: c.viaCore, at: now() }; });
    if (v.cfFail || c.st?.cfFail) notice('warn', '当前线路的 ProxyIP 不可用：普通网站正常，Cloudflare 托管网站可能打不开。可点「换 IP」或「一键优选」。');
    if (!silent) log('info', `已连接：${c.name}${c.pip ? ' · ProxyIP ' + shortPip(c.pip) : ''}${exitCf ? ` · 出口 ${exitCf.ip} ${exitCf.loc}` : ''}`);
    refreshExit().catch(() => {});
    return true;
  } catch (e) {
    log('warn', `应用线路失败：${c.name}：${e.message}`);
    return false;
  }
}

export async function refreshExit() {
  if (rt.status !== 'on') return;
  const s = await store.get('settings');
  const [cf, std] = await Promise.all([
    timedFetch(`${s.test.cfUrl}${s.test.cfUrl.includes('?') ? '&' : '?'}x=${now()}`, 8000).then(r => (r.ok ? parseTrace(r.text) : null)),
    // 统一出口只改写 HTTPS（80 端口视 ProxyIP 而定）→ 用 HTTPS 的 ipinfo 检测「其他网站」出口
    rt.active?.uni
      ? timedFetch(`https://ipinfo.io/json?x=${now()}`, 8000).then(r => { try { const j = JSON.parse(r.text); return j.ip ? { ip: j.ip, cc: j.country || '', isp: (j.org || '').replace(/^AS\d+\s*/, ''), as: (/^AS\d+/.exec(j.org || '') || [''])[0] } : null; } catch { return null; } })
      : timedFetch('http://ip-api.com/json/?fields=status,query,countryCode,isp,org,as,hosting,proxy,mobile&lang=zh-CN', 8000).then(r => { try { const j = JSON.parse(r.text); return j.status === 'success' ? { ip: j.query, cc: j.countryCode, isp: j.isp || j.org || '', as: j.as || '', hosting: !!j.hosting, proxy: !!j.proxy, mobile: !!j.mobile } : null; } catch { return null; } }),
  ]);
  // 1.2.8：当前出口的 IPPure 风险系数（IPPure 在 Cloudflare 上 → 测的就是 ProxyIP 出口）
  const ipp = await timedFetch(`${ipq.PURE_URL}?x=${now()}`, 8000).then(r => ipq.parsePure({ text: r.text, status: r.status })).catch(() => null);
  if (ipp && !ipp.err && ipp.ip) await ipq.recordPure({ [ipp.ip]: ipp }).catch(() => {});
  let pure = null;
  if (cf?.ip && (cf.ip !== std?.ip || rt.active?.uni)) {
    const r = await timedFetch(`http://ip-api.com/json/${encodeURIComponent(cf.ip)}?fields=status,countryCode,isp,org,as,hosting,proxy,mobile&lang=zh-CN`, 8000);
    try { const j = JSON.parse(r.text); if (j.status === 'success') pure = { isp: j.isp || j.org || '', as: j.as || '', hosting: !!j.hosting, proxy: !!j.proxy, mobile: !!j.mobile }; } catch {}
  } else if (std) pure = { isp: std.isp, as: std.as, hosting: std.hosting, proxy: std.proxy, mobile: std.mobile };
  if (rt.status !== 'on') return;
  patchRt({ exit: { cf: cf || rt.exit?.cf || null, std: std || rt.exit?.std || null, pure: pure || rt.exit?.pure || null, ipp: ipp && !ipp.err ? ipp : (rt.exit?.ipp?.ip === cf?.ip ? rt.exit.ipp : null), at: now() } });
}

// ───────────── 连接 / 断开 ─────────────
export function connect({ reason = 'user' } = {}) {
  return runOp('connect', async () => {
    const s = await store.get('settings');
    if (!s.enabled) await store.mutate('settings', st => { st.enabled = true; });
    const level = await px.controlLevel();
    if (level === 'controlled_by_other_extensions' || level === 'not_controllable') {
      patchRt({ status: 'error', conflict: level, phase: '' }, { flush: true });
      throw new UserError(level === 'not_controllable' ? '代理设置被系统策略锁定，无法接管' : '代理设置正被其他扩展（如 SwitchyOmega）占用，请先停用它');
    }
    patchRt({ status: 'connecting', phase: '准备连接…', notice: null, conflict: '' }, { flush: true });
    const tried = new Set();
    // 快速通道：优先恢复上次可用线路，秒连
    const last = s.mode === 'manual' ? { key: routeKey(s.manual.nodeId, s.manual.pip) } : s.last;
    if (last?.key) {
      const c = await resolveCand(last.key);
      if (c && s.mode !== 'manual' && s.pipQuality?.enabled !== false) { ipq.setPrefs(s.pipQuality); if (ipq.risky(routeQ(c, await store.get('ipq')))) { store.log('info', `上次线路 IPPure 风险过高，重新选线：${c.name}`); c.st = { ...(c.st || {}), ok: false }; } }
      if (c && (s.mode === 'manual' || (c.st?.ok && (!s.region || c.st?.exit?.loc === s.region) && !(uniOnly() && c.viaCore && !c.route?.uni)))) {
        patchRt({ phase: `恢复上次线路：${c.name}` });
        tried.add(c.key);
        if (await tryApply(c)) { afterConnected(reason); return { ok: true, fast: true }; }
        if (s.mode === 'manual') notice('warn', '手动选择的线路暂不可用，已自动为你选择可用线路（连通性优先）');
      }
    }
    let res;
    try {
      res = await plan({ quick: true, speed: false, exclude: tried, phase: t => patchRt({ phase: t }) });
    } catch (e) {
      await degrade(e.message);
      throw e;
    }
    if (res.regionMiss) notice('warn', `${flag(res.regionMiss)} ${ccName(res.regionMiss)} 暂无可用 ProxyIP，已临时使用最快线路`);
    for (const c of res.ranked.slice(0, 5)) {
      if (tried.has(c.key)) continue;
      tried.add(c.key);
      patchRt({ phase: `连接 ${c.name}${c.pip ? ' · ' + shortPip(c.pip) : ''}` });
      if (await tryApply(c)) { afterConnected(reason); return { ok: true }; }
    }
    const why = !res.ranked.length ? (res.coreNote && !res.coreUp ? '本地核心未运行，无法使用 VLESS/Trojan 节点' : '没有测试通过的线路') : '候选线路均验证失败';
    await degrade(why);
    throw new UserError(why);
  });
}

function afterConnected(reason) {
  if (reason !== 'silent') log('info', '连接成功');
  // 后台补充完整优选（含测速），为容灾准备热备
  setTimeout(() => { backgroundOptimize({ force: false }).catch(() => {}); }, 4000);
}

async function degrade(why) {
  const s = await store.get('settings');
  const retries = (rt.retries || 0) + 1;
  const wait = Math.min(300, 15 * 2 ** Math.min(4, retries - 1));
  if (s.strict) {
    await px.applyPac(px.buildPac({ proxy: `SOCKS5 127.0.0.1:${Core.port || s.core.port}`, strict: true, scope: s.scope, directList: s.directList, proxyList: s.proxyList }));
    patchRt({ status: 'error', phase: '', retries, retryAt: now() + wait * 1000, notice: { lv: 'err', text: `${why}。严格防泄漏模式已阻断流量，${wait} 秒后自动重试`, at: now() } }, { flush: true });
  } else {
    await px.clearProxy();
    await px.setWebRtcProtection(false);
    patchRt({ status: 'degraded', phase: '', retries, retryAt: now() + wait * 1000, notice: { lv: 'warn', text: `${why}。已暂时直连保持网络畅通，${wait} 秒后自动重试`, at: now() } }, { flush: true });
  }
  log('warn', `降级：${why}`);
  if (retries === 1) notify('Brana VPN 已降级', `${why}。${s.strict ? '已阻断流量防止泄漏' : '已暂时直连，网络保持畅通'}，稍后自动重试。`);
}

export function disconnect() {
  return runOp('disconnect', async () => {
    await store.mutate('settings', st => { st.enabled = false; });
    await px.clearProxy();
    await px.setWebRtcProtection(false);
    if (Core.up) { try { await Core.call('apply', { routes: [], reset: true }, 5000); } catch {} }
    if (Core.via === 'native') Core.disconnect();
    patchRt({ core: { ...rt.core, up: false, via: '' } });
    patchRt({ status: 'off', phase: '', active: null, exit: null, since: 0, notice: null, retries: 0, retryAt: 0, speed: null, health: { ok: 0, fail: 0, at: 0, ms: 0, hist: [] } }, { flush: true });
    log('info', '已断开');
    return { ok: true };
  });
}

export async function toggle() {
  const s = await store.get('settings');
  if (s.enabled && rt.status !== 'off') return disconnect();
  return connect();
}

// ───────────── 容灾切换 ─────────────
let failoverRunning = false;
export async function failover(reason) {
  if (failoverRunning) return;
  failoverRunning = true;
  try {
    await runOp('failover', async () => {
      const s = await store.get('settings');
      if (!s.enabled) return;
      const from = rt.active;
      patchRt({ status: 'switching', phase: `${reason}，正在切换备用线路…` }, { flush: true });
      log('warn', `触发容灾：${reason}${from ? '（' + from.name + '）' : ''}`);
      if (from?.pip) await pool.cool(from.pip, 15, reason);
      if (from) await store.mutate('stats', st => { const o = st.routes[from.key]; if (o) { o.succ = +((o.succ ?? 1) * 0.4).toFixed(3); o.fails = (o.fails || 0) + 1; o.ok = false; o.err = reason; o.at = now(); } });
      const tried = new Set(from ? [from.key] : []);
      for (const r of rt.ranking || []) {
        if (tried.has(r.key)) continue;
        const c = await resolveCand(r.key);
        if (!c || !c.st?.ok) continue;
        if (s.region && c.st?.exit?.loc && c.st.exit.loc !== s.region && (rt.ranking || []).some(x => x.key !== r.key)) { /* 先尝试同地区 */ }
        tried.add(c.key);
        patchRt({ phase: `切换到 ${c.name}${c.pip ? ' · ' + shortPip(c.pip) : ''}` });
        if (await tryApply(c)) { onSwitched(from, c, reason); return; }
      }
      try {
        const res = await plan({ quick: true, speed: false, exclude: tried, force: true, phase: t => patchRt({ phase: t }) });
        for (const c of res.ranked.slice(0, 5)) {
          if (tried.has(c.key)) continue;
          tried.add(c.key);
          if (await tryApply(c)) { onSwitched(from, c, reason); return; }
        }
      } catch {}
      await degrade('所有线路暂时不可用');
    });
  } finally {
    failoverRunning = false;
  }
}

function onSwitched(from, to, reason) {
  const t = `${reason}，已自动切换到 ${to.name}${to.pip ? ' · ' + shortPip(to.pip) : ''}`;
  notice('info', t);
  log('info', t);
  if (rt.retries) notify('Brana VPN 已恢复', '线路已恢复正常');
  setTimeout(() => { backgroundOptimize({ force: false }).catch(() => {}); }, 5000);
}

// ───────────── 无感升级：主线路失败而热备正在正常工作时，原地提升热备为主线路（不重置任何连接）─────────────
let promoting = false;
async function softPromote(coreStatus, reason) {
  if (promoting || busy() || rt.status !== 'on' || !rt.active?.viaCore) return false;
  promoting = true;
  try {
    const cur = rt.active;
    const t = now();
    const alive = Object.entries(coreStatus.routeStats || {})
      .filter(([k, v]) => k !== cur.key && v.consec === 0 && v.lastOk && t - v.lastOk < 120e3 && !v.down)
      .sort((a, b) => b[1].lastOk - a[1].lastOk);
    if (!alive.length) return false;
    const c = await resolveCand(alive[0][0]);
    if (!c) return false;
    const s = await store.get('settings');
    const fallbacks = (await pickFallbacks(c)).filter(f => f.key !== cur.key);
    await Core.call('apply', { routes: [c.route, ...fallbacks.map(f => f.route)], directFallback: s.directFallback && !s.strict, strict: s.strict, reset: false }, 8000);
    if (cur.pip) await pool.cool(cur.pip, 15, reason);
    await store.mutate('stats', st => { const o = st.routes[cur.key]; if (o) { o.succ = +((o.succ ?? 1) * 0.4).toFixed(3); o.fails = (o.fails || 0) + 1; o.ok = false; o.err = reason; o.at = now(); } });
    const n = (await nodesMap()).get(c.nodeId);
    patchRt({ active: { key: c.key, nodeId: c.nodeId, pip: c.pip, viaCore: true, uni: !!c.route?.uni, kind: c.kind, name: c.name, nodeName: n?.name || c.name, ms: c.st?.ms || 0, cold: c.st?.cold || 0, mbps: c.st?.mbps || 0, hint: c.st?.exit?.loc || '', cfFail: !!c.st?.cfFail, at: now() } }, { flush: true });
    await store.mutate('settings', st => { st.last = { key: c.key, viaCore: true, at: now() }; if (st.mode === 'manual') st.manual = { nodeId: c.nodeId, pip: c.pip }; });
    const msg = `${reason}，已无感切换到热备 ${c.name}${c.pip ? ' · ' + shortPip(c.pip) : ''}（连接未中断）`;
    notice('info', msg);
    log('info', msg);
    refreshExit().catch(() => {});
    setTimeout(() => { backgroundOptimize({ force: false }).catch(() => {}); }, 3000);
    return true;
  } catch (e) {
    log('warn', '无感升级失败：' + e.message);
    return false;
  } finally {
    promoting = false;
  }
}

// ───────────── 健康监测（闹钟每 30 秒唤醒）─────────────
let healthRunning = false;
export async function healthTick() {
  if (healthRunning) return;
  healthRunning = true;
  try {
    await loadRt();
    const s = await store.get('settings');
    if (!s.enabled) { if (rt.status !== 'off') patchRt({ status: 'off' }); return; }
    if (busy()) return;
    if (rt.status === 'off') { connect({ reason: 'silent' }).catch(() => {}); return; }
    if (rt.status === 'degraded' || rt.status === 'error') {
      if (now() >= (rt.retryAt || 0)) {
        log('info', '自动重试连接…');
        const wasDegraded = true;
        try { await connect({ reason: 'silent' }); if (wasDegraded) { notify('Brana VPN 已恢复', '线路恢复正常，已重新接管浏览器流量'); log('info', '已从降级状态恢复'); } } catch {}
      }
      return;
    }
    if (rt.status !== 'on' || !rt.active) return;
    if (rt.active.viaCore && !Core.up) { await coreRecover(); return; }
    const n = (rt.health?.n || 0) + 1;
    // 不用 cp.cloudflare.com：edgetunnel 会拦截测速站点（经节点访问没有响应），会被误判为节点故障
    const url = rt.active.cfFail || n % 2 ? s.test.latencyUrl : (s.test.cfUrl || 'https://www.cloudflare.com/cdn-cgi/trace');
    const r = await timedFetch(`${url}${url.includes('?') ? '&' : '?'}h=${now()}`, 7000, { noBody: true });
    const ok = r.ok && r.status < 500;
    const hist = [...(rt.health?.hist || []), { t: now(), ms: ok ? r.ms : null }].slice(-40);
    const fail = ok ? 0 : (rt.health?.fail || 0) + 1;
    patchRt({ health: { n, ok: ok ? (rt.health?.ok || 0) + 1 : 0, fail, at: now(), ms: ok ? r.ms : rt.health?.ms || 0, hist } });
    let coreDown = false;
    if (rt.active.viaCore && Core.up) {
      try {
        const st = await Core.call('status', {}, 5000);
        const rs = st.routeStats?.[rt.active.key];
        coreDown = !!(rs && rs.down);
        patchRt({ traffic: { up: st.up, down: st.down, rateUp: st.rateUp, rateDown: st.rateDown, conns: st.conns, failovers: st.failovers, direct: st.direct, at: now() } });
        const failing = rs && rs.consec >= 1 && rs.lastFail > rs.lastOk && now() - rs.lastFail < 120e3;
        if ((failing || coreDown) && await softPromote(st, coreDown ? '主线路连续失败' : '主线路出现失败')) return;
      } catch {}
    }
    if (fail >= 2 || coreDown) { await failover(coreDown ? '主线路连续失败' : '健康检查连续失败'); return; }
    if (now() - (rt.exit?.at || 0) > 10 * 60e3) refreshExit().catch(() => {});
    if (s.mode === 'auto' && s.autoSwitch && now() - (rt.lastPlan || 0) > (s.optimizeMin || 20) * 60e3) backgroundOptimize({ force: true }).catch(() => {});
  } finally {
    healthRunning = false;
  }
}

// 后台复测：更新热备，必要时切换到明显更优的线路（有滞回，避免频繁跳变）
export function backgroundOptimize({ force = false } = {}) {
  return runOp('optimize-bg', async () => {
    const s = await store.get('settings');
    if (!s.enabled || rt.status !== 'on') return;
    let res;
    try { res = await plan({ force, quick: false, speed: true }); } catch { return; }
    if (s.mode !== 'auto' || !s.autoSwitch || !res.ranked.length || !rt.active) { if (rt.active) await refreshFallbacks(); return; }
    const best = res.ranked[0];
    const cur = res.all.find(c => c.key === rt.active.key) || await resolveCand(rt.active.key);
    const curScore = score(cur?.st), bestScore = score(best.st);
    // 1.2.8：当前线路已被判为高风险（IPPure）而有低风险线路时，也切换
    const curRisky = s.pipQuality?.enabled !== false && ipq.risky(cur?.st?.q) && !ipq.risky(best.st?.q);
    if (best.key !== rt.active.key && (curScore === Infinity || bestScore < curScore * 0.6 || curRisky)) {
      if (curRisky) log('info', `当前出口 IPPure 风险系数 ${cur.st.q.fraud}% 过高，切换到低风险线路`);
      log('info', `后台发现更优线路：${best.name}${best.pip ? ' · ' + shortPip(best.pip) : ''}（评分 ${Math.round(bestScore)} vs ${curScore === Infinity ? '不可用' : Math.round(curScore)}）`);
      const from = rt.active;
      patchRt({ status: 'switching', phase: '切换到更优线路…' });
      if (await tryApply(best)) { notice('info', `已自动切换到更优线路：${best.name}`); return; }
      const back = await resolveCand(from.key);
      if (back && await tryApply(back, { silent: true })) return;
      setTimeout(() => { failover('切换更优线路失败').catch(() => {}); }, 0);
    } else {
      await refreshFallbacks();
    }
  }, { background: true });
}

async function refreshFallbacks() {
  if (!rt.active?.viaCore || !Core.up) return;
  const c = await resolveCand(rt.active.key);
  if (!c) return;
  const s = await store.get('settings');
  const fallbacks = await pickFallbacks(c);
  try { await Core.call('apply', { routes: [c.route, ...fallbacks.map(f => f.route)], directFallback: s.directFallback && !s.strict, strict: s.strict, reset: false }, 8000); } catch {}
}

// ───────────── 用户操作 ─────────────
export function optimize() {
  return runOp('optimize', async () => {
    const s = await store.get('settings');
    const t0 = now();
    const wasOn = rt.status === 'on';
    if (!wasOn) patchRt({ status: 'connecting' });
    let res;
    try {
      res = await plan({ force: true, quick: false, speed: true, phase: t => patchRt({ phase: t }) });
    } catch (e) {
      if (!wasOn) await degrade(e.message);
      throw e;
    }
    if (!res.ranked.length) {
      if (!wasOn) await degrade('没有测试通过的线路');
      throw new UserError(res.coreNote && !res.coreUp ? '本地核心未运行，无法使用 VLESS/Trojan 节点' : '没有测试通过的线路，请检查节点或 ProxyIP 来源');
    }
    if (!s.enabled) await store.mutate('settings', st => { st.enabled = true; st.mode = 'auto'; });
    else if (s.mode !== 'auto') await store.mutate('settings', st => { st.mode = 'auto'; });
    for (const c of res.ranked.slice(0, 5)) {
      if (rt.active?.key === c.key && rt.status === 'on') { await refreshFallbacks(); return summaryOf(c, res, t0, true); }
      patchRt({ status: rt.status === 'on' ? 'switching' : 'connecting', phase: `应用 ${c.name}` });
      if (await tryApply(c)) return summaryOf(c, res, t0, false);
    }
    if (wasOn && rt.active) {
      const back = await resolveCand(rt.active.key);
      if (back && await tryApply(back, { silent: true })) throw new UserError('新候选线路验证均未通过，已保持当前线路');
    }
    await degrade('候选线路均验证失败');
    throw new UserError('候选线路均验证失败');
  });
}

function summaryOf(c, res, t0, same) {
  const st = c.st || {};
  const loc = st.exit?.loc;
  const msg = `${same ? '当前已是最优' : '已切换到最优'}：${c.name}${c.pip ? ' · ' + shortPip(c.pip) : ''}${loc ? ' · ' + flag(loc) + ' ' + ccName(loc) : ''} · ${st.ms || '?'}ms${st.mbps ? ' · ' + st.mbps + 'Mbps' : ''}`;
  notice('ok', msg);
  return { ok: true, message: msg, tested: res.all.length, seconds: Math.round((now() - t0) / 1000), regionMiss: res.regionMiss };
}

export function nextIp() {
  return runOp('next-ip', async () => {
    const s = await store.get('settings');
    if (rt.status !== 'on' || !rt.active) throw new UserError('请先连接');
    const cur = rt.active;
    if (!cur.viaCore) throw new UserError('当前是普通代理节点，没有可更换的 ProxyIP；可在节点列表中切换节点');
    const node = (await nodesMap()).get(cur.nodeId);
    if (!node) throw new UserError('当前节点已被删除');
    const region = s.region || cur.hint || '';
    const curExit = rt.exit?.cf?.ip || '';
    if (cur.pip) await pool.cool(cur.pip, 20, '手动换 IP');
    patchRt({ status: 'switching', phase: '寻找新的出口 IP…' });
    const stats = await store.get('stats');
    let pips = await pool.candidates({ region, limit: 10, exclude: [cur.pip], only: uniOnly() });
    const stale = pips.filter(pip => !fresh(stats.routes[routeKey(node.id, pip)], ROUTE_TTL));
    if (stale.length) {
      patchRt({ phase: `检测 ${stale.length} 个 ProxyIP…` });
      const items = stale.map(pip => ({ key: routeKey(node.id, pip), pip }));
      const res = await Core.call('probe', { routes: items.map(it => buildRoute(node, it.pip)), url: s.test.cfUrl, count: 2, timeout: 7000, concurrency: 8 }, 90000);
      await recordRouteResults(items, res);
    }
    const st2 = await store.get('stats');
    // 优先选择出口 IP 不同的；若都相同（同一反代集群）则退而求其次换一个 ProxyIP
    const list = pips.map(pip => mkCand(node, pip, st2.routes[routeKey(node.id, pip)]))
      .filter(c => c.st?.ok && (!region || c.st.exit?.loc === region))
      .sort((a, b) => ((curExit && a.st.exit?.ip === curExit) - (curExit && b.st.exit?.ip === curExit)) || score(a.st) - score(b.st));
    for (const c of list.slice(0, 4)) {
      patchRt({ phase: `切换到 ${shortPip(c.pip)}` });
      if (await tryApply(c)) {
        const same = curExit && (rt.exit?.cf?.ip || c.st.exit?.ip) === curExit;
        const m = same ? `已更换 ProxyIP：${shortPip(c.pip)}（出口 IP 未变化，该地区可用出口较少）` : `已更换出口：${c.st.exit?.ip || shortPip(c.pip)}${c.st.exit?.loc ? ' ' + flag(c.st.exit.loc) : ''} · ${c.st.ms}ms`;
        notice('ok', m);
        return { ok: true, message: m };
      }
    }
    const back = await resolveCand(cur.key);
    if (back) await tryApply(back, { silent: true });
    patchRt({ status: 'on', phase: '' });
    throw new UserError(region ? `${flag(region)} ${ccName(region)} 暂无更多可用 ProxyIP，可在 ProxyIP 页添加来源` : '暂无更多可用 ProxyIP');
  });
}

export async function setRegion(cc) {
  cc = String(cc || '').toUpperCase();
  await store.mutate('settings', st => { st.region = cc; if (st.mode === 'manual') st.mode = 'auto'; });
  const s = await store.get('settings');
  if (!s.enabled) return { ok: true };
  return runOp('region', async () => {
    patchRt({ status: rt.status === 'on' ? 'switching' : 'connecting', phase: cc ? `切换到 ${flag(cc)} ${ccName(cc)}…` : '切换到最快线路…' });
    const res = await plan({ quick: false, speed: false, phase: t => patchRt({ phase: t }) });
    if (res.regionMiss) notice('warn', `${flag(cc)} ${ccName(cc)} 暂无可用 ProxyIP，已使用最快线路。可在 ProxyIP 页导入该地区来源`);
    for (const c of res.ranked.slice(0, 5)) {
      if (rt.active?.key === c.key && rt.status !== 'off' && rt.status !== 'degraded' && rt.status !== 'error') { patchRt({ status: 'on', phase: '' }); return { ok: true, same: true }; }
      if (await tryApply(c)) return { ok: true };
    }
    if (rt.active) { const back = await resolveCand(rt.active.key); if (back && await tryApply(back, { silent: true })) return { ok: false }; }
    await degrade('没有可用线路');
    throw new UserError('没有可用线路');
  });
}

export async function selectRoute(nodeId, pip = '') {
  const c = await resolveCand(routeKey(nodeId, pip));
  if (!c) throw new UserError('节点不存在或不受支持');
  return runOp('select', async () => {
    const wasOn = rt.status === 'on';
    if (!(await store.get('settings')).enabled) await store.mutate('settings', st => { st.enabled = true; });
    patchRt({ status: wasOn ? 'switching' : 'connecting', phase: `连接 ${c.name}${pip ? ' · ' + shortPip(pip) : ''}` });
    if (await tryApply(c)) {
      await store.mutate('settings', st => { st.mode = 'manual'; st.manual = { nodeId, pip: pip || '' }; });
      notice('ok', `已切换到 ${c.name}${pip ? ' · ' + shortPip(pip) : ''}`);
      return { ok: true };
    }
    if (wasOn && rt.active && rt.active.key !== c.key) {
      const back = await resolveCand(rt.active.key);
      if (back && await tryApply(back, { silent: true })) throw new UserError('该线路暂不可用，已保持原线路');
    }
    patchRt({ status: 'connecting' });
    const res = await plan({ quick: true, speed: false }).catch(() => ({ ranked: [] }));
    for (const x of res.ranked.slice(0, 4)) if (await tryApply(x)) throw new UserError('该线路暂不可用，已自动连接可用线路（连通性优先）');
    await degrade('所选线路不可用');
    throw new UserError('该线路暂不可用');
  });
}

export async function setMode(mode) {
  await store.mutate('settings', st => { st.mode = mode === 'manual' ? 'manual' : 'auto'; if (st.mode === 'manual' && rt.active) st.manual = { nodeId: rt.active.nodeId, pip: rt.active.pip }; });
  if (mode === 'auto' && rt.status === 'on') backgroundOptimize({ force: false }).catch(() => {});
  return { ok: true };
}

// 浏览器路径测速（真实反映当前线路）
export function speedTest() {
  return runOp('speed', async () => {
    if (rt.status !== 'on') throw new UserError('请先连接');
    const s = await store.get('settings');
    const url = s.test.speedUrl + (s.test.speedUrl.includes('?') ? '&' : '?') + 't=' + now();
    const seconds = Math.max(3, Math.min(10, s.test.speedSeconds || 5));
    patchRt({ speed: { running: true, mbps: 0, progress: 0, at: now() } }, { flush: true });
    const ctl = new AbortController();
    const killer = setTimeout(() => ctl.abort(), (seconds + 8) * 1000);
    let bytes = 0, first = 0, firstBytes = 0, last = 0, lastPush = 0;
    try {
      const r = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctl.signal });
      const reader = r.body.getReader();
      const t0 = performance.now();
      const stopAt = t0 + seconds * 1000;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const t = performance.now();
        if (!first) { first = t; firstBytes = value.length; }
        bytes += value.length;
        last = t;
        if (t - lastPush > 250 && last > first) {
          lastPush = t;
          const mbps = +((bytes - firstBytes) * 8 / ((last - first) / 1000) / 1e6).toFixed(1);
          patchRt({ speed: { running: true, mbps, progress: Math.min(1, (t - t0) / (seconds * 1000)), at: now() } }, { flush: true });
        }
        if (t > stopAt) { ctl.abort(); break; }
      }
    } catch (e) {
      if (!bytes) { patchRt({ speed: { running: false, mbps: 0, err: e.name === 'AbortError' ? '超时' : e.message, at: now() } }, { flush: true }); throw new UserError('测速失败：' + (e.name === 'AbortError' ? '超时' : e.message)); }
    } finally { clearTimeout(killer); }
    const secs = Math.max(0.05, (last - first) / 1000);
    const mbps = +((Math.max(0, bytes - firstBytes)) * 8 / secs / 1e6).toFixed(1);
    patchRt({ speed: { running: false, mbps, progress: 1, bytes, at: now() }, active: rt.active ? { ...rt.active, mbps } : rt.active }, { flush: true });
    if (rt.active) await store.mutate('stats', st => { const o = st.routes[rt.active.key]; if (o) { o.mbps = mbps; o.sAt = now(); } });
    if (rt.active?.pip && mbps > 0) await pool.recordSpeed(rt.active.pip, mbps).catch(() => {});
    return { ok: true, mbps, bytes };
  });
}

// ───────────── Cloudflare 优选 IP ─────────────
export async function scanNode(nodeId, { silent = false } = {}) {
  if (!(await ensureCore())) throw new UserError('扫描优选 IP 需要本地核心');
  const n = (await nodesMap()).get(nodeId);
  if (!n || !needsCore(n)) throw new UserError('仅 VLESS/Trojan 节点支持优选 IP');
  const r = await Core.call('scan', { route: { ...buildRoute(n, ''), address: n.address, addrs: undefined, addrsMain: undefined }, sample: 72, top: 8 }, 90000);
  await store.mutate('nodes', list => {
    const x = list.find(v => v.id === nodeId);
    if (!x) return;
    x.prefTriedAt = now();
    if (r.list?.length) { x.prefAddr = r.list[0].ip; x.prefList = r.list.slice(0, 5); x.prefAt = now(); }
  });
  await store.mutate('stats', st => { delete st.nodes[nodeId]; });
  if (!silent) log('info', `优选 IP：${n.name} → ${r.list?.[0]?.ip || '未找到'}（扫描 ${r.scanned}，可达 ${r.reachable}）`);
  return r;
}

export async function clearPref(nodeId) {
  await store.mutate('nodes', list => { const x = list.find(v => v.id === nodeId); if (x) { delete x.prefAddr; delete x.prefList; delete x.prefAt; } });
  await store.mutate('stats', st => { delete st.nodes[nodeId]; });
  return { ok: true };
}

// ───────────── 节点 / 订阅 ─────────────
async function fetchSub(url) {
  const tryCore = async () => {
    if (!(await ensureCore())) return null;
    const r = await Core.call('fetch', { url, timeout: 15000, ua: 'v2rayN/7.10.0' }, 40000);
    return r && r.ok ? r.text : (() => { throw new Error('HTTP ' + (r && r.status)); })();
  };
  const tryBrowser = async u => {
    const r = await timedFetch(u, 15000);
    if (!r.ok) throw new Error(r.err);
    if (r.status >= 400) throw new Error('HTTP ' + r.status);
    return r.text;
  };
  let text = null;
  try { text = await tryCore(); } catch (e) { text = null; }
  if (text == null) text = await tryBrowser(url);
  if (/^\s*<(!doctype|html)/i.test(text)) {
    for (const p of ['b64', 'base64']) {
      try { const t = await tryBrowser(url + (url.includes('?') ? '&' : '?') + p); if (!/^\s*<(!doctype|html)/i.test(t)) { text = t; break; } } catch {}
    }
  }
  return text;
}

export async function updateSub(subId) {
  const subs = await store.get('subs');
  const sub = subs.find(x => x.id === subId);
  if (!sub) throw new UserError('订阅不存在');
  let text;
  try { text = await fetchSub(sub.url); } catch (e) {
    await store.mutate('subs', l => { const x = l.find(v => v.id === subId); if (x) { x.err = e.message; x.tried = now(); } });
    throw new UserError('订阅获取失败：' + e.message);
  }
  const links = extractLinks(text);
  const parsed = links.map(l => ({ l, n: parseLink(l) })).filter(x => x.n);
  const good = parsed.filter(x => !x.n.unsupported);
  const unsupported = parsed.length - good.length;
  if (!good.length) {
    const err = parsed.length ? `${unsupported} 个节点均为暂不支持的协议` : '订阅内容中没有识别到节点';
    await store.mutate('subs', l => { const x = l.find(v => v.id === subId); if (x) { x.err = err; x.tried = now(); } });
    throw new UserError(err);
  }
  // edgetunnel：同 Host + UUID 的条目合并成一个节点（地址交给优选 IP）
  const merged = collapseEt(good.map(({ l, n }) => ({ ...n, link: l })));
  let added = 0, kept = 0, removed = 0, removedIds = [];
  await store.mutate('nodes', list => {
    const old = new Map(list.filter(n => n.subId === subId).map(n => [nodeSig(n), n]));
    const next = [];
    for (const n of merged) {
      const l = n.link;
      const sig = nodeSig(n);
      const prev = old.get(sig);
      if (prev) { next.push({ ...prev, ...n, id: prev.id, enabled: prev.enabled, prefAddr: prev.prefAddr, prefList: prev.prefList, prefAt: prev.prefAt, prefTriedAt: prev.prefTriedAt, link: l, subId }); old.delete(sig); kept++; }
      else if (!next.some(x => nodeSig(x) === sig)) { next.push({ ...n, id: uid('n'), link: l, subId, enabled: true, createdAt: now() }); added++; }
    }
    removed = old.size;
    removedIds = [...old.values()].map(n => n.id);
    const others = list.filter(n => n.subId !== subId);
    list.length = 0;
    list.push(...others, ...next);
  });
  await store.mutate('subs', l => { const x = l.find(v => v.id === subId); if (x) { x.at = now(); x.count = merged.length; x.entries = good.length; x.err = ''; x.unsupported = unsupported; } });
  if (removedIds.length) await dropNodeRefs(removedIds, '订阅更新后当前节点已不存在');
  const etN = merged.filter(n => n.et).length;
  log('info', `订阅「${sub.name}」已更新：${merged.length} 个节点${etN ? `（${good.length} 个条目，edgetunnel 同一节点已合并，连接地址使用优选 IP）` : ''}（新增 ${added}，移除 ${removed}${unsupported ? '，不支持 ' + unsupported : ''}）`);
  return { ok: true, count: merged.length, entries: good.length, merged: etN, added, removed, unsupported };
}

export async function updateAllSubs({ stale = false } = {}) {
  const s = await store.get('settings');
  const subs = await store.get('subs');
  const out = [];
  for (const sub of subs) {
    if (stale && sub.at && now() - sub.at < (s.subsHours || 12) * 3600e3) continue;
    try { out.push({ id: sub.id, ...(await updateSub(sub.id)) }); } catch (e) { out.push({ id: sub.id, ok: false, error: e.message }); }
  }
  return out;
}

export async function importText(text) {
  const r = parseImport(text);
  let added = 0, dup = 0;
  await store.mutate('nodes', list => {
    const sigs = new Set(list.map(nodeSig));
    for (const n of collapseEt(r.nodes)) {
      const sig = nodeSig(n);
      if (sigs.has(sig)) { dup++; continue; }
      sigs.add(sig);
      const { network, security, ...rest } = n;
      list.push({ ...rest, id: uid('n'), enabled: true, createdAt: now() });
      added++;
    }
  });
  const subResults = [];
  for (const url of r.subs) {
    const subs = await store.get('subs');
    let sub = subs.find(x => x.url === url);
    if (!sub) {
      sub = { id: uid('s'), name: subName(url), url, at: 0, count: 0, err: '' };
      await store.mutate('subs', l => { l.push(sub); });
    }
    try { subResults.push({ url, ...(await updateSub(sub.id)) }); } catch (e) { subResults.push({ url, ok: false, error: e.message }); }
  }
  if (added || subResults.some(x => x.ok)) log('info', `导入：新增节点 ${added}${dup ? '，重复 ' + dup : ''}${subResults.length ? '，订阅 ' + subResults.length : ''}`);
  return { added, dup, unsupported: r.unsupported, bad: r.bad, subs: subResults };
}

function subName(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '订阅'; } }

export async function saveNode(node) {
  const n = { ...node };
  if (!n.kind || !n.address || !n.port) throw new UserError('请填写完整的节点信息');
  if (n.kind === 'vless' && !/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(n.uuid || '')) throw new UserError('UUID 格式无效');
  if (n.kind === 'trojan' && !n.password) throw new UserError('请填写 Trojan 密码');
  n.port = +n.port;
  n.name = String(n.name || '').trim() || `${n.kind.toUpperCase()} ${n.address}`;
  await store.mutate('nodes', list => {
    const i = list.findIndex(x => x.id === n.id);
    if (i >= 0) list[i] = { ...list[i], ...n };
    else list.push({ ...n, id: uid('n'), enabled: true, createdAt: now() });
  });
  if (n.id) await store.mutate('stats', st => { delete st.nodes[n.id]; for (const k of Object.keys(st.routes)) if (k.startsWith(n.id + '|')) delete st.routes[k]; });
  return { ok: true };
}

// 节点被删除/合并后：清理测速记录；正在使用的节点没了就切换
async function dropNodeRefs(ids, why) {
  const set = new Set(ids);
  await store.mutate('stats', st => { for (const id of set) delete st.nodes[id]; for (const k of Object.keys(st.routes)) if (set.has(k.split('|')[0])) delete st.routes[k]; });
  if (rt && rt.active && set.has(rt.active.nodeId) && rt.status === 'on') failover(why).catch(() => {});
}
// 升级迁移：已有订阅里同一个 edgetunnel 节点的多个条目合并成一个（保留第一个节点的 ID 与历史）
export async function collapseStoredEt() {
  let gone = [], groups = 0;
  await store.mutate('nodes', list => {
    const bySub = new Map();
    for (const n of list) if (n.subId) { if (!bySub.has(n.subId)) bySub.set(n.subId, []); bySub.get(n.subId).push(n); }
    for (const [, arr] of bySub) {
      const merged = collapseEt(arr);
      if (merged.length === arr.length && merged.every((m, i) => m === arr[i])) continue;
      const keepIds = new Set();
      for (const m of merged) {
        if (!m.et || arr.includes(m)) { keepIds.add(m.id); continue; }
        // 合并出来的新对象沿用组里第一个节点的 ID（保留启用状态）
        const first = arr.find(n => nodeSig({ ...n, et: 1 }) === nodeSig(m));
        m.id = first ? first.id : m.id;
        m.enabled = first ? first.enabled !== false : true;
        keepIds.add(m.id);
        groups++;
      }
      gone.push(...arr.filter(n => !keepIds.has(n.id)).map(n => n.id));
      const idx = list.indexOf(arr[0]);
      const rest = list.filter(n => !arr.includes(n));
      rest.splice(Math.max(0, Math.min(idx, rest.length)), 0, ...merged);
      list.length = 0; list.push(...rest);
    }
  });
  if (gone.length) {
    const nodes = await store.get('nodes');
    await store.mutate('subs', l => { for (const x of l) { const c = nodes.filter(n => n.subId === x.id).length; if (c && c !== x.count) { x.entries = Math.max(x.entries || 0, x.count || 0); x.count = c; } } });
    log('info', `edgetunnel 订阅节点已合并：${groups} 个节点（去掉 ${gone.length} 个重复条目），连接地址使用优选 IP`);
    await dropNodeRefs(gone, 'edgetunnel 节点已合并');
  }
}

export async function removeNodes(ids) {
  const set = new Set(ids);
  await store.mutate('nodes', list => { const keep = list.filter(n => !set.has(n.id)); list.length = 0; list.push(...keep); });
  await store.mutate('stats', st => { for (const id of set) delete st.nodes[id]; for (const k of Object.keys(st.routes)) if (set.has(k.split('|')[0])) delete st.routes[k]; });
  if (rt.active && set.has(rt.active.nodeId) && rt.status === 'on') failover('当前节点已删除').catch(() => {});
  return { ok: true };
}

export async function removeSub(subId, { withNodes = true } = {}) {
  await store.mutate('subs', l => { const k = l.filter(x => x.id !== subId); l.length = 0; l.push(...k); });
  if (withNodes) { const ids = (await store.get('nodes')).filter(n => n.subId === subId).map(n => n.id); await removeNodes(ids); }
  return { ok: true };
}

// ───────────── ProxyIP 来源 ─────────────
export async function setSources(lines) {
  const parsed = lines.map(l => parsePoolLine(l)).filter(Boolean);
  const uniq = [...new Map(parsed.map(p => [p.line, p.line])).values()];
  const before = (await store.get('pool')).sources;
  const added = uniq.filter(l => !before.includes(l));
  await store.mutate('pool', d => { d.sources = uniq; });
  const r = await pool.refreshSources({ only: added.length ? added : [], inUse: rt.active?.pip || '' });
  return { ok: true, sources: uniq.length, invalid: lines.length - parsed.length, ...r };
}

export async function poolClear(what) {
  const inUse = rt.active?.pip || '';
  let n = 0;
  await store.mutate('pool', d => {
    for (const [k, e] of Object.entries(d.items)) {
      if (k === inUse) continue;
      const hit = what === 'all' || (what === 'bad' && e.ok === false) || (what === 'untested' && (e.ok === null || e.ok === undefined)) || (what === 'risky' && e.risky);
      if (hit) { if (what === 'all' || what === 'untested') delete d.items[k]; else e.ban = true; n++; }
    }
  });
  return { ok: true, removed: n };
}

export async function poolBan(keys, ban = true) {
  await store.mutate('pool', d => { for (const k of keys) if (d.items[k]) d.items[k].ban = ban; });
  return { ok: true };
}

// ───────────── 分流规则 ─────────────
export async function siteRule(host, action) {
  const h = normDomain(host);
  if (!h) throw new UserError('域名无效');
  await store.mutate('settings', st => {
    st.directList = st.directList.filter(d => d !== h);
    st.proxyList = st.proxyList.filter(d => d !== h);
    if (action === 'direct') st.directList.push(h);
    if (action === 'proxy') st.proxyList.push(h);
  });
  await reapplyPac();
  return { ok: true, host: h };
}

export async function reapplyPac() {
  if (rt.status !== 'on' || !rt.active) return;
  const c = await resolveCand(rt.active.key);
  if (!c) return;
  const fallbacks = await pickFallbacks(c);
  const s = await store.get('settings');
  const base = { strict: s.strict, scope: s.scope, directList: s.directList, proxyList: s.proxyList };
  if (c.viaCore) await px.applyPac(px.buildPac({ ...base, proxy: `SOCKS5 127.0.0.1:${Core.port || s.core.port}` }));
  else await applyChrome(c, fallbacks);
  await px.setWebRtcProtection(!!s.webrtc);
}

// ───────────── 429 自动换 IP ─────────────
let last429 = 0;
export async function on429(details) {
  const s = await store.get('settings');
  if (!s.autoRotate429 || s.mode !== 'auto' || rt.status !== 'on' || !rt.active?.viaCore || busy()) return;
  const isCf = (details.responseHeaders || []).some(h => /^(cf-ray|cf-cache-status)$/i.test(h.name));
  if (!isCf || now() - last429 < 60e3) return;
  last429 = now();
  let host = '';
  try { host = new URL(details.url).hostname; } catch {}
  log('warn', `${host} 返回 429（出口 IP 被限流），自动更换 ProxyIP`);
  try { await nextIp(); notice('info', `${host} 限流（429），已自动更换出口 IP`); } catch (e) { log('warn', '自动换 IP 失败：' + e.message); }
}

// 优选 IP 列表变化（新一轮测试结果 / 日出日落切换）：经核心的连接无感更新地址，不中断现有连接
let refreshP = null;
export function refreshRoutes() {
  // 300ms 内的多次请求合并为一次
  return refreshP ||= sleep(300).then(async () => {
    refreshP = null;
    try {
      if (!rt || rt.status !== 'on' || !rt.active?.viaCore || opName || !Core.up) return false;
      const c = await resolveCand(rt.active.key);
      if (!c) return false;
      const fb = await pickFallbacks(c);
      await applyChrome(c, fb, { reset: false });
      return true;
    } catch (e) { log('warn', '更新优选 IP 失败：' + e.message); return false; }
  });
}

// ───────────── 启动恢复 ─────────────
export async function boot(reason) {
  await loadRt();
  await collapseStoredEt().catch(e => log('warn', '合并 edgetunnel 节点失败：' + e.message));
  // 旧版本升级：把新增的设置项（如 autoStart）补写进存储，界面页面直接读存储也能拿到默认值
  const raw = (await chrome.storage.local.get('settings').catch(() => ({}))).settings;
  if (raw && Object.keys(store.DEFAULT_SETTINGS).some(k => !(k in raw))) await store.mutate('settings', () => {});
  let s = await store.get('settings');
  // 本次浏览器会话的首次启动（浏览器刚打开 / 扩展刚重载）：按「启动自动连接」决定连接与否。
  // 不依赖 onStartup 事件的先后顺序 —— session 存储只在浏览器重启或扩展重载时清空。
  const ses = await chrome.storage.session.get('booted').catch(() => ({}));
  if (!ses.booted) {
    await chrome.storage.session.set({ booted: now() }).catch(() => {});
    const usable = (await store.get('nodes')).some(n => n.enabled !== false && !n.unsupported);
    const want = !!s.autoStart && usable;
    if (want !== !!s.enabled) await store.mutate('settings', st => { st.enabled = want; });
    s = await store.get('settings');
    if (want) log('info', reason === 'startup' ? '浏览器已启动，自动连接' : '扩展已启动，自动连接');
  }
  await syncBadge();
  refreshIcon();
  if (reason === 'install' || reason === 'update' || reason === 'startup') {
    store.get('pool').then(pd => { if (!Object.keys(pd.items).length && pd.sources.length) pool.refreshSources({ force: false }).catch(() => {}); });
  }
  if (!s.enabled) {
    if (rt.status !== 'off') patchRt({ status: 'off', active: null });
    const lv = await px.controlLevel();
    if (lv === 'controlled_by_this_extension') { await px.clearProxy(); await px.setWebRtcProtection(false); }
    return;
  }
  if (reason === 'wake' && (rt.status === 'connecting' || rt.status === 'switching')) {
    connect({ reason: 'silent' }).catch(() => {});
    return;
  }
  if (reason === 'wake' && rt.status !== 'off') {
    // Service Worker 被唤醒：会话状态仍在，若需要核心则确保核心连接
    if (rt.active?.viaCore && !Core.up) { const ok = await ensureCore(); if (ok) { const c = await resolveCand(rt.active.key); if (c) { const fb = await pickFallbacks(c); await applyChrome(c, fb).catch(() => {}); } } }
    return;
  }
  connect({ reason: 'silent' }).catch(() => {});
}
