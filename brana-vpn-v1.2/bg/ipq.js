// Brana VPN · ProxyIP 质量检测（1.2.5）：住宅 / 机房类型 + 纯净度
// 数据源（均免费、无需注册）：
//   ip-api.com 批量接口：hosting（机房）/ proxy（代理）/ mobile（移动网络）/ ISP，100 个/次，15 次/分钟
//   proxycheck.io：type（Residential / Wireless / Business / Hosting / VPN）+ risk 风险分 0–100
//     无 key 约 100 次/天（按查询来源 IP 计；它托管在 Cloudflare 上，经节点访问时按 ProxyIP 计，公共 ProxyIP 额度可能已被他人用完）
//     可在设置填写免费 key（1000 次/天）；查不到时自动只用 ip-api
// 结果缓存 7 天（失败 6 小时），只对 ProxyIP 本身的出口 IP 查询。
// 1.2.8：IPPure（my.ippure.com，托管在 Cloudflare 上）—— 经节点 + 该 ProxyIP 访问，返回的就是这个出口的风险系数（基于风险库与蜜罐记录）。
//   有 IPPure 结果时：纯净度 = 100 − IPPure 系数；系数超过上限（默认 50，即 ≥51 中度 / 高度风险）或被 Cloudflare 人机验证拦截 → 自动拉黑不用。缓存 3 天。
import * as store from './store.js';

const TTL = 7 * 24 * 3600e3;
const FAIL_TTL = 6 * 3600e3;
const MAX_CACHE = 4000;
const now = () => Date.now();

// 偏好（由 engine 在每轮优选前写入）
let QP = { enabled: true, prefer: 'residential', minPurity: 60, minMbps: 50, pcKey: '', maxRisk: 50 };
export function setPrefs(p) { QP = { ...QP, ...(p || {}) }; }
export function prefs() { return QP; }

// 常见家宽 / 移动运营商（名称匹配，仅在两个数据源都未判定为机房时用来区分「住宅」与「普通商业」）
const ISP_RE = /telecom|telekom|broadband|cable|fiber|fibre|\bdsl|ntt|kddi|softbank|so-net|biglobe|\bocn\b|chunghwa|hinet|korea telecom|\bkt corp|sk broadband|lg (dacom|u\+|uplus|powercomm)|hkbn|hong kong broadband|\bhgc\b|i-cable|singtel|starhub|\bm1\b|myrepublic|comcast|charter|spectrum|verizon|at&t|\bcox\b|centurylink|frontier|rogers|telus|vodafone|orange|telefonica|chinanet|china (telecom|unicom|mobile)|viettel|vnpt|\bfpt\b|true internet|\bais\b|3bb|pldt|globe telecom|telstra|optus|\btpg\b|reliance jio|airtel|bsnl|maxis|\btm net|unifi|time dotcom|indosat|xl axiata|smartone|jcom|j:com|eonet|kbro|taiwan mobile|far eastone|asia pacific telecom|mobile|wireless|cellular/i;
// 机房 / 云厂商名称（任一数据源漏判时兜底）
const DC_RE = /cloud|hosting|\bhost|server|data ?cent|\bvps\b|\bidc\b|colo|oracle|amazon|\baws\b|google|microsoft|azure|alibaba|aliyun|tencent|huawei cloud|digitalocean|linode|akamai|vultr|constant company|choopa|\bovh|hetzner|contabo|leaseweb|\bm247|psychz|cogent|zenlayer|colocrossing|bytevirt|\bdmit|gcore|g-core|cdn77|datacamp|packetstream|frantech|buyvm|racknerd|hostinger|ionos|scaleway|sakura internet|kamatera|upcloud|netcup|hostwinds|quadranet|multacom|sunoaki|akile|zillion|netrouting|alice networks|zmto|moedove|geoscry|debee|adcdata|easy link|ncse network|cloudflare|fastly/i;

export const TYPE_LABEL = { residential: '住宅', mobile: '移动', isp: 'ISP', business: '商业', datacenter: '机房', unknown: '未知' };

export function classify(ia, pc) {
  const name = `${ia?.isp || ''} ${ia?.org || ''} ${ia?.as || ''} ${pc?.provider || ''} ${pc?.organisation || ''}`;
  const pt = String(pc?.type || '').toLowerCase();
  const dcName = DC_RE.test(name);
  const ispName = !dcName && ISP_RE.test(name);
  let type = 'unknown';
  if (ia?.mobile || pt === 'wireless') type = 'mobile';
  else if (pt === 'residential' && !ia?.hosting && !dcName) type = 'residential';
  else if (ia?.hosting || pt === 'hosting' || pt === 'vpn' || pt === 'tor' || dcName) type = 'datacenter';
  else if (ispName) type = pt === 'business' ? 'isp' : 'residential';
  else if (pt === 'business') type = 'business';
  else if (ia && !ia.hosting && !ia.proxy) type = 'business';
  // 纯净度 0–100：以 proxycheck 风险分为基础，叠加代理 / 机房标记
  let p = 100;
  if (pc && pc.risk != null && isFinite(+pc.risk)) p = Math.min(p, 100 - +pc.risk);
  if (pc?.proxy === 'yes') p -= 15;
  if (ia?.proxy) p -= 25;
  if (ia?.hosting) p -= 15;
  if (type === 'datacenter' && !pc) p -= 20;
  if (type === 'business' && !pc) p -= 10;
  const purity = Math.max(0, Math.min(100, Math.round(p)));
  return {
    type, purity,
    isp: String(ia?.isp || pc?.provider || ia?.org || '').slice(0, 60),
    as: String(ia?.as || pc?.asn || '').slice(0, 60),
    cc: ia?.countryCode || pc?.isocode || '',
    flags: { hosting: !!ia?.hosting, proxy: !!ia?.proxy || pc?.proxy === 'yes', mobile: !!ia?.mobile },
    pcType: pc?.type || '', risk: pc?.risk ?? null,
    src: pc ? 'ip-api+proxycheck' : 'ip-api',
    at: now(),
  };
}

