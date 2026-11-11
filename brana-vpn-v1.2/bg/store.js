// 持久化存储：设置 / 节点 / 订阅 / ProxyIP 池 / 测速统计 / 日志（带内存缓存与按键串行化写入）

export const DEFAULT_SOURCES = [
  'proxyip.cmliussss.net',
  'proxyip.hk.cmliussss.net',
  'proxyip.jp.cmliussss.net',
  'proxyip.sg.cmliussss.net',
  'proxyip.tw.cmliussss.net',
  'proxyip.kr.cmliussss.net',
  'proxyip.us.cmliussss.net',
  'proxyip.de.cmliussss.net',
  'proxyip.gb.cmliussss.net',
  'proxyip.nl.cmliussss.net',
];

export const SOURCE_PRESETS = [
  { id: 'cm-global', label: '🌐 CMLiussss 全球', lines: ['proxyip.cmliussss.net'] },
  { id: 'cm-asia', label: '🌏 亚洲常用（港/日/新/台/韩）', lines: ['proxyip.hk.cmliussss.net', 'proxyip.jp.cmliussss.net', 'proxyip.sg.cmliussss.net', 'proxyip.tw.cmliussss.net', 'proxyip.kr.cmliussss.net'] },
  { id: 'cm-west', label: '🌍 欧美常用（美/德/英/荷）', lines: ['proxyip.us.cmliussss.net', 'proxyip.de.cmliussss.net', 'proxyip.gb.cmliussss.net', 'proxyip.nl.cmliussss.net'] },
  { id: 'cm-colo', label: '🏢 按机房（HKG/NRT/SIN/LAX…）', lines: ['hkg.proxyip.cmliussss.net', 'nrt.proxyip.cmliussss.net', 'kix.proxyip.cmliussss.net', 'sin.proxyip.cmliussss.net', 'icn.proxyip.cmliussss.net', 'tpe.proxyip.cmliussss.net', 'lax.proxyip.cmliussss.net', 'sjc.proxyip.cmliussss.net', 'fra.proxyip.cmliussss.net', 'lhr.proxyip.cmliussss.net'] },
  { id: 'fxxk', label: '🪞 fxxk.dedyn.io 镜像', lines: ['proxyip.fxxk.dedyn.io', 'proxyip.jp.fxxk.dedyn.io', 'proxyip.sg.fxxk.dedyn.io', 'proxyip.us.fxxk.dedyn.io', 'proxyip.hk.fxxk.dedyn.io'] },
  { id: 'nirevil', label: '🔄 NiREvil 每日扫描库（API）', lines: ['https://raw.githubusercontent.com/NiREvil/vless/main/sub/country_proxies/JP.txt', 'https://raw.githubusercontent.com/NiREvil/vless/main/sub/country_proxies/SG.txt', 'https://raw.githubusercontent.com/NiREvil/vless/main/sub/country_proxies/HK.txt', 'https://raw.githubusercontent.com/NiREvil/vless/main/sub/country_proxies/US.txt', 'https://raw.githubusercontent.com/NiREvil/vless/main/sub/country_proxies/KR.txt', 'https://raw.githubusercontent.com/NiREvil/vless/main/sub/country_proxies/TW.txt'] },
];

// 优选 IP 默认设置（edgetunnel 节点的连接地址自动优选）
export const DEFAULT_BESTIP = {
  enabled: true,
  v6Cidrs: ['2606:4700:5a::/48', '2606:4700:52::/48', '2606:4700:57::/48'],
  v4Cidrs: ['172.64.229.0/24'],
  perCidr: 20,            // 每个网段每轮抽样数量
  intervalH: 3,           // 每几小时测一次（整点对齐）
  top: 5,                 // 每个时段保留前几名作为连接地址
  backups: 2,             // IPv4 备用数量（IPv6 可用时）
  th6: { ms: 80, mbs: 30, loss: 0 },   // IPv6 达标线：延迟 < ms、峰值 ≥ mbs MB/s、丢包 ≤ loss %
  th4: { ms: 150, mbs: 15, loss: 0 },  // IPv4 达标线（IPv4 一般延迟更高、稳定性更差，单独设置）
  family: 'auto',         // auto：IPv6 优先、IPv4 备用 | v6：只用 IPv6 | v4：只用 IPv4
  scope: 'auto',          // auto：仅 Cloudflare 节点 | all：所有 VLESS/Trojan 节点
  geo: { mode: 'auto', lat: null, lon: null, dayStart: 6, dayEnd: 18, city: '' }, // auto：按时区估算 | manual：经纬度 | fixed：固定时刻
  speedUrl: 'https://speed.cloudflare.com/__down?bytes=99999999',
  speedSec: 3,            // 每个 IP 测速秒数
  speedTop: 4,            // 每轮最多测速的 IP 数（测速消耗流量；近期测过且延迟没变差的 IP 会跳过）
  speedDaily: 40,         // 每日测速次数上限（含手动测试；安全兜底，正常每天约 25~30 次）
  pings: 8,               // 精测每个 IP 的 TCP 握手次数（丢包率精度）
  idleOnly: true,         // 自动测试时，若正在大流量使用则推迟/跳过测速
  fill: true,             // 达标 IP 不足时，用最接近达标的 IP 补足
  sv: 2,                  // 设置版本（用于一次性迁移旧默认值）
};

