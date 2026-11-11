// ProxyIP 池：来源（域名 / IP / 链式代理 / API）→ 解析 → 候选排序 → 记录检测结果
import * as store from './store.js';
import { Core } from './core.js';
import * as ipq from './ipq.js';
import { parsePoolLine, parseApiItems, isIPv4 } from '../shared/links.js';

const MAX_ITEMS = 3000;
const now = () => Date.now();

async function dohResolve(host) {
  const qs = [
    [`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, { accept: 'application/dns-json' }],
    [`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=1`, {}],
    [`https://dns.alidns.com/resolve?name=${encodeURIComponent(host)}&type=1`, {}],
  ];
  const one = async ([u, h]) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(u, { headers: h, signal: ctl.signal, cache: 'no-store', credentials: 'omit' });
      const j = await r.json();
      return (j.Answer || []).filter(a => a.type === 1).map(a => String(a.data).trim()).filter(isIPv4);
    } catch { return []; } finally { clearTimeout(t); }
  };
  const res = await Promise.all(qs.map(one));
  return [...new Set(res.flat())];
}

export async function resolveHosts(hosts) {
  if (!hosts.length) return {};
  if (Core.up) {
    try { return await Core.call('resolve', { hosts }, 45000); } catch {}
  }
  const out = {};
  for (const h of hosts) out[h] = await dohResolve(h);
  return out;
}

export async function fetchText(url, { timeout = 15000 } = {}) {
  if (Core.up) {
    try { const r = await Core.call('fetch', { url, timeout }, timeout + 10000); if (r && r.ok) return r.text; if (r) throw new Error('HTTP ' + r.status); } catch (e) { if (!/核心/.test(e.message)) throw e; }
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store', credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '请求超时' : e.message);
  } finally { clearTimeout(t); }
}

// 刷新来源：域名重新解析、API 重新拉取；新 IP 加入，消失的移除（正在使用的仅标记 gone）
export async function refreshSources({ force = false, only = null, inUse = '' } = {}) {
  const p = await store.get('pool');
  const lines = (only || p.sources).map(parsePoolLine).filter(Boolean);
  const domains = lines.filter(x => x.type === 'domain' && (force || !p.src[x.line] || now() - (p.src[x.line].at || 0) > 3 * 3600e3));
  const apis = lines.filter(x => x.type === 'api' && (force || !p.src[x.line] || now() - (p.src[x.line].at || 0) > 6 * 3600e3));
  const statics = lines.filter(x => x.type === 'ip' || x.type === 'chain');
  const resolved = await resolveHosts([...new Set(domains.map(d => d.host))]);
  const apiData = {};
  for (const a of apis) {
    try { apiData[a.line] = { items: parseApiItems(await fetchText(a.line), a.hint) }; } catch (e) { apiData[a.line] = { err: e.message }; }
  }
  return store.mutate('pool', d => {
    let added = 0, removed = 0;
    const touch = (key, base) => {
      const e = d.items[key];
      if (e) { e.gone = false; if (!e.hint && base.hint) e.hint = base.hint; return; }
      d.items[key] = { ...base, at: 0, ok: null };
      added++;
    };
    for (const s of statics) {
      if (s.type === 'ip') touch(s.line, { host: s.host, port: s.port, src: s.line });
      else touch(s.line, { host: s.host, port: s.port, chain: true, src: s.line });
      d.src[s.line] = { at: now(), n: 1, err: '' };
    }
    for (const dm of domains) {
      const ips = resolved[dm.host] || [];
      if (!ips.length) { d.src[dm.line] = { ...(d.src[dm.line] || {}), err: '解析失败', tried: now() }; continue; }
      const want = new Set(ips.map(ip => `${ip}:${dm.port}`));
      for (const k of want) touch(k, { host: k.split(':')[0], port: dm.port, src: dm.line, hint: dm.hint || '' });
      for (const [k, e] of Object.entries(d.items)) if (e.src === dm.line && !want.has(k)) { if (k === inUse) e.gone = true; else { delete d.items[k]; removed++; } }
      d.src[dm.line] = { at: now(), n: want.size, err: '' };
    }
    for (const a of apis) {
      const r = apiData[a.line];
      if (!r || r.err || !r.items.length) { d.src[a.line] = { ...(d.src[a.line] || {}), err: r?.err || '内容里没有识别到 IP', tried: now() }; continue; }
      const want = new Set(r.items.map(i => i.key));
      for (const it of r.items) touch(it.key, { host: it.host, port: it.port, src: a.line, hint: it.cc || a.hint || '' });
      for (const [k, e] of Object.entries(d.items)) if (e.src === a.line && !want.has(k)) { if (k === inUse) e.gone = true; else { delete d.items[k]; removed++; } }
      d.src[a.line] = { at: now(), n: want.size, err: '' };
    }
    // 来源被删除：清掉对应条目
    const live = new Set(p.sources.map(l => (parsePoolLine(l) || {}).line).filter(Boolean));
    for (const [k, e] of Object.entries(d.items)) if (e.src && !live.has(e.src) && k !== inUse) { delete d.items[k]; removed++; }
    for (const k of Object.keys(d.src)) if (!live.has(k)) delete d.src[k];
    // 容量控制：优先淘汰未检测 / 失败的
    const keys = Object.keys(d.items);
    if (keys.length > MAX_ITEMS) {
      const rank = e => (e.ok === true ? 0 : e.ok === null ? 1 : 2);
      keys.sort((a, b) => rank(d.items[a]) - rank(d.items[b]) || (d.items[b].at || 0) - (d.items[a].at || 0));
      for (const k of keys.slice(MAX_ITEMS)) if (k !== inUse) { delete d.items[k]; removed++; }
    }
    return { added, removed, total: Object.keys(d.items).length };
  });
}

