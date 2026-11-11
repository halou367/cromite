// 国家/地区：国旗 emoji、中文名称
let dn = null;
try { dn = new Intl.DisplayNames(['zh-CN'], { type: 'region' }); } catch {}

const SHORT = { HK: '香港', TW: '台湾', MO: '澳门', US: '美国', GB: '英国', KR: '韩国', KP: '朝鲜', RU: '俄罗斯', AE: '阿联酋', NL: '荷兰', CZ: '捷克' };

export const flag = cc => {
  cc = String(cc || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '🌐';
  return String.fromCodePoint(127397 + cc.charCodeAt(0), 127397 + cc.charCodeAt(1));
};

export const ccName = cc => {
  cc = String(cc || '').trim().toUpperCase();
  if (!cc) return '未知';
  if (SHORT[cc]) return SHORT[cc];
  try { return (dn && dn.of(cc)) || cc; } catch { return cc; }
};

export const ccLabel = cc => (cc ? `${flag(cc)} ${ccName(cc)}` : '🌐 未知');

// 常用地区排序（亚洲优先，便于亚洲用户快速选择）
export const PREFERRED_ORDER = ['HK', 'JP', 'SG', 'TW', 'KR', 'US', 'GB', 'DE', 'NL', 'FR', 'CA', 'AU', 'IN', 'MY', 'TH', 'VN', 'ID', 'PH', 'TR', 'RU'];
export const ccSort = (a, b) => {
  const ia = PREFERRED_ORDER.indexOf(a), ib = PREFERRED_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a).localeCompare(String(b));
};
