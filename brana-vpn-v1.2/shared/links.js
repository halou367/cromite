// 节点链接 / 订阅 / ProxyIP 来源解析（后台与界面共用）

export const uid = (p = 'n') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

const dec = s => { try { return decodeURIComponent(String(s).replace(/\+/g, '%20')); } catch { return String(s); } };

export function b64decode(s) {
  s = String(s || '').trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function parseQuery(qs) {
  const q = {};
  for (const kv of String(qs || '').split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    q[dec(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? '' : dec(kv.slice(i + 1));
  }
  return q;
}

function splitAddr(hp, defPort = 443) {
  hp = String(hp || '').replace(/\/+$/, '');
  const b6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hp);
  if (b6) return { host: b6[1], port: +b6[2] || defPort };
  const i = hp.lastIndexOf(':');
  if (i > 0 && hp.indexOf(':') === i && /^\d+$/.test(hp.slice(i + 1))) return { host: hp.slice(0, i), port: +hp.slice(i + 1) };
  return { host: hp, port: defPort };
}

export const isIPv4 = s => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(s || ''));
export const isIP = s => isIPv4(s) || /^[0-9a-f:]+$/i.test(String(s || '')) && String(s).includes(':');

// 解析单条分享链接 → 节点对象（未知/不支持返回带 unsupported 的对象或 null）
export function parseLink(raw) {
  const s = String(raw || '').trim();
  let m;
  if ((m = /^(vless|trojan):\/\/([^@]+)@([^?#]+?)(?:\?([^#]*))?(?:#(.*))?$/i.exec(s))) {
    const kind = m[1].toLowerCase();
    const { host, port } = splitAddr(m[3]);
    const q = parseQuery(m[4]);
    const g = (...ks) => { for (const k of ks) if (q[k] != null && q[k] !== '') return q[k]; return ''; };
    const network = (g('type', 'net') || 'tcp').toLowerCase();
    let security = (g('security') || (kind === 'trojan' ? 'tls' : 'none')).toLowerCase();
    if (security === 'xtls') security = 'tls';
    const node = {
      kind,
      name: m[5] ? dec(m[5]).trim() : '',
      address: host,
      port,
      tls: security === 'tls',
      sni: g('sni', 'peer', 'serverName'),
      host: g('host'),
      path: g('path') || '/',
      fp: g('fp'),
      alpn: g('alpn'),
      insecure: /^(1|true)$/i.test(g('allowInsecure', 'insecure')),
      network,
      security,
    };
    if (kind === 'vless') node.uuid = dec(m[2]).trim(); else node.password = dec(m[2]);
    const ed = g('ed');
    if (ed && !/[?&]ed=/i.test(node.path)) node.path += (node.path.includes('?') ? '&' : '?') + 'ed=' + ed;
    if (network !== 'ws') node.unsupported = `传输方式 ${network.toUpperCase()} 暂不支持（当前仅支持 WebSocket）`;
    else if (security === 'reality') node.unsupported = 'REALITY 暂不支持';
    else if (kind === 'vless' && !/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(node.uuid)) node.unsupported = 'UUID 格式无效';
    if (!node.name) node.name = `${kind.toUpperCase()} ${host}`;
    return node;
  }
  if ((m = /^(socks5h?|socks|https?):\/\/(?:([^:@/\s]*)(?::([^@/\s]*))?@)?(\[[^\]]+\]|[^:/?#\s]+)(?::(\d+))?\/?(?:#(.*))?$/i.exec(s))) {
    const sc = m[1].toLowerCase();
    const kind = sc.startsWith('socks') ? 'socks5' : sc;
    const address = m[4].replace(/^\[|\]$/g, '');
    const node = {
      kind,
      name: m[6] ? dec(m[6]).trim() : '',
      address,
      port: +m[5] || (kind === 'socks5' ? 1080 : kind === 'https' ? 443 : 80),
      user: m[2] ? dec(m[2]) : '',
      pass: m[3] ? dec(m[3]) : '',
    };
    if (!node.name) node.name = `${kind.toUpperCase()} ${address}:${node.port}`;
    return node;
  }
  if ((m = /^(vmess|ss|ssr|hysteria2?|hy2|tuic|wireguard|wg|anytls|naive\+https?):\/\//i.exec(s))) {
    return { kind: m[1].toLowerCase(), name: '', unsupported: `${m[1].toUpperCase()} 协议暂不支持` };
  }
  return null;
}

export function toLink(n) {
  if (n.kind === 'vless' || n.kind === 'trojan') {
    const P = [];
    const add = (k, v) => { if (v !== '' && v != null && v !== false) P.push(k + '=' + encodeURIComponent(v === true ? '1' : String(v))); };
    if (n.kind === 'vless') add('encryption', 'none');
    add('security', n.tls ? 'tls' : 'none');
    if (n.tls) { add('sni', n.sni); add('fp', n.fp || 'chrome'); add('alpn', n.alpn); if (n.insecure) add('allowInsecure', '1'); }
    add('type', 'ws');
    add('host', n.host);
    add('path', n.path || '/');
    const h = String(n.address).includes(':') ? `[${n.address}]` : n.address;
    return `${n.kind}://${encodeURIComponent(n.kind === 'vless' ? n.uuid : n.password)}@${h}:${n.port}?${P.join('&')}${n.name ? '#' + encodeURIComponent(n.name) : ''}`;
  }
  const auth = n.user ? `${encodeURIComponent(n.user)}:${encodeURIComponent(n.pass || '')}@` : '';
  const h = String(n.address).includes(':') ? `[${n.address}]` : n.address;
  return `${n.kind}://${auth}${h}:${n.port}${n.name ? '#' + encodeURIComponent(n.name) : ''}`;
}

// edgetunnel 订阅：几十个条目其实是同一个节点（同协议 + 同 UUID/密码 + 同 Host），只是 address 换成了不同的优选 IP/域名。
// 合并成一个节点：保留 Host / UUID / 路径 / TLS，连接地址交给「优选 IP」；订阅里的这些地址只作为最后的备用。
export function etKey(n) {
  if (!n || (n.kind !== 'vless' && n.kind !== 'trojan')) return '';
  const host = String(n.host || n.sni || '').trim().toLowerCase();
  const cred = String(n.uuid || n.password || '').trim().toLowerCase();
  return host && cred ? [n.kind, cred, host].join('|') : '';
}
export function collapseEt(nodes) {
  const groups = new Map(), order = [];
  for (const n of nodes) {
    const k = etKey(n);
    if (!k) { order.push(n); continue; }
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k).push(n);
  }
  // 订阅里有多个 Host 时按 Host 分成多个节点（每个 Host 一个）。只要这批里有 edgetunnel 形态的分组，
  // 只出现一次的 Host 也按 Host + UUID 识别（订阅轮换地址时不会变成「新节点」）
  const anyEt = [...groups.values()].some(g => g.length > 1 || g[0].et);
  return order.map(x => {
    if (typeof x !== 'string') return x;
    const g = groups.get(x);
    if (g.length === 1) {
      const n = g[0];
      if (n.et || !anyEt) return n;
      const host = String(n.host || n.sni).trim().toLowerCase();
      if (host === String(n.address || '').toLowerCase()) return n; // 地址就是 Host（普通直连节点），不处理
      return { ...n, name: host, et: 1, altAddrs: [] };
    }
    // 基准条目：TLS 优先、443 端口优先（优选 IP 用这个端口连接）
    const rank = n => (n.tls ? 2 : 0) + (+n.port === 443 ? 1 : 0) + (n.et ? 4 : 0);
    const base = [...g].sort((a, b) => rank(b) - rank(a))[0];
    const same = g.filter(n => !!n.tls === !!base.tls && +n.port === +base.port);
    const alts = [...new Set([...(base.altAddrs || []), ...same.flatMap(n => [n.address, ...(n.altAddrs || [])])].filter(a => a && a !== base.address))].slice(0, 20);
    const host = String(base.host || base.sni).trim().toLowerCase();
    return { ...base, name: base.et ? base.name : host, et: g.reduce((s, n) => s + (n.et || 1), 0), altAddrs: alts };
  });
}

// 节点身份签名（订阅刷新时保留同一节点的 ID 与测速历史）
export function nodeSig(n) {
  if (n.et) return 'et|' + etKey(n); // 合并后的 edgetunnel 节点：地址会随订阅变化，身份只看 Host + UUID
  let path = String(n.path || '/').replace(/\/proxyip=[^/?#]*/ig, '').replace(/[?&]ed=\d+/ig, '').replace(/[?&]+$/, '');
  path = ('/' + path.replace(/^\/+/, '')).replace(/(.)\/+$/, '$1').replace(/^\/\?/, '/?');
  return [n.kind, String(n.address).toLowerCase(), n.port, n.uuid || n.password || n.user || '', String(n.host || '').toLowerCase(), path].join('|');
}

export const needsCore = n => n.kind === 'vless' || n.kind === 'trojan' || (n.kind === 'socks5' && !!n.user);

// 是否像订阅地址（带路径或参数的 http(s) 链接，而不是 http://host:port 代理）
export function isSubUrl(s) {
  const m = /^https?:\/\/([^\s/?#]+)([/?][^\s]*)$/i.exec(String(s || '').trim());
  if (!m) return false;
  if (/@/.test(m[1])) return false;
  return m[2].length > 1;
}

// 从任意文本里抽取分享链接（自动识别 Base64 订阅）
export function extractLinks(text) {
  let t = String(text || '').trim();
  if (!t) return [];
  if (!/:\/\//.test(t.slice(0, 4000)) && /^[A-Za-z0-9+/=_\-\s]+$/.test(t.slice(0, 8000))) {
    try { t = b64decode(t); } catch {}
  }
  const out = [];
  for (const m of t.matchAll(/(?:vless|trojan|vmess|ss|ssr|hysteria2|hy2|tuic|anytls|socks5h?|socks):\/\/[^\s"'<>`]+/gi)) out.push(m[0]);
  return out;
}

// 解析「导入」文本：节点链接、HTTP/SOCKS 代理、订阅地址
export function parseImport(text) {
  const nodes = [], subs = [], unsupported = [], bad = [];
  const lines = String(text || '').split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  const handleLink = l => {
    const n = parseLink(l);
    if (!n) return false;
    if (n.unsupported) unsupported.push({ link: l, reason: n.unsupported, name: n.name });
    else nodes.push({ ...n, link: l });
    return true;
  };
  for (const line of lines) {
    if (isSubUrl(line)) { subs.push(line); continue; }
    if (/^(vless|trojan|vmess|ss|ssr|hysteria2?|hy2|tuic|anytls|socks5h?|socks|https?):\/\//i.test(line)) { if (!handleLink(line)) bad.push(line); continue; }
    const links = extractLinks(line);
    if (links.length) { for (const l of links) handleLink(l); continue; }
    bad.push(line);
  }
  return { nodes, subs, unsupported, bad };
}

// ── ProxyIP ──
export const CHAIN_RE = /^(socks5?|https?|turn|sstp):\/\//i;

// 把 ProxyIP 写进 WebSocket 路径（edgetunnel：/proxyip=IP:端口；链式代理：/socks5://user:pass@host:port）
export function withProxyIp(p, pip) {
  p = p == null || p === '' ? '/' : String(p);
  pip = String(pip || '').trim();
  if (!pip) return p;
  const qi = p.indexOf('?');
  let base = qi < 0 ? p : p.slice(0, qi);
  let qs = qi < 0 ? '' : p.slice(qi + 1);
  base = base
    .replace(/\/proxyip=[^/]*/ig, '')
    .replace(/\/(?:socks5?|https?|turn|sstp):\/\/?[^/]*/ig, '')
    .replace(/\/(?:socks5|s5|gs5|http|https|turn|sstp)=[^/]*/ig, '')
    .replace(/\/+$/, '');
  qs = qs.split('&').filter(x => x && !/^(proxyip|socks5|s5|http|https|turn|sstp|globalproxy)(=|$)/i.test(x)).join('&');
  const seg = CHAIN_RE.test(pip) ? pip.replace(/^socks:\/\//i, 'socks5://') : 'proxyip=' + pip;
  return base + '/' + seg + (qs ? '?' + qs : '');
}

const COLO_CC = { hkg: 'HK', sin: 'SG', nrt: 'JP', kix: 'JP', fuk: 'JP', icn: 'KR', tpe: 'TW', khh: 'TW', lax: 'US', sjc: 'US', sea: 'US', ord: 'US', iad: 'US', ewr: 'US', dfw: 'US', mia: 'US', atl: 'US', den: 'US', phx: 'US', pdx: 'US', bos: 'US', yyz: 'CA', yvr: 'CA', yul: 'CA', lhr: 'GB', man: 'GB', cdg: 'FR', mrs: 'FR', fra: 'DE', muc: 'DE', dus: 'DE', ber: 'DE', ams: 'NL', arn: 'SE', hel: 'FI', waw: 'PL', dme: 'RU', led: 'RU', zrh: 'CH', rix: 'LV', bom: 'IN', del: 'IN', maa: 'IN', syd: 'AU', mel: 'AU', gru: 'BR', ist: 'TR', mxp: 'IT', fco: 'IT', mad: 'ES', vie: 'AT', dub: 'IE', cgk: 'ID', kul: 'MY', bkk: 'TH', sgn: 'VN', han: 'VN', mnl: 'PH' };
export const coloToCc = c => COLO_CC[String(c || '').toLowerCase()] || '';

// 来源行的地区提示：proxyip.jp.xxx / nrt.proxyip.xxx / …/country_proxies/JP.txt
export function regionHint(line) {
  const s = String(line || '').toLowerCase();
  let m = /country_proxies\/([a-z]{2})\.txt/.exec(s);
  if (m) return m[1].toUpperCase();
  m = /(?:^|\.)proxyip\.([a-z]{2})\./.exec(s);
  if (m) return m[1].toUpperCase();
  m = /^([a-z]{3})\.proxyip\./.exec(s);
  if (m && COLO_CC[m[1]]) return COLO_CC[m[1]];
  m = /^([a-z]{2})\.[a-z0-9-]+\./.exec(s);
  if (m && /william|mia/.test(s)) return m[1].toUpperCase();
  return '';
}

// ProxyIP 来源行：IP、IP:端口、域名[:端口]、链式代理 socks5:// http(s):// 、API 地址
export function parsePoolLine(raw) {
  const s0 = String(raw || '').trim().replace(/#.*$/, '').trim();
  if (!s0) return null;
  const am = /^(https?):\/\/([^\s/?#@]+)([/?][^\s]*)$/i.exec(s0);
  if (am && am[3].length > 1 && !/proxyip=/i.test(am[3])) return { type: 'api', line: am[1].toLowerCase() + '://' + am[2].toLowerCase() + am[3], hint: regionHint(s0) };
  const cm = /^(socks5?|https?|turn|sstp):\/\/(?:([^@\s]{1,128})@)?((?:\[[0-9a-f:]+\]|[\w.-]{3,160})(?::(\d{1,5}))?)\/?$/i.exec(s0);
  if (cm) {
    const t = cm[1].toLowerCase().replace(/^socks$/, 'socks5');
    return { type: 'chain', line: t + '://' + (cm[2] ? cm[2] + '@' : '') + cm[3].toLowerCase(), host: cm[3].replace(/:\d+$/, ''), port: +cm[4] || 0 };
  }
  const s = s0.replace(/^.*?proxyip=/i, '').replace(/^[a-z][\w+.-]*:\/\//i, '').replace(/[/?#].*$/, '').trim();
  let m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(s);
  if (m) {
    if (!isIPv4(m[1]) || (m[2] && +m[2] > 65535)) return null;
    return { type: 'ip', line: m[1] + ':' + (m[2] || 443), host: m[1], port: +m[2] || 443 };
  }
  m = /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*)(?::(\d{1,5}))?$/i.exec(s);
  if (m && !(m[2] && +m[2] > 65535)) return { type: 'domain', line: m[1].toLowerCase() + (m[2] ? ':' + m[2] : ''), host: m[1].toLowerCase(), port: +m[2] || 443, hint: regionHint(m[1]) };
  return null;
}

// API 内容 → ProxyIP 列表（兼容 IP:端口、"IP 端口"、NiREvil CSV、Base64）
export function parseApiItems(text, hint = '') {
  let t = String(text || '').trim();
  if (t && !/[:.]/.test(t.slice(0, 300)) && /^[A-Za-z0-9+/=_\-\s]+$/.test(t)) { try { t = b64decode(t); } catch {} }
  const out = new Map();
  const put = (host, port, cc) => {
    if (!isIPv4(host) || !(port > 0 && port < 65536)) return;
    const k = host + ':' + port;
    if (!out.has(k)) out.set(k, { key: k, host, port, cc: cc || hint || '' });
  };
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    let m = /^(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,5})(?:\s+([A-Za-z]{2}))?\b/.exec(line);
    if (m) { put(m[1], +m[2], m[3] && m[3].toUpperCase()); continue; }
    m = /^(\d{1,3}(?:\.\d{1,3}){3})\s*,\s*(\d{1,5})\s*,\s*(?:true|false|1|0)\s*(?:,\s*([A-Za-z]{2,3})\b)?(?:\s*,\s*([A-Za-z]{2})\b)?/i.exec(line);
    if (m) {
      const c3 = (m[3] || '').toUpperCase();
      const cc = c3.length === 2 ? c3 : (coloToCc(c3) || (m[4] || '').toUpperCase());
      put(m[1], +m[2], cc);
      continue;
    }
    for (const mm of line.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?\b/g)) put(mm[1], +mm[2] || 443, '');
  }
  return [...out.values()].slice(0, 3000);
}

export function splitLines(t) {
  return String(t || '').split(/[\r\n,，;；\s|]+/).map(x => x.trim()).filter(Boolean);
}

export function parseTrace(text) {
  const kv = {};
  for (const line of String(text || '').split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return kv.ip ? { ip: kv.ip, loc: String(kv.loc || '').toUpperCase(), colo: String(kv.colo || '').toUpperCase() } : null;
}

// 规则域名规范化：*.a.com / .a.com / https://a.com/x → a.com
export function normDomain(s) {
  s = String(s || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#:].*$/, '').replace(/^\*?\.+/, '');
  return /^[a-z0-9.-]+$/.test(s) && s.includes('.') || isIPv4(s) || s === 'localhost' ? s : '';
}
