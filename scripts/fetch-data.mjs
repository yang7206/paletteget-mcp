/**
 * 从线上公开端点重建 Worker 数据（GitHub Actions 用，本地也能跑）
 * ------------------------------------------------------------
 * 数据源：https://paletteget.com/api/index.json（中文）
 *        https://paletteget.com/en/api/index.json（英文）
 * 产出：data/palettes.zh.json / data/palettes.en.json
 *
 * /api/index.json 与 Worker 数据同构（roles / contrast / score / page / json / css），
 * 唯一缺的是 colors（生成 CSS 变量时的角色清单）——从 roles 派生，
 * key 原样、label 用易读名（只出现在 CSS 注释里，不影响功能）。
 *
 * 用法：node scripts/fetch-data.mjs
 * 环境变量：PALETTEGET_BASE（默认 https://paletteget.com）
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'data');
const BASE = (process.env.PALETTEGET_BASE || 'https://paletteget.com').replace(/\/+$/, '');
const PLATFORMS = ['app', 'web', 'miniapp'];

/** role key → CSS 注释用的易读名（label 只进注释，语义以站点 /docs/ 的角色定义为准） */
const ROLE_LABEL = {
  primary: 'Primary', primaryDark: 'Primary dark', primaryLight: 'Primary light',
  primaryHover: 'Primary hover', primaryActive: 'Primary active',
  theme: 'Theme', btn: 'Button', btnDisabled: 'Button disabled',
  secondary: 'Secondary', accent: 'Accent', price: 'Price',
  success: 'Success', warning: 'Warning', danger: 'Danger',
  bg: 'Background', surface: 'Surface', card: 'Card',
  border: 'Border', divider: 'Divider',
  text: 'Text', textMain: 'Text main', textSub: 'Text sub', tag: 'Tag',
};

const labelOf = (key) => ROLE_LABEL[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2')
  .replace(/^./, (c) => c.toUpperCase());

/** roles 对象 → [{key, hex, label}]，保持声明顺序；label 优先用端点的本地化角色定义 */
function colorsFromRoles(roles = {}, labels = {}) {
  return Object.entries(roles)
    .filter(([, hex]) => typeof hex === 'string' && /^#[0-9a-f]{3,8}$/i.test(hex))
    .map(([key, hex]) => ({ key, hex, label: labels[key] || ROLE_LABEL[key] || key }));
}

function transform(payload) {
  // 端点自带本地化角色定义（中文构建 → 中文标签），拿来做 colors 的 label
  const labelMaps = {};
  for (const [platform, def] of Object.entries(payload.roleDefinitions || {})) {
    labelMaps[platform] = Object.fromEntries((def.roles || []).map((r) => [r.key, r.label]));
  }
  const palettes = {};
  let total = 0;
  for (const platform of PLATFORMS) {
    const labels = labelMaps[platform] || {};
    palettes[platform] = (payload.palettes?.[platform] || []).map((p) => ({
      slug: p.slug,
      name: p.name,
      scene: p.scene,
      tags: p.tags || [],
      advice: p.advice,
      colors: colorsFromRoles(p.roles, labels),
      roles: p.roles,
      contrast: p.contrast,
      score: p.score,
      source: p.source,
      page: p.page,
      json: p.json,
      css: p.css,
    }));
    total += palettes[platform].length;
  }
  if (total === 0) throw new Error('端点返回 0 套配色，疑似结构变更，拒绝写出空数据');
  return { palettes, total };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'paletteget-mcp-data-refresh/1.0' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const [zh, en] = await Promise.all([
  fetchJson(`${BASE}/api/index.json`),
  fetchJson(`${BASE}/en/api/index.json`),
]);

const dataZh = transform(zh);
const dataEn = transform(en);

if (dataZh.total !== dataEn.total) {
  throw new Error(`中英数量不一致：zh=${dataZh.total} en=${dataEn.total}`);
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'palettes.zh.json'), JSON.stringify(dataZh, null, 2) + '\n');
await writeFile(join(outDir, 'palettes.en.json'), JSON.stringify(dataEn, null, 2) + '\n');
console.log(`✅ 数据重建完成：${dataZh.total} 套（zh + en 各一份）→ data/`);
