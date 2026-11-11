#!/usr/bin/env node
/*
 * Brana VPN Core —— 浏览器专属本地核心（零依赖，Node.js ≥ 16）
 *
 * 为什么需要它：Chrome 的 chrome.proxy 只认识 HTTP / HTTPS / SOCKS 代理，不会说 VLESS / Trojan。
 * 本核心在 127.0.0.1 上提供一个「混合代理端口」，把浏览器的流量经 VLESS / Trojan (WebSocket + TLS)
 * 送到你的节点（如 edgetunnel），并通过路径参数 /proxyip=… 指定 ProxyIP。只有浏览器在用它，系统其它程序不受影响。
 *
 *  · 入站：同一端口同时支持 SOCKS5 / HTTP CONNECT / 普通 HTTP 代理
 *  · 出站：VLESS-WS、Trojan-WS（TLS 或明文）、上游 SOCKS5（支持账号密码）、上游 HTTP(S) 代理、直连
 *  · 连通性优先：每条连接在收到服务器首个字节前都可以「无感重试」备用线路（缓存并重放客户端已发送的数据），
 *    连续失败的线路自动熔断降级；全部失败时可直连兜底（严格防泄漏模式下关闭）
 *  · 控制：Chrome Native Messaging（扩展自动拉起，随浏览器退出）或本地 HTTP API（/__brana/*，仅允许扩展来源）
 *  · 探测：真实 URL 延迟（冷/热两次）、出口 IP 追踪、下载测速、TCP Ping、DNS 解析、Cloudflare 优选 IP 扫描
 *
 * 用法：
 *   node brana-core.js                 手动模式（HTTP 控制，默认端口 17890）
 *   node brana-core.js --port 17890    指定端口
 *   node brana-core.js --install       安装为浏览器自动托管（注册 Native Messaging，仅当前用户）
 *   node brana-core.js --uninstall     卸载（可加 --dry-run 只显示将执行的操作）
 *   （由浏览器通过 Native Messaging 启动时自动进入原生模式，无需参数）
 */
'use strict';

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const dns = require('dns');
const os = require('os');
const { Duplex } = require('stream');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');

const VERSION = '1.2.4';
// 1.2.4：统一出口（线路 uni = 通用转发 ProxyIP：所有 HTTPS 域名连接改写为经它按 SNI 转发，全部网站看到同一个 IP）；移除无效的 TLS 指纹试验
// 1.2.1：测速限流识别（429 / 1015 / 403 + Retry-After）、峰值稳定后提前结束测速
// 1.2.0：优选 IP（多地址线路 addrs + 单 IP 熔断）、netcaps / ipping / ipspeed / ipverify
const FEATURES = ['addrs', 'bestip', 'speedguard', 'addrlive', 'uni'];
const ARGV = process.argv.slice(2);
const argOf = (name, def) => {
  const i = ARGV.indexOf('--' + name);
  return i >= 0 && ARGV[i + 1] !== undefined ? ARGV[i + 1] : def;
};
const CALLER = ARGV.find(a => /^chrome-extension:\/\//i.test(a)) || '';
const NATIVE = !!CALLER || ARGV.includes('--native');
const DEBUG = ARGV.includes('--debug') || process.env.BRANA_DEBUG === '1';
const LISTEN_HOST = '127.0.0.1';
let PORT = Math.max(1, Math.min(65535, +argOf('port', process.env.BRANA_PORT || 17890) || 17890));
const EMPTY = Buffer.alloc(0);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STARTED = Date.now();

// ───────────────────────────── 日志 ─────────────────────────────
const LOGS = [];
function log(lv, msg) {
  const item = { t: Date.now(), lv, msg: String(msg) };
  LOGS.push(item);
  if (LOGS.length > 500) LOGS.splice(0, LOGS.length - 500);
  if (!NATIVE) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const mark = lv === 'error' ? '✖' : lv === 'warn' ? '!' : '·';
    try { process.stdout.write(`[${ts}] ${mark} ${item.msg}\n`); } catch {}
  } else if (DEBUG) {
    try { process.stderr.write(`[brana-core] ${lv}: ${item.msg}\n`); } catch {}
  }
}

function friendlyErr(e) {
  if (!e) return new Error('未知错误');
  if (e.friendly) return e;
  const code = e.code || '';
  const map = {
    ECONNREFUSED: '连接被拒绝',
    ECONNRESET: '连接被重置',
    ETIMEDOUT: '连接超时',
    EHOSTUNREACH: '主机不可达',
    ENETUNREACH: '网络不可达',
    ENOTFOUND: '域名解析失败',
    EAI_AGAIN: '域名解析失败',
    EPIPE: '连接已断开',
    ERR_SSL_WRONG_VERSION_NUMBER: 'TLS 握手失败（端口/协议不匹配）',
    CERT_HAS_EXPIRED: '证书已过期',
    DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书（可开启“跳过证书验证”）',
    SELF_SIGNED_CERT_IN_CHAIN: '自签名证书（可开启“跳过证书验证”）',
    ERR_TLS_CERT_ALTNAME_INVALID: '证书与 SNI 不匹配',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书校验失败',
  };
  const out = new Error(map[code] ? `${map[code]}${code ? ' (' + code + ')' : ''}` : (e.message || String(e)));
  out.code = code;
  out.friendly = true;
  return out;
}

// ───────────────────────────── 工具 ─────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const msNow = () => performance.now();

async function runPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { ok: false, err: friendlyErr(e).message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

function splitHostPort(s, defPort) {
  s = String(s || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
  const m6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (m6) return { host: m6[1], port: +m6[2] || defPort };
  const i = s.lastIndexOf(':');
  if (i > 0 && s.indexOf(':') === i && /^\d+$/.test(s.slice(i + 1))) return { host: s.slice(0, i), port: +s.slice(i + 1) || defPort };
  return { host: s, port: defPort };
}

function ipv6Bytes(ip) {
  ip = String(ip).replace(/^\[|\]$/g, '').split('%')[0];
  const fixV4 = arr => {
    const last = arr[arr.length - 1];
    if (last && last.includes('.')) {
      const q = last.split('.').map(Number);
      arr.splice(arr.length - 1, 1, ((q[0] << 8) | q[1]).toString(16), ((q[2] << 8) | q[3]).toString(16));
    }
    return arr;
  };
  let parts;
  if (ip.includes('::')) {
    const [a, b] = ip.split('::');
    const pa = a ? a.split(':') : [];
    const pb = b ? fixV4(b.split(':')) : [];
    parts = [...pa, ...Array(Math.max(0, 8 - pa.length - pb.length)).fill('0'), ...pb];
  } else parts = fixV4(ip.split(':'));
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) buf.writeUInt16BE(parseInt(parts[i] || '0', 16) & 0xffff, i * 2);
  return buf;
}
const ipv6Str = b => Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':');

// SOCKS5 / Trojan 地址格式：ATYP(1=IPv4,3=域名,4=IPv6) + 地址 + 端口
function socksAddr(host, port) {
  let head;
  if (net.isIPv4(host)) head = Buffer.from([1, ...host.split('.').map(Number)]);
  else if (net.isIPv6(host)) head = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]);
  else {
    const d = Buffer.from(host, 'utf8');
    if (d.length > 255) throw new Error('域名过长');
    head = Buffer.concat([Buffer.from([3, d.length]), d]);
  }
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return Buffer.concat([head, p]);
}

// VLESS 请求头：版本0 | UUID(16) | 附加长度0 | 指令1(TCP) | 端口 | ATYP(1=IPv4,2=域名,3=IPv6) | 地址
function vlessHeader(uuid, host, port) {
  let atyp, addr;
  if (net.isIPv4(host)) { atyp = 1; addr = Buffer.from(host.split('.').map(Number)); }
  else if (net.isIPv6(host)) { atyp = 3; addr = ipv6Bytes(host); }
  else {
    const d = Buffer.from(host, 'utf8');
    if (d.length > 255) throw new Error('域名过长');
    atyp = 2; addr = Buffer.concat([Buffer.from([d.length]), d]);
  }
  const h = Buffer.alloc(22);
  h[0] = 0;
  uuid.copy(h, 1);
  h[17] = 0;
  h[18] = 1;
  h.writeUInt16BE(port, 19);
  h[21] = atyp;
  return Buffer.concat([h, addr]);
}

// 统一出口：返回实际要让 Worker 连接的目标；null = 该连接不适用（非 443 端口 / IP 直连 / 无 80 转发）
function uniTarget(r, host, port) {
  if (!r || !r.uni) return [host, port];
  const dom = !net.isIP(String(host).replace(/^\[|\]$/g, ''));
  if (dom && port === 443) return [r.uni.host, r.uni.port];
  if (dom && port === 80 && r.uniHttp) return [r.uni.host, 80];
  return null;
}

// Trojan 请求头：hex(SHA224(密码)) CRLF | CMD(1) | SOCKS5 地址 | CRLF
function trojanHeader(passHex, host, port) {
  return Buffer.concat([Buffer.from(passHex + '\r\n', 'latin1'), Buffer.from([1]), socksAddr(host, port), Buffer.from('\r\n')]);
}

let maskPool = EMPTY;
let maskOff = 0;
function nextMask() {
  if (maskOff + 4 > maskPool.length) { maskPool = crypto.randomBytes(4096); maskOff = 0; }
  const m = maskPool.subarray(maskOff, maskOff + 4);
  maskOff += 4;
  return m;
}

// ───────────────────────────── 线路 ─────────────────────────────
const DIRECT = Object.freeze({ key: 'direct', kind: 'direct', name: '直连' });

function normPath(p) {
  p = String(p || '/').trim() || '/';
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/[^\x21-\x7e]/g, c => encodeURIComponent(c));
}

function normRoute(r) {
  if (!r || typeof r !== 'object') throw new Error('线路为空');
  const kind = String(r.kind || '').toLowerCase();
  if (kind === 'direct') return DIRECT;
  const o = {
    key: String(r.key || ''),
    kind,
    name: String(r.name || '').slice(0, 80),
    address: String(r.address || '').trim().replace(/^\[|\]$/g, ''),
    port: +r.port || (kind === 'socks5' ? 1080 : kind === 'http' ? 80 : 443),
  };
  if (!o.address) throw new Error('线路地址为空');
  if (!(o.port > 0 && o.port < 65536)) throw new Error('端口无效');
  if (kind === 'vless' || kind === 'trojan') {
    o.tls = !(r.tls === false || r.tls === 'none' || r.tls === 0);
    o.host = String(r.host || r.sni || o.address).trim();
    o.sni = String(r.sni || r.host || '').trim();
    o.path = normPath(r.path);
    o.insecure = !!r.insecure;
    const m = /[?&]ed=(\d+)/i.exec(o.path);
    o.ed = Math.min(8192, m ? +m[1] : +r.ed || 0);
    if (kind === 'vless') {
      const hex = String(r.uuid || '').replace(/[-{}\s]/g, '').toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('UUID 格式无效');
      o.uuid = Buffer.from(hex, 'hex');
    } else {
      if (!r.password) throw new Error('Trojan 密码为空');
      o.passHex = crypto.createHash('sha224').update(String(r.password)).digest('hex');
    }
    // 1.2.4 统一出口：uni = 「通用转发」ProxyIP（IP:端口）。HTTPS 域名连接的目标改写为它，由它按 SNI 转发到真实网站
    if (r.uni) {
      const hp = splitHostPort(String(r.uni).trim(), 443);
      if (hp && net.isIP(hp.host) && hp.port > 0 && hp.port < 65536) {
        o.uni = { host: hp.host, port: hp.port };
        o.uniHttp = !!r.uniHttp;
        o.uniStrict = !!r.uniStrict;
      }
    }
  } else if (kind === 'socks5' || kind === 'http' || kind === 'https') {
    o.user = r.user ? String(r.user) : '';
    o.pass = r.pass ? String(r.pass) : '';
    o.sni = String(r.sni || '').trim();
    o.insecure = !!r.insecure;
  } else {
    throw new Error('不支持的线路类型：' + (kind || '空'));
  }
  if (!o.key) o.key = `${kind}:${o.address}:${o.port}${o.path || ''}`;
  // 优选 IP：同一条线路可携带多个连接地址（前 addrsMain 个为主用，其余为备用），由核心按健康度与延迟分配
  if ((kind === 'vless' || kind === 'trojan') && Array.isArray(r.addrs)) {
    const seen = new Set();
    const list = [];
    for (const a of r.addrs.slice(0, 16)) {
      const v = String(a || '').trim().replace(/^\[|\]$/g, '');
      if (!v || seen.has(v) || !(net.isIP(v) || /^[a-z0-9.-]+$/i.test(v))) continue;
      seen.add(v);
      list.push(v);
    }
    if (list.length) {
      o.addrs = list;
      o.addrsMain = Math.max(1, Math.min(list.length, +r.addrsMain || list.length));
      o.address = list[0];
    }
  }
  return o;
}

