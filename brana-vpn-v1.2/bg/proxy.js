// Chrome 代理控制：PAC 生成 / 应用 / 清除、控制权检测、WebRTC 防泄漏
// PAC 中只使用字符串匹配（不调用 dnsResolve/isInNet），避免本地 DNS 查询造成泄漏或卡顿。

export function proxyString(kind, host, port) {
  const h = String(host).includes(':') ? `[${host}]` : host;
  if (kind === 'https') return `HTTPS ${h}:${port}`;
  if (kind === 'http') return `PROXY ${h}:${port}`;
  return `SOCKS5 ${h}:${port}`;
}

export function buildPac({ proxy, strict = false, scope = 'global', directList = [], proxyList = [], probes = null }) {
  const P = strict ? proxy : `${proxy}; DIRECT`;
  const probeMap = probes ? JSON.stringify(probes) : '{}';
  return `// Brana VPN PAC
var P=${JSON.stringify(P)};
var D=${JSON.stringify(directList)};
var X=${JSON.stringify(proxyList)};
var S=${JSON.stringify(scope)};
var T=${probeMap};
function m(h,l){for(var i=0;i<l.length;i++){var d=l[i];if(h===d)return true;var n=d.length;if(h.length>n&&h.charAt(h.length-n-1)==='.'&&h.substring(h.length-n)===d)return true;}return false;}
function lan(h){
if(isPlainHostName(h)||h==='localhost')return true;
if(/\\.(local|localhost|lan|home|internal|intranet|corp|arpa)$/.test(h))return true;
if(/^(127\\.|10\\.|192\\.168\\.|169\\.254\\.|0\\.)/.test(h))return true;
if(/^172\\.(1[6-9]|2\\d|3[01])\\./.test(h))return true;
if(/^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\./.test(h))return true;
if(h.indexOf(':')>=0&&/^(\\[)?(::1|fe80:|fc|fd)/i.test(h))return true;
return false;}
function FindProxyForURL(url,host){
var h=String(host).toLowerCase();
if(T.hasOwnProperty(h))return T[h];
if(lan(h))return 'DIRECT';
if(m(h,D))return 'DIRECT';
if(S==='rules'&&!m(h,X))return 'DIRECT';
return P;}
`;
}

export async function applyPac(pac) {
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: pac, mandatory: false } }, scope: 'regular' });
}

export async function clearProxy() {
  try { await chrome.proxy.settings.clear({ scope: 'regular' }); } catch {}
}

// 'controlled_by_this_extension' | 'controllable_by_this_extension' | 'controlled_by_other_extensions' | 'not_controllable'
export async function controlLevel() {
  try { const d = await chrome.proxy.settings.get({ incognito: false }); return d.levelOfControl || ''; } catch { return ''; }
}

export async function currentMode() {
  try { const d = await chrome.proxy.settings.get({ incognito: false }); return d.value?.mode || ''; } catch { return ''; }
}

export async function setWebRtcProtection(on) {
  try {
    if (!chrome.privacy?.network?.webRTCIPHandlingPolicy) return;
    if (on) await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
    else await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
  } catch {}
}
