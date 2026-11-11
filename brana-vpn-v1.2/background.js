// Brana VPN · Service Worker 入口：消息路由 / 闹钟 / 代理认证 / 429 监听 / 实时统计
import * as store from './bg/store.js';
import * as engine from './bg/engine.js';
import * as pool from './bg/pool.js';
import * as px from './bg/proxy.js';
import * as bestip from './bg/bestip.js';
import { Core } from './bg/core.js';
import { nodeSig, toLink, parsePoolLine } from './shared/links.js';

const VERSION = chrome.runtime.getManifest().version;

// ───────────── 启动 ─────────────
let bootP = null;
bestip.setHooks({ ensureCore: () => engine.ensureCore(), onChange: () => engine.refreshRoutes(), getRt: () => engine.getRt(), busy: () => engine.busy() });
// 优选 IP 结果先加载（建线路时要用），再启动引擎
const bootOnce = reason => (bootP ||= bestip.load().catch(() => {}).then(() => engine.boot(reason)).then(() => bestip.start()).catch(e => store.log('error', '启动失败：' + e.message)));

chrome.runtime.onStartup.addListener(() => { bootOnce('startup'); });
chrome.runtime.onInstalled.addListener(d => {
  bootOnce(d.reason === 'install' ? 'install' : 'update');
  if (d.reason === 'install' || d.reason === 'update') store.log('info', d.reason === 'install' ? `扩展已安装 v${VERSION}` : `扩展已更新 v${d.previousVersion || '?'} → v${VERSION}`);
  ensureAlarms();
  // 首次安装：打开新手设置向导（一步一步：核心 → 导入 → 连接 → 完成）
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('setup/setup.html') }).catch(() => {});
  // 从旧版本更新且还没配置节点：同样打开向导
  if (d.reason === 'update') {
    Promise.all([store.get('settings'), store.get('nodes')]).then(([s, nodes]) => {
      if (!s.setupDone && !nodes.length) chrome.tabs.create({ url: chrome.runtime.getURL('setup/setup.html') }).catch(() => {});
    }).catch(() => {});
  }
});
setTimeout(() => bootOnce('wake'), 0);

async function ensureAlarms() {
  const s = await store.get('settings');
  const period = Math.max(0.5, Math.min(5, (+s.healthSec || 30) / 60));
  const h = await chrome.alarms.get('health');
  if (!h || Math.abs((h.periodInMinutes || 0) - period) > 0.01) chrome.alarms.create('health', { periodInMinutes: period, delayInMinutes: period });
  if (!(await chrome.alarms.get('maint'))) chrome.alarms.create('maint', { periodInMinutes: 30, delayInMinutes: 2 });
}
ensureAlarms();

chrome.alarms.onAlarm.addListener(async a => {
  await bootOnce('wake');
  if (a.name === 'health') engine.healthTick().catch(e => store.log('error', '健康检查异常：' + e.message));
  if (a.name === 'maint') maintenance().catch(() => {});
  if (a.name === 'bestip' || a.name === 'bestip-switch') bestip.onAlarm(a.name).catch(e => store.log('error', '优选 IP 异常：' + e.message));
});

async function maintenance() {
  await engine.updateAllSubs({ stale: true }).catch(() => {});
  const rt = engine.getRt();
  await pool.refreshSources({ force: false, inUse: rt?.active?.pip || '' }).catch(() => {});
}

chrome.commands.onCommand.addListener(async cmd => {
  await bootOnce('wake');
  if (cmd === 'toggle-vpn') engine.toggle().catch(() => {});
  if (cmd === 'next-ip') engine.nextIp().catch(() => {});
});

// ───────────── 429 限流 → 自动换出口 IP ─────────────
try {
  chrome.webRequest.onCompleted.addListener(d => {
    if (d.statusCode === 429 && d.tabId >= 0) engine.on429(d).catch(() => {});
  }, { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'xmlhttprequest'] }, ['responseHeaders']);
} catch {}

// ───────────── HTTP/HTTPS 代理节点账号密码 ─────────────
const authTries = new Map();
try {
  chrome.webRequest.onAuthRequired.addListener((details, callback) => {
    if (!details.isProxy) { callback({}); return; }
    (async () => {
      const nodes = await store.get('nodes');
      const ch = details.challenger || {};
      const n = nodes.find(x => (x.kind === 'http' || x.kind === 'https') && x.user && String(x.address).toLowerCase() === String(ch.host || '').toLowerCase() && +x.port === +ch.port);
      const tries = (authTries.get(details.requestId) || 0) + 1;
      authTries.set(details.requestId, tries);
      if (authTries.size > 500) authTries.clear();
      if (!n) { callback({}); return; }
      if (tries > 2) { store.log('warn', `代理认证失败：${n.name}（账号或密码错误）`); callback({ cancel: true }); return; }
      callback({ authCredentials: { username: n.user, password: n.pass || '' } });
    })().catch(() => callback({}));
  }, { urls: ['<all_urls>'] }, ['asyncBlocking']);
} catch {}

