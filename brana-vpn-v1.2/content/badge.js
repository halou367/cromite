// Brana VPN · 网页右下角悬浮胶囊（可在设置中开启）。Shadow DOM 隔离，不影响网页样式。
(() => {
  if (window.top !== window || window.__branaBadge) return;
  window.__branaBadge = true;
  const FLAG = cc => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(127397 + cc.charCodeAt(0), 127397 + cc.charCodeAt(1)) : '🌐');
  let host = null, root = null, pill = null, menu = null, state = null, hidden = false, busy = false;

  const css = `
  @font-face { font-family: "BranaFlags"; src: url("${chrome.runtime.getURL('shared/flags.woff2')}") format("woff2"); unicode-range: U+1F1E6-1F1FF; }
  :host { all: initial; }
  .wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; font: 12px/1.3 "BranaFlags", -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #e8edf7; }
  .pill { display: flex; align-items: center; gap: 7px; height: 30px; padding: 0 6px 0 10px; border-radius: 999px; background: rgba(11, 18, 34, .86); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 10px 28px rgba(0,0,0,.35); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); cursor: pointer; user-select: none; transition: transform .25s cubic-bezier(.34,1.56,.64,1), border-color .2s, opacity .3s; animation: in .45s cubic-bezier(.34,1.56,.64,1); }
  .pill:hover { transform: translateY(-2px); border-color: rgba(99,102,241,.6); }
  @keyframes in { from { opacity: 0; transform: translateY(12px) scale(.9); } to { opacity: 1; transform: none; } }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.2); }
  .dot.warn { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.22); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .4; } }
  .flag { font-size: 15px; line-height: 1; }
  .ip { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-weight: 600; }
  .ms { color: #4ade80; font-weight: 700; font-family: ui-monospace, Consolas, monospace; }
  .ms.mid { color: #fbbf24; } .ms.bad { color: #fb7185; }
  .btn { width: 22px; height: 22px; border-radius: 50%; border: 0; display: grid; place-items: center; background: rgba(255,255,255,.08); color: #cbd5e1; cursor: pointer; padding: 0; transition: background .2s, transform .2s; }
  .btn:hover { background: rgba(99,102,241,.45); color: #fff; }
  .btn.spin svg { animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .menu { position: absolute; right: 0; bottom: 38px; min-width: 168px; padding: 5px; border-radius: 12px; background: rgba(15, 23, 42, .96); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 16px 40px rgba(0,0,0,.45); animation: in .25s cubic-bezier(.34,1.56,.64,1); }
  .menu button { width: 100%; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: #e8edf7; font: inherit; cursor: pointer; text-align: left; }
  .menu button:hover { background: rgba(255,255,255,.08); }
  .menu .sep { height: 1px; margin: 4px 6px; background: rgba(255,255,255,.08); }
  .menu .meta { padding: 6px 10px 4px; color: #94a3b8; font-size: 11px; }
  `;
  const rot = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.36-6.36L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.36 6.36L3 16"/><path d="M3 21v-5h5"/></svg>';

  function ensure() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('brana-badge');
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = css;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    pill = document.createElement('div');
    pill.className = 'pill';
    pill.addEventListener('click', e => { if (e.target.closest('.btn')) return; toggleMenu(); });
    wrap.append(pill);
    root.append(style, wrap);
    (document.body || document.documentElement).append(host);
  }

  const send = cmd => new Promise(res => { try { chrome.runtime.sendMessage({ cmd }, r => { void chrome.runtime.lastError; res(r); }); } catch { res(null); } });

  function render() {
    if (hidden || !state || state.status === 'off' || state.status === 'connecting' && !state.ip) { if (host) host.remove(); host = null; return; }
    ensure();
    const warn = state.status !== 'on';
    const ms = state.ms || 0;
    pill.innerHTML = '';
    const dot = document.createElement('span'); dot.className = 'dot' + (warn ? ' warn' : '');
    const fl = document.createElement('span'); fl.className = 'flag'; fl.textContent = state.status === 'degraded' ? '🛟' : FLAG(state.cc);
    const ip = document.createElement('span'); ip.className = 'ip'; ip.textContent = state.status === 'degraded' ? '直连' : state.status === 'switching' ? '切换中…' : (state.ip || '检测中');
    const m = document.createElement('span'); m.className = 'ms' + (ms > 900 ? ' bad' : ms > 450 ? ' mid' : ''); m.textContent = ms && state.status === 'on' ? ms + 'ms' : '';
    const b = document.createElement('button'); b.className = 'btn' + (busy ? ' spin' : ''); b.title = '换 IP'; b.innerHTML = rot;
    b.addEventListener('click', async e => { e.stopPropagation(); if (busy) return; busy = true; render(); await send('nextIp'); busy = false; render(); });
    pill.append(dot, fl, ip, m, b);
    pill.title = 'Brana VPN · ' + (state.name || '') + (state.pip ? ' · ' + state.pip : '');
  }

  function toggleMenu() {
    if (menu) { menu.remove(); menu = null; return; }
    menu = document.createElement('div');
    menu.className = 'menu';
    const item = (label, fn) => { const x = document.createElement('button'); x.textContent = label; x.addEventListener('click', async e => { e.stopPropagation(); menu?.remove(); menu = null; await fn(); }); return x; };
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${state?.name || ''}${state?.pip ? ' · ' + state.pip : ''}`;
    const sep = () => { const s = document.createElement('div'); s.className = 'sep'; return s; };
    menu.append(meta, item('⚡ 一键优选', () => send('optimize')), item('🔄 更换出口 IP', () => send('nextIp')), item('🧭 打开控制面板', () => send('openPopupOrOptions')), sep(), item('🙈 本页隐藏', () => { hidden = true; render(); }));
    pill.parentElement.append(menu);
    setTimeout(() => document.addEventListener('mousedown', function off(ev) { if (!host || !ev.composedPath().includes(host)) { menu?.remove(); menu = null; document.removeEventListener('mousedown', off, true); } }, true), 0);
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'brana-state') { state = msg.state; render(); }
    if (msg?.type === 'brana-badge-off') { hidden = true; render(); }
  });
  send('badgeState').then(r => { if (r?.ok) { state = r.data; render(); } });
})();
