/**
 * 颜色数学（MCP 自包含实现）
 * ------------------------------------------------------------
 * ⚠️ 这是站点 src/lib/color.mjs + src/lib/theme.mjs 的镜像实现。
 *    MCP 是独立子包（自己的 package.json / node_modules），不能 import
 *    站点源码，所以算法必须有两份。两份一旦漂移，工具页与 agent 拿到
 *    的数字就会不一致 —— 而这个服务的卖点正是「数字可复核」。
 *
 *    对照脚本：node scripts/check-theme-parity.mjs
 *    它用同一批输入跑两边，任何一处 ratio / hex 不同就报错退出。
 *
 * 改算法时的顺序：先改 src/lib/，再同步这里，最后跑对照脚本。
 */

// 注意：必须带默认值。hslToRgb 里调用的是 clamp(s) / clamp(l)，
// 漏掉默认值会让 min/max 变成 undefined，颜色全部算出 NaN（对照脚本会当场抓到）。
const clamp = (v, min = 0, max = 100) => Math.min(max, Math.max(min, v));
const round = (v, p = 2) => Number(v.toFixed(p));

export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`Invalid HEX: ${hex}`);
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
  const to = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function rgbToHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: round(h, 1), s: round(s * 100, 1), l: round(l * 100, 1) };
}

export function hslToRgb({ h, s, l }) {
  const H = ((h % 360) + 360) % 360;
  const S = clamp(s) / 100;
  const L = clamp(l) / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = L - c / 2;
  let rgb;
  if (H < 60) rgb = [c, x, 0];
  else if (H < 120) rgb = [x, c, 0];
  else if (H < 180) rgb = [0, c, x];
  else if (H < 240) rgb = [0, x, c];
  else if (H < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 };
}

export const hexToHsl = (hex) => rgbToHsl(hexToRgb(hex));
export const hslToHex = (hsl) => rgbToHex(hslToRgb(hsl));

export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return round((hi + 0.05) / (lo + 0.05), 2);
}

export function wcagLevel(ratio, size = 'normal') {
  const [aa, aaa] = size === 'large' ? [3, 4.5] : [4.5, 7];
  if (ratio >= aaa) return 'AAA';
  if (ratio >= aa) return 'AA';
  if (ratio >= 3) return 'AA Large';
  return 'Fail';
}

/* ---------------- 文字色推荐（对应站点 /tools/text-on/） ---------------- */

export function textCandidates(bgHex, limit = 9) {
  const { h, s } = hexToHsl(bgHex);
  const out = [];
  const seen = new Set();

  const push = (hex, kind, source) => {
    const key = hex.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const ratio = contrastRatio(key, bgHex);
    out.push({ hex: key, ratio, level: wcagLevel(ratio, 'normal'), kind, source, recommended: false });
  };

  // 中性参照先入列，理由同站点实现：否则白色会被 tint 抢先占位，推荐逻辑失效
  push('#ffffff', 'neutral', 'white');
  push('#000000', 'neutral', 'black');

  const lightSat = Math.min(40, s * 0.55);
  for (const l of [100, 97, 93, 88]) push(hslToHex({ h, s: lightSat, l }), 'light', 'tint');

  const darkSat = Math.min(55, s * 0.8);
  for (const l of [22, 15, 8, 3]) push(hslToHex({ h, s: darkSat, l }), 'dark', 'shade');

  out.sort((a, b) => b.ratio - a.ratio);
  // 与站点 src/lib/theme.mjs 同一规则：优先同色相候选，纯黑白只作参照
  const bestTinted = out.find((x) => x.kind !== 'neutral' && x.ratio >= 4.5);
  const firstAa = out.find((x) => x.ratio >= 4.5);
  (bestTinted || firstAa || out[0]).recommended = true;
  return out.slice(0, limit);
}

/* ---------------- 深色版本推导（对应站点 /tools/darkmode/） ---------------- */