// ───────────────────────────── 出站 ─────────────────────────────
class Outbound extends EventEmitter {
  constructor(route, host, port, early) {
    super();
    this.route = route;
    this.host = host;
    this.port = port;
    this.early = early || EMPTY;
    this.sock = null;
    this.ready = false;
    this.closed = false;
    this.t0 = msNow();
    this.tConn = 0;
    this.tReady = 0;
    this.tFirst = 0;
  }
  _socket(host, port, useTls, servername, insecure) {
    const sn = servername && !net.isIP(servername) ? servername : undefined;
    const s = useTls
      ? tls.connect({ host, port, servername: sn, ALPNProtocols: ['http/1.1'], rejectUnauthorized: !insecure, minVersion: 'TLSv1.2' })
      : net.connect({ host, port });
    s.setNoDelay(true);
    this.sock = s;
    return s;
  }
  _begin(timeoutMs, connectEvent, onConnected) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err = friendlyErr(err);
        this.destroy(err);
        reject(err);
      };
      const timer = setTimeout(() => fail(Object.assign(new Error('连接超时'), { friendly: true, code: 'TIMEOUT' })), timeoutMs);
      this._ok = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = true;
        this.tReady = msNow();
        resolve();
      };
      this._fail = fail;
      const s = this.sock;
      s.once(connectEvent, () => {
        this.tConn = msNow();
        try { onConnected(); } catch (e) { fail(e); }
      });
      s.on('data', d => {
        try { this._onData(d); } catch (e) { if (!settled) fail(e); else this.destroy(friendlyErr(e)); }
      });
      s.on('error', err => { if (!settled) fail(err); else this._close(friendlyErr(err)); });
      s.on('close', () => { if (!settled) fail(Object.assign(new Error('连接被关闭'), { friendly: true })); else this._close(); });
      s.on('drain', () => this.emit('drain'));
    });
  }
  write(buf) {
    if (this.closed || !this.sock || this.sock.destroyed) return true;
    return this._write(buf);
  }
  _write(buf) { return this.sock.write(buf); }
  pause() { if (this.sock && !this.sock.destroyed) this.sock.pause(); }
  resume() { if (this.sock && !this.sock.destroyed) this.sock.resume(); }
  end() { if (!this.closed && this.sock && !this.sock.destroyed) this.sock.end(); }
  destroy(err) {
    if (this.sock && !this.sock.destroyed) this.sock.destroy();
    this._close(err);
  }
  _close(err) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', err || null);
  }
  _emitData(d) {
    if (!d || !d.length) return;
    if (!this.tFirst) this.tFirst = msNow();
    this.emit('data', d);
  }
}

class DirectOutbound extends Outbound {
  start(timeoutMs) {
    this._socket(this.host, this.port, false);
    return this._begin(timeoutMs, 'connect', () => {
      if (this.early.length) this.sock.write(this.early);
      this._ok();
    });
  }
  _onData(d) { this._emitData(d); }
}

class SocksOutbound extends Outbound {
  start(timeoutMs) {
    const r = this.route;
    this.stage = 0;
    this.rx = EMPTY;
    this._socket(r.address, r.port, false);
    return this._begin(timeoutMs, 'connect', () => this.sock.write(Buffer.from(r.user ? [5, 2, 0, 2] : [5, 1, 0])));
  }
  _req() { this.sock.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddr(this.host, this.port)])); }
  _onData(d) {
    if (this.ready) return this._emitData(d);
    const r = this.route;
    this.rx = this.rx.length ? Buffer.concat([this.rx, d]) : d;
    if (this.stage === 0) {
      if (this.rx.length < 2) return;
      if (this.rx[0] !== 5) throw new Error('上游不是 SOCKS5 代理');
      const m = this.rx[1];
      this.rx = this.rx.subarray(2);
      if (m === 2) {
        const u = Buffer.from(r.user), p = Buffer.from(r.pass);
        this.sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        this.stage = 1;
      } else if (m === 0) { this._req(); this.stage = 2; }
      else throw new Error('SOCKS5 认证方式不被支持');
    }
    if (this.stage === 1) {
      if (this.rx.length < 2) return;
      if (this.rx[1] !== 0) throw new Error('SOCKS5 用户名或密码错误');
      this.rx = this.rx.subarray(2);
      this._req();
      this.stage = 2;
    }
    if (this.stage === 2) {
      if (this.rx.length < 5) return;
      if (this.rx[1] !== 0) throw new Error('SOCKS5 连接目标失败 (REP=' + this.rx[1] + ')');
      const atyp = this.rx[3];
      const alen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + this.rx[4] : -1;
      if (alen < 0) throw new Error('SOCKS5 响应无效');
      const total = 4 + alen + 2;
      if (this.rx.length < total) return;
      const rest = this.rx.subarray(total);
      this.rx = EMPTY;
      this.stage = 3;
      if (this.early.length) this.sock.write(this.early);
      this._ok();
      if (rest.length) this._emitData(rest);
    }
  }
}

class HttpOutbound extends Outbound {
  start(timeoutMs) {
    const r = this.route;
    const useTls = r.kind === 'https';
    this.rx = EMPTY;
    this._socket(r.address, r.port, useTls, r.sni || r.address, r.insecure);
    const hp = (net.isIPv6(this.host) ? `[${this.host}]` : this.host) + ':' + this.port;
    let req = `CONNECT ${hp} HTTP/1.1\r\nHost: ${hp}\r\nUser-Agent: ${UA}\r\nProxy-Connection: keep-alive\r\n`;
    if (r.user) req += `Proxy-Authorization: Basic ${Buffer.from(r.user + ':' + r.pass).toString('base64')}\r\n`;
    req += '\r\n';
    return this._begin(timeoutMs, useTls ? 'secureConnect' : 'connect', () => this.sock.write(req));
  }
  _onData(d) {
    if (this.ready) return this._emitData(d);
    this.rx = this.rx.length ? Buffer.concat([this.rx, d]) : d;
    const i = this.rx.indexOf('\r\n\r\n');
    if (i < 0) { if (this.rx.length > 16384) throw new Error('代理响应过大'); return; }
    const head = this.rx.subarray(0, i).toString('latin1');
    const rest = this.rx.subarray(i + 4);
    this.rx = EMPTY;
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
    if (!m || m[1] !== '200') throw new Error(m && m[1] === '407' ? 'HTTP 代理认证失败 (407)' : `HTTP 代理拒绝连接 (${m ? m[1] : '无效响应'})`);
    if (this.early.length) this.sock.write(this.early);
    this._ok();
    if (rest.length) this._emitData(rest);
  }
}

// VLESS / Trojan over WebSocket（edgetunnel 等 Workers 节点）
class WsOutbound extends Outbound {
  start(timeoutMs) {
    const r = this.route;
    const [th, tp] = uniTarget(r, this.host, this.port) || [this.host, this.port];
    const head = r.kind === 'vless' ? vlessHeader(r.uuid, th, tp) : trojanHeader(r.passHex, th, tp);
    const first = this.early.length ? Buffer.concat([head, this.early]) : head;
    let proto = '';
    if (r.ed > 0) {
      const n = Math.min(first.length, r.ed);
      proto = first.subarray(0, n).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      this.rest = first.subarray(n);
    } else this.rest = first;
    this.respNeed = r.kind === 'vless' ? -1 : 0;
    this.respBuf = null;
    this.rx = EMPTY;
    this.fLeft = 0;
    this.fOp = '';
    this.upgraded = false;
    this.closeSent = false;
    const key = crypto.randomBytes(16).toString('base64');
    const req = `GET ${r.path} HTTP/1.1\r\nHost: ${r.host}\r\nUser-Agent: ${UA}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`
      + (proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : '')
      + `Cache-Control: no-cache\r\nPragma: no-cache\r\n\r\n`;
    this._socket(r.address, r.port, r.tls, r.sni || r.host, r.insecure);
    return this._begin(timeoutMs, r.tls ? 'secureConnect' : 'connect', () => this.sock.write(req));
  }
  _onData(chunk) {
    if (!this.upgraded) {
      this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
      const idx = this.rx.indexOf('\r\n\r\n');
      if (idx < 0) { if (this.rx.length > 16384) throw new Error('WebSocket 握手响应过大'); return; }
      const head = this.rx.subarray(0, idx).toString('latin1');
      const rest = this.rx.subarray(idx + 4);
      this.rx = EMPTY;
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      if (!m || m[1] !== '101') {
        const code = m ? m[1] : '无效响应';
        const hint = code === '403' ? '（UUID/密码错误或被拒绝）' : code === '404' ? '（路径错误）' : code === '400' ? '（请求被拒绝）' : code === '530' || code === '522' || code === '521' ? '（节点 Worker 不可用）' : '';
        throw Object.assign(new Error(`WebSocket 握手失败 HTTP ${code}${hint}`), { friendly: true, code: 'WS_' + code });
      }
      this.upgraded = true;
      if (this.rest && this.rest.length) this._frame(this.rest, 2);
      this.rest = null;
      this._ok();
      if (rest.length) this._frames(rest);
      return;
    }
    this._frames(chunk);
  }
  _frames(chunk) {
    let buf = chunk;
    let off = 0;
    if (this.rx.length) { buf = Buffer.concat([this.rx, chunk]); this.rx = EMPTY; }
    while (off < buf.length) {
      if (this.fLeft > 0) {
        const n = Math.min(this.fLeft, buf.length - off);
        let part = buf.subarray(off, off + n);
        if (this.fMask) {
          part = Buffer.from(part);
          for (let i = 0; i < n; i++) part[i] ^= this.fMask[(this.fMaskPos + i) & 3];
          this.fMaskPos += n;
        }
        off += n;
        this.fLeft -= n;
        if (this.fOp === 'data') this._payload(part);
        else { this.fCtrl.push(part); if (this.fLeft === 0) this._control(); }
        continue;
      }
      const avail = buf.length - off;
      if (avail < 2) break;
      const b0 = buf[off], b1 = buf[off + 1];
      let len = b1 & 0x7f;
      let hl = 2 + (len === 126 ? 2 : len === 127 ? 8 : 0);
      const masked = (b1 & 0x80) !== 0;
      if (masked) hl += 4;
      if (avail < hl) break;
      if (len === 126) len = buf.readUInt16BE(off + 2);
      else if (len === 127) len = buf.readUInt32BE(off + 2) * 4294967296 + buf.readUInt32BE(off + 6);
      this.fMask = masked ? Buffer.from(buf.subarray(off + hl - 4, off + hl)) : null;
      this.fMaskPos = 0;
      const op = b0 & 0x0f;
      off += hl;
      if (op >= 0x8) {
        this.fOp = 'ctrl';
        this.fCode = op;
        this.fCtrl = [];
        this.fLeft = len;
        if (len === 0) this._control();
      } else {
        this.fOp = 'data';
        this.fLeft = len;
      }
    }
    if (off < buf.length) this.rx = Buffer.from(buf.subarray(off));
  }
  _control() {
    const payload = Buffer.concat(this.fCtrl || []);
    this.fCtrl = null;
    if (this.fCode === 0x8) {
      if (!this.closeSent) { this.closeSent = true; try { this._frame(payload.subarray(0, 2), 0x8); } catch {} }
      if (this.sock && !this.sock.destroyed) this.sock.end();
    } else if (this.fCode === 0x9) {
      this._frame(payload, 0xa);
    }
  }
  _payload(part) {
    if (this.respNeed !== 0) {
      // VLESS 响应头：版本(1) | 附加长度(1) | 附加数据
      this.respBuf = this.respBuf ? Buffer.concat([this.respBuf, part]) : part;
      if (this.respBuf.length < 2) return;
      const need = 2 + this.respBuf[1];
      if (this.respBuf.length < need) return;
      part = this.respBuf.subarray(need);
      this.respBuf = null;
      this.respNeed = 0;
      if (!part.length) return;
    }
    this._emitData(part);
  }
  _frame(payload, op) {
    const len = payload.length;
    const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
    const frame = Buffer.allocUnsafe(2 + ext + 4 + len);
    frame[0] = 0x80 | op;
    let p = 2;
    if (ext === 0) frame[1] = 0x80 | len;
    else if (ext === 2) { frame[1] = 0x80 | 126; frame.writeUInt16BE(len, 2); p = 4; }
    else { frame[1] = 0x80 | 127; frame.writeUInt32BE(Math.floor(len / 4294967296), 2); frame.writeUInt32BE(len >>> 0, 6); p = 10; }
    const mask = nextMask();
    frame[p] = mask[0]; frame[p + 1] = mask[1]; frame[p + 2] = mask[2]; frame[p + 3] = mask[3];
    p += 4;
    for (let i = 0; i < len; i++) frame[p + i] = payload[i] ^ mask[i & 3];
    return this.sock.write(frame);
  }
  _write(buf) {
    let ok = true;
    for (let i = 0; i < buf.length; i += 65536) ok = this._frame(buf.subarray(i, Math.min(buf.length, i + 65536)), 2);
    return ok;
  }
  end() {
    if (this.closed || !this.sock || this.sock.destroyed) return;
    if (this.upgraded && !this.closeSent) { this.closeSent = true; try { this._frame(Buffer.from([0x03, 0xe8]), 0x8); } catch {} }
    this.sock.end();
  }
}

