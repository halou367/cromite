// 优选 IP（BestIP）：为 edgetunnel 类 Cloudflare 节点挑选连接地址（address）
// 流程：本机网络能力（IPv4/IPv6）→ 每个网段随机抽样 → TCP 延迟/丢包 → 下载峰值测速 → 经节点验证 → 记录（白天/夜晚分开）→ 排名 → 选出当前时段前 N 名
// 原则：IPv6 为主、IPv4 为辅（本机无 IPv6 时自动只用 IPv4）；每个 IP 的白天/夜晚成绩分别累计，越新的成绩权重越高。
import * as store from './store.js';
import { DEFAULT_BESTIP } from './store.js';
export { DEFAULT_BESTIP };
import { Core } from './core.js';

const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const log = (lv, msg) => store.log(lv, msg);
const MB = 1048576;
const H = 3600e3;
const MAX_SAMPLES = 8;
const SAMPLE_TTL = 7 * 24 * H;
const STALE = 3 * 24 * H;
// 测量模式：不同模式的数据不可互相比较，排名只使用与当前模式一致的样本
//   延迟：仅 TCP 握手（直连该 IP，不含 DNS / TLS / HTTP）
//   速度：按测速地址区分（换了测速地址，旧速度数据不再参与排名）
export const LAT_MODE = 'tcp';
export function speedKey(url) { try { const u = new URL(url); return (u.host + u.pathname).toLowerCase(); } catch { return String(url || ''); } }

export const ST0 = () => ({ v: 1, ips: {}, caps: null, lists: { day: null, night: null }, active: null, rounds: [], nodeCf: {}, running: null, lastRun: 0, lastDay: 0, lastNight: 0, next: 0, nextSwitch: 0, lim: null, spd: null });

// ───────────── 测速保护：尽量不触发测速接口（speed.cloudflare.com）的限流 ─────────────
//  · 被限流（429 / Cloudflare 1015 / 无错误码的 403）→ 立即停止本轮测速，按 Retry-After 暂停（没有则 1 小时，24 小时内再次被限流时翻倍，最长 12 小时）
//  · 近 12 小时同一时段测过速、延迟/丢包没变差的 IP 不再重复测速（沿用上次速度）
//  · 延迟已经不可能挤进当前名单的新候选不测速
//  · 每日测速次数上限（含手动）；两次测速之间随机间隔 45~75 秒、每小时最多 8 次；峰值稳定后提前结束下载（核心 1.2.1）
export const FRESH = 12 * H;
// 实测：约 1 分钟内连续 5 次 ~95 MB 下载就会被 403（十几分钟后自动恢复）→ 关键是「拉开间隔」
//   两次测速至少间隔 45~75 秒（随机），1 小时内最多 8 次
export const _t = { gap: [45e3, 75e3], perHour: 8, minGap: 45e3 };
function hourCount(t = now()) { S.spLog = (S.spLog || []).filter(x => t - x < H); return S.spLog.length; }
const LIMIT_BASE = H, LIMIT_MAX = 12 * H;
const dayKey = (t = now()) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
export function isLimited(r) {
  if (!r || r.ok) return false;
  const err = String(r.err || '');
  return !!r.limited || r.status === 429 || /错误 1015/.test(err) || (r.status === 403 && !/错误 \d{4}/.test(err));
}
export function limitLeft(t = now()) { return S.lim && S.lim.until > t ? S.lim.until - t : 0; }
function setLimit(r, where) {
  const t = now();
  const prev = S.lim;
  const n = prev && t - (prev.until || 0) < 24 * H ? (prev.n || 1) + 1 : 1;
  const ra = Math.max(0, +r.retryAfter || 0) * 1000;
  const dur = Math.min(24 * H, Math.max(ra, Math.min(LIMIT_MAX, LIMIT_BASE * Math.pow(2, n - 1))));
  S.lim = { at: t, until: t + dur, n, status: r.status || 0, err: r.err || '', ra: +r.retryAfter || 0, where };
  log('warn', `优选 IP：测速接口返回限流（${r.err || 'HTTP ' + r.status}${r.retryAfter ? `，要求 ${r.retryAfter} 秒后再试` : ''}），暂停测速 ${Math.round(dur / 60e3)} 分钟；期间只测延迟/丢包，速度沿用历史数据`);
  return dur;
}
export function budget(c, t = now()) {
  if (!S.spd || S.spd.d !== dayKey(t)) S.spd = { d: dayKey(t), n: 0, bytes: 0 };
  return { used: S.spd.n, left: Math.max(0, c.speedDaily - S.spd.n), bytes: S.spd.bytes, max: c.speedDaily };
}
function spent(c, r) { budget(c); S.spd.n += 1; S.spd.bytes += r?.bytes || 0; hourCount(); S.spLog.push(now()); S.spLast = now(); }
// 距离上一次测速不足最小间隔时等待（可取消），等待期间显示倒计时
async function waitGap(ms, label) {
  const end = now() + ms;
  while (now() < end) {
    checkCancel();
    progress({ phase: 'speed', text: `${label}，等待 ${Math.ceil((end - now()) / 1000)} 秒（拉开间隔，避免测速接口限流）…` }, { flush: true });
    await sleep(Math.min(5000, end - now()));
  }
  checkCancel();
}
const fmtMin = ms => (ms >= 90 * 60e3 ? `${(ms / H).toFixed(1)} 小时` : `${Math.max(1, Math.ceil(ms / 60e3))} 分钟`);

// ───────────── 外部钩子（由 background.js 注入，避免与 engine 循环依赖）─────────────
let hooks = { ensureCore: async () => false, onChange: async () => {}, getRt: () => null, busy: () => '' };
export function setHooks(h) { hooks = { ...hooks, ...h }; }

let S = ST0();
let loaded = false;
export async function load() {
  S = { ...ST0(), ...((await store.get('bestip')) || {}) };
  S.lists ||= { day: null, night: null };
  S.ips ||= {}; S.nodeCf ||= {}; S.rounds ||= [];
  // Service Worker 在测试中途被回收：清掉残留的「进行中」状态
  if (S.running && now() - (S.running.started || 0) > 20 * 60e3) S.running = null;
  loaded = true;
  return S;
}
export const state = () => S;
let saveT = 0, saveP = null;
function save({ soon = false } = {}) {
  if (soon) { clearTimeout(saveT); saveT = setTimeout(() => save(), 400); return; }
  clearTimeout(saveT);
  const snap = S;
  saveP = store.set('bestip', snap).catch(() => {});
  return saveP;
}

async function cfg() {
  const s = await store.get('settings');
  return normCfg(s.bestip);
}

