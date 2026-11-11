// 工具栏图标：已连接显示出口国家国旗 + 状态点；未连接显示品牌图标（灰）
import { flag } from '../shared/geo.js';

let fontState = null;
async function ensureFont() {
  if (fontState !== null) return fontState;
  try {
    const ff = new FontFace('BranaFlags', `url(${chrome.runtime.getURL('shared/flags.woff2')})`);
    await ff.load();
    const set = self.fonts || globalThis.document?.fonts;
    if (!set) throw new Error('no FontFaceSet');
    set.add(ff);
    fontState = true;
  } catch {
    fontState = false;
  }
  return fontState;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 品牌图标：圆角渐变底 + 盾形 + 闪电
function drawBrand(ctx, s, on) {
  const g = ctx.createLinearGradient(0, 0, s, s);
  if (on) { g.addColorStop(0, '#22d3ee'); g.addColorStop(1, '#6366f1'); }
  else { g.addColorStop(0, '#64748b'); g.addColorStop(1, '#334155'); }
  rr(ctx, 0, 0, s, s, s * 0.24);
  ctx.fillStyle = g;
  ctx.fill();
  const k = s / 32;
  ctx.save();
  ctx.translate(0, 0);
  ctx.beginPath();
  ctx.moveTo(16 * k, 5 * k);
  ctx.lineTo(25 * k, 8.5 * k);
  ctx.lineTo(25 * k, 15 * k);
  ctx.bezierCurveTo(25 * k, 21 * k, 21 * k, 25 * k, 16 * k, 27.5 * k);
  ctx.bezierCurveTo(11 * k, 25 * k, 7 * k, 21 * k, 7 * k, 15 * k);
  ctx.lineTo(7 * k, 8.5 * k);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(17.5 * k, 9 * k);
  ctx.lineTo(11.5 * k, 17 * k);
  ctx.lineTo(15.5 * k, 17 * k);
  ctx.lineTo(14.5 * k, 23.5 * k);
  ctx.lineTo(20.5 * k, 15 * k);
  ctx.lineTo(16.5 * k, 15 * k);
  ctx.closePath();
  ctx.fillStyle = on ? '#4f46e5' : '#475569';
  ctx.fill();
  ctx.restore();
}

function drawDot(ctx, s, color) {
  const r = Math.max(2.4, s * 0.17);
  const x = s - r - s * 0.02, y = s - r - s * 0.02;
  ctx.beginPath();
  ctx.arc(x, y, r + Math.max(1, s * 0.06), 0, Math.PI * 2);
  ctx.fillStyle = '#0f172a';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawCcBadge(ctx, s, cc) {
  const g = ctx.createLinearGradient(0, 0, s, s);
  g.addColorStop(0, '#0ea5e9');
  g.addColorStop(1, '#4f46e5');
  rr(ctx, 0, s * 0.12, s, s * 0.76, s * 0.18);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(s * 0.42)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cc, s / 2, s * 0.52);
}

const COLORS = { on: '#22c55e', switching: '#f59e0b', connecting: '#f59e0b', degraded: '#f59e0b', error: '#ef4444' };

export async function renderIcon({ status = 'off', cc = '' } = {}) {
  if (typeof OffscreenCanvas === 'undefined') return;
  const font = cc ? await ensureFont() : false;
  const imageData = {};
  for (const s of [16, 32, 48, 128]) {
    const c = new OffscreenCanvas(s, s);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    const live = status !== 'off';
    if (live && cc && /^[A-Z]{2}$/.test(cc)) {
      if (font) {
        ctx.font = `${Math.round(s * 0.98)}px BranaFlags`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(flag(cc), s / 2, s * 0.52);
      } else drawCcBadge(ctx, s, cc);
    } else {
      drawBrand(ctx, s, live && status !== 'error');
    }
    if (live) drawDot(ctx, s, COLORS[status] || COLORS.on);
    imageData[s] = ctx.getImageData(0, 0, s, s);
  }
  try { await chrome.action.setIcon({ imageData }); } catch {}
}