function createOutbound(route, host, port, early) {
  switch (route.kind) {
    case 'vless':
    case 'trojan': return new WsOutbound(route, host, port, early);
    case 'socks5': return new SocksOutbound(route, host, port, early);
    case 'http':
    case 'https': return new HttpOutbound(route, host, port, early);
    default: return new DirectOutbound(route, host, port, early);
  }
}

// ───────────────────────────── 运行状态 ─────────────────────────────
const CFG = { connectTimeout: 7000, firstByteTimeout: 10000, maxTries: 3, directFallback: true, strict: false, idleTimeout: 5 * 60e3 };
let ROUTES = [];
const RSTAT = new Map();
const SESSIONS = new Set();
const STATS = { active: 0, total: 0, up: 0, down: 0, failovers: 0, direct: 0, failed: 0, rateUp: 0, rateDown: 0 };
let lastUp = 0, lastDown = 0;
setInterval(() => {
  STATS.rateUp = STATS.up - lastUp;
  STATS.rateDown = STATS.down - lastDown;
  lastUp = STATS.up;
  lastDown = STATS.down;
}, 1000).unref();

function routeStat(key) {
  let s = RSTAT.get(key);
  if (!s) { s = { ok: 0, fail: 0, consec: 0, err: '', lastOk: 0, lastFail: 0, down: 0, ms: 0 }; RSTAT.set(key, s); }
  return s;
}
// 单个地址（优选 IP）的统计与熔断：一个 IP 坏了只熔断这个 IP，不影响同线路的其他 IP
const ASTAT = new Map();
function addrStat(akey) {
  let s = ASTAT.get(akey);
  if (!s) { s = { ok: 0, fail: 0, consec: 0, err: '', lastOk: 0, lastFail: 0, down: 0, ms: 0, act: 0, bytes: 0 }; ASTAT.set(akey, s); }
  return s;
}
const akeyOf = (route, addr) => route.key + '@' + addr;
function routeAllDown(route) {
  if (!route.addrs || !route.addrs.length) return false;
  const t = Date.now();
  return route.addrs.every(a => addrStat(akeyOf(route, a)).down > t);
}
// 为一次会话挑选 n 个不同的地址：主用优先；在延迟接近最优（≤1.3 倍）的地址中随机分散；未测过的地址也有机会被探索
function pickAddrs(route, n) {
  const t = Date.now();
  const all = route.addrs.map((a, i) => ({ a, i, s: addrStat(akeyOf(route, a)) }));
  const healthy = all.filter(x => x.s.down <= t);
  const main = healthy.filter(x => x.i < route.addrsMain);
  const backup = healthy.filter(x => x.i >= route.addrsMain);
  const order = list => {
    const known = list.filter(x => x.s.ms > 0).sort((a, b) => a.s.ms - b.s.ms);
    const unknown = list.filter(x => !(x.s.ms > 0));
    if (!known.length) return [...unknown].sort(() => Math.random() - 0.5);
    const best = known[0].s.ms;
    const near = [...known.filter(x => x.s.ms <= best * 1.3), ...unknown].sort(() => Math.random() - 0.5);
    const rest = known.filter(x => x.s.ms > best * 1.3);
    return [...near, ...rest];
  };
  let seq = [...order(main), ...order(backup)];
  if (!seq.length) seq = [...all].sort((a, b) => a.s.down - b.s.down);
  return seq.slice(0, n).map(x => x.a);
}
function markOk(route, ms) {
  if (route._akey) {
    const a = addrStat(route._akey);
    a.ok++; a.consec = 0; a.lastOk = Date.now(); a.down = 0;
    a.ms = a.ms ? Math.round(a.ms * 0.7 + ms * 0.3) : Math.round(ms);
  }
  const s = routeStat(route.key);
  s.ok++; s.consec = 0; s.lastOk = Date.now(); s.down = 0;
  s.ms = s.ms ? Math.round(s.ms * 0.7 + ms * 0.3) : Math.round(ms);
}
function markFail(route, err) {
  if (route._akey) {
    const a = addrStat(route._akey);
    a.fail++; a.consec++; a.lastFail = Date.now();
    a.err = String((err && err.message) || err || '失败').slice(0, 160);
    if (a.consec >= 2) {
      const was = a.down > Date.now();
      a.down = Date.now() + 30000 * Math.min(8, a.consec - 1);
      if (!was) log('warn', `优选 IP 熔断：${route._addr}（${route.name || route.key}，${a.err}）`);
    }
    // 只有该线路的全部地址都熔断，才算整条线路失败
    if (!routeAllDown(route)) return;
  }
  const s = routeStat(route.key);
  s.fail++; s.consec++; s.lastFail = Date.now();
  s.err = String((err && err.message) || err || '失败').slice(0, 160);
  if (s.consec >= 2) {
    const wasDown = s.down > Date.now();
    s.down = Date.now() + 20000 * Math.min(6, s.consec - 1);
    if (!wasDown) {
      log('warn', `线路熔断：${route.name || route.key}（连续失败 ${s.consec} 次：${s.err}）`);
      emitEvent('routeDown', { key: route.key, err: s.err, consec: s.consec });
    }
  }
}
function planRoutes() {
  const t = Date.now();
  const up = ROUTES.filter(r => routeStat(r.key).down <= t);
  const down = ROUTES.filter(r => routeStat(r.key).down > t);
  const base = up.length ? up.slice(0, CFG.maxTries) : down.slice(0, 2);
  const plan = [];
  base.forEach((r, i) => {
    // 多地址线路：本次会话先后尝试多个不同的优选 IP（主线路 3 个、其余 2 个），再轮到下一条线路
    if (r.addrs && r.addrs.length > 1) for (const a of pickAddrs(r, i === 0 ? 3 : 2)) plan.push({ ...r, address: a, _addr: a, _akey: akeyOf(r, a) });
    else plan.push(r);
  });
  if (!ROUTES.length || (CFG.directFallback && !CFG.strict)) plan.push(DIRECT);
  return plan;
}