// ───────────── 设置规范化（界面保存与导入都走这里）─────────────
const cidrOk = c => !!parseCidr(c);
export function normCfg(c) {
  const d = DEFAULT_BESTIP;
  c = c && typeof c === 'object' ? c : {};
  const th = (x, dd) => ({ ms: clamp(Math.round(+x?.ms || dd.ms), 10, 2000), mbs: clamp(+(+x?.mbs >= 0 ? +x.mbs : dd.mbs).toFixed(2), 0, 1000), loss: clamp(+(+x?.loss >= 0 ? +x.loss : dd.loss).toFixed(1), 0, 100) });
  const list = (v, dd, fam) => {
    const arr = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,，;；]+/) : dd).map(s => String(s).trim()).filter(Boolean);
    const out = [];
    for (const s of arr) { const p = parseCidr(s); if (p && p.fam === fam && !out.includes(p.text)) out.push(p.text); }
    return out.slice(0, 24);
  };
  const g = c.geo && typeof c.geo === 'object' ? c.geo : {};
  const num = (v, a, b) => (v === null || v === '' || v === undefined || !isFinite(+v) ? null : clamp(+v, a, b));
  return {
    enabled: c.enabled !== undefined ? !!c.enabled : d.enabled,
    v6Cidrs: c.v6Cidrs !== undefined ? list(c.v6Cidrs, d.v6Cidrs, 6) : [...d.v6Cidrs],
    v4Cidrs: c.v4Cidrs !== undefined ? list(c.v4Cidrs, d.v4Cidrs, 4) : [...d.v4Cidrs],
    perCidr: clamp(Math.round(+c.perCidr || d.perCidr), 5, 100),
    intervalH: [1, 2, 3, 4, 6, 8, 12, 24].includes(+c.intervalH) ? +c.intervalH : d.intervalH,
    top: clamp(Math.round(+c.top || d.top), 1, 10),
    backups: clamp(Math.round(c.backups !== undefined ? +c.backups : d.backups), 0, 5),
    th6: th(c.th6, d.th6),
    th4: th(c.th4, d.th4),
    family: ['auto', 'v6', 'v4'].includes(c.family) ? c.family : d.family,
    scope: ['auto', 'all'].includes(c.scope) ? c.scope : d.scope,
    geo: {
      mode: ['auto', 'manual', 'fixed'].includes(g.mode) ? g.mode : 'auto',
      lat: num(g.lat, -90, 90), lon: num(g.lon, -180, 180),
      dayStart: clamp(+g.dayStart >= 0 ? +g.dayStart : 6, 0, 23.99), dayEnd: clamp(+g.dayEnd >= 0 ? +g.dayEnd : 18, 0, 23.99),
      city: String(g.city || '').slice(0, 20),
    },
    speedUrl: /^https?:\/\/[^\s/]+\/\S*$/i.test(String(c.speedUrl || '')) ? String(c.speedUrl) : d.speedUrl,
    speedSec: clamp(Math.round(+c.speedSec || d.speedSec), 2, 10),
    speedTop: clamp(Math.round(+c.speedTop || d.speedTop), 2, 20),
    speedDaily: clamp(Math.round(+c.speedDaily || d.speedDaily), 6, 200),
    pings: clamp(Math.round(+c.pings || d.pings), 3, 20),
    idleOnly: c.idleOnly !== undefined ? !!c.idleOnly : d.idleOnly,
    fill: c.fill !== undefined ? !!c.fill : d.fill,
  };
}
export const cfgOf = normCfg;

// ───────────── IP / 网段工具 ─────────────
function parseV4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  if (b.some(x => x > 255)) return null;
  return b;
}
function parseV6(s) {
  s = String(s).toLowerCase().replace(/^\[|\]$/g, '');
  if (!/^[0-9a-f:]+$/.test(s) || s.includes(':::') || (s.match(/::/g) || []).length > 1) return null;
  let parts;
  if (s.includes('::')) {
    const [a, b] = s.split('::');
    const pa = a ? a.split(':') : [], pb = b ? b.split(':') : [];
    if (pa.length + pb.length > 7) return null;
    parts = [...pa, ...Array(8 - pa.length - pb.length).fill('0'), ...pb];
  } else parts = s.split(':');
  if (parts.length !== 8 || parts.some(p => !p || p.length > 4)) return null;
  const bytes = [];
  for (const p of parts) { const v = parseInt(p, 16); bytes.push(v >> 8, v & 255); }
  return bytes;
}
export function fmtV6(bytes) {
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  // 压缩最长的连续 0 段
  let bs = -1, bl = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== '0') { i++; continue; }
    let j = i; while (j < 8 && g[j] === '0') j++;
    if (j - i > bl && j - i > 1) { bs = i; bl = j - i; }
    i = j;
  }
  if (bs < 0) return g.join(':');
  return (g.slice(0, bs).join(':') + '::' + g.slice(bs + bl).join(':'));
}
export function parseCidr(c) {
  const [ip, bitsS] = String(c || '').trim().split('/');
  const v4 = parseV4(ip);
  const v6 = v4 ? null : parseV6(ip);
  if (!v4 && !v6) return null;
  const max = v4 ? 32 : 128;
  const bits = bitsS === undefined || bitsS === '' ? max : +bitsS;
  if (!Number.isInteger(bits) || bits < (v4 ? 8 : 16) || bits > max) return null;
  const bytes = (v4 || v6).slice();
  for (let i = 0; i < bytes.length; i++) { const keep = clamp(bits - i * 8, 0, 8); bytes[i] &= (0xff << (8 - keep)) & 0xff; }
  const text = (v4 ? bytes.join('.') : fmtV6(bytes)) + '/' + bits;
  return { fam: v4 ? 4 : 6, bytes, bits, text };
}
export const famOf = ip => (String(ip).includes(':') ? 6 : 4);
function inCidr(ip, cidr) {
  const p = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!p) return false;
  const b = p.fam === 4 ? parseV4(ip) : parseV6(ip);
  if (!b) return false;
  for (let i = 0; i < b.length; i++) { const keep = clamp(p.bits - i * 8, 0, 8); if (!keep) break; const m = (0xff << (8 - keep)) & 0xff; if ((b[i] & m) !== p.bytes[i]) return false; }
  return true;
}
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
// 在网段内随机抽取 n 个不重复 IP（IPv4 跳过 .0 / .255）
export function sampleCidr(cidr, n) {
  const p = parseCidr(cidr);
  if (!p) return [];
  const out = new Set();
  const hostBits = (p.fam === 4 ? 32 : 128) - p.bits;
  const cap = hostBits >= 20 ? n : Math.min(n, 2 ** hostBits - (p.fam === 4 ? 2 : 0));
  let guard = 0;
  while (out.size < cap && guard++ < n * 30) {
    const r = rnd(p.bytes.length);
    const b = p.bytes.map((x, i) => { const keep = clamp(p.bits - i * 8, 0, 8); const m = (0xff << (8 - keep)) & 0xff; return (x & m) | (r[i] & ~m & 0xff); });
    if (p.fam === 4) { if (b[3] === 0 || b[3] === 255) continue; out.add(b.join('.')); }
    else { if (b.slice(8).every(x => x === 0)) continue; out.add(fmtV6(b)); }
  }
  return [...out];
}

// Cloudflare 官方网段（判断节点是否为 Cloudflare 节点）
const CF4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'].map(parseCidr);
const CF6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'].map(parseCidr);
export const isCfIp = ip => (famOf(ip) === 4 ? CF4 : CF6).some(c => inCidr(ip, c));
const isIp = s => !!(parseV4(s) || parseV6(s));

// ───────────── 白天 / 夜晚（日出日落，NOAA/suncalc 算法）─────────────
const RAD = Math.PI / 180;
function sunRiseSet(date, lat, lon) {
  const dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, J0 = 0.0009, e = RAD * 23.4397;
  const toDays = d => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
  const fromJ = j => (j + 0.5 - J1970) * dayMs;
  const lw = RAD * -lon, phi = RAD * lat, d = toDays(date);
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const M = RAD * (357.5291 + 0.98560028 * ds);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const cosw = (Math.sin(RAD * -0.833) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosw < -1) return { polar: 'day' };
  if (cosw > 1) return { polar: 'night' };
  const w = Math.acos(cosw);
  const a = J0 + (w + lw) / (2 * Math.PI) + n;
  const Jset = J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const Jrise = Jnoon - (Jset - Jnoon);
  return { rise: fromJ(Jrise), set: fromJ(Jset) };
}