try {
  chrome.proxy.onProxyError.addListener(d => { if (d.fatal) store.log('error', `代理错误：${d.error} ${d.details || ''}`); });
} catch {}

// 连接期间若代理控制权被其他扩展抢走，如实反映状态并提示
try {
  chrome.proxy.settings.onChange.addListener(async d => {
    await bootOnce('wake');
    const rt = engine.getRt();
    const s = await store.get('settings');
    if (!rt || !s.enabled) return;
    if (d.levelOfControl === 'controlled_by_other_extensions' || d.levelOfControl === 'not_controllable') {
      if (rt.conflict !== d.levelOfControl) {
        engine.patchRt({ status: 'error', conflict: d.levelOfControl, notice: { lv: 'err', text: d.levelOfControl === 'not_controllable' ? '代理设置被系统策略锁定' : '代理设置已被其他扩展接管（如 SwitchyOmega），请停用它后重新连接', at: Date.now() } }, { flush: true });
        store.log('warn', '代理控制权被其他扩展接管');
      }
    } else if (rt.conflict && d.levelOfControl === 'controllable_by_this_extension') {
      engine.patchRt({ conflict: '' });
      engine.connect({ reason: 'silent' }).catch(() => {});
    }
  });
} catch {}

// ───────────── 界面实时数据（打开弹窗/设置页时每 2 秒刷新流量）─────────────
const uiPorts = new Set();
let liveTimer = null;
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'ui') return;
  uiPorts.add(port);
  bootOnce('wake').then(() => startLive());
  port.onDisconnect.addListener(() => { uiPorts.delete(port); if (!uiPorts.size) stopLive(); });
});
// 原生核心的实时流量推送：界面打开期间订阅；核心晚于界面上线（如向导里刚装好核心）时也会补订阅
let subscribed = false;
Core.on('down', () => { subscribed = false; });
function startLive() {
  if (liveTimer) return;
  const tick = async () => {
    for (const p of uiPorts) { try { p.postMessage({ t: Date.now() }); } catch {} }
    if (Core.via === 'native' && !subscribed) { subscribed = true; Core.call('subscribe', { on: true }).catch(() => { subscribed = false; }); }
    const rt = engine.getRt();
    if (!rt) return;
    if (Core.up && Core.via !== 'native') {
      try {
        const st = await Core.call('status', {}, 3000);
        engine.patchRt({ traffic: { up: st.up, down: st.down, rateUp: st.rateUp, rateDown: st.rateDown, conns: st.conns, failovers: st.failovers, direct: st.direct, at: Date.now() } });
      } catch {}
    }
  };
  tick();
  liveTimer = setInterval(tick, 2000);
}
function stopLive() {
  clearInterval(liveTimer);
  liveTimer = null;
  if (subscribed && Core.via === 'native') Core.call('subscribe', { on: false }).catch(() => {});
  subscribed = false;
}

