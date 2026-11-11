// 本地核心客户端：优先 Native Messaging（扩展自动拉起核心），否则连接手动启动的核心（HTTP 127.0.0.1）
export const HOST_NAME = 'com.brana.vpn';

async function fetchJson(url, body, timeout) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal, cache: 'no-store' } : { signal: ctl.signal, cache: 'no-store' });
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

class CoreClient {
  constructor() {
    this.via = '';
    this.port = 0;
    this.info = null;
    this.native = null;
    this.pending = new Map();
    this.seq = 0;
    this.lastErr = '';
    this.installed = null;   // null 未知；true 已注册原生宿主；false 未注册
    this.handlers = new Map();
    this.connecting = null;
  }
  on(ev, fn) { if (!this.handlers.has(ev)) this.handlers.set(ev, new Set()); this.handlers.get(ev).add(fn); }
  emit(ev, data) { for (const fn of this.handlers.get(ev) || []) { try { fn(data); } catch {} } }
  get up() { return !!this.via; }

  async ensure({ native = true, port = 17890 } = {}) {
    if (this.via === 'native' && this.native) return true;
    if (this.via === 'http') { if (await this.ping()) return true; this.via = ''; }
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        if (native && await this.tryNative(4500)) return true;
        if (await this.tryHttp(port)) return true;
        this.via = '';
        return false;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  tryNative(timeout) {
    return new Promise(resolve => {
      let port;
      try { port = chrome.runtime.connectNative(HOST_NAME); } catch (e) { this.lastErr = e.message; this.installed = false; return resolve(false); }
      let settled = false;
      const done = ok => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
      const timer = setTimeout(() => { this.lastErr = '核心启动超时'; try { port.disconnect(); } catch {} done(false); }, timeout);
      port.onMessage.addListener(msg => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.event === 'ready') {
          this.native = port;
          this.via = 'native';
          this.info = msg.data;
          this.port = msg.data.port;
          this.installed = true;
          this.lastErr = '';
          done(true);
          this.emit('up', msg.data);
          return;
        }
        if (msg.event === 'fatal') { this.lastErr = msg.data?.error || '核心启动失败'; this.installed = true; done(false); return; }
        this.onMessage(msg);
      });
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError?.message || '核心进程已退出';
        if (/not found|未找到/i.test(err)) this.installed = false;
        else if (/forbidden/i.test(err)) { this.installed = true; }
        else this.installed = this.installed ?? true;
        this.lastErr = err;
        for (const p of this.pending.values()) p.reject(new Error('核心已断开'));
        this.pending.clear();
        if (this.native === port) { this.native = null; this.via = ''; this.emit('down', err); }
        done(false);
      });
    });
  }

  async tryHttp(port) {
    for (const p of [port, port + 1, port + 2]) {
      const r = await fetchJson(`http://127.0.0.1:${p}/__brana/hello`, null, 1200);
      if (r && r.ok && r.result && r.result.name === 'brana-core') {
        this.via = 'http';
        this.port = r.result.port;
        this.info = r.result;
        this.lastErr = '';
        this.emit('up', r.result);
        return true;
      }
    }
    if (!this.lastErr) this.lastErr = '未检测到本地核心';
    return false;
  }

  async ping() {
    const r = await fetchJson(`http://127.0.0.1:${this.port}/__brana/hello`, null, 1500);
    return !!(r && r.ok);
  }

  onMessage(msg) {
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || '核心错误'));
      return;
    }
    if (msg.event) this.emit(msg.event, msg.data);
  }

  call(method, params = {}, timeout = 30000) {
    if (this.via === 'native' && this.native) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { this.pending.delete(id); reject(new Error('核心响应超时')); }, timeout);
        this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
        try { this.native.postMessage({ id, method, params }); } catch (e) { this.pending.delete(id); clearTimeout(t); reject(e); }
      });
    }
    if (this.via === 'http') {
      return fetchJson(`http://127.0.0.1:${this.port}/__brana/rpc`, { method, params }, timeout).then(r => {
        if (!r) { this.via = ''; this.emit('down', '核心未响应'); throw new Error('本地核心未响应'); }
        if (!r.ok) throw new Error(r.error || '核心错误');
        return r.result;
      });
    }
    return Promise.reject(new Error('本地核心未运行'));
  }

  disconnect() {
    if (this.native) { try { this.native.disconnect(); } catch {} }
    this.native = null;
    this.via = '';
  }
}

export const Core = new CoreClient();