// 时区 → 代表城市坐标（没有手动设置位置时，用系统时区估算日出日落）
const TZ = {
  'Asia/Shanghai': [31.23, 121.47], 'Asia/Chongqing': [29.56, 106.55], 'Asia/Chungking': [29.56, 106.55], 'Asia/Harbin': [45.8, 126.53], 'Asia/Urumqi': [43.83, 87.62], 'Asia/Kashgar': [39.47, 75.99], 'PRC': [31.23, 121.47],
  'Asia/Hong_Kong': [22.32, 114.17], 'Asia/Macau': [22.2, 113.55], 'Asia/Taipei': [25.03, 121.57], 'Asia/Tokyo': [35.68, 139.69], 'Asia/Seoul': [37.57, 126.98], 'Asia/Pyongyang': [39.03, 125.75],
  'Asia/Singapore': [1.35, 103.82], 'Asia/Kuala_Lumpur': [3.14, 101.69], 'Asia/Bangkok': [13.75, 100.5], 'Asia/Ho_Chi_Minh': [10.82, 106.63], 'Asia/Saigon': [10.82, 106.63], 'Asia/Jakarta': [-6.2, 106.85], 'Asia/Manila': [14.6, 120.98],
  'Asia/Dhaka': [23.81, 90.41], 'Asia/Kolkata': [22.57, 88.36], 'Asia/Calcutta': [22.57, 88.36], 'Asia/Karachi': [24.86, 67.0], 'Asia/Kathmandu': [27.72, 85.32], 'Asia/Colombo': [6.93, 79.85], 'Asia/Yangon': [16.87, 96.2],
  'Asia/Dubai': [25.2, 55.27], 'Asia/Riyadh': [24.71, 46.68], 'Asia/Tehran': [35.69, 51.39], 'Asia/Jerusalem': [31.77, 35.21], 'Asia/Almaty': [43.24, 76.89], 'Asia/Tashkent': [41.3, 69.24], 'Asia/Ulaanbaatar': [47.89, 106.91],
  'Asia/Vladivostok': [43.12, 131.89], 'Asia/Yekaterinburg': [56.84, 60.6], 'Asia/Novosibirsk': [55.03, 82.92], 'Europe/Moscow': [55.76, 37.62], 'Europe/Istanbul': [41.01, 28.98],
  'Europe/London': [51.51, -0.13], 'Europe/Dublin': [53.35, -6.26], 'Europe/Paris': [48.86, 2.35], 'Europe/Berlin': [52.52, 13.4], 'Europe/Amsterdam': [52.37, 4.9], 'Europe/Madrid': [40.42, -3.7], 'Europe/Rome': [41.9, 12.5],
  'Europe/Stockholm': [59.33, 18.07], 'Europe/Warsaw': [52.23, 21.01], 'Europe/Kiev': [50.45, 30.52], 'Europe/Kyiv': [50.45, 30.52], 'Europe/Zurich': [47.38, 8.54], 'Europe/Vienna': [48.21, 16.37], 'Europe/Helsinki': [60.17, 24.94],
  'America/New_York': [40.71, -74.0], 'America/Chicago': [41.88, -87.63], 'America/Denver': [39.74, -104.99], 'America/Los_Angeles': [34.05, -118.24], 'America/Phoenix': [33.45, -112.07], 'America/Toronto': [43.65, -79.38],
  'America/Vancouver': [49.28, -123.12], 'America/Mexico_City': [19.43, -99.13], 'America/Sao_Paulo': [-23.55, -46.63], 'America/Buenos_Aires': [-34.6, -58.38], 'America/Argentina/Buenos_Aires': [-34.6, -58.38], 'America/Bogota': [4.71, -74.07], 'America/Lima': [-12.05, -77.04], 'America/Santiago': [-33.45, -70.67],
  'Australia/Sydney': [-33.87, 151.21], 'Australia/Melbourne': [-37.81, 144.96], 'Australia/Brisbane': [-27.47, 153.03], 'Australia/Perth': [-31.95, 115.86], 'Australia/Adelaide': [-34.93, 138.6], 'Pacific/Auckland': [-36.85, 174.76],
  'Africa/Cairo': [30.04, 31.24], 'Africa/Johannesburg': [-26.2, 28.05], 'Africa/Lagos': [6.52, 3.38], 'Africa/Nairobi': [-1.29, 36.82],
};
// 手动选择城市（界面下拉）
export const CITIES = [
  ['北京', 39.9, 116.4], ['上海', 31.23, 121.47], ['广州', 23.13, 113.26], ['深圳', 22.54, 114.06], ['杭州', 30.27, 120.15], ['南京', 32.06, 118.8], ['武汉', 30.59, 114.31], ['成都', 30.57, 104.07],
  ['重庆', 29.56, 106.55], ['西安', 34.34, 108.94], ['郑州', 34.75, 113.62], ['长沙', 28.23, 112.94], ['济南', 36.65, 117.12], ['青岛', 36.07, 120.38], ['天津', 39.13, 117.2], ['沈阳', 41.8, 123.43],
  ['哈尔滨', 45.8, 126.53], ['长春', 43.82, 125.32], ['福州', 26.07, 119.3], ['厦门', 24.48, 118.09], ['南宁', 22.82, 108.32], ['昆明', 25.04, 102.71], ['贵阳', 26.65, 106.63], ['兰州', 36.06, 103.83],
  ['乌鲁木齐', 43.83, 87.62], ['拉萨', 29.65, 91.13], ['呼和浩特', 40.84, 111.75], ['海口', 20.04, 110.2], ['香港', 22.32, 114.17], ['澳门', 22.2, 113.55], ['台北', 25.03, 121.57],
  ['东京', 35.68, 139.69], ['首尔', 37.57, 126.98], ['新加坡', 1.35, 103.82], ['曼谷', 13.75, 100.5], ['吉隆坡', 3.14, 101.69], ['达卡', 23.81, 90.41], ['迪拜', 25.2, 55.27],
  ['伦敦', 51.51, -0.13], ['法兰克福', 50.11, 8.68], ['纽约', 40.71, -74.0], ['洛杉矶', 34.05, -118.24], ['悉尼', -33.87, 151.21],
];

export function geoOf(c) {
  const g = c.geo || {};
  if (g.mode === 'manual' && g.lat !== null && g.lon !== null) return { lat: g.lat, lon: g.lon, src: g.city || `${g.lat.toFixed(2)}, ${g.lon.toFixed(2)}` };
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  if (TZ[tz]) return { lat: TZ[tz][0], lon: TZ[tz][1], src: '时区 ' + tz };
  const off = -new Date().getTimezoneOffset() / 60;
  return { lat: 30, lon: clamp(off * 15, -180, 180), src: `时区 UTC${off >= 0 ? '+' : ''}${off}（估算）` };
}