// 选线倍率（越小越优先）；st 需含 q（质量）与 mbps（经该 ProxyIP 访问 Cloudflare 网站的实测速度）
export function qMult(q, mbps) {
  if (!QP.enabled || QP.prefer === 'off' || !q || q.err) return 1;
  const clean = q.purity >= QP.minPurity;
  const fast = mbps == null || !(mbps > 0) ? null : mbps >= QP.minMbps;
  const home = q.type === 'residential' || q.type === 'mobile';
  if (QP.prefer === 'residential') {
    if (home && clean) return fast === false ? 0.85 : fast ? 0.2 : 0.3;   // 未测速时也加分，保证能进入测速名单
    if (q.type === 'isp' && clean) return fast === false ? 0.9 : fast ? 0.3 : 0.4;
  }
  if (clean) return fast === false ? 0.95 : QP.prefer === 'clean' ? 0.4 : 0.6;
  return q.purity < 20 ? 1.3 : 1;
}
// 是否属于「优先」档（用于给候选预留名额）
export function preferred(q) {
  if (!QP.enabled || QP.prefer === 'off' || !q || q.err) return false;
  if (q.purity < QP.minPurity) return false;
  return QP.prefer === 'clean' || ['residential', 'mobile', 'isp'].includes(q.type);
}

// 从 ProxyIP 键（IP:端口 / [v6]:端口 / 链式）或出口取出可查询的 IP
export function ipOf(pip, exitIp) {
  if (exitIp && isIp(exitIp)) return exitIp;
  const s = String(pip || '').trim();
  if (!s) return '';
  const m6 = /^\[([0-9a-f:]+)\]/i.exec(s);
  if (m6 && isIp(m6[1])) return m6[1];
  const chain = /^[a-z0-9]+:\/\/(?:[^@/]*@)?([^/:]+|\[[^\]]+\])/i.exec(s);
  const host = chain ? chain[1].replace(/^\[|\]$/g, '') : s.split('#')[0].replace(/:\d+$/, '');
  return isIp(host) ? host : '';
}
function isIp(s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || (/^[0-9a-f:]+$/i.test(s) && s.includes(':')); }

async function fetchJson(url, opt = {}, timeout = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctl.signal, ...opt });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function ipApiBatch(ips) {
  const out = {};
  for (let i = 0; i < ips.length; i += 100) {
    const part = ips.slice(i, i + 100);
    const j = await fetchJson('http://ip-api.com/batch?fields=status,message,query,countryCode,isp,org,as,mobile,proxy,hosting', { method: 'POST', body: JSON.stringify(part) });
    for (const v of Array.isArray(j) ? j : []) if (v && v.status === 'success') out[v.query] = v;
  }
  return out;
}

let pcBlockedUntil = 0;
async function proxycheck(ips) {
  const out = {};
  if (!ips.length || now() < pcBlockedUntil) return out;
  for (let i = 0; i < ips.length; i += 50) {
    const part = ips.slice(i, i + 50);
    const key = QP.pcKey ? '&key=' + encodeURIComponent(QP.pcKey) : '';
    let j;
    try { j = await fetchJson(`https://proxycheck.io/v2/${part.join(',')}?vpn=1&asn=1&risk=1${key}`); }
    catch { pcBlockedUntil = now() + 30 * 60e3; break; }
    if (j.status && !['ok', 'warning'].includes(j.status)) { pcBlockedUntil = now() + FAIL_TTL; break; }   // denied / error：额度用完
    for (const ip of part) if (j[ip] && typeof j[ip] === 'object') out[ip] = j[ip];
  }
  return out;
}

