// 智能导入框（设置向导 与 控制中心共用）：粘贴 / 拖入文件 → 实时识别类型 → 一键导入
import { h, icon, rpc, toast, kindLabel } from './ui.js';
import { parseImport } from './links.js';

export const KIND_IC = { vless: 'zap', trojan: 'shield', http: 'globe', https: 'lock', socks5: 'route' };

// onDone(result)：result = { total, added, subNodes, unsupported, unsupportedWhy, subFail, subErr, dup, fromConfig }
export function importBox({ onDone, compact = false } = {}) {
  const ta = h('textarea', { spellcheck: false, 'aria-label': '订阅链接或节点链接' });
  const ph = h('div', { class: 'drop-ph' },
    h('div', { class: 'ico-tile soft' + (compact ? '' : ' lg') }, icon('clipboard', compact ? 20 : 26)),
    h('b', null, '粘贴订阅链接或节点'),
    h('span', { class: 'dim' }, 'Ctrl + V  ·  可拖入文件'));
  const drop = h('label', { class: 'drop' + (compact ? ' compact' : '') }, ta, ph);
  const chips = h('div', { class: 'detect' });
  const fileIn = h('input', { type: 'file', accept: '.txt,.json,.conf,.yaml,.yml,text/plain,application/json', style: { display: 'none' } });
  const bPaste = h('button', { class: 'btn', type: 'button', 'data-tip': '读取剪贴板' }, icon('clipboard', 15), h('span', null, '粘贴'));
  const bFile = h('button', { class: 'btn', type: 'button', 'data-tip': '从 .txt 或备份配置文件导入' }, icon('folder', 15), h('span', null, '文件'));
  const bGo = h('button', { class: 'btn primary', type: 'button' }, icon('download', 16), h('span', null, '导入'));

  const detect = () => {
    const t = ta.value.trim();
    drop.classList.toggle('has', !!t);
    if (!t) { chips.replaceChildren(); bGo.disabled = true; return; }
    const r = parseImport(t);
    const by = {};
    for (const n of r.nodes) by[n.kind] = (by[n.kind] || 0) + 1;
    const list = [];
    if (r.subs.length) list.push(h('span', { class: 'pill accent' }, icon('link', 12), '订阅 ×' + r.subs.length));
    for (const [k, v] of Object.entries(by)) list.push(h('span', { class: 'pill ok' }, icon(KIND_IC[k] || 'server', 12), `${kindLabel(k)} ×${v}`));
    if (r.unsupported.length) list.push(h('span', { class: 'pill warn', 'data-tip': [...new Set(r.unsupported.map(x => x.reason))].slice(0, 4).join('\n') }, icon('alert', 12), '不支持 ×' + r.unsupported.length));
    if (r.bad.length && !list.length) list.push(h('span', { class: 'pill err' }, icon('x', 12), '未识别'));
    else if (r.bad.length) list.push(h('span', { class: 'pill', 'data-tip': r.bad.slice(0, 3).join('\n').slice(0, 300) }, '忽略 ' + r.bad.length + ' 行'));
    chips.replaceChildren(...list);
    bGo.disabled = !(r.subs.length || r.nodes.length);
  };
  ta.addEventListener('input', detect);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !bGo.disabled) bGo.click(); });
  bPaste.addEventListener('click', async () => {
    try { const t = await navigator.clipboard.readText(); if (!t.trim()) throw new Error('empty'); ta.value = t.trim(); detect(); }
    catch { ta.focus(); toast('请按 Ctrl + V 粘贴', 'info', 2200); }
  });
  const readFile = async f => {
    if (!f) return;
    const text = await f.text();
    try {
      const j = JSON.parse(text);
      if (j && j.app === 'brana-vpn') {
        const r = await rpc('importConfig', { data: j });
        onDone?.({ total: r.nodesAdded, added: r.nodesAdded, subNodes: 0, fromConfig: true, subsAdded: r.subsAdded });
        return;
      }
    } catch (e) { if (e && e.message && !/JSON|Unexpected/.test(e.message)) { toast(e.message, 'err'); return; } }
    ta.value = text.trim(); detect();
  };
  bFile.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { readFile(fileIn.files[0]); fileIn.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag');
    const f = e.dataTransfer.files?.[0];
    if (f) readFile(f);
    else { const t = e.dataTransfer.getData('text'); if (t) { ta.value = t; detect(); } }
  });

  bGo.addEventListener('click', async () => {
    if (bGo.disabled) return;
    bGo.classList.add('loading'); bGo.disabled = true;
    try {
      const r = await rpc('importText', { text: ta.value });
      const subOk = r.subs.filter(x => x.ok);
      const subNodes = subOk.reduce((a, x) => a + (x.count || 0), 0);
      const subFail = r.subs.filter(x => !x.ok);
      const res = {
        total: r.added + subNodes, added: r.added, subNodes, dup: r.dup,
        unsupported: r.unsupported.length, unsupportedWhy: [...new Set(r.unsupported.map(x => x.reason))].join('\n'),
        subFail: subFail.length, subErr: subFail.map(x => x.error).join('\n'),
      };
      if (!res.total) {
        const why = subFail[0]?.error || (r.dup ? '这些节点已经导入过了' : r.unsupported.length ? r.unsupported[0].reason : '没有识别到可用节点');
        if (r.dup) { toast(why, 'info'); onDone?.(res); }
        else throw Object.assign(new Error(why), { user: true });
      } else {
        ta.value = '';
        onDone?.(res);
      }
    } catch (e) { toast(e.message, e.user ? 'warn' : 'err', 4800); }
    bGo.classList.remove('loading');
    detect();
  });

  detect();
  const el = h('div', { class: 'imp-form' }, drop, chips, h('div', { class: 'imp-acts' }, h('div', { class: 'row' }, bPaste, bFile, fileIn), bGo));
  return { el, focus: () => ta.focus(), set: t => { ta.value = t; detect(); } };
}

// 导入结果卡
export function importResult(res, nodes) {
  const by = {};
  for (const n of nodes) by[n.kind] = (by[n.kind] || 0) + 1;
  return h('div', { class: 'res-card ok pop' },
    h('div', { class: 'ico-tile ok' }, icon('check', 22)),
    h('div', { class: 'grow' },
      h('b', null, res.fromConfig ? `已导入配置：${res.added} 个节点` : res.total ? `已导入 ${res.total} 个节点` : '没有新节点'),
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '5px', marginTop: '6px' } },
        ...Object.entries(by).map(([k, v]) => h('span', { class: 'pill' }, icon(KIND_IC[k] || 'server', 11), `${kindLabel(k)} ${v}`)),
        res.unsupported ? h('span', { class: 'pill warn', 'data-tip': res.unsupportedWhy || '' }, `${res.unsupported} 个不支持`) : null,
        res.subFail ? h('span', { class: 'pill err', 'data-tip': res.subErr || '' }, '订阅失败 ' + res.subFail) : null)));
}