const atLocal = (t, hours) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() + hours * H; };
function dayTimes(t, c) {
  if (c.geo.mode === 'fixed') return { rise: atLocal(t, c.geo.dayStart), set: atLocal(t, c.geo.dayEnd), src: '固定时刻' };
  const g = geoOf(c);
  const noon = new Date(t); noon.setHours(12, 0, 0, 0);
  const r = sunRiseSet(noon, g.lat, g.lon);
  if (r.polar) return { rise: atLocal(t, 6), set: atLocal(t, 18), src: g.src + '（极昼/极夜，按 6–18 点）' };
  return { rise: r.rise, set: r.set, src: g.src };
}
// 当前时段：日出 ≤ t < 日落 为白天，否则为夜晚
export function periodAt(t, c) {
  const td = dayTimes(t, c);
  if (td.set <= td.rise) { // 固定时刻跨午夜（如 dayStart 20 > dayEnd 8 的反常设置）
    const day = t >= td.rise || t < td.set;
    return { period: day ? 'day' : 'night', rise: td.rise, set: td.set, next: day ? (t < td.set ? td.set : td.set + 24 * H) : td.rise, src: td.src };
  }
  if (t < td.rise) return { period: 'night', rise: td.rise, set: td.set, next: td.rise, src: td.src };
  if (t < td.set) return { period: 'day', rise: td.rise, set: td.set, next: td.set, src: td.src };
  const tm = dayTimes(t + 24 * H, c);
  return { period: 'night', rise: td.rise, set: td.set, next: tm.rise, src: td.src };
}
// 下一次定时测试：本地时间按 intervalH 整点对齐（3 小时 → 0/3/6/9/12/15/18/21 点），+2 分钟错开整点高峰
export function nextRunAt(t, intervalH) {
  const d = new Date(t);
  d.setMinutes(2, 0, 0);
  d.setHours(Math.floor(d.getHours() / intervalH) * intervalH);
  while (d.getTime() <= t + 30e3) d.setHours(d.getHours() + intervalH);
  return d.getTime();
}

// ───────────── 节点范围：哪些节点使用优选 IP ─────────────
const CF_HOST = /\.(workers\.dev|pages\.dev)$/i;
const nodeSigOf = n => `${n.address}|${n.host || ''}|${n.sni || ''}|${n.port}`;
function eligibleKind(n) { return (n.kind === 'vless' || n.kind === 'trojan') && n.enabled !== false && !n.unsupported; }
function nodeIsCf(n) {
  if (n.et >= 2) return true; // 合并的 edgetunnel 订阅节点（同一 Host/UUID 有多个优选地址）就是 Cloudflare 优选模式；只有一个条目的 Host 走正常识别
  if (CF_HOST.test(n.host || '') || CF_HOST.test(n.sni || '') || CF_HOST.test(n.address || '')) return true;
  if (isIp(n.address)) return isCfIp(n.address);
  const e = S.nodeCf[n.id];
  return !!(e && e.sig === nodeSigOf(n) && e.cf);
}
let detectP = null;
export function detectNodes({ force = false } = {}) {
  if (detectP) return detectP;
  detectP = (async () => {
    const nodes = (await store.get('nodes')).filter(eligibleKind);
    const todo = nodes.filter(n => {
      if (CF_HOST.test(n.host || '') || CF_HOST.test(n.sni || '') || isIp(n.address)) return false;
      const e = S.nodeCf[n.id];
      return force || !e || e.sig !== nodeSigOf(n) || now() - e.at > 24 * H;
    });
    let changed = false;
    if (todo.length && Core.up) {
      const hosts = [...new Set(todo.map(n => String(n.address).toLowerCase()))];
      let res = {};
      try { res = await Core.call('resolve', { hosts }, 20000); } catch {}
      for (const n of todo) {
        const ips = res[String(n.address).toLowerCase()] || [];
        if (!ips.length) continue;
        const cf = ips.some(isCfIp);
        const prev = S.nodeCf[n.id];
        if (!prev || prev.cf !== cf || prev.sig !== nodeSigOf(n)) changed = true;
        S.nodeCf[n.id] = { cf, sig: nodeSigOf(n), at: now(), ip: ips[0] };
      }
    }
    const ids = new Set(nodes.map(n => n.id));
    for (const id of Object.keys(S.nodeCf)) if (!ids.has(id)) { delete S.nodeCf[id]; changed = true; }
    if (changed) { save(); hooks.onChange().catch(() => {}); }
    return changed;
  })().finally(() => { detectP = null; });
  return detectP;
}

let cfgCache = normCfg(null);
export function setCfgCache(c) { cfgCache = normCfg(c); }

// 引擎在构建线路时同步调用：返回该节点要使用的地址列表（null 表示不使用优选 IP）
export function addrsFor(n) {
  const c = cfgCache;
  if (!loaded || !c.enabled || !S.active || !S.active.main?.length) return null;
  if (!eligibleKind(n)) return null;
  if (c.scope !== 'all' && !nodeIsCf(n)) {
    if (!isIp(n.address) && !S.nodeCf[n.id]) setTimeout(() => detectNodes().catch(() => {}), 1000);
    return null;
  }
  const list = [...S.active.main, ...(S.active.backup || [])];
  if (n.prefAddr) list.push(n.prefAddr);
  list.push(n.address);
  if (n.et && n.altAddrs?.length) list.push(...n.altAddrs.slice(0, 6)); // 合并的 edgetunnel 节点：订阅地址作为最后的备用
  const addrs = [...new Set(list.filter(Boolean))].slice(0, 16);
  return { addrs, main: S.active.main.length };
}
export function nodeUsesBestip(n) { return !!addrsFor(n); }

