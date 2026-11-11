// 本地核心「一键安装」组件（设置向导第 1 步 与 控制中心 › 核心 共用）
// 状态：检测中 → 已就绪 / 未安装 →（点击一键安装）等待安装完成（自动轮询，装好立即识别）
import { h, icon, tip, rpc, toast, copyText, platformOs, downloadInstaller, INSTALLER } from './ui.js';

// 扩展自带的核心版本（与 core/brana-core.js 的 VERSION 保持一致）
export const CORE_LATEST = '1.2.0';
export const verLt = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };

const T = {
  why: 'Chrome 只能直接使用 HTTP / SOCKS 代理。\n本地核心在本机 127.0.0.1 把浏览器流量转成 VLESS / Trojan。\n只装一次，之后随浏览器自动启动、自动退出。',
  allow: 'Chrome 提示「可能有害」→ 点「保留」。\nWindows 提示「无法验证发布者」→ 点「运行」；\n提示「已保护你的电脑」→「更多信息」→「仍要运行」。\n脚本只写入当前用户目录与浏览器注册项，可用记事本打开查看。',
  node: '核心基于 Node.js 运行。\n电脑上没有 Node.js 时，安装脚本会用 winget 自动安装（可能弹出权限确认，点「是」）。',
  folder: '也可以打开你加载的 brana-vpn 文件夹，\n双击 core 里的 install-windows.cmd —— 效果相同，且不会出现下载提示。',
  unix: '下载后在「终端」运行这条命令即可（仅当前用户，无需 sudo）。\n需要 Node.js 16+：macOS 可 brew install node。',
};

export function coreSetup({ getCore, onReady, autoCheck = true } = {}) {
  const el = h('div', { class: 'cs' });
  let os = 'win';
  let phase = 'check';        // check | ready | missing | waiting | broken
  let timer = 0, checking = false, readyFired = false, lastSig = '';

  const core = () => (getCore && getCore()) || {};
  const sync = () => {
    const c = core();
    if (c.up) { phase = 'ready'; stop(); if (!readyFired) { readyFired = true; onReady?.(c); } }
    else if (phase === 'ready') phase = c.installed === false ? 'missing' : 'broken';
    else if (phase === 'check' && c.installed === false) phase = 'missing';
    render();
  };

  async function check(force = false, quiet = true) {
    if (checking) return;
    checking = true;
    try {
      const c = await rpc('coreCheck', force ? { force: true } : {});
      if (c.up) { phase = 'ready'; }
      else if (phase !== 'waiting') phase = c.installed === false ? 'missing' : (c.installed ? 'broken' : 'missing');
      if (!quiet && !c.up) toast(c.installed === false ? '还没检测到核心' : (c.err || '核心未运行'), 'warn', 2600);
    } catch (e) { if (!quiet) toast(e.message, 'err'); }
    checking = false;
    sync();
  }
  function poll() { stop(); timer = setInterval(() => check(false, true), 2500); }
  function stop() { clearInterval(timer); timer = 0; }

  async function install(btn) {
    btn?.classList.add('loading');
    try {
      await downloadInstaller(os === 'win' ? 'win' : 'unix');
      phase = 'waiting';
      poll();
      render();
    } catch (e) { toast(e.message, 'err'); }
    btn?.classList.remove('loading');
  }

  function render() {
    const c = core();
    const sig = [phase, os, c.up, c.version, c.via, c.err].join('|');
    if (sig === lastSig) return;
    lastSig = sig;
    el.dataset.phase = phase;
    if (phase === 'check') {
      el.replaceChildren(h('div', { class: 'cs-status' }, h('span', { class: 'spin' }), h('span', null, '正在检测核心')));
      return;
    }
    if (phase === 'ready') {
      el.replaceChildren(h('div', { class: 'cs-ready' },
        h('div', { class: 'ico-tile ok lg pop' }, icon('check', 30)),
        h('div', { class: 'cs-ready-t' }, h('b', null, '核心已就绪'),
          h('div', { class: 'row', style: { gap: '6px', justifyContent: 'center', flexWrap: 'wrap' } },
            c.version ? h('span', { class: 'pill ok' }, 'v' + c.version) : null,
            h('span', { class: 'pill' }, icon(c.via === 'native' ? 'sparkles' : 'terminal', 11), c.via === 'native' ? '自动托管' : '手动运行'),
            c.port ? h('span', { class: 'pill mono' }, '127.0.0.1:' + c.port) : null))));
      return;
    }
    const isWin = os === 'win';
    const bInstall = h('button', { class: 'btn primary big-btn' }, icon('download', 18), h('span', null, isWin ? '一键安装' : '下载安装脚本'));
    bInstall.addEventListener('click', () => install(bInstall));
    const bRecheck = h('button', { class: 'btn ghost sm' }, icon('refresh', 14), h('span', null, '重新检测'));
    bRecheck.addEventListener('click', async () => { bRecheck.classList.add('loading'); await check(phase === 'broken', false); bRecheck.classList.remove('loading'); });

    if (phase === 'missing' || phase === 'broken') {
      el.replaceChildren(
        phase === 'broken' && c.err ? h('div', { class: 'cs-err' }, icon('alert', 15), h('span', null, c.err)) : null,
        h('div', { class: 'cs-cta' }, bInstall, tip(isWin ? T.node : T.unix)),
        h('div', { class: 'cs-links' },
          isWin ? h('span', { class: 'row', style: { gap: '2px' } }, icon('folder', 13), '文件夹安装', tip(T.folder, 13)) : null,
          bRecheck));
      return;
    }
    // waiting：三个小步骤卡片 + 自动检测
    const mini = (n, ic, label, extra, live = false) => h('div', { class: 'cs-step' + (live ? ' live' : '') },
      h('span', { class: 'cs-n' }, n),
      h('div', { class: 'ico-tile soft' + (live ? ' radar' : '') }, icon(ic, 20)),
      h('div', { class: 'cs-t' }, label), extra);
    const again = h('button', { class: 'btn ghost sm' }, icon('download', 14), h('span', null, '重新下载'));
    again.addEventListener('click', () => install(again));
    el.replaceChildren(
      h('div', { class: 'cs-steps' },
        isWin
          ? mini('1', 'pointer', '打开下载的文件', h('div', { class: 'cs-s' }, INSTALLER.win.name))
          : mini('1', 'download', '已下载', h('div', { class: 'cs-s' }, INSTALLER.unix.name)),
        isWin
          ? mini('2', 'shield', h('span', null, '允许运行 ', tip(T.allow, 13)), h('div', { class: 'cs-s' }, '保留 → 运行'))
          : mini('2', 'terminal', '终端运行', h('div', { class: 'code sm' }, h('code', null, INSTALLER.unix.cmd), h('button', { class: 'icon-btn xs', 'data-tip': '复制', onclick: () => copyText(INSTALLER.unix.cmd).then(() => toast('已复制', 'ok', 1200)) }, icon('copy', 13)))),
        mini('3', 'radar', '自动检测', h('div', { class: 'cs-s live-t' }, h('span', { class: 'phase-dots' }, '等待核心上线')), true)),
      h('div', { class: 'cs-links' }, again, bRecheck));
  }

  const forced = new URLSearchParams(location.search).get('os');   // 预览 / 测试用：?os=win 或 ?os=mac
  platformOs().then(o => { os = (forced || o) === 'win' ? 'win' : 'unix'; lastSig = ''; render(); });
  if (core().up) { phase = 'ready'; readyFired = true; }
  render();
  if (autoCheck && !core().up) check(false, true);
  return { el, update: sync, destroy: stop, check, get phase() { return phase; } };
}