// ───────────────────────────── 会话（带无感重试）─────────────────────────────
class Session {
  constructor(client, host, port) {
    this.client = client;
    this.host = host;
    this.port = port;
    this.pending = [];
    this.pendingLen = 0;
    this.ob = null;
    this.obSent = 0;
    this.obReady = false;
    this.committed = false;
    this.closed = false;
    this.isTls = false;
    this.idx = 0;
    this.plan = planRoutes();
    this.t0 = msNow();
    STATS.active++;
    STATS.total++;
    SESSIONS.add(this);
    client.removeAllListeners('timeout');
    client.setTimeout(CFG.idleTimeout, () => client.destroy());
    client.on('data', d => this.onClient(d));
    client.on('drain', () => { if (this.ob && this.committed) this.ob.resume(); });
    client.on('error', () => {});
    client.on('close', () => this.close());
  }
  begin(initial, waitFirst) {
    if (initial && initial.length) this.addPending(initial);
    if (!this.pendingLen && waitFirst) this.waitTimer = setTimeout(() => { this.waitTimer = null; this.next(); }, 60);
    else this.next();
  }
  addPending(d) {
    if (!this.pendingLen && d.length >= 2) this.isTls = d[0] === 0x16 && d[1] === 0x03;
    this.pending.push(d);
    this.pendingLen += d.length;
  }
  pendingFrom(off) {
    if (!this.pending || off >= this.pendingLen) return null;
    const all = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
    this.pending = [all];
    return all.subarray(off);
  }
  onClient(d) {
    STATS.up += d.length;
    if (this.astat) this.astat.bytes += d.length;
    if (this.committed) {
      if (this.ob && !this.ob.write(d)) this.client.pause();
      return;
    }
    this.addPending(d);
    if (this.pendingLen > (1 << 20)) this.client.pause();
    if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null; this.next(); return; }
    if (this.ob && this.obReady) { this.ob.write(d); this.obSent += d.length; }
  }
  next() {
    if (this.closed || this.committed) return;
    const route = this.plan[this.idx++];
    if (!route) {
      STATS.failed++;
      if (this.uniSkip && this.uniSkip === this.plan.length) log('info', `统一出口（严格）：已拒绝 ${this.host}:${this.port}（只能统一 HTTPS 域名连接）`);
      else log('warn', `✖ ${this.host}:${this.port} 所有线路均失败`);
      this.client.destroy();
      return;
    }
    // 统一出口（严格）：不能经通用转发 ProxyIP 的连接（非 443 / IP 直连）不走这条线路，也不计失败
    if (route.uni && route.uniStrict && !uniTarget(route, this.host, this.port)) {
      this.uniSkip = (this.uniSkip || 0) + 1;
      return this.next();
    }
    const early = this.pendingLen ? this.pendingFrom(0) : EMPTY;
    let ob;
    try { ob = createOutbound(route, this.host, this.port, early); } catch (e) { markFail(route, e); return this.next(); }
    this.ob = ob;
    this.obSent = early.length;
    this.obReady = false;
    ob.on('data', d => this.onOb(ob, d));
    ob.on('close', err => this.onObClose(ob, err));
    ob.on('drain', () => { if (ob === this.ob && this.committed) this.client.resume(); });
    const timeout = this.idx === 1 ? CFG.connectTimeout : Math.min(CFG.connectTimeout, 5000);
    ob.start(timeout).then(() => {
      if (ob !== this.ob || this.closed) return;
      this.obReady = true;
      if (!this.committed) {
        const extra = this.pendingFrom(this.obSent);
        if (extra) { ob.write(extra); this.obSent += extra.length; }
        if (this.isTls) this.fbTimer = setTimeout(() => this.retry(ob, Object.assign(new Error('首包超时'), { friendly: true, soft: true })), CFG.firstByteTimeout);
      }
    }, err => this.retry(ob, err));
  }
  onOb(ob, d) {
    if (ob !== this.ob || this.closed) return;
    STATS.down += d.length;
    if (!this.committed) this.commit(ob);
    if (this.astat) this.astat.bytes += d.length;
    if (!this.client.write(d)) ob.pause();
  }
  commit(ob) {
    this.committed = true;
    clearTimeout(this.fbTimer);
    this.obReady = true;
    const extra = this.pendingFrom(this.obSent);
    if (extra) { ob.write(extra); this.obSent += extra.length; }
    this.pending = null;
    this.pendingLen = 0;
    this.client.resume();
    markOk(ob.route, msNow() - this.t0);
    // 1.2.2：记录这个会话用的是哪个优选 IP（当前连接数 / 流量），供「优选 IP」页显示正在使用的 IP
    if (ob.route._akey) { this.astat = addrStat(ob.route._akey); this.astat.act++; }
    if (this.idx > 1) {
      STATS.failovers++;
      if (ob.route.kind === 'direct') STATS.direct++;
      log('info', `↻ ${this.host}:${this.port} 已无感切换到${ob.route.kind === 'direct' ? '直连兜底' : '备用线路 ' + (ob.route.name || ob.route.key)}`);
    }
  }
  onObClose(ob, err) {
    if (ob !== this.ob) return;
    if (!this.committed) return this.retry(ob, err || Object.assign(new Error('连接被关闭'), { friendly: true }));
    if (!this.client.destroyed) this.client.end();
  }
  retry(ob, err) {
    if (ob !== this.ob || this.committed || this.closed) return;
    clearTimeout(this.fbTimer);
    this.fbTimer = null;
    this.ob = null;
    ob.removeAllListeners('data');
    ob.removeAllListeners('close');
    ob.destroy();
    // 首包超时：WebSocket 已连上（IP 与节点本身是通的），慢在 Worker 拨号 / ProxyIP / 目标站点，
    // 例如 edgetunnel 对测速站点不响应、访问 CF 站点时先直连失败再走 ProxyIP。不计入 IP / 线路失败，避免误熔断
    if (ob.route.kind !== 'direct' && !(err && err.soft)) markFail(ob.route, err);
    if (DEBUG) log('warn', `${ob.route.name || ob.route.key} → ${this.host}:${this.port} 失败：${(err && err.message) || err}`);
    this.next();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    STATS.active--;
    if (this.astat) { this.astat.act = Math.max(0, this.astat.act - 1); this.astat = null; }
    SESSIONS.delete(this);
    clearTimeout(this.fbTimer);
    clearTimeout(this.waitTimer);
    const ob = this.ob;
    this.ob = null;
    if (ob) { ob.removeAllListeners('data'); ob.destroy(); }
    if (!this.client.destroyed) this.client.destroy();
  }
}

function closeAllSessions() {
  for (const s of [...SESSIONS]) { try { s.client.destroy(); } catch {} }
}

// ───────────────────────────── 入站（混合端口）─────────────────────────────
function onInbound(sock) {
  sock.setNoDelay(true);
  sock.on('error', () => {});
  sock.setTimeout(20000, () => { if (!sock._brana) sock.destroy(); });
  sock.once('data', first => {
    if (first[0] === 0x05) return socks5In(sock, first);
    if (first[0] === 0x04) return sock.destroy();
    return httpIn(sock, first);
  });
}

function startSession(sock, host, port, initial, waitFirst) {
  sock._brana = true;
  host = String(host || '').replace(/^\[|\]$/g, '');
  if (!host || !(port > 0 && port < 65536)) return sock.destroy();
  new Session(sock, host, port).begin(initial, waitFirst);
}