// ───────────── 成绩记录与汇总 ─────────────
function record(ip, period, sample) {
  const e = S.ips[ip] ||= { f: famOf(ip), day: [], night: [], colo: '', first: now() };
  e[period] = [...(e[period] || []), sample].slice(-MAX_SAMPLES);
  if (sample.colo) e.colo = sample.colo;
  e.last = sample.at;
}
function prune() {
  const t = now();
  const ranges6 = cfgCache.v6Cidrs.map(parseCidr), ranges4 = cfgCache.v4Cidrs.map(parseCidr);
  for (const [ip, e] of Object.entries(S.ips)) {
    e.day = (e.day || []).filter(s => t - s.at < SAMPLE_TTL);
    e.night = (e.night || []).filter(s => t - s.at < SAMPLE_TTL);
    const inRange = (e.f === 6 ? ranges6 : ranges4).some(r => r && inCidr(ip, r));
    // 不在当前网段里的 IP（用户改了网段）：保留 1 天后清掉
    if ((!e.day.length && !e.night.length) || (!inRange && t - (e.last || 0) > 24 * H)) delete S.ips[ip];
  }
  // 硬上限，防止存储膨胀：只保留最近测过的 600 个
  const ips = Object.entries(S.ips);
  if (ips.length > 600) ips.sort((a, b) => (b[1].last || 0) - (a[1].last || 0)).slice(600).forEach(([ip]) => delete S.ips[ip]);
}
// 加权汇总：半衰期 12 小时，最新一次额外加权
function agg(all, sk) {
  const list = (all || []).filter(s => s.lm === LAT_MODE);
  if (!list.length) return null;
  const t = now();
  let w = 0, ms = 0, loss = 0, wl = 0, pk = 0, av = 0, wp = 0, jit = 0;
  list.forEach((s, i) => {
    const wi = Math.pow(0.5, (t - s.at) / (12 * H)) * (i === list.length - 1 ? 2 : 1);
    loss += wi * s.loss; wl += wi;
    if (s.ms > 0) { ms += wi * s.ms; jit += wi * (s.jit || 0); w += wi; }
    if (s.pk != null && s.sk === sk) { pk += wi * s.pk; av += wi * (s.av || 0); wp += wi; }
  });
  const last = list[list.length - 1];
  return {
    ms: w ? Math.round(ms / w) : 0, jit: w ? Math.round(jit / w) : 0, loss: wl ? +(loss / wl).toFixed(3) : 1,
    pk: wp ? pk / wp : null, av: wp ? av / wp : null, n: list.length, at: last.at,
    lastOk: last.loss < 1 && last.v !== false, v: last.v, vms: last.vms || 0, lastMs: last.ms, lastLoss: last.loss,
  };
}
function thOf(c, f) { return f === 6 ? c.th6 : c.th4; }
function judge(a, c, f) {
  const th = thOf(c, f);
  const why = [];
  if (!a.lastOk) why.push(a.v === false ? '经节点验证失败' : '最近一次不通');
  if (!(a.ms > 0) || a.ms >= th.ms) why.push(`延迟 ${a.ms || '—'}ms ≥ ${th.ms}`);
  if (a.loss * 100 > th.loss + 1e-6) why.push(`丢包 ${(a.loss * 100).toFixed(0)}% > ${th.loss}%`);
  if (th.mbs > 0) { if (a.pk == null) why.push('未测速'); else if (a.pk / MB < th.mbs) why.push(`峰值 ${(a.pk / MB).toFixed(1)} < ${th.mbs} MB/s`); }
  return why;
}
function scoreOf(a, c, f) {
  const th = thOf(c, f);
  const ratio = a.pk == null ? 0.5 : (a.pk / MB) / Math.max(1, th.mbs);
  return Math.round((a.ms || 999) * (1 + 3 * a.loss) + 0.5 * a.jit + 40 * Math.max(0, 1 - ratio) - 10 * clamp(ratio - 1, 0, 1.5) + (a.lastOk ? 0 : 500));
}
function ranked(period, c, f) {
  const t = now();
  const out = [];
  const sk = speedKey(c.speedUrl);
  for (const [ip, e] of Object.entries(S.ips)) {
    if (e.f !== f) continue;
    const a = agg(e[period], sk);
    if (!a || t - a.at > STALE) continue;
    const why = judge(a, c, f);
    out.push({ ip, f, ms: a.ms, jit: a.jit, loss: a.loss, pk: a.pk, av: a.av, n: a.n, at: a.at, colo: e.colo || '', q: !why.length, why, score: scoreOf(a, c, f), ok: a.lastOk, vms: a.vms });
  }
  return out.sort((x, y) => (y.q - x.q) || x.score - y.score);
}
function buildList(period, c, caps) {
  const useV6 = c.family !== 'v4' && caps?.v6 !== false;
  const useV4 = c.family !== 'v6' && (caps?.v4 !== false || !useV6);
  const R6 = useV6 ? ranked(period, c, 6) : [];
  const R4 = useV4 ? ranked(period, c, 4) : [];
  if (!R6.length && !R4.length) return null;
  const main = [], backup = [];
  const take = (arr, n, pred) => { for (const x of arr) { if (main.length >= n) break; if (pred(x) && !main.includes(x)) main.push(x); } };
  if (useV6 && R6.length) {
    // 双栈：主用只用 IPv6（达标优先，不足时用最接近达标的 IPv6 补）；可用的 IPv6 都不够数时才让 IPv4 进主用
    take(R6, c.top, x => x.q);
    if (c.fill) take(R6, c.top, x => x.ok);
    if (useV4) { take(R4, c.top, x => x.q); if (c.fill) take(R4, c.top, x => x.ok); }
    if (useV4) for (const x of [...R4.filter(x => x.q), ...R4.filter(x => !x.q && x.ok)]) { if (backup.length >= c.backups) break; if (!main.includes(x) && !backup.includes(x)) backup.push(x); }
  } else {
    take(R4, c.top, x => x.q);
    if (c.fill) take(R4, c.top, x => x.ok);
    for (const x of R4.filter(x => x.ok)) { if (backup.length >= c.backups) break; if (!main.includes(x)) backup.push(x); }
  }
  const pick = x => ({ ip: x.ip, f: x.f, ms: x.ms, loss: x.loss, pk: x.pk, av: x.av, colo: x.colo, q: x.q, why: x.why, n: x.n, at: x.at, score: x.score, vms: x.vms });
  const all = [...R6.slice(0, 12), ...R4.slice(0, 8)].map(pick);
  return { main: main.map(pick), backup: backup.map(pick), all, q6: R6.filter(x => x.q).length, q4: R4.filter(x => x.q).length, n6: R6.length, n4: R4.length, at: now() };
}
function rebuild(c) {
  prune();
  S.lists = { day: buildList('day', c, S.caps), night: buildList('night', c, S.caps) };
  return selectActive(c);
}
// 选出当前时段的生效列表；当前时段没有数据时借用另一时段
function selectActive(c, t = now()) {
  const p = periodAt(t, c);
  const own = S.lists[p.period];
  const other = S.lists[p.period === 'day' ? 'night' : 'day'];
  const L = own?.main?.length ? own : other?.main?.length ? other : null;
  const next = L ? { period: p.period, borrowed: L !== own, main: L.main.map(x => x.ip), backup: L.backup.map(x => x.ip), at: now() } : null;
  const changed = JSON.stringify(next && [next.main, next.backup]) !== JSON.stringify(S.active && [S.active.main, S.active.backup]);
  S.active = next;
  S.period = p.period;
  S.nextSwitch = p.next;
  return changed;
}

// ───────────── 测试一轮 ─────────────
let runP = null;
let cancelReq = false;
let progT = 0;
function progress(p, { flush = false } = {}) {
  S.running = { ...(S.running || {}), ...p };
  if (flush || now() - progT > 700) { progT = now(); save(); } else save({ soon: true });
}
const checkCancel = () => { if (cancelReq) throw Object.assign(new Error('已取消'), { cancelled: true }); };

export function running() { return !!runP; }
export function cancel() { if (runP) cancelReq = true; return { ok: true }; }

export function runRound({ manual = false, reason = '' } = {}) {
  if (runP) return runP;
  cancelReq = false;
  runP = doRound({ manual, reason }).finally(() => { runP = null; cancelReq = false; });
  return runP;
}