export const DEFAULT_SETTINGS = {
  v: 1,
  enabled: false,
  autoStart: true,         // 启动浏览器时自动连接（关闭则每次启动都保持断开）
  setupDone: false,        // 是否走完过设置向导
  mode: 'auto',            // auto 智能优选 | manual 手动
  region: '',              // '' = 最快；否则为 ProxyIP 出口国家代码
  scope: 'global',         // global 全局 | rules 仅名单走代理
  manual: { nodeId: '', pip: '' },
  strict: false,           // 防泄漏：任何情况下都不直连
  directFallback: false,   // 全部线路失败时直连兜底。1.2.7 起默认关：兜底会让网站看到真实 IP，且破坏统一出口
  dfMig: 1,                // 1.2.7 迁移标记：旧版默认开启的直连兜底只自动关闭一次，之后尊重用户选择
  webrtc: true,            // 连接时阻止 WebRTC 泄露真实 IP
  autoRotate429: true,     // Cloudflare 网站 429 限流时自动更换 ProxyIP
  autoSwitch: true,        // 后台发现明显更优线路时自动切换
  notify: true,            // 关键事件桌面通知
  badge: false,            // 网页右下角悬浮胶囊
  healthSec: 30,           // 健康检查间隔（秒）
  optimizeMin: 20,         // 后台复测间隔（分钟）
  subsHours: 12,           // 订阅自动更新（小时）
  core: { port: 17890, native: true },
  test: {
    latencyUrl: 'https://www.gstatic.com/generate_204',
    cfUrl: 'https://www.cloudflare.com/cdn-cgi/trace',
    // 1.2.4：经节点测速改用「托管在 Cloudflare 上」的大文件（npm 包，约 41 MB）。
    // edgetunnel 访问 Cloudflare 网站必须经 ProxyIP，所以这样测出的才是「节点 + ProxyIP」的真实带宽；
    // 不能用 speed./cp.cloudflare.com（edgetunnel 会拦截），Linode 等非 CF 站点不经 ProxyIP 且实测波动极大（6~290 Mbps）。
    speedUrl: 'https://registry.npmjs.org/@next/swc-win32-x64-msvc/-/swc-win32-x64-msvc-14.2.5.tgz',
    speedSeconds: 5,
  },
  pipPerTest: 8,           // 每轮优选测试的 ProxyIP 数量
  // 1.2.5：ProxyIP 质量（住宅 / 机房 + 纯净度）。prefer：residential = 住宅纯净优先，clean = 只看纯净度，off = 不参与选线
  pipQuality: { enabled: true, prefer: 'residential', minPurity: 60, minMbps: 50, pcKey: '', maxRisk: 50 },   // maxRisk：IPPure 系数上限（超过即拉黑；100 = 不拉黑）
  // 1.2.6 统一出口：只用「通用转发」ProxyIP，所有 HTTPS 网站（含非 Cloudflare）都看到同一个出口 IP；strict = 不能统一的连接（非 443 / IP 直连）不走代理节点
  uniform: { enabled: false, strict: false },
  cfScan: true,            // 允许为 Cloudflare 节点扫描优选 IP
  directList: [],
  proxyList: [],
  theme: 'auto',
  bestip: structuredClone(DEFAULT_BESTIP),
};

const DEFAULTS = {
  settings: () => structuredClone(DEFAULT_SETTINGS),
  nodes: () => [],
  subs: () => [],
  pool: () => ({ sources: [...DEFAULT_SOURCES], items: {}, src: {} }),
  stats: () => ({ nodes: {}, routes: {} }),
  logs: () => [],
  bestip: () => null,
  ipq: () => ({}),
};

const cache = new Map();
const chains = new Map();