function socks5In(sock, first) {
  let buf = first;
  let stage = 0;
  const onData = d => { buf = Buffer.concat([buf, d]); if (buf.length > 4096) return sock.destroy(); step(); };
  sock.on('data', onData);
  const reply = rep => Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]);
  const step = () => {
    if (stage === 0) {
      if (buf.length < 2) return;
      const n = buf[1];
      if (buf.length < 2 + n) return;
      buf = buf.subarray(2 + n);
      sock.write(Buffer.from([5, 0]));
      stage = 1;
    }
    if (stage === 1) {
      if (buf.length < 5) return;
      if (buf[0] !== 5) return sock.destroy();
      const cmd = buf[1], atyp = buf[3];
      let host, p;
      if (atyp === 1) { if (buf.length < 10) return; host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`; p = 8; }
      else if (atyp === 3) { const l = buf[4]; if (buf.length < 7 + l) return; host = buf.subarray(5, 5 + l).toString('utf8'); p = 5 + l; }
      else if (atyp === 4) { if (buf.length < 22) return; host = ipv6Str(buf.subarray(4, 20)); p = 20; }
      else { sock.end(reply(8)); return; }
      const port = buf.readUInt16BE(p);
      const rest = buf.subarray(p + 2);
      stage = 2;
      sock.removeListener('data', onData);
      if (cmd !== 1) { sock.end(reply(7)); return; }
      sock.write(reply(0));
      startSession(sock, host, port, rest, true);
    }
  };
  step();
}

function httpIn(sock, first) {
  let buf = first;
  const onData = d => { buf = Buffer.concat([buf, d]); if (buf.length > 65536) return sock.destroy(); parse(); };
  sock.on('data', onData);
  const parse = () => {
    const i = buf.indexOf('\r\n\r\n');
    if (i < 0) return;
    sock.removeListener('data', onData);
    const head = buf.subarray(0, i).toString('latin1');
    const rest = buf.subarray(i + 4);
    const lines = head.split('\r\n');
    const [method, target, ver] = lines[0].split(' ');
    const headers = [];
    for (const l of lines.slice(1)) { const c = l.indexOf(':'); if (c > 0) headers.push([l.slice(0, c).trim(), l.slice(c + 1).trim()]); }
    const hget = n => { n = n.toLowerCase(); const h = headers.find(([k]) => k.toLowerCase() === n); return h ? h[1] : ''; };
    if (!method || !target) return sock.destroy();
    if (method === 'CONNECT') {
      const { host, port } = splitHostPort(target, 443);
      if (!host) return sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      sock.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: BranaCore\r\n\r\n');
      return startSession(sock, host, port, rest, true);
    }
    if (target.startsWith('/')) return apiIn(sock, method, target, hget, rest);
    let u;
    try { u = new URL(target); } catch { return sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); }
    if (u.protocol !== 'http:') return sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    const out = [`${method} ${u.pathname + u.search} ${ver || 'HTTP/1.1'}`];
    for (const [k, v] of headers) {
      const lk = k.toLowerCase();
      if (lk === 'proxy-connection' || lk === 'proxy-authorization' || lk === 'connection' || lk === 'keep-alive') continue;
      out.push(`${k}: ${v}`);
    }
    if (!hget('host')) out.push(`Host: ${u.host}`);
    out.push('Connection: close');
    const reqBuf = Buffer.concat([Buffer.from(out.join('\r\n') + '\r\n\r\n', 'latin1'), rest]);
    startSession(sock, u.hostname, +u.port || 80, reqBuf, false);
  };
  parse();
}

// ───────────────────────────── 本地 HTTP 控制 API ─────────────────────────────
const isExtOrigin = o => /^(chrome-extension|moz-extension|extension):\/\/[a-z0-9_-]+\/?$/i.test(String(o || ''));

function apiIn(sock, method, path, hget, rest) {
  sock._brana = true;
  const origin = hget('origin');
  const host = hget('host').toLowerCase();
  const send = (code, obj, extra) => {
    const body = Buffer.from(obj === null ? '' : JSON.stringify(obj));
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', Connection: 'close', ...(extra || {}) };
    if (isExtOrigin(origin)) {
      h['Access-Control-Allow-Origin'] = origin;
      h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      h['Access-Control-Allow-Headers'] = 'Content-Type';
      h['Access-Control-Allow-Private-Network'] = 'true';
      h.Vary = 'Origin';
    }
    const text = { 200: 'OK', 204: 'No Content', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 413: 'Payload Too Large', 500: 'Internal Server Error' }[code] || 'OK';
    sock.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${code} ${text}\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n', 'latin1'), body]));
  };
  // 防 DNS 重绑定：只接受 127.0.0.1 / localhost 的 Host
  const okHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  if (!okHost) return send(403, { ok: false, error: 'forbidden host' });
  // 防网页滥用：带 Origin 的请求只接受浏览器扩展来源
  if (origin && !isExtOrigin(origin)) return send(403, { ok: false, error: 'forbidden origin' });
  const p = path.split('?')[0];
  if (method === 'OPTIONS') return send(204, null);
  if (method === 'GET' && (p === '/__brana/status' || p === '/__brana/hello')) return send(200, { ok: true, result: p.endsWith('hello') ? hello() : status() });
  if (method !== 'POST' || p !== '/__brana/rpc') return send(404, { ok: false, error: 'not found' });
  if (!origin && hget('x-brana-local') !== '1') return send(403, { ok: false, error: 'missing origin' });
  const len = +hget('content-length') || 0;
  if (len > 4 << 20) return send(413, { ok: false, error: 'too large' });
  let body = rest;
  const finish = async () => {
    let req;
    try { req = JSON.parse(body.subarray(0, len).toString('utf8') || '{}'); } catch { return send(400, { ok: false, error: 'bad json' }); }
    try {
      const result = await rpc(req.method, req.params || {});
      send(200, { ok: true, result });
    } catch (e) {
      send(200, { ok: false, error: friendlyErr(e).message });
    }
  };
  if (body.length >= len) return void finish();
  const onData = d => {
    body = Buffer.concat([body, d]);
    if (body.length >= len) { sock.removeListener('data', onData); finish(); }
  };
  sock.on('data', onData);
}

// ───────────────────────────── HTTP 客户端（经指定线路）─────────────────────────────
function outboundDuplex(ob) {
  const d = new Duplex({
    write(chunk, enc, cb) { if (ob.write(chunk)) cb(); else ob.once('drain', () => cb()); },
    read() { ob.resume(); },
    final(cb) { ob.end(); cb(); },
    destroy(err, cb) { ob.destroy(); cb(err); },
  });
  ob.on('data', c => { if (!d.push(c)) ob.pause(); });
  ob.on('close', () => { d.push(null); });
  return d;
}

function tlsOver(stream, servername, insecure, timeout) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket: stream, servername: net.isIP(servername) ? undefined : servername, ALPNProtocols: ['http/1.1'], rejectUnauthorized: !insecure });
    const timer = setTimeout(() => { t.destroy(); reject(Object.assign(new Error('目标 TLS 握手超时'), { friendly: true })); }, timeout);
    t.once('secureConnect', () => { clearTimeout(timer); resolve(t); });
    t.once('error', e => { clearTimeout(timer); reject(friendlyErr(e)); });
  });
}

function responseReader(stream) {
  let buf = EMPTY;
  let ended = false;
  let failure = null;
  let waiter = null;
  const wake = () => { const w = waiter; waiter = null; if (w) w(); };
  stream.on('data', d => { buf = buf.length ? Buffer.concat([buf, d]) : d; wake(); });
  stream.on('end', () => { ended = true; wake(); });
  stream.on('close', () => { ended = true; wake(); });
  stream.on('error', e => { failure = friendlyErr(e); ended = true; wake(); });
  const wait = () => new Promise(r => { waiter = r; });
  const early = () => failure || Object.assign(new Error('连接提前关闭'), { friendly: true });
  return async function read({ maxBody = 65536, onBody, stopAt = 0 } = {}) {
    let stopTimer = null;
    let stopped = false;
    if (stopAt) stopTimer = setTimeout(() => { stopped = true; wake(); }, Math.max(0, stopAt - msNow()));
    try {
      let i;
      while ((i = buf.indexOf('\r\n\r\n')) < 0) {
        if (ended) throw early();
        if (buf.length > 65536) throw new Error('响应头过大');
        await wait();
      }
      const tHead = msNow();
      const head = buf.subarray(0, i).toString('latin1');
      buf = buf.subarray(i + 4);
      const status = +((/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head) || [])[1] || 0);
      const headers = {};
      for (const l of head.split('\r\n').slice(1)) { const c = l.indexOf(':'); if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim(); }
      const parts = [];
      let kept = 0, total = 0;
      const take = chunk => {
        total += chunk.length;
        if (onBody) onBody(chunk.length, msNow());
        if (kept < maxBody) { const k = chunk.subarray(0, maxBody - kept); parts.push(k); kept += k.length; }
      };
      const noBody = status === 204 || status === 304 || (status >= 100 && status < 200);
      if (!noBody) {
        if (/chunked/i.test(headers['transfer-encoding'] || '')) {
          outer: for (;;) {
            let j;
            while ((j = buf.indexOf('\r\n')) < 0) { if (ended) throw early(); if (stopped) break outer; await wait(); }
            const size = parseInt(buf.subarray(0, j).toString('latin1'), 16);
            buf = buf.subarray(j + 2);
            if (!(size >= 0)) throw new Error('chunked 编码错误');
            if (size === 0) {
              let k;
              while ((k = buf.indexOf('\r\n')) < 0 && !ended && !stopped) await wait();
              if (k >= 0) buf = buf.subarray(k + 2);
              break;
            }
            let left = size;
            while (left > 0) {
              if (stopped) break outer;
              if (!buf.length) { if (ended) throw early(); await wait(); continue; }
              const n = Math.min(left, buf.length);
              take(buf.subarray(0, n));
              buf = buf.subarray(n);
              left -= n;
            }
            while (buf.length < 2) { if (ended) break outer; if (stopped) break outer; await wait(); }
            buf = buf.subarray(2);
          }
        } else if (headers['content-length'] !== undefined) {
          let left = +headers['content-length'] || 0;
          while (left > 0) {
            if (stopped) break;
            if (!buf.length) { if (ended) throw early(); await wait(); continue; }
            const n = Math.min(left, buf.length);
            take(buf.subarray(0, n));
            buf = buf.subarray(n);
            left -= n;
          }
        } else {
          for (;;) {
            if (buf.length) { take(buf); buf = EMPTY; }
            if (ended || stopped) break;
            await wait();
          }
        }
      }
      return { status, headers, body: Buffer.concat(parts), bytes: total, tHead, tEnd: msNow(), stopped };
    } finally {
      clearTimeout(stopTimer);
    }
  };
}

// 经指定线路发起 HTTP(S) GET；reqCount>1 时在同一条连接上复用（第二次即“热延迟”）
async function requestVia(route, urlStr, opts = {}) {
  const { timeout = 9000, reqCount = 1, maxBody = 65536, onBody, maxSeconds = 0, insecure = false, headers: extraHeaders = {} } = opts;
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = +u.port || (isHttps ? 443 : 80);
  const t0 = msNow();
  const ob = createOutbound(route, host, port, EMPTY);
  let stream = null;
  let killed = false;
  const killer = setTimeout(() => { killed = true; try { stream ? stream.destroy() : ob.destroy(); } catch {} }, timeout + (maxSeconds ? maxSeconds * 1000 : 0));
  try {
    await ob.start(Math.min(timeout, 9000));
    const tReady = msNow();
    stream = outboundDuplex(ob);
    if (isHttps) stream = await tlsOver(stream, host, insecure || route.insecureTarget, Math.max(1000, timeout - (msNow() - t0)));
    const tTls = msNow();
    const read = responseReader(stream);
    const results = [];
    for (let i = 0; i < reqCount; i++) {
      const tReq = msNow();
      const last = i === reqCount - 1;
      let req = `GET ${u.pathname + u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: ${extraHeaders['user-agent'] || UA}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nCache-Control: no-cache\r\nConnection: ${last ? 'close' : 'keep-alive'}\r\n`;
      for (const [k, v] of Object.entries(extraHeaders)) if (k.toLowerCase() !== 'user-agent') req += `${k}: ${v}\r\n`;
      stream.write(req + '\r\n');
      const r = await read({ maxBody, onBody, stopAt: maxSeconds ? msNow() + maxSeconds * 1000 : 0 });
      results.push({ status: r.status, headers: r.headers, body: r.body, bytes: r.bytes, ms: Math.round(r.tHead - tReq), tHead: r.tHead, tEnd: r.tEnd, stopped: r.stopped });
      if (last || /close/i.test(r.headers.connection || '')) break;
    }
    return { ok: true, tunnelMs: Math.round(tReady - t0), tlsMs: Math.round(tTls - tReady), totalMs: Math.round(msNow() - t0), results };
  } catch (e) {
    if (killed) throw Object.assign(new Error('请求超时'), { friendly: true });
    throw friendlyErr(e);
  } finally {
    clearTimeout(killer);
    try { stream ? stream.destroy() : ob.destroy(); } catch {}
  }
}

function parseTrace(body) {
  const kv = {};
  for (const line of String(body || '').split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return kv.ip ? { ip: kv.ip, loc: (kv.loc || '').toUpperCase(), colo: (kv.colo || '').toUpperCase(), warp: kv.warp || '', tls: kv.tls || '', http: kv.http || '' } : null;
}

// 线路延迟：同一连接两次请求 → cold(含握手) / warm(纯往返)
async function probeRoute(route, p) {
  const url = p.url || 'https://www.gstatic.com/generate_204';
  const count = Math.max(1, Math.min(3, +p.count || 2));
  try {
    const r = await requestVia(route, url, { timeout: +p.timeout || 8000, reqCount: count, maxBody: 8192, insecure: !!p.insecure });
    const first = r.results[0];
    const warm = r.results.length > 1 ? r.results[r.results.length - 1].ms : 0;
    const cold = Math.round(first.ms + r.tunnelMs + r.tlsMs);
    const out = { key: route.key, ok: first.status > 0, status: first.status, ms: warm || cold, cold, warm, tunnel: r.tunnelMs, tls: r.tlsMs };
    if (/\/cdn-cgi\/trace/.test(url)) out.trace = parseTrace(first.body.toString('utf8'));
    if (first.status >= 500) { out.ok = false; out.err = `目标返回 HTTP ${first.status}`; }
    return out;
  } catch (e) {
    return { key: route.key, ok: false, err: friendlyErr(e).message };
  }
}

async function speedRoute(route, p) {
  // 经节点测速：不能用 speed.cloudflare.com / cp.cloudflare.com（edgetunnel 会拦截测速站点，经节点访问永远没有响应）
  const url = p.url || 'https://speedtest.tokyo2.linode.com/100MB-tokyo2.bin';
  const maxSeconds = Math.max(2, Math.min(15, +p.seconds || 6));
  let firstT = 0, lastT = 0, bytes = 0, firstBytes = 0;
  try {
    const r = await requestVia(route, url, {
      timeout: +p.timeout || 10000,
      maxBody: 0,
      maxSeconds,
      insecure: !!p.insecure,
      onBody: (n, t) => { if (!firstT) { firstT = t; firstBytes = n; } bytes += n; lastT = t; },
    });
    const res = r.results[0];
    const secs = Math.max(0.001, (lastT - firstT) / 1000);
    const counted = Math.max(0, bytes - firstBytes);
    const mbps = counted > 0 ? +(counted * 8 / secs / 1e6).toFixed(2) : 0;
    return { key: route.key, ok: bytes > 0 && res.status < 400, status: res.status, mbps, bytes, secs: +secs.toFixed(2), ttfb: res.ms, tunnel: r.tunnelMs };
  } catch (e) {
    // 中途断开（如 Worker 关闭长连接）时按已收到的数据计算速度，不作废
    const secs = Math.max(0.001, (lastT - firstT) / 1000);
    const counted = Math.max(0, bytes - firstBytes);
    const mbps = counted > 1048576 && secs >= 0.2 ? +(counted * 8 / secs / 1e6).toFixed(2) : 0;
    return { key: route.key, ok: mbps > 0, mbps, bytes, secs: +secs.toFixed(2), err: friendlyErr(e).message, partial: mbps > 0 };
  }
}

async function traceRoute(route, p) {
  const timeout = +p.timeout || 9000;
  const cfUrl = p.cfUrl || 'https://www.cloudflare.com/cdn-cgi/trace';
  const stdUrl = p.stdUrl || 'http://ip-api.com/json/?fields=status,message,query,countryCode,country,regionName,city,isp,org,as,mobile,proxy,hosting&lang=zh-CN';
  const [cf, std] = await Promise.all([
    requestVia(route, cfUrl, { timeout, maxBody: 4096, insecure: !!p.insecure })
      .then(r => parseTrace(r.results[0].body.toString('utf8')) || { err: '解析失败' })
      .catch(e => ({ err: friendlyErr(e).message })),
    requestVia(route, stdUrl, { timeout, maxBody: 16384, insecure: !!p.insecure })
      .then(r => {
        const j = JSON.parse(r.results[0].body.toString('utf8'));
        if (j.status && j.status !== 'success') return { err: j.message || 'ip-api 查询失败' };
        return { ip: j.query || j.ip || '', cc: String(j.countryCode || j.country_code || '').toUpperCase(), country: j.country || '', city: j.city || '', isp: j.isp || j.org || '', as: j.as || '', hosting: !!j.hosting, proxy: !!j.proxy, mobile: !!j.mobile };
      })
      .catch(e => ({ err: friendlyErr(e).message })),
  ]);
  return { cf, std };
}

function tcping(host, port, timeout) {
  return new Promise(resolve => {
    const t0 = msNow();
    let done = false;
    const s = net.connect({ host, port });
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      resolve({ ok, ms: Math.round(msNow() - t0), err: err || '' });
    };
    const timer = setTimeout(() => finish(false, '超时'), timeout);
    s.once('connect', () => finish(true));
    s.once('error', e => finish(false, friendlyErr(e).message));
  });
}

function httpsJson(url, headers, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function doh(host) {
  const qs = [
    [`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, { accept: 'application/dns-json' }],
    [`https://223.5.5.5/resolve?name=${encodeURIComponent(host)}&type=1`, {}],
    [`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=1`, {}],
  ];
  const res = await Promise.all(qs.map(([u, h]) => httpsJson(u, h, 5000).catch(() => null)));
  const ips = new Set();
  for (const j of res) for (const a of (j && j.Answer) || []) if (a.type === 1 && net.isIPv4(String(a.data).trim())) ips.add(String(a.data).trim());
  return [...ips];
}

async function resolveHosts(hosts) {
  const out = {};
  await runPool(hosts.slice(0, 200), 8, async h => {
    h = String(h || '').trim().toLowerCase();
    if (!h) return;
    if (net.isIP(h)) { out[h] = [h]; return; }
    const set = new Set();
    try { (await dns.promises.resolve4(h)).forEach(ip => set.add(ip)); } catch {}
    if (set.size < 2) { try { (await doh(h)).forEach(ip => set.add(ip)); } catch {} }
    if (!set.size) { try { (await dns.promises.lookup(h, { all: true, family: 4 })).forEach(x => set.add(x.address)); } catch {} }
    out[h] = [...set];
  });
  return out;
}

const CF_CIDRS = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
function randomCfIps(n) {
  const ranges = CF_CIDRS.map(c => {
    const [ip, bits] = c.split('/');
    const base = ip.split('.').reduce((a, b) => a * 256 + +b, 0);
    return { base, size: 2 ** (32 - +bits) };
  });
  // 按 /20 粒度均衡抽样，避免大网段独占
  const weights = ranges.map(r => Math.sqrt(r.size));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = new Set();
  let guard = 0;
  while (out.size < n && guard++ < n * 20) {
    let x = Math.random() * sum, k = 0;
    while (x > weights[k] && k < weights.length - 1) { x -= weights[k]; k++; }
    const r = ranges[k];
    const v = r.base + 1 + Math.floor(Math.random() * Math.max(1, r.size - 2));
    const last = v & 255;
    if (last === 0 || last === 255) continue;
    out.add([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.'));
  }
  return [...out];
}

// Cloudflare 优选 IP：随机抽样 → TCP 延迟初筛 → 用节点的 SNI/Host 做真实 WebSocket 握手复核
async function scanCf(route, p) {
  const sample = Math.max(16, Math.min(256, +p.sample || 72));
  const top = Math.max(2, Math.min(20, +p.top || 8));
  const port = +p.port || route.port || 443;
  const extra = Array.isArray(p.candidates) ? p.candidates.filter(Boolean).slice(0, 64) : [];
  const ips = [...new Set([...extra, ...randomCfIps(sample)])];
  const tcp = await runPool(ips, 24, ip => tcping(ip, port, +p.tcpTimeout || 1500).then(r => ({ ip, ...r })));
  const good = tcp.filter(x => x && x.ok).sort((a, b) => a.ms - b.ms).slice(0, top);
  const verified = await runPool(good, 4, async g => {
    const ob = createOutbound({ ...route, address: g.ip }, 'www.gstatic.com', 443, EMPTY);
    const t0 = msNow();
    try {
      await ob.start(+p.wsTimeout || 4500);
      const up = Math.round(msNow() - t0);
      ob.destroy();
      return { ip: g.ip, tcp: g.ms, up, ok: true };
    } catch (e) {
      return { ip: g.ip, tcp: g.ms, ok: false, err: friendlyErr(e).message };
    }
  });
  return { scanned: ips.length, reachable: tcp.filter(x => x && x.ok).length, list: verified.filter(v => v && v.ok).sort((a, b) => a.up - b.up) };
}

// ───────────────────────────── 优选 IP 测量（直连，不经过任何节点）─────────────────────────────
function globalV6Iface() {
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        const fam = a.family === 6 || a.family === 'IPv6';
        if (!fam || a.internal) continue;
        const ip = String(a.address).toLowerCase();
        if (ip === '::1' || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb') || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('2001:0:') || ip.startsWith('2001::')) continue;
        if (/^[23]/.test(ip)) return ip;
      }
    }
  } catch {}
  return '';
}

// 本机网络能力：是否具备可用的 IPv4 / IPv6 出口（真实 TCP 连接验证）
async function netCaps(p) {
  const timeout = Math.max(800, Math.min(6000, +p.timeout || 2500));
  const firstOk = async targets => {
    const res = await Promise.all(targets.map(([h, port]) => tcping(h, port, timeout)));
    const ok = res.filter(r => r.ok).sort((a, b) => a.ms - b.ms);
    return ok.length ? { ok: true, ms: ok[0].ms } : { ok: false, err: (res[0] && res[0].err) || '不可达' };
  };
  const iface = globalV6Iface();
  const [v4, v6] = await Promise.all([
    firstOk([['1.1.1.1', 443], ['8.8.8.8', 443], ['223.5.5.5', 443]]),
    firstOk([['2606:4700:4700::1111', 443], ['2001:4860:4860::8888', 443], ['2400:3200::1', 443]]),
  ]);
  return { v4: v4.ok, v4ms: v4.ms || 0, v6: v6.ok, v6ms: v6.ms || 0, v6iface: iface, v6err: v6.ok ? '' : v6.err, at: Date.now() };
}

// 多次 TCP 握手测延迟与丢包（与 CloudflareSpeedTest 的 TCPing 同原理）
async function ipPing(p) {
  const ips = (Array.isArray(p.ips) ? p.ips : []).map(x => String(x).trim()).filter(x => net.isIP(x)).slice(0, 400);
  const port = Math.max(1, Math.min(65535, +p.port || 443));
  const count = Math.max(1, Math.min(20, +p.count || 4));
  const timeout = Math.max(300, Math.min(5000, +p.timeout || 1000));
  const gap = Math.max(0, Math.min(2000, +p.gap || 0));
  const conc = Math.max(1, Math.min(64, +p.concurrency || 16));
  return runPool(ips, conc, async ip => {
    const ms = [];
    let fails = 0, err = '';
    for (let i = 0; i < count; i++) {
      const r = await tcping(ip, port, timeout);
      if (r.ok) ms.push(r.ms); else { fails++; err = r.err; }
      if (gap && i < count - 1) await sleep(gap);
    }
    const sorted = [...ms].sort((a, b) => a - b);
    const avg = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0;
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    let jitter = 0;
    for (let i = 1; i < ms.length; i++) jitter += Math.abs(ms[i] - ms[i - 1]);
    jitter = ms.length > 1 ? Math.round(jitter / (ms.length - 1)) : 0;
    return { ip, sent: count, recv: ms.length, loss: +(fails / count).toFixed(3), min: sorted[0] || 0, avg, med, max: sorted[sorted.length - 1] || 0, jitter, err: ms.length ? '' : err };
  });
}

// 直连测速：直接对该 IP 建立 TLS（SNI 用测速域名），下载并统计平均速度与 1 秒峰值速度；cf-ray 里带有机房代码
function ipSpeed(p) {
  const ip = String(p.ip || '').trim().replace(/^\[|\]$/g, '');
  if (!net.isIP(ip)) return Promise.resolve({ ip, ok: false, err: 'IP 无效' });
  let u;
  try { u = new URL(p.url || 'https://speed.cloudflare.com/__down?bytes=50000000'); } catch { return Promise.resolve({ ip, ok: false, err: '测速地址无效' }); }
  const isHttps = u.protocol === 'https:';
  const port = +u.port || (isHttps ? 443 : 80);
  const seconds = Math.max(2, Math.min(15, +p.seconds || 4));
  const timeout = Math.max(2000, Math.min(15000, +p.timeout || 6000));
  const BUCKET = 200;
  return new Promise(resolve => {
    const t0 = msNow();
    let sock = null, done = false, head = EMPTY, headDone = false, status = 0, ctype = '', colo = '', errBody = null, firstT = 0, bytes = 0, firstBytes = 0, lastT = 0, retryAfter = 0, plateau = false, bestWin = 0, bestK = -1;
    const maxBytes = Math.max(0, +p.maxBytes || 0);
    const usePlateau = p.plateau !== false;
    const buckets = new Map();
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(connTimer); clearTimeout(stopTimer);
      try { sock && sock.destroy(); } catch {}
      const secs = Math.max(0.001, (lastT - firstT) / 1000);
      const avg = bytes > firstBytes ? (bytes - firstBytes) / secs : 0;
      // 1 秒滑动窗口峰值（5 个 200ms 桶）
      let peak = 0;
      const keys = [...buckets.keys()].sort((a, b) => a - b);
      if (keys.length) {
        const k0 = keys[0], k1 = keys[keys.length - 1];
        const win = Math.round(1000 / BUCKET);
        if (k1 - k0 + 1 < win) peak = avg;
        else for (let k = k0; k + win - 1 <= k1; k++) { let sum = 0; for (let j = 0; j < win; j++) sum += buckets.get(k + j) || 0; peak = Math.max(peak, sum); }
      }
      const ok = bytes > 0 && status >= 200 && status < 400;
      const e = ok ? '' : (err || (status ? 'HTTP ' + status : '无数据'));
      // 限流判定：429、Cloudflare 1015、无错误码的 403（官方测速接口对“非浏览器”大文件请求会直接 403）
      const cfcode = (/错误 (\d{4})/.exec(e) || [])[1] || '';
      const limited = !ok && (status === 429 || cfcode === '1015' || (status === 403 && !cfcode));
      resolve({ ip, ok, status, ctype, bytes, avg: Math.round(avg), peak: Math.round(Math.max(peak, ok ? avg : 0)), ttfb: firstT ? Math.round(firstT - t0) : 0, secs: +secs.toFixed(2), colo, err: e, limited, retryAfter, cfcode, plateau });
    };
    const connTimer = setTimeout(() => finish('连接超时'), timeout);
    const stopTimer = setTimeout(() => finish(''), timeout + seconds * 1000);
    const opts = { host: ip, port };
    sock = isHttps ? tls.connect({ ...opts, servername: u.hostname, ALPNProtocols: ['http/1.1'], rejectUnauthorized: !p.insecure, minVersion: 'TLSv1.2' }) : net.connect(opts);
    sock.setNoDelay(true);
    sock.once(isHttps ? 'secureConnect' : 'connect', () => {
      sock.write(`GET ${u.pathname + u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: ${UA}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', d => {
      const t = msNow();
      if (errBody) { errBody = Buffer.concat([errBody, d]).subarray(0, 512); if (errBody.length >= 64) finish(httpErr(status, errBody)); return; }
      if (!headDone) {
        head = head.length ? (d.length ? Buffer.concat([head, d]) : head) : d;
        const i = head.indexOf('\r\n\r\n');
        if (i < 0) { if (head.length > 32768) finish('响应头过大'); return; }
        const h = head.subarray(0, i).toString('latin1');
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(h);
        status = m ? +m[1] : 0;
        // 跳过 1xx 临时响应（如 103 Early Hints），继续解析真正的响应头
        if (status >= 100 && status < 200) { head = head.subarray(i + 4); status = 0; if (head.length) sock.emit('data', EMPTY); return; }
        headDone = true;
        clearTimeout(connTimer);
        const ct = /\r\ncontent-type:\s*([^\r\n;]+)/i.exec(h);
        ctype = ct ? ct[1].trim().toLowerCase() : '';
        const ray = /\r\ncf-ray:\s*([^\r\n]+)/i.exec(h);
        if (ray) colo = (ray[1].split('-').pop() || '').trim().toUpperCase();
        retryAfter = parseRetryAfter((/\r\nretry-after:\s*([^\r\n]+)/i.exec(h) || [])[1]);
        if (status < 200 || status >= 400) {
          // 读取一小段错误内容（Cloudflare 会返回 error code: 1034 之类），给出可读原因
          errBody = head.subarray(i + 4);
          head = EMPTY;
          if (errBody.length >= 64) return finish(httpErr(status, errBody));
          setTimeout(() => finish(httpErr(status, errBody)), 1200).unref();
          return;
        }
        if (/^text\/html/.test(ctype)) { status = 0; return finish('测速地址返回的是网页，不是测速数据'); }
        d = head.subarray(i + 4);
        head = EMPTY;
        clearTimeout(stopTimer);
        setTimeout(() => finish(''), seconds * 1000).unref();
        if (!d.length) return;
      }
      if (!firstT) { firstT = t; firstBytes = d.length; }
      bytes += d.length;
      lastT = t;
      const k = Math.floor((t - firstT) / BUCKET);
      buckets.set(k, (buckets.get(k) || 0) + d.length);
      if (maxBytes && bytes >= maxBytes) return finish('');
      // 峰值已稳定就提前结束（省流量、少占用测速接口）：至少 1.6 秒数据，且 1 秒窗口峰值已有 0.8 秒没有再提高（>3%）
      if (usePlateau && k >= 1) {
        const win = Math.round(1000 / BUCKET);
        const kc = k - 1; // 只看已经完整的桶
        if (kc >= win - 1) {
          let sum = 0; for (let j = 0; j < win; j++) sum += buckets.get(kc - j) || 0;
          if (sum > bestWin * 1.03) { bestWin = sum; bestK = kc; }
          if (t - firstT >= 1600 && bestK >= 0 && kc - bestK >= 4) { plateau = true; return finish(''); }
        }
      }
    });
    sock.on('error', e => finish(friendlyErr(e).message));
    sock.on('close', () => finish(errBody ? httpErr(status, errBody) : ''));
  });
}
function parseRetryAfter(v) {
  if (!v) return 0;
  v = String(v).trim();
  if (/^\d+$/.test(v)) return Math.min(86400, +v);
  const t = Date.parse(v);
  return isFinite(t) ? Math.max(0, Math.min(86400, Math.round((t - Date.now()) / 1000))) : 0;
}
const CF_ERR = { 1015: '请求过于频繁，已被限流', 1003: '不允许直接用 IP 访问', 1010: '浏览器特征被拦截', 1016: '源站 DNS 错误', 1020: '被防火墙规则拦截', 1034: '该域名不能经此 IP 访问，或该地址不是测速地址' };
function httpErr(status, body) {
  const m = /error code:\s*(\d{4})/i.exec(String(body || ''));
  return `HTTP ${status}` + (m ? `（Cloudflare 错误 ${m[1]}${CF_ERR[m[1]] ? '：' + CF_ERR[m[1]] : ''}）` : '');
}

// 用真实节点（SNI/Host/路径/UUID）经指定 IP 完成 WebSocket 握手，确认该 IP 能用于该节点
async function ipVerify(p) {
  const route = normRoute(p.route);
  const ips = (Array.isArray(p.ips) ? p.ips : []).map(x => String(x).trim()).filter(x => net.isIP(x)).slice(0, 64);
  const timeout = Math.max(1500, Math.min(10000, +p.timeout || 5000));
  return runPool(ips, Math.max(1, Math.min(8, +p.concurrency || 4)), async ip => {
    const r = { ...route, address: ip };
    delete r.addrs;
    const ob = createOutbound(r, 'www.gstatic.com', 443, EMPTY);
    const t0 = msNow();
    try {
      await ob.start(timeout);
      const ms = Math.round(msNow() - t0);
      ob.destroy();
      return { ip, ok: true, ms };
    } catch (e) {
      return { ip, ok: false, err: friendlyErr(e).message };
    }
  });
}

function fetchDirect(url, { timeout = 15000, ua = 'v2rayN/7.10.0', maxBytes = 8 << 20 } = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('地址无效')); }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) return reject(new Error('仅支持 http/https'));
    const req = mod.get(u, { headers: { 'User-Agent': ua, Accept: '*/*', 'Accept-Encoding': 'identity' }, timeout }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 4) {
        res.resume();
        return resolve(fetchDirect(new URL(res.headers.location, u).href, { timeout, ua, maxBytes }, depth + 1));
      }
      const parts = [];
      let n = 0;
      res.on('data', c => { n += c.length; if (n > maxBytes) { req.destroy(new Error('内容过大')); return; } parts.push(c); });
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, text: Buffer.concat(parts).toString('utf8'), via: 'direct' }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { friendly: true })));
    req.on('error', e => reject(friendlyErr(e)));
  });
}

async function fetchText(p) {
  const url = String(p.url || '');
  const timeout = +p.timeout || 15000;
  const ua = p.ua || 'v2rayN/7.10.0';
  const tryVia = async () => {
    const route = p.route ? normRoute(p.route) : ROUTES[0];
    if (!route) throw new Error('没有可用线路');
    let target = url;
    for (let i = 0; i < 4; i++) {
      const r = await requestVia(route, target, { timeout, maxBody: 8 << 20, headers: { 'user-agent': ua } });
      const res = r.results[0];
      if (res.status >= 300 && res.status < 400 && res.headers.location) { target = new URL(res.headers.location, target).href; continue; }
      return { ok: res.status < 400, status: res.status, text: res.body.toString('utf8'), via: 'tunnel' };
    }
    throw new Error('重定向过多');
  };
  if (p.via === 'tunnel') return tryVia();
  try {
    const r = await fetchDirect(url, { timeout, ua });
    if (r.ok || p.via === 'direct') return r;
    throw new Error('HTTP ' + r.status);
  } catch (e) {
    if (p.via === 'direct' || (!ROUTES.length && !p.route)) throw friendlyErr(e);
    log('info', `直连获取失败（${friendlyErr(e).message}），改经隧道获取：${url.slice(0, 80)}`);
    return tryVia();
  }
}

// ───────────────────────────── RPC ─────────────────────────────
function hello() {
  return { name: 'brana-core', version: VERSION, features: FEATURES, pid: process.pid, port: PORT, node: process.version, platform: process.platform, native: NATIVE, startedAt: STARTED };
}
function status() {
  const routes = {};
  for (const r of ROUTES) { const s = routeStat(r.key); routes[r.key] = { ok: s.ok, fail: s.fail, consec: s.consec, err: s.err, lastOk: s.lastOk, lastFail: s.lastFail, down: s.down > Date.now() ? s.down : 0, ms: s.ms }; }
  return {
    ...hello(),
    uptime: Math.round((Date.now() - STARTED) / 1000),
    active: ROUTES[0] ? ROUTES[0].key : '',
    routes: ROUTES.map(r => r.key),
    routeStats: routes,
    conns: STATS.active,
    total: STATS.total,
    up: STATS.up,
    down: STATS.down,
    rateUp: STATS.rateUp,
    rateDown: STATS.rateDown,
    failovers: STATS.failovers,
    direct: STATS.direct,
    failed: STATS.failed,
    cfg: { directFallback: CFG.directFallback, strict: CFG.strict },
    addrStats: addrStatsOf(ROUTES[0]),
  };
}
function addrStatsOf(route) {
  if (!route || !route.addrs) return null;
  const t = Date.now();
  return route.addrs.map((a, i) => { const s = addrStat(akeyOf(route, a)); return { addr: a, main: i < route.addrsMain, ok: s.ok, fail: s.fail, ms: s.ms, down: s.down > t ? s.down : 0, err: s.err, act: s.act || 0, bytes: s.bytes || 0, last: s.lastOk || 0 }; });
}

function apply(p) {
  const list = [];
  const errors = [];
  for (const r of (Array.isArray(p.routes) ? p.routes : []).slice(0, 16)) {
    try { const n = normRoute(r); if (n.kind !== 'direct') list.push(n); } catch (e) { errors.push(`${(r && (r.name || r.key)) || '线路'}：${e.message}`); }
  }
  const prevKey = ROUTES[0] ? ROUTES[0].key : '';
  ROUTES = list;
  if (typeof p.directFallback === 'boolean') CFG.directFallback = p.directFallback;
  if (typeof p.strict === 'boolean') CFG.strict = p.strict;
  if (+p.connectTimeout >= 2000) CFG.connectTimeout = Math.min(20000, +p.connectTimeout);
  if (+p.firstByteTimeout >= 2000) CFG.firstByteTimeout = Math.min(20000, +p.firstByteTimeout);
  for (const r of list) { const s = routeStat(r.key); if (p.resetStats) { s.consec = 0; s.down = 0; } }
  // 清理已不再使用的优选 IP 统计
  const keep = new Set();
  for (const r of list) for (const a of r.addrs || []) keep.add(akeyOf(r, a));
  for (const k of [...ASTAT.keys()]) if (!keep.has(k)) ASTAT.delete(k);
  const multi = list.find(r => r.addrs && r.addrs.length > 1);
  const msig = multi ? multi.key + '#' + multi.addrs.join(',') : '';
  if (multi && msig !== lastMultiSig) log('info', `优选 IP：${multi.name || multi.key} 使用 ${multi.addrsMain} 个主用 + ${multi.addrs.length - multi.addrsMain} 个备用地址（${multi.addrs.slice(0, multi.addrsMain).join('，')}）`);
  lastMultiSig = msig;
  if (p.reset) closeAllSessions();
  const newKey = list[0] ? list[0].key : '';
  if (newKey !== prevKey) log('info', list[0] ? `已应用主线路：${list[0].name || list[0].key}（备用 ${list.length - 1} 条）` : '已清空线路（直通模式）');
  return { ok: true, count: list.length, errors, port: PORT };
}

let lastMultiSig = '';
function safeRoute(r) {
  try { return normRoute(r); } catch (e) { return { key: (r && r.key) || '', invalid: friendlyErr(e).message }; }
}

let SUBSCRIBED = false;
async function rpc(method, p) {
  p = p || {};
  switch (method) {
    case 'hello': return hello();
    case 'status': return status();
    case 'apply': return apply(p);
    case 'probe': {
      const routes = (p.routes || []).slice(0, 96).map(safeRoute);
      return runPool(routes, Math.max(1, Math.min(12, +p.concurrency || 6)), r => r.invalid ? { key: r.key, ok: false, err: r.invalid } : probeRoute(r, p));
    }
    case 'speed': return speedRoute(normRoute(p.route), p);
    case 'trace': return traceRoute(normRoute(p.route), p);
    case 'tcping': {
      const list = (p.targets || []).slice(0, 256);
      return runPool(list, Math.max(1, Math.min(48, +p.concurrency || 16)), t => { const { host, port } = splitHostPort(t, 443); return tcping(host, port, +p.timeout || 2000).then(r => ({ target: t, ...r })); });
    }
    case 'resolve': return resolveHosts(Array.isArray(p.hosts) ? p.hosts : []);
    case 'scan': return scanCf(normRoute(p.route), p);
    case 'netcaps': return netCaps(p);
    case 'ipping': return ipPing(p);
    case 'ipspeed': return ipSpeed(p);
    case 'ipverify': return ipVerify(p);
    case 'fetch': return fetchText(p);
    case 'logs': return LOGS.slice(-Math.max(1, Math.min(500, +p.limit || 200)));
    case 'subscribe': SUBSCRIBED = !!p.on; return true;
    case 'reset': closeAllSessions(); return true;
    case 'quit': setTimeout(() => process.exit(0), 80); return true;
    default: throw new Error('未知方法：' + method);
  }
}

// ───────────────────────────── Native Messaging ─────────────────────────────
function nativeSend(obj) {
  if (!NATIVE) return;
  try {
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    if (json.length > 1000 * 1024) return nativeSend({ id: obj.id, ok: false, error: '响应过大' });
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(json.length, 0);
    process.stdout.write(Buffer.concat([hdr, json]));
  } catch {}
}
function emitEvent(event, data) { if (NATIVE) nativeSend({ event, data }); }

function startNative() {
  let buf = EMPTY;
  process.stdin.on('data', chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > 64 << 20) { process.exit(1); }
      if (buf.length < 4 + len) break;
      const raw = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { continue; }
      if (!msg || typeof msg !== 'object') continue;
      Promise.resolve()
        .then(() => rpc(msg.method, msg.params))
        .then(result => nativeSend({ id: msg.id, ok: true, result }), e => nativeSend({ id: msg.id, ok: false, error: friendlyErr(e).message }));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  setInterval(() => { if (SUBSCRIBED) nativeSend({ event: 'stats', data: status() }); }, 2000).unref();
  nativeSend({ event: 'ready', data: hello() });
}

// ───────────────────────────── 启动 ─────────────────────────────
function localRequest(port, method, path, body) {
  return new Promise(resolve => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path, timeout: 1500, headers: { Host: `127.0.0.1:${port}`, 'x-brana-local': '1', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    if (data) req.write(data);
    req.end();
  });
}

function bind(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = e => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, LISTEN_HOST);
  });
}

async function listen(server) {
  const base = PORT;
  for (let attempt = 0; attempt < 14; attempt++) {
    try { await bind(server, PORT); return; } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      const other = await localRequest(PORT, 'GET', '/__brana/hello');
      if (other && other.ok && other.result && other.result.name === 'brana-core') {
        if (NATIVE) {
          // 由浏览器托管的核心优先：请旧实例退出后接管端口
          await localRequest(PORT, 'POST', '/__brana/rpc', { method: 'quit' });
          await sleep(500);
          continue;
        }
        log('warn', `端口 ${PORT} 上已有 Brana 核心在运行（v${other.result.version}），无需重复启动。`);
        process.exit(0);
      }
      if (attempt < 2) { await sleep(400); continue; }
      PORT = PORT + 1;
      if (PORT > base + 10) throw e;
    }
  }
  throw new Error('无法监听端口');
}

process.on('uncaughtException', e => log('error', '未捕获异常：' + ((e && e.stack) || e)));
process.on('unhandledRejection', e => log('error', '未处理的 Promise：' + ((e && e.stack) || e)));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));


// ───────────── 安装 / 卸载（Native Messaging 注册，仅当前用户，无需管理员）─────────────
const HOST_NAME = 'com.brana.vpn';
const DEFAULT_EXT_ID = 'jdnojnkpdjoijmgipheghikkkpmnaaao';
const WIN_BROWSERS = ['Google\\Chrome', 'Google\\Chrome Beta', 'Google\\Chrome Dev', 'Google\\Chrome SxS', 'Chromium', 'Microsoft\\Edge', 'Microsoft\\Edge Beta', 'Microsoft\\Edge Dev', 'BraveSoftware\\Brave-Browser', 'Vivaldi'];
const MAC_BROWSERS = ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary', 'Chromium', 'Microsoft Edge', 'Microsoft Edge Beta', 'Microsoft Edge Dev', 'BraveSoftware/Brave-Browser', 'Vivaldi', 'Arc/User Data'];
const LINUX_BROWSERS = ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev', 'BraveSoftware/Brave-Browser', 'vivaldi'];

function installPlan(extId, dirArg) {
  const os = require('os');
  const path = require('path');
  const home = os.homedir();
  const plat = process.platform;
  const dir = dirArg || process.env.BRANA_INSTALL_DIR || (plat === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'BranaVPN')
    : plat === 'darwin' ? path.join(home, 'Library', 'Application Support', 'BranaVPN')
      : path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'brana-vpn'));
  const host = path.join(dir, plat === 'win32' ? 'brana-core-host.bat' : 'brana-core-host.sh');
  const manifest = { name: HOST_NAME, description: 'Brana VPN Core', path: host, type: 'stdio', allowed_origins: [`chrome-extension://${extId}/`] };
  let targets;
  if (plat === 'win32') targets = WIN_BROWSERS.map(b => `HKCU\\Software\\${b}\\NativeMessagingHosts\\${HOST_NAME}`);
  else {
    const base = plat === 'darwin' ? path.join(home, 'Library', 'Application Support') : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
    const list = (plat === 'darwin' ? MAC_BROWSERS : LINUX_BROWSERS).map(b => path.join(base, b));
    const fs = require('fs');
    const present = list.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    targets = (present.length ? present : [list[0]]).map(d => path.join(d, 'NativeMessagingHosts', HOST_NAME + '.json'));
  }
  return { plat, dir, core: path.join(dir, 'brana-core.js'), host, manifestFile: path.join(dir, HOST_NAME + '.json'), manifest, targets };
}

// .bat 由 cmd 按系统代码页读取：Node 路径含中文等字符时改用 8.3 短路径，保证可执行
function winSafePath(p) {
  if (/^[\x20-\x7e]+$/.test(p)) return p;
  try {
    const out = require('child_process').execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { windowsVerbatimArguments: true, encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    if (out && /^[\x20-\x7e]+$/.test(out)) return out;
  } catch {}
  return p;
}

function cliInstall({ uninstall = false, dry = false, extId = DEFAULT_EXT_ID, dir = '' } = {}) {
  const fs = require('fs');
  const path = require('path');
  const cp = require('child_process');
  const P = installPlan(extId, dir);
  const say = (mark, text) => process.stdout.write(`  ${mark} ${text}\n`);
  const act = (desc, fn) => { if (dry) { say('[dry-run]', desc); return true; } fn(); return true; };
  const same = (a, b) => (P.plat === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  try {
    if (uninstall) {
      if (P.plat === 'win32') {
        for (const k of P.targets) act(`reg delete "${k}" /f`, () => { try { cp.execFileSync('reg', ['delete', k, '/f'], { stdio: 'ignore', windowsHide: true }); } catch {} });
      } else {
        for (const f of P.targets) act(`删除 ${f}`, () => { try { fs.unlinkSync(f); } catch {} });
      }
      for (const f of [P.manifestFile, P.host, P.core]) act(`删除 ${f}`, () => { try { fs.unlinkSync(f); } catch {} });
      act(`删除目录 ${P.dir}（如已为空）`, () => { try { fs.rmdirSync(P.dir); } catch {} });
      say('[√]', '已卸载 Brana VPN 本地核心');
      return 0;
    }
    const node = process.execPath;
    say('[√]', `Node.js ${process.version}  (${node})`);
    act(`创建目录 ${P.dir}`, () => fs.mkdirSync(P.dir, { recursive: true }));
    if (!same(__filename, P.core)) act(`复制核心 → ${P.core}`, () => fs.copyFileSync(__filename, P.core));
    if (P.plat === 'win32') {
      const nodeBat = winSafePath(node);
      const bat = `@echo off\r\n"${nodeBat}" "%~dp0brana-core.js" %*\r\n`;
      act(`写入启动器 ${P.host}`, () => fs.writeFileSync(P.host, /^[\x00-\x7e]*$/.test(bat) ? bat : '@echo off\r\nchcp 65001 >nul\r\n' + bat.slice(11)));
    } else {
      const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
      act(`写入启动器 ${P.host}`, () => { fs.writeFileSync(P.host, `#!/bin/sh\nexec ${q(node)} ${q(P.core)} "$@"\n`); fs.chmodSync(P.host, 0o755); });
    }
    const json = JSON.stringify(P.manifest, null, 2) + '\n';
    act(`写入宿主清单 ${P.manifestFile}`, () => fs.writeFileSync(P.manifestFile, json));
    let ok = 0;
    if (P.plat === 'win32') {
      for (const k of P.targets) {
        act(`reg add "${k}" /ve /d "${P.manifestFile}" /f`, () => { try { cp.execFileSync('reg', ['add', k, '/ve', '/t', 'REG_SZ', '/d', P.manifestFile, '/f'], { stdio: 'ignore', windowsHide: true }); ok++; } catch {} });
      }
      if (!dry && !ok) throw new Error('写入注册表失败');
    } else {
      for (const f of P.targets) act(`写入 ${f}`, () => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, json); ok++; });
    }
    say('[√]', `已注册浏览器：${P.plat === 'win32' ? 'Chrome / Edge / Brave / Chromium / Vivaldi' : P.targets.map(t => path.basename(path.dirname(path.dirname(t)))).join(' / ')}`);
    if (!dry) {
      // 自检：经启动器运行核心（--version），验证 Node 路径、启动器与核心文件都正常
      const out = P.plat === 'win32'
        ? cp.execFileSync('cmd.exe', ['/d', '/s', '/c', `""${P.host}" --version"`], { windowsVerbatimArguments: true, encoding: 'utf8', windowsHide: true, timeout: 15000 })
        : cp.execFileSync(P.host, ['--version'], { encoding: 'utf8', timeout: 15000 });
      if (String(out).trim() !== VERSION) throw new Error('核心自检失败：' + String(out).trim().slice(0, 200));
      say('[√]', `核心 v${VERSION} 自检通过 → ${P.dir}`);
    }
    say('[√]', `扩展 ID：${extId}`);
    return 0;
  } catch (e) {
    say('[x]', (uninstall ? '卸载' : '安装') + '失败：' + (e && e.message || e));
    return 1;
  }
}

async function main() {
  if (ARGV.includes('--version')) { process.stdout.write(VERSION + '\n'); return; }
  if (ARGV.includes('--install') || ARGV.includes('--uninstall')) {
    const extId = ARGV.find(a => /^[a-p]{32}$/.test(a)) || DEFAULT_EXT_ID;
    process.exitCode = cliInstall({ uninstall: ARGV.includes('--uninstall'), dry: ARGV.includes('--dry-run'), extId, dir: argOf('dir', '') });
    return;
  }
  const server = net.createServer(onInbound);
  server.maxConnections = 4096;
  try {
    await listen(server);
  } catch (e) {
    log('error', '启动失败：' + e.message);
    if (NATIVE) { startNative(); nativeSend({ event: 'fatal', data: { error: '无法监听本地端口：' + e.message } }); return; }
    process.exit(1);
  }
  if (NATIVE) {
    startNative();
  } else {
    const line = '─'.repeat(54);
    process.stdout.write(`\n${line}\n  Brana VPN Core v${VERSION} 已启动（手动模式）\n  本地代理：127.0.0.1:${PORT}（SOCKS5 / HTTP 混合端口）\n  浏览器扩展会自动连接本核心，请保持此窗口开启。\n  按 Ctrl+C 退出。\n${line}\n\n`);
  }
}

if (require.main === module) main();
module.exports = { normRoute, uniTarget, vlessHeader, trojanHeader, socksAddr, ipv6Bytes, splitHostPort, randomCfIps, parseTrace, rpc, VERSION };