// ───────────── 消息路由 ─────────────
const H = {
  ping: () => ({ ok: true, version: VERSION }),
  connect: () => engine.connect(),
  disconnect: () => engine.disconnect(),
  toggle: () => engine.toggle(),
  optimize: () => engine.optimize(),
  nextIp: () => engine.nextIp(),
  speedTest: () => engine.speedTest(),
  setRegion: m => engine.setRegion(m.cc),
  setMode: m => engine.setMode(m.mode),
  selectRoute: m => engine.selectRoute(m.nodeId, m.pip || ''),
  testNodes: m => engine.testNodes({ ids: m.ids || null }),
  uniScan: m => engine.uniScan({ limit: Math.min(200, m.limit || 60), force: !!m.force, keys: m.keys || null }),
  pureScan: m => engine.pureScan({ pips: m.keys || null, limit: Math.min(80, m.limit || 40), force: !!m.force }),
  testPool: m => engine.testPool({ region: m.region || '', keys: m.keys || null, limit: m.limit || 24 }),
  refreshExit: () => engine.refreshExit(),
  healthNow: () => engine.healthTick(),
  debug: () => ({ rt: engine.getRt(), core: { via: Core.via, port: Core.port, installed: Core.installed, err: Core.lastErr, info: Core.info } }),

  importText: m => engine.importText(m.text || ''),
  saveNode: m => engine.saveNode(m.node || {}),
  removeNodes: m => engine.removeNodes(m.ids || []),
  toggleNode: async m => { await store.mutate('nodes', l => { const n = l.find(x => x.id === m.id); if (n) n.enabled = !!m.enabled; }); return { ok: true }; },
  nodeLink: async m => { const n = (await store.get('nodes')).find(x => x.id === m.id); if (!n) throw new engine.UserError('节点不存在'); return toLink(n); },
  scanNode: m => engine.scanNode(m.id),
  clearPref: m => engine.clearPref(m.id),
  updateSub: m => engine.updateSub(m.id),
  updateSubs: () => engine.updateAllSubs(),
  removeSub: m => engine.removeSub(m.id, { withNodes: m.withNodes !== false }),
  renameSub: async m => { await store.mutate('subs', l => { const s = l.find(x => x.id === m.id); if (s) s.name = String(m.name || '').slice(0, 40) || s.name; }); return { ok: true }; },

  setSources: m => engine.setSources(m.lines || []),
  refreshPool: async () => { const rt = engine.getRt(); return pool.refreshSources({ force: true, inUse: rt?.active?.pip || '' }); },
  poolClear: m => engine.poolClear(m.what),
  poolBan: m => engine.poolBan(m.keys || [], m.ban !== false),
  poolSummary: () => pool.summary(),

  saveSettings: async m => saveSettings(m.patch || {}),

  // 优选 IP
  bestipView: () => bestip.view(),
  // 当前正在使用哪些优选 IP：读取核心里活动线路的逐地址统计（核心 1.2.2 起含当前连接数 / 流量）
  bestipLive: async () => {
    const rt = engine.getRt();
    if (!rt || !['on', 'degraded'].includes(rt.status) || !rt.active) return { on: false };
    if (!rt.active.viaCore) return { on: true, viaCore: false, node: rt.active.nodeName || rt.active.name };
    if (!Core.up) return { on: true, viaCore: true, coreDown: true, node: rt.active.nodeName || rt.active.name };
    const st = await Core.call('status', {}, 3000);
    return { on: true, viaCore: true, at: Date.now(), node: rt.active.nodeName || rt.active.name, sameRoute: st.active === rt.active.key, addrs: st.addrStats || null, live: (st.features || []).includes('addrlive'), conns: st.conns || 0, coreVersion: st.version || '' };
  },
  bestipRun: async () => {
    if (bestip.running()) throw new engine.UserError('测试正在进行中');
    const r = await bestip.runRound({ manual: true, reason: 'manual' });
    if (!r.ok) throw new engine.UserError(r.error || '测试失败');
    await bestip.schedule({ catchUp: false });
    return r;
  },
  bestipCancel: () => bestip.cancel(),
  bestipClear: m => bestip.clear(m.what || 'all'),
  bestipDetect: () => bestip.detectNodes({ force: true }),
  bestipCheckUrl: m => bestip.checkSpeedUrl(m.url || ''),
  siteRule: m => engine.siteRule(m.host, m.action),

  // force：强制重启原生核心（会短暂中断经核心的连接）；默认只在核心未运行时重新探测
  coreCheck: async m => { if (m.force && Core.via === 'native') Core.disconnect(); await engine.ensureCore(); return engine.getRt().core; },
  coreLogs: async () => { if (!Core.up && !(await engine.ensureCore())) return []; return Core.call('logs', { limit: 200 }); },
  extInfo: () => ({ id: chrome.runtime.id, version: VERSION }),

  clearLogs: () => store.clearLogs(),
  exportConfig: () => exportConfig(),
  importConfig: m => importConfig(m.data),
  resetStats: async () => { await store.set('stats', { nodes: {}, routes: {} }); return { ok: true }; },
  resetAll: async () => {
    await engine.disconnect().catch(() => {});
    await chrome.storage.local.clear();
    store.invalidate();
    await bestip.load().catch(() => {});
    return { ok: true };
  },
  badgeState: () => engine.badgeState(),
  openPopupOrOptions: async () => {
    try { await chrome.action.openPopup(); return { ok: true }; } catch {}
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

async function saveSettings(patch) {
  const prev = structuredClone(await store.get('settings'));
  const allowed = ['autoStart', 'setupDone', 'scope', 'strict', 'directFallback', 'webrtc', 'autoRotate429', 'autoSwitch', 'notify', 'badge', 'healthSec', 'optimizeMin', 'subsHours', 'core', 'test', 'pipPerTest', 'pipQuality', 'cfScan', 'directList', 'proxyList', 'theme', 'mode', 'bestip', 'uniform'];
  await store.mutate('settings', st => {
    for (const k of allowed) {
      if (!(k in patch)) continue;
      if (k === 'core' || k === 'test' || k === 'pipQuality' || k === 'uniform') st[k] = { ...st[k], ...patch[k] };
      else if (k === 'bestip') { const b = patch.bestip || {}; const o = st.bestip || {}; st.bestip = bestip.normCfg({ ...o, ...b, th6: { ...o.th6, ...(b.th6 || {}) }, th4: { ...o.th4, ...(b.th4 || {}) }, geo: { ...o.geo, ...(b.geo || {}) } }); }
      else st[k] = patch[k];
    }
    st.healthSec = Math.max(30, Math.min(300, +st.healthSec || 30));
    st.optimizeMin = Math.max(5, Math.min(240, +st.optimizeMin || 20));
    st.subsHours = Math.max(1, Math.min(168, +st.subsHours || 12));
    st.pipPerTest = Math.max(3, Math.min(24, +st.pipPerTest || 8));
    st.core.port = Math.max(1024, Math.min(65535, +st.core.port || 17890));
    st.test.speedSeconds = Math.max(3, Math.min(10, +st.test.speedSeconds || 5));
  });
  const s = await store.get('settings');
  if (prev.badge !== s.badge) await engine.syncBadge();
  if (prev.healthSec !== s.healthSec) await ensureAlarms();
  if (JSON.stringify(prev.bestip) !== JSON.stringify(s.bestip)) await bestip.onSettings(prev.bestip, s.bestip).catch(e => store.log('warn', '优选 IP 设置应用失败：' + e.message));
  if (JSON.stringify(prev.uniform) !== JSON.stringify(s.uniform)) engine.onUniformChange().catch(e => store.log('warn', '统一出口：' + e.message));
  if (prev.core.port !== s.core.port || prev.core.native !== s.core.native) { Core.disconnect(); }
  const pacKeys = ['scope', 'strict', 'directFallback', 'webrtc', 'directList', 'proxyList'];
  if (pacKeys.some(k => JSON.stringify(prev[k]) !== JSON.stringify(s[k]))) await engine.reapplyPac().catch(() => {});
  return s;
}

async function exportConfig() {
  const s = await store.get('settings');
  const { enabled, last, ...settings } = s;
  const nodes = (await store.get('nodes')).map(({ prefList, ...n }) => n);
  return { app: 'brana-vpn', v: 1, at: new Date().toISOString(), settings, nodes, subs: (await store.get('subs')).map(({ id, name, url }) => ({ id, name, url })), sources: (await store.get('pool')).sources };
}

async function importConfig(data) {
  if (!data || data.app !== 'brana-vpn') throw new engine.UserError('不是 Brana VPN 的配置文件');
  let nodesAdded = 0, subsAdded = 0;
  if (Array.isArray(data.subs)) await store.mutate('subs', l => { for (const s of data.subs) if (s?.url && !l.some(x => x.url === s.url)) { l.push({ id: s.id || 's' + Math.random().toString(36).slice(2, 9), name: s.name || '订阅', url: s.url, at: 0, count: 0, err: '' }); subsAdded++; } });
  if (Array.isArray(data.nodes)) await store.mutate('nodes', l => { const sigs = new Set(l.map(nodeSig)); for (const n of data.nodes) { if (!n?.kind || !n.address) continue; const sig = nodeSig(n); if (sigs.has(sig)) continue; sigs.add(sig); l.push({ ...n, id: n.id && !l.some(x => x.id === n.id) ? n.id : 'n' + Math.random().toString(36).slice(2, 9), enabled: n.enabled !== false }); nodesAdded++; } });
  if (Array.isArray(data.sources)) await store.mutate('pool', d => { const set = new Set(d.sources); for (const l of data.sources) { const p = parsePoolLine(l); if (p && !set.has(p.line)) { d.sources.push(p.line); set.add(p.line); } } });
  if (data.settings && typeof data.settings === 'object') await saveSettings(data.settings);
  pool.refreshSources({ force: false }).catch(() => {});
  return { ok: true, nodesAdded, subsAdded };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !msg.cmd) return false;
  const fn = H[msg.cmd];
  if (!fn) { sendResponse({ ok: false, error: '未知指令：' + msg.cmd }); return false; }
  // 内容脚本只允许读取状态与少量操作
  const trusted = sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  if (!trusted && !['badgeState', 'nextIp', 'optimize', 'openPopupOrOptions', 'toggle'].includes(msg.cmd)) { sendResponse({ ok: false, error: 'forbidden' }); return false; }
  bootOnce('wake')
    .then(() => fn(msg))
    .then(data => sendResponse({ ok: true, data }), e => sendResponse({ ok: false, error: (e && e.message) || String(e), user: e instanceof engine.UserError }));
  return true;
});