function mergeSettings(v) {
  const d = structuredClone(DEFAULT_SETTINGS);
  if (!v || typeof v !== 'object') return d;
  // 1.2.3：经节点测速不能用 Cloudflare 测速站（edgetunnel 拦截 speed./cp.cloudflare.com，经节点访问永远没有响应）
  // 1.2.4：1.2.3 默认的 Linode 测速文件不经 ProxyIP、测不出 ProxyIP 带宽 → 迁移到新默认
  if (v.test && (/^https?:\/\/(speed|cp)\.cloudflare\.com\//i.test(v.test.speedUrl || '') || v.test.speedUrl === 'https://speedtest.tokyo2.linode.com/100MB-tokyo2.bin')) v = { ...v, test: { ...v.test, speedUrl: d.test.speedUrl } };
  // 1.2.7：直连兜底改为默认关闭（只迁移一次；用户之后手动打开不会被改回）
  if (v.dfMig !== 1) v = { ...v, directFallback: false, dfMig: 1 };
  return { ...d, ...v, core: { ...d.core, ...(v.core || {}) }, test: { ...d.test, ...(v.test || {}) }, pipQuality: { ...d.pipQuality, ...(v.pipQuality || {}) }, uniform: { ...d.uniform, ...(v.uniform || {}) }, manual: { ...d.manual, ...(v.manual || {}) }, bestip: mergeBestip(d.bestip, v.bestip) };
}
function mergeBestip(d, v) {
  if (!v || typeof v !== 'object') return d;
  // 旧默认值迁移；cf.090227.xyz 是「优选域名」站点、没有 __down 下载（Cloudflare 错误 1034），不能用来测速
  if (v.speedUrl === 'https://speed.cloudflare.com/__down?bytes=50000000' || /^https?:\/\/cf\.090227\.xyz\//i.test(v.speedUrl || '')) v = { ...v, speedUrl: d.speedUrl };
  // 1.2.2：测速接口是「短时间多次大下载」触发限流 → 每轮测速个数旧默认 6 改为 4
  if ((v.sv || 0) < 2) v = { ...v, sv: 2, ...(v.speedTop === 6 ? { speedTop: 4 } : {}) };
  return { ...d, ...v, th6: { ...d.th6, ...(v.th6 || {}) }, th4: { ...d.th4, ...(v.th4 || {}) }, geo: { ...d.geo, ...(v.geo || {}) } };
}

export async function get(key) {
  if (cache.has(key)) return cache.get(key);
  const r = await chrome.storage.local.get(key);
  let v = r[key];
  if (key === 'settings') v = mergeSettings(v);
  else if (v === undefined || v === null) v = DEFAULTS[key] ? DEFAULTS[key]() : null;
  if (key === 'pool') { v.items ||= {}; v.src ||= {}; if (!Array.isArray(v.sources)) v.sources = [...DEFAULT_SOURCES]; }
  if (key === 'stats') {
    v.nodes ||= {}; v.routes ||= {};
    // 1.2.4：旧速度记录来自不经 ProxyIP 的测速，且失败时会填假值（0.5、再减半）→ 一次性清除，全部重测
    if ((v.sv || 0) < 124) { for (const o of [...Object.values(v.routes), ...Object.values(v.nodes)]) if (o && typeof o === 'object') { delete o.mbps; delete o.sAt; delete o.sFail; } v.sv = 124; }
  }
  cache.set(key, v);
  return v;
}

export async function set(key, value) {
  cache.set(key, value);
  await chrome.storage.local.set({ [key]: value });
  return value;
}

// 串行化的读-改-写，避免并发测试互相覆盖
export function mutate(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const cur = await get(key);
    const res = await fn(cur);
    await set(key, cur);
    return res;
  });
  chains.set(key, next);
  return next;
}

// 说明：所有写入都经由后台（界面通过消息调用），因此后台缓存始终是最新的；界面页面只读并监听 storage.onChanged。
export function invalidate(key) { if (key) cache.delete(key); else cache.clear(); }

// ── 日志 ──
let logBuf = null;
let logTimer = null;
export async function log(lv, msg) {
  if (!logBuf) logBuf = await get('logs');
  logBuf.push({ t: Date.now(), lv, msg: String(msg).slice(0, 300) });
  if (logBuf.length > 300) logBuf.splice(0, logBuf.length - 300);
  clearTimeout(logTimer);
  logTimer = setTimeout(() => { set('logs', logBuf).catch(() => {}); }, 400);
}
export async function clearLogs() { logBuf = []; await set('logs', []); }