// 查询（带缓存）。deep=false 只用 ip-api（批量预筛）；deep=true 对其中「不是机房」或在 deepIps 里的再查 proxycheck
export async function lookup(ips, { deepIps = [], maxIa = 300, maxPc = 40 } = {}) {
  const cache = await store.get('ipq');
  const t = now();
  const want = [...new Set(ips.filter(isIp))];
  const stale = want.filter(ip => { const c = cache[ip]; return !c || t - (c.at || 0) > (c.err ? FAIL_TTL : TTL); }).slice(0, maxIa);
  let ia = {};
  if (stale.length) { try { ia = await ipApiBatch(stale); } catch (e) { ia = {}; } }
  // 需要 proxycheck 的：新查的里 ip-api 判为非机房的 + 指定的 deepIps（尚无 proxycheck 结果的）
  const deepSet = new Set(deepIps.filter(isIp));
  const needPc = [...new Set([
    ...stale.filter(ip => ia[ip] && !ia[ip].hosting),
    ...want.filter(ip => deepSet.has(ip) && !(cache[ip]?.src || '').includes('proxycheck')),
  ])].slice(0, maxPc);
  const pc = await proxycheck(needPc).catch(() => ({}));
  if (stale.length || Object.keys(pc).length) {
    await store.mutate('ipq', d => {
      for (const ip of stale) { const pure = d[ip]?.pure; d[ip] = ia[ip] ? classify(ia[ip], pc[ip]) : { err: 'lookup', at: t }; if (pure) d[ip].pure = pure; }
      for (const ip of Object.keys(pc)) if (!stale.includes(ip)) {
        const prev = d[ip];
        const iaPrev = prev && !prev.err ? { isp: prev.isp, as: prev.as, countryCode: prev.cc, hosting: prev.flags?.hosting, proxy: prev.flags?.proxy && prev.src === 'ip-api', mobile: prev.flags?.mobile } : null;
        d[ip] = classify(iaPrev, pc[ip]);
        if (prev?.pure) d[ip].pure = prev.pure;
      }
      const keys = Object.keys(d);
      if (keys.length > MAX_CACHE) keys.sort((a, b) => (d[a].at || 0) - (d[b].at || 0)).slice(0, keys.length - MAX_CACHE).forEach(k => delete d[k]);
    });
  }
  const res = await store.get('ipq');
  const out = {};
  for (const ip of want) if (res[ip] && !res[ip].err) out[ip] = res[ip];
  return out;
}

// ───────────── IPPure ─────────────
export const PURE_URL = 'https://my.ippure.com/v1/info';
const PURE_TTL = 3 * 24 * 3600e3, PURE_FAIL_TTL = 6 * 3600e3;
// res = 核心 fetch 结果 { ok, status, text }
export function parsePure(res) {
  const text = String(res?.text || '');
  if (/Just a moment|cf-chl|challenge-platform|Attention Required/i.test(text)) return { chal: true, fraud: 100, at: now() };
  try {
    const j = JSON.parse(text);
    if (j && j.fraudScore != null && isFinite(+j.fraudScore)) return { ip: String(j.ip || ''), fraud: Math.max(0, Math.min(100, Math.round(+j.fraudScore))), res: !!j.isResidential, bc: !!j.isBroadcast, org: String(j.asOrganization || '').slice(0, 60), cc: String(j.countryCode || ''), at: now() };
  } catch {}
  return { err: res?.status ? 'HTTP ' + res.status : (res?.err || '解析失败'), at: now() };
}
export const pureFresh = p => !!p && !p.err && now() - (p.at || 0) < PURE_TTL;
export const pureStale = p => !p || now() - (p.at || 0) > (p.err ? PURE_FAIL_TTL : PURE_TTL);
export async function recordPure(map) {
  if (!Object.keys(map).length) return;
  await store.mutate('ipq', d => {
    for (const [ip, pr] of Object.entries(map)) {
      const prev = d[ip];
      // 有更新鲜的成功结果时，不用失败结果覆盖
      if (pr.err && pureFresh(prev?.pure)) continue;
      d[ip] = { ...(prev || { err: 'lookup', at: 0 }), pure: pr };
    }
  });
}
// 合并 IPPure 后的有效质量
function eff(q) {
  if (!q) return null;
  const p = q.pure;
  if (!pureFresh(p)) return q.err ? null : q;
  const b = q.err ? { type: 'unknown', purity: 50, isp: '', as: '', risk: null, src: '', at: p.at } : q;
  let type = b.type;
  if (p.res && type !== 'mobile') type = 'residential';
  else if (!p.res && (type === 'residential' || type === 'unknown')) type = b.type === 'residential' ? 'isp' : 'datacenter';
  return { ...b, type, purity: 100 - p.fraud, fraud: p.fraud, bc: !!p.bc, chal: !!p.chal, isp: b.isp || p.org || '', src: 'ippure' + (b.src ? '+' + b.src : '') };
}
export const slim = q => {
  const e = eff(q);
  if (!e || e.err) return null;
  const o = { type: e.type, purity: e.purity, isp: e.isp, risk: e.risk, src: e.src, at: e.at };
  if (e.fraud != null) { o.fraud = e.fraud; o.bc = e.bc; o.chal = e.chal; o.pAt = q.pure.at; }
  return o;
};
// 高风险（自动拉黑）：IPPure 系数超过上限，或被 Cloudflare 人机验证拦截
export function risky(q) {
  if (!QP.enabled || !q || q.fraud == null) return false;
  const max = QP.maxRisk == null ? 50 : +QP.maxRisk;
  if (max >= 100) return false;
  return !!q.chal || q.fraud > max;
}