const SEMANTIC = {
  bg: { l: 9, sMul: 0.4, sCap: 16 },
  surface: { l: 14, sMul: 0.4, sCap: 18 },
  card: { l: 14, sMul: 0.4, sCap: 18 },
  text: { l: 93, sMul: 0.3, sCap: 12 },
  textMain: { l: 93, sMul: 0.3, sCap: 12 },
  textSub: { l: 70, sMul: 0.3, sCap: 14 },
  border: { l: 26, sMul: 0.35, sCap: 18 },
  divider: { l: 22, sMul: 0.35, sCap: 18 },
};

export const DARK_CHECKS = [
  { key: 'textOnBg', fg: ['text', 'textMain'], bg: 'bg' },
  { key: 'primaryOnBg', fg: ['primary', 'theme', 'btn'], bg: 'bg' },
  { key: 'textOnSurface', fg: ['text', 'textMain'], bg: ['surface', 'card'] },
];

function pick(roles, keys) {
  for (const k of Array.isArray(keys) ? keys : [keys]) {
    if (roles[k]) return roles[k];
  }
  return null;
}

export function darkVariant(roles = {}) {
  const next = {};
  const changed = [];

  for (const [key, hex] of Object.entries(roles)) {
    if (!hex) continue;
    const hsl = hexToHsl(hex);
    const rule = SEMANTIC[key];

    if (rule) {
      next[key] = hslToHex({ h: hsl.h, s: Math.min(rule.sCap, hsl.s * rule.sMul), l: rule.l });
    } else {
      next[key] = hslToHex({ h: hsl.h, s: hsl.s, l: clamp(hsl.l + 14, 55, 78) });
    }
    if (next[key] !== String(hex).toLowerCase()) changed.push(key);
  }

  const checks = [];
  for (const c of DARK_CHECKS) {
    const fg = pick(next, c.fg);
    const bg = pick(next, c.bg);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    const basis = c.key === 'primaryOnBg' ? 'large' : 'normal';
    checks.push({ key: c.key, fg, bg, ratio, basis, level: wcagLevel(ratio, basis) });
  }

  return { roles: next, changed, checks };
}

/** 背景亮度（判断一套配色是不是浅色底） */
export function bgLuminance(roles = {}) {
  const bg = pick(roles, ['bg']);
  return bg ? relativeLuminance(bg) : null;
}

/* ---------------- 色阶（对应站点 /tools/shades/） ---------------- */

export const SCALE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];

const CURVE_L = { 50: 97, 100: 94, 200: 86, 300: 76, 400: 66, 500: 56, 600: 48, 700: 40, 800: 32, 900: 24 };
const CURVE_S = { 50: 0.55, 100: 0.64, 200: 0.74, 300: 0.84, 400: 0.94, 500: 1, 600: 1, 700: 0.98, 800: 0.95, 900: 0.9 };

export function colorScale(baseHex) {
  const base = String(baseHex).toLowerCase();
  const { h, s, l } = hexToHsl(base);
  const anchor = CURVE_L[500];
  const kUp = Math.max(0.35, Math.min(1, (97 - l) / (CURVE_L[50] - anchor)));
  const kDown = Math.max(0.35, Math.min(1, (l - 3) / (anchor - CURVE_L[900])));

  return SCALE_STEPS.map((step) => {
    const dist = CURVE_L[step] - anchor;
    const light = Math.max(3, Math.min(97, l + dist * (dist >= 0 ? kUp : kDown)));
    const sat = Math.max(0, Math.min(100, s * CURVE_S[step]));
    const hex = step === 500 ? base : hslToHex({ h, s: sat, l: light });
    const onWhite = contrastRatio(hex, '#ffffff');
    const onBlack = contrastRatio(hex, '#000000');
    return {
      step,
      hex,
      onWhite,
      onBlack,
      levelWhite: wcagLevel(onWhite, 'normal'),
      levelBlack: wcagLevel(onBlack, 'normal'),
    };
  });
}