export const itemCc = e => (e && (e.cc || e.hint)) || '';

export function itemScore(e) {
  if (!e || e.ok !== true) return Infinity;
  const succ = e.succ ?? 1;
  // 1.2.4：计入实测带宽（经该 ProxyIP 访问 Cloudflare 网站的速度），慢的 IP 不再因延迟低而总被选中
  const spd = e.mbps > 0 ? Math.max(0.55, Math.min(3, Math.sqrt(100 / e.mbps))) : 1.2;
  // 1.2.5：计入 IP 质量（住宅 / 纯净优先，见 ipq.qMult）
  return ((e.ms || 400) + 0.2 * (e.cold || 0)) * (1 + 2.5 * (1 - succ)) * spd * ipq.qMult(e.q, e.mbps);
}

// 1.2.4：记录经某 ProxyIP 的测速结果（平滑）
export async function recordSpeed(pip, mbps) {
  if (!pip || !(mbps > 0)) return;
  await store.mutate('pool', d => {
    const e = d.items[pip];
    if (!e) return;
    e.mbps = e.mbps > 0 ? +(e.mbps * 0.3 + mbps * 0.7).toFixed(1) : +mbps.toFixed(1);
    e.sAt = Date.now();
  });
}

// 选出本轮要测试/使用的 ProxyIP：已验证可用的优先，再混入少量未测的（持续发现更好的 IP）
export async function candidates({ region = '', limit = 8, exclude = [], only = null } = {}) {
  const p = await store.get('pool');
  const t = now();
  const ex = new Set(exclude);
  const base = Object.entries(p.items).filter(([k, e]) => !ex.has(k) && !e.ban && !e.gone && !((e.cool || 0) > t) && (!only || only.has(k)));
  // 1.2.8：IPPure 高风险的自动拉黑；一个低风险可用 / 未测的都没有时，临时放宽（按风险从低到高）
  let all = base.filter(([, e]) => !ipq.risky(e.q));
  if (!all.some(([, e]) => e.ok !== false)) all = base.filter(([, e]) => ipq.risky(e.q)).sort((a, b) => (a[1].q.fraud || 0) - (b[1].q.fraud || 0));
  const inRegion = region ? all.filter(([, e]) => itemCc(e) === region) : all;
  const good = inRegion.filter(([, e]) => e.ok === true).sort((a, b) => itemScore(a[1]) - itemScore(b[1]));
  const fresh = inRegion.filter(([, e]) => e.ok === null || e.ok === undefined);
  const failed = inRegion.filter(([, e]) => e.ok === false && t - (e.at || 0) > 30 * 60e3).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  // 未测的按来源均衡抽样
  const bySrc = new Map();
  for (const [k, e] of fresh.sort(() => Math.random() - 0.5)) { const s = e.src || ''; if (!bySrc.has(s)) bySrc.set(s, []); bySrc.get(s).push(k); }
  const freshPick = [];
  while (freshPick.length < limit && [...bySrc.values()].some(a => a.length)) for (const a of bySrc.values()) if (a.length && freshPick.length < limit) freshPick.push(a.shift());
  const nGood = Math.min(good.length, Math.max(Math.ceil(limit * 0.6), limit - freshPick.length));
  // 1.2.5：为「住宅 / 纯净」的 IP 预留约 40% 名额（已验证的按评分，未测的随机），保证它们每轮都有机会被测到
  const out = [];
  const nPref = Math.ceil(limit * 0.4);
  const prefGood = good.filter(([, e]) => ipq.preferred(e.q)).map(([k]) => k);
  const prefFresh = fresh.filter(([, e]) => ipq.preferred(e.q)).map(([k]) => k).sort(() => Math.random() - 0.5);
  for (const k of [...prefGood, ...prefFresh]) if (out.length < nPref && !out.includes(k)) out.push(k);
  for (const [k] of good.slice(0, nGood)) if (out.length < limit && !out.includes(k)) out.push(k);
  for (const k of freshPick) if (out.length < limit && !out.includes(k)) out.push(k);
  for (const [k] of failed) if (out.length < limit && !out.includes(k)) out.push(k);
  for (const [k] of good.slice(nGood)) if (out.length < limit && !out.includes(k)) out.push(k);
  return out;
}