async function doRound({ manual, reason }) {
  const c = await cfg();
  setCfgCache(c);
  const t0 = now();
  const period = periodAt(t0, c).period;
  const ka = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20e3); // 保持 Service Worker 存活
  const SK = speedKey(c.speedUrl);
  const round = { at: t0, period, manual, reason, lm: LAT_MODE, sk: SK, sampled: 0, reach: 0, speed: 0, bytes: 0, err: '' };
  let startedCore = false;
  try {
    progress({ started: t0, phase: 'prep', text: '准备中…', done: 0, total: 0, period, manual }, { flush: true });
    // 等待引擎空闲（正在连接/切换时不抢资源）
    for (let i = 0; i < 45 && hooks.busy(); i++) { await sleep(2000); checkCancel(); }
    const wasUp = Core.up;
    if (!(await hooks.ensureCore())) throw Object.assign(new Error('本地核心未运行，无法测试（请在「核心」页安装或启动）'), { user: true });
    startedCore = !wasUp;
    const feats = Core.info?.features || [];
    if (!feats.includes('bestip')) throw Object.assign(new Error(`本地核心版本过旧（${Core.info?.version || '?'}），优选 IP 需要核心 1.2.0 或更新，请在「核心」页重新安装`), { user: true, oldCore: true });

    // ① 本机网络能力
    progress({ phase: 'caps', text: '检测本机 IPv4 / IPv6…' }, { flush: true });
    const caps = await Core.call('netcaps', { timeout: 2500 }, 15000);
    const prevCaps = S.caps;
    S.caps = caps;
    if (!prevCaps || prevCaps.v6 !== caps.v6) log('info', `优选 IP：本机 IPv6 ${caps.v6 ? '可用' : '不可用'}，IPv4 ${caps.v4 ? '可用' : '不可用'}${caps.v6 ? '' : '，本轮只测 IPv4 网段'}`);
    const useV6 = c.family !== 'v4' && caps.v6 && c.v6Cidrs.length > 0;
    const useV4 = c.family !== 'v6' ? (caps.v4 && c.v4Cidrs.length > 0) : false;
    if (!useV6 && !useV4) throw Object.assign(new Error(c.family === 'v6' && !caps.v6 ? '本机没有可用的 IPv6，且设置为「只用 IPv6」' : '本机网络不可用'), { user: true });
    checkCancel();

    // ② 抽样：每个网段随机 perCidr 个 + 上轮入选的 IP（持续复测，保证排名稳定）
    const incumbents = new Set([...(S.lists.day?.main || []), ...(S.lists.day?.backup || []), ...(S.lists.night?.main || []), ...(S.lists.night?.backup || [])].map(x => x.ip));
    const cands = new Set();
    for (const cidr of useV6 ? c.v6Cidrs : []) sampleCidr(cidr, c.perCidr).forEach(ip => cands.add(ip));
    for (const cidr of useV4 ? c.v4Cidrs : []) sampleCidr(cidr, c.perCidr).forEach(ip => cands.add(ip));
    for (const ip of incumbents) { const f = famOf(ip); if ((f === 6 && useV6) || (f === 4 && useV4)) cands.add(ip); }
    const list = [...cands];
    round.sampled = list.length;

    // ③ 快速筛选：每个 IP 握手 2 次
    progress({ phase: 'ping', text: `延迟初筛 ${list.length} 个 IP…`, done: 0, total: list.length }, { flush: true });
    const quick = await Core.call('ipping', { ips: list, count: 2, timeout: 1200, concurrency: 24 }, 120000);
    checkCancel();
    const alive = quick.filter(r => r.recv > 0);
    round.reach = alive.length;
    const fails = quick.filter(r => !r.recv);
    // 完全不通的 IP 也记录（下次排名靠后、不会入选）
    for (const r of fails) if (incumbents.has(r.ip)) record(r.ip, period, { at: now(), lm: LAT_MODE, sk: SK, ms: 0, loss: 1, jit: 0, pk: null, av: null });
    if (!alive.length) throw Object.assign(new Error('所有抽样 IP 都无法连接（网络异常或网段不可用）'), { user: true });

    // ④ 精测：延迟最低的一批，各握手 pings 次，得到稳定的延迟与丢包
    const by = f => alive.filter(r => famOf(r.ip) === f).sort((a, b) => a.avg - b.avg);
    const deepList = [...by(6).slice(0, 16), ...by(4).slice(0, 10)];
    for (const ip of incumbents) { const r = alive.find(x => x.ip === ip); if (r && !deepList.includes(r)) deepList.push(r); }
    progress({ phase: 'deep', text: `精测延迟与丢包（${deepList.length} 个 × ${c.pings} 次）…`, done: 0, total: deepList.length }, { flush: true });
    const deep = await Core.call('ipping', { ips: deepList.map(r => r.ip), count: c.pings, timeout: 1500, gap: 120, concurrency: 8 }, 180000);
    checkCancel();
    const deepMap = new Map(deep.map(r => [r.ip, r]));

    // ⑤ 测速：每个协议族挑延迟最低、丢包达标的若干个，逐个测（避免互相抢带宽）
    const lossOk = r => r.loss * 100 <= thOf(c, famOf(r.ip)).loss + 1e-6;
    const sortD = arr => arr.sort((a, b) => (lossOk(b) - lossOk(a)) || a.avg - b.avg || a.loss - b.loss);
    const d6 = sortD(deep.filter(r => r.recv > 0 && famOf(r.ip) === 6));
    const d4 = sortD(deep.filter(r => r.recv > 0 && famOf(r.ip) === 4));
    let q6 = 0, q4 = 0;
    if (d6.length && d4.length) { q4 = Math.min(d4.length, Math.max(2, Math.floor(c.speedTop / 3))); q6 = Math.min(d6.length, c.speedTop - q4); }
    else if (d6.length) q6 = Math.min(d6.length, c.speedTop);
    else q4 = Math.min(d4.length, c.speedTop);
    // 测速保护：近期测过且没变差的 IP、不可能入选的新候选都不测
    const t5 = now();
    const prevSp = ip => (S.ips[ip]?.[period] || []).filter(x => x.pk != null && !x.carry && x.sk === SK).pop();
    const fresh = r => { const p = prevSp(r.ip); return !!p && t5 - p.at < FRESH && p.ms > 0 && r.avg <= p.ms * 1.25 + 5 && r.loss <= (p.loss || 0) + 1e-6; };
    const curL = S.lists[period];
    const hasV6Main = (curL?.main || []).some(x => x.f === 6);
    // 该协议族当前名单（主用，或双栈时 IPv4 的备用）是否已满且全部达标
    const poolOf = f => {
      const need = Math.max(1, f === 4 && hasV6Main ? c.backups : c.top);
      const pool = [...(curL?.main || []), ...(curL?.backup || [])].filter(x => x.f === f && x.q && x.ms > 0);
      return { full: pool.length >= need, worst: pool.length ? Math.max(...pool.map(x => x.score)) : Infinity };
    };
    const P = { 6: poolOf(6), 4: poolOf(4) };
    // 名单已满时，新候选只有在「即使速度拿满分也能比名单里最差的好 5 分以上」才值得测
    const hopeless = r => {
      const f = famOf(r.ip);
      if (!P[f].full) return false;
      const best = r.avg * (1 + 3 * r.loss) + 0.5 * (r.jitter || 0) - 15;
      return r.avg >= thOf(c, f).ms || best >= P[f].worst - 5;
    };
    round.spFresh = 0; round.spHope = 0;
    let explore = 2; // 名单已满时，每轮最多试测 2 个新候选
    // 按延迟从低到高取，跳过免测的，直到凑满该协议族的测速名额
    const pickSp = (arr, q) => {
      const out = [];
      for (const r of arr) {
        if (out.length >= q) break;
        if (fresh(r)) { round.spFresh++; continue; }
        const isNew = !incumbents.has(r.ip);
        if (isNew && hopeless(r)) { round.spHope++; continue; }
        if (isNew && P[famOf(r.ip)].full) { if (explore <= 0) { round.spHope++; continue; } explore--; }
        out.push(r.ip);
      }
      return out;
    };
    let speedList = [...pickSp(d6, q6), ...pickSp(d4, q4)];
    const speedRes = new Map();
    let skipSpeed = false;
    const lim0 = limitLeft();
    const bud = budget(c);
    if (lim0 && speedList.length) { skipSpeed = true; round.limited = true; round.err = `测速接口限流中，${fmtMin(lim0)}后恢复；本轮只测延迟/丢包（速度沿用历史）`; }
    else if (speedList.length && bud.left <= 0) { skipSpeed = true; round.spBudget = speedList.length; round.err = `今日测速次数已达上限（${c.speedDaily} 次），本轮只测延迟/丢包（可在「高级」调整）`; }
    else if (speedList.length > bud.left) { round.spBudget = speedList.length - bud.left; speedList = speedList.slice(0, bud.left); }
    if (!skipSpeed && c.idleOnly && !manual && speedList.length) {
      // 自动测试时若正在大流量使用（>1.5 MB/s）则等待，最多 1 分钟，仍忙则本轮不测速（沿用历史速度）
      for (let i = 0; i < 4; i++) {
        let st = null;
        try { st = await Core.call('status', {}, 4000); } catch {}
        const rate = (st?.rateDown || 0) + (st?.rateUp || 0);
        if (rate < 1.5 * MB) break;
        if (i === 3) { skipSpeed = true; round.err = '正在大流量使用，本轮跳过测速'; break; }
        progress({ phase: 'wait', text: '检测到正在大流量使用，稍后再测速…' }, { flush: true });
        await sleep(20000);
        checkCancel();
      }
    }
    round.speed = 0;
    if (!skipSpeed && speedList.length) {
      let i = 0, okN = 0, httpStreak = 0;
      for (const ip of speedList) {
        checkCancel();
        if (hourCount() >= _t.perHour) { round.err = `1 小时内已测速 ${_t.perHour} 次，剩下的 IP 本轮不测（速度沿用历史，避免限流）`; round.spBudget = (round.spBudget || 0) + speedList.length - i; break; }
        const since = now() - (S.spLast || 0);
        const gap = i > 0 ? _t.gap[0] + Math.random() * (_t.gap[1] - _t.gap[0]) : _t.minGap;
        if (since < gap) await waitGap(gap - since, `已测 ${i}/${speedList.length}`);
        progress({ phase: 'speed', text: `测速 ${ip}（${++i}/${speedList.length}）…`, done: i - 1, total: speedList.length }, { flush: true });
        let r;
        try { r = await Core.call('ipspeed', { ip, url: c.speedUrl, seconds: c.speedSec, timeout: 6000, plateau: true }, (c.speedSec + 15) * 1000); } catch (e) { r = { ok: false, err: e.message }; }
        spent(c, r);
        round.speed++;
        round.bytes += r.bytes || 0;
        if (isLimited(r)) {
          const dur = setLimit(r, 'round');
          round.limited = true;
          round.err = `测速接口限流（${r.err || 'HTTP ' + r.status}），已停止本轮测速并暂停 ${fmtMin(dur)}`;
          break;
        }
        if (r.ok) { okN++; httpStreak = 0; speedRes.set(ip, r); continue; }
        if (r.status >= 400) {
          // 测速地址本身的问题（不是这个 IP 慢）：不记成绩；连续两次就停，避免反复请求
          if (++httpStreak >= 2) { round.err = `测速地址连续返回错误（${r.err}），已停止本轮测速，请在「高级」检查测速地址`; log('warn', '优选 IP：' + round.err); break; }
          continue;
        }
        speedRes.set(ip, r); // 连接超时 / TLS 失败等：记为该 IP 测速失败
      }
      const allFail = round.speed > 0 && okN === 0 && !round.limited;
      if (allFail && !round.err) { const why = [...speedRes.values()].map(x => x.err).filter(Boolean)[0] || '未知原因'; round.err = `测速全部失败（${why}），本轮只按延迟/丢包记录，请在「高级」检查测速地址`; log('warn', '优选 IP：' + round.err); }
      round.speedFail = allFail;
    }

    // ⑥ 经节点验证：用真实节点参数通过这些 IP 握手，确保能用于该节点
    let vMap = new Map();
    const vNode = await pickVerifyNode(c);
    if (vNode) {
      const vIps = [...new Set([...speedList, ...[...incumbents].filter(ip => deepMap.get(ip)?.recv > 0)])].slice(0, 20);
      progress({ phase: 'verify', text: `经节点「${vNode.name}」验证 ${vIps.length} 个 IP…`, done: 0, total: vIps.length }, { flush: true });
      try {
        const vr = await Core.call('ipverify', { route: vNode.route, ips: vIps, timeout: 5000, concurrency: 4 }, 90000);
        vMap = new Map(vr.map(r => [r.ip, r]));
        round.verified = vr.filter(r => r.ok).length;
        round.vnode = vNode.name;
      } catch (e) { round.err ||= '节点验证失败：' + e.message; }
    }
    checkCancel();

    // ⑦ 记录本轮成绩
    const at = now();
    for (const r of deep) {
      const sp = speedRes.get(r.ip);
      const v = vMap.get(r.ip);
      const s = { at, lm: LAT_MODE, sk: SK, ms: r.recv ? r.avg : 0, loss: r.loss, jit: r.jitter || 0, pk: null, av: null };
      if (sp && !round.speedFail) { s.pk = sp.ok ? sp.peak : 0; s.av = sp.ok ? sp.avg : 0; if (sp.colo) s.colo = sp.colo; }
      if (v) { s.v = !!v.ok; if (v.ok) s.vms = v.ms; }
      // 本轮未测速 / 测速地址故障：沿用该 IP 同时段最近一次速度
      if (s.pk == null) { const prev = (S.ips[r.ip]?.[period] || []).filter(x => x.pk != null && !x.carry && x.sk === SK).pop(); if (prev && at - prev.at < 2 * 24 * H) { s.pk = prev.pk; s.av = prev.av; s.carry = 1; } }
      record(r.ip, period, s);
    }
    S.lastRun = at;
    S[period === 'day' ? 'lastDay' : 'lastNight'] = at;

    // ⑧ 排名与生效
    const changed = rebuild(c);
    const L = S.lists[period];
    round.q6 = L?.q6 || 0; round.q4 = L?.q4 || 0;
    round.main = (L?.main || []).map(x => x.ip);
    round.backup = (L?.backup || []).map(x => x.ip);
    round.dur = now() - t0;
    log('info', `优选 IP（${period === 'day' ? '白天' : '夜晚'}）：抽样 ${round.sampled}，可达 ${round.reach}，测速 ${round.speed}，达标 IPv6 ${round.q6} / IPv4 ${round.q4}，用时 ${Math.round(round.dur / 1000)} 秒`);
    if (changed) hooks.onChange().catch(() => {});
    return { ok: true, round, active: S.active };
  } catch (e) {
    round.err = e.cancelled ? '已取消' : e.message;
    round.dur = now() - t0;
    round.failed = true;
    if (!e.cancelled) log(e.user ? 'warn' : 'error', '优选 IP 测试失败：' + e.message);
    if (e.user || e.cancelled) return { ok: false, round, error: round.err, oldCore: !!e.oldCore };
    throw e;
  } finally {
    clearInterval(ka);
    S.rounds = [round, ...(S.rounds || [])].slice(0, 30);
    S.running = null;
    S.next = nextRunAt(now(), c.intervalH);
    await save();
    // VPN 关闭时由本模块临时拉起的原生核心：测完关掉，恢复原状
    if (startedCore) {
      const s = await store.get('settings');
      if (!s.enabled && Core.via === 'native') { try { Core.disconnect(); } catch {} }
    }
  }
}