export async function recordProbes(results) {
  if (!results.length) return;
  await store.mutate('pool', d => {
    for (const r of results) {
      const e = d.items[r.pip];
      if (!e) continue;
      e.at = now();
      if (r.ok) {
        e.ok = true;
        e.ms = e.ms ? Math.round(e.ms * 0.4 + r.ms * 0.6) : r.ms;
        e.cold = r.cold || e.cold || 0;
        e.succ = e.succ == null ? 1 : +(e.succ * 0.7 + 0.3).toFixed(3);
        e.fail = 0;
        if (r.trace) { e.exitIp = r.trace.ip; if (r.trace.loc) e.cc = r.trace.loc; e.colo = r.trace.colo || ''; }
        e.err = '';
      } else {
        e.fail = (e.fail || 0) + 1;
        e.succ = e.succ == null ? 0 : +(e.succ * 0.7).toFixed(3);
        e.ok = e.succ > 0.5 && e.fail < 2 ? e.ok : false;
        e.err = String(r.err || '失败').slice(0, 120);
      }
    }
  });
}

export async function cool(key, minutes, reason = '') {
  if (!key) return;
  await store.mutate('pool', d => { const e = d.items[key]; if (e) { e.cool = now() + minutes * 60e3; if (reason) e.err = reason; } });
}

export async function summary() {
  const p = await store.get('pool');
  const regions = {};
  let ok = 0, untested = 0, bad = 0;
  for (const e of Object.values(p.items)) {
    if (e.ban || e.gone) continue;
    const cc = itemCc(e) || '??';
    regions[cc] ||= { ok: 0, total: 0, best: Infinity };
    regions[cc].total++;
    if (e.ok === true) { ok++; regions[cc].ok++; regions[cc].best = Math.min(regions[cc].best, e.ms || Infinity); }
    else if (e.ok === false) bad++; else untested++;
  }
  for (const r of Object.values(regions)) if (r.best === Infinity) r.best = 0;
  return { total: Object.keys(p.items).length, ok, untested, bad, regions };
}

// 1.2.5：IP 质量预筛 —— 对池中尚无质量数据的 IP 批量查询（ip-api，免费额度充足），非机房的再查 proxycheck 风险分
export async function prescreen({ deepPips = [], max = 300 } = {}) {
  const p = await store.get('pool');
  const t = Date.now();
  const list = Object.entries(p.items).filter(([, e]) => !e.ban && !e.gone);
  const need = list.filter(([, e]) => !e.q || t - (e.q.at || 0) > 7 * 24 * 3600e3);
  const ipBy = new Map();
  for (const [k, e] of [...need.filter(([, e]) => e.ok === true), ...need.filter(([, e]) => e.ok !== true)].slice(0, max)) { const ip = ipq.ipOf(k, e.exitIp); if (ip) ipBy.set(k, ip); }
  const deep = deepPips.map(k => ipq.ipOf(k, p.items[k]?.exitIp)).filter(Boolean);
  for (const k of deepPips) { const ip = ipq.ipOf(k, p.items[k]?.exitIp); if (ip) ipBy.set(k, ip); }
  if (!ipBy.size) return 0;
  const res = await ipq.lookup([...ipBy.values()], { deepIps: deep, maxIa: max });
  let n = 0;
  await store.mutate('pool', d => {
    for (const [k, ip] of ipBy) { const e = d.items[k]; const q = res[ip]; if (e && q) { e.q = ipq.slim(q); e.qIp = ip; n++; } }
  });
  return n;
}