// 选一个 Cloudflare 节点用于验证：优先当前正在用的
async function pickVerifyNode(c) {
  const nodes = (await store.get('nodes')).filter(eligibleKind);
  const rt = hooks.getRt();
  const curId = rt?.active?.nodeId;
  const ok = n => c.scope === 'all' || nodeIsCf(n);
  const n = nodes.find(x => x.id === curId && ok(x)) || nodes.find(x => ok(x) && x.tls) || nodes.find(ok);
  if (!n) return null;
  const sni = n.sni || (n.tls ? (n.host || (isIp(n.address) ? '' : n.address)) : '');
  return { name: n.name, route: { key: 'bestip-verify', kind: n.kind, name: n.name, address: n.address, port: n.port, tls: !!n.tls, sni, host: n.host || n.sni || n.address, path: n.path || '/', uuid: n.uuid, password: n.password, insecure: !!n.insecure } };
}

// ───────────── 调度：每 intervalH 小时整点 + 日出/日落切换 ─────────────
export async function schedule({ catchUp = true } = {}) {
  const c = await cfg();
  setCfgCache(c);
  if (!c.enabled) {
    await chrome.alarms.clear('bestip');
    await chrome.alarms.clear('bestip-switch');
    S.next = 0;
    save();
    return;
  }
  const t = now();
  // 定时点加 0~5 分钟随机偏移（同一个整点不固定打到测速接口）；同一个定时点内保持不变
  const base = nextRunAt(t, c.intervalH);
  if (!S.jit || S.jit.base !== base) S.jit = { base, ms: Math.floor(Math.random() * 5 * 60e3) };
  let next = base + S.jit.ms;
  // 补测：从未测过 / 上次太久以前 / 当前时段没有自己的数据 → 1~2 分钟后先测一轮
  const p = periodAt(t, c);
  const lastP = p.period === 'day' ? S.lastDay : S.lastNight;
  if (catchUp && (!S.lastRun || t - S.lastRun > c.intervalH * H * 1.5 || (!lastP && t - S.lastRun > 20 * 60e3))) next = Math.min(next, t + (S.lastRun ? 2 : 1) * 60e3);
  S.next = next;
  chrome.alarms.create('bestip', { when: next });
  chrome.alarms.create('bestip-switch', { when: Math.max(t + 30e3, p.next + 5e3) });
  if (selectActive(c)) hooks.onChange().catch(() => {});
  save();
}

export async function onAlarm(name) {
  if (name === 'bestip') {
    const c = await cfg();
    if (!c.enabled) return;
    try { await runRound({ reason: 'timer' }); } catch {}
    await schedule({ catchUp: false });
  }
  if (name === 'bestip-switch') {
    const c = await cfg();
    setCfgCache(c);
    const prev = S.active?.period;
    const changed = selectActive(c);
    if (prev && prev !== S.period) log('info', `优选 IP：进入${S.period === 'day' ? '白天' : '夜晚'}时段，切换为${S.period === 'day' ? '白天' : '夜晚'}最优的 ${S.active?.main?.length || 0} 个 IP${S.active?.borrowed ? '（该时段暂无数据，暂用另一时段结果）' : ''}`);
    if (changed) hooks.onChange().catch(() => {});
    await schedule();
  }
}

// 启动（Service Worker 每次唤醒都会调用）
export async function start() {
  if (!loaded) await load();
  const c = await cfg();
  setCfgCache(c);
  if (S.lists && (S.lists.day || S.lists.night)) selectActive(c);
  const [a, b] = await Promise.all([chrome.alarms.get('bestip'), chrome.alarms.get('bestip-switch')]);
  if (!a || !b || !S.next) await schedule();
  setTimeout(() => detectNodes().catch(() => {}), 5000);
}

// 设置变化：重排（阈值变了排名就变）、重设闹钟、必要时刷新线路
export async function onSettings(prevRaw, nextRaw) {
  const p = normCfg(prevRaw), c = normCfg(nextRaw);
  setCfgCache(c);
  const changed = rebuild(c);
  const sched = p.enabled !== c.enabled || p.intervalH !== c.intervalH || JSON.stringify(p.geo) !== JSON.stringify(c.geo);
  if (sched) await schedule();
  else save();
  if (p.scope !== c.scope) detectNodes({ force: true }).catch(() => {});
  if (changed || p.enabled !== c.enabled || p.scope !== c.scope) await hooks.onChange().catch(() => {});
  // 网段或协议族变化：尽快重测
  if (p.speedUrl !== c.speedUrl && speedKey(p.speedUrl) !== speedKey(c.speedUrl)) log('info', `优选 IP：测速地址已改为 ${speedKey(c.speedUrl)}，旧地址的速度数据不再参与排名（不同模式不可比较），1 分钟后重新测试`);
  if (c.enabled && (JSON.stringify([p.v6Cidrs, p.v4Cidrs, p.family, speedKey(p.speedUrl)]) !== JSON.stringify([c.v6Cidrs, c.v4Cidrs, c.family, speedKey(c.speedUrl)]))) {
    chrome.alarms.create('bestip', { when: now() + 60e3 });
    S.next = now() + 60e3;
    save();
  }
}

// 检测测速地址：用当前最优（或网段内随机）IP 直连测速，确认地址返回的是测速数据
export async function checkSpeedUrl(url) {
  const c = await cfg();
  url = url || c.speedUrl;
  if (!(await hooks.ensureCore())) throw Object.assign(new Error('本地核心未运行'), { user: true });
  if (!(Core.info?.features || []).includes('bestip')) throw Object.assign(new Error('本地核心版本过旧，请先更新核心到 1.2.0'), { user: true, oldCore: true });
  const caps = S.caps || await Core.call('netcaps', {}, 15000);
  const pool = [...(S.active?.main || []), ...(S.active?.backup || [])].filter(ip => (famOf(ip) === 6 ? caps.v6 : caps.v4));
  const ip = pool[0] || sampleCidr((caps.v6 && c.family !== 'v4' ? c.v6Cidrs : c.v4Cidrs)[0] || c.v4Cidrs[0], 1)[0];
  if (!ip) throw Object.assign(new Error('没有可用的测试 IP'), { user: true });
  const left = limitLeft();
  if (left) throw Object.assign(new Error(`测速接口限流中，约 ${fmtMin(left)}后恢复；为避免延长限流，暂不检测（可在「高级」解除等待）`), { user: true });
  if (runP) throw Object.assign(new Error('优选测试进行中，请稍后再检测'), { user: true });
  const since = now() - (S.spLast || 0);
  if (since < _t.minGap) throw Object.assign(new Error(`刚刚测过速，请 ${Math.ceil((_t.minGap - since) / 1000)} 秒后再检测（拉开间隔，避免限流）`), { user: true });
  if (hourCount() >= _t.perHour) throw Object.assign(new Error(`1 小时内已测速 ${_t.perHour} 次，请稍后再检测（避免限流）`), { user: true });
  const r = await Core.call('ipspeed', { ip, url, seconds: 3, timeout: 6000, plateau: true }, 30000);
  spent(c, r);
  if (isLimited(r)) { const dur = setLimit(r, 'check'); r.err = `${r.err || 'HTTP ' + r.status}：测速接口限流，已暂停测速 ${fmtMin(dur)}`; }
  await save();
  return { ...r, url };
}

export async function clear(what = 'all') {
  if (runP) throw Object.assign(new Error('测试进行中，请先取消'), { user: true });
  if (what === 'all') { S.ips = {}; S.lists = { day: null, night: null }; S.active = null; S.rounds = []; S.lastRun = 0; S.lastDay = 0; S.lastNight = 0; }
  if (what === 'rounds') S.rounds = [];
  if (what === 'limit') { if (S.lim) log('info', '优选 IP：已手动解除测速限流等待'); S.lim = null; }
  await save();
  if (what === 'all') { await hooks.onChange().catch(() => {}); await schedule(); }
  return { ok: true };
}

// 给界面用的快照（计算当前时段与日出日落）
export async function view() {
  const c = await cfg();
  const t = now();
  const p = periodAt(t, c);
  const tm = periodAt(t + 24 * H, c);
  const nodes = (await store.get('nodes')).filter(eligibleKind);
  return {
    cfg: c, period: p.period, rise: p.rise, set: p.set, nextSwitch: p.next, geoSrc: p.src, riseTomorrow: tm.rise,
    using: nodes.filter(n => addrsFor(n)).map(n => n.name),
    eligible: nodes.length, cfNodes: nodes.filter(n => c.scope === 'all' || nodeIsCf(n)).length,
    running: !!runP, coreFeatures: Core.info?.features || [], coreVersion: Core.info?.version || '',
    limitLeft: limitLeft(t), budget: budget(c, t),
  };
}
