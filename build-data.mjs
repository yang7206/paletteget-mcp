/**
 * 导出 MCP Worker 用的内联数据集
 * ------------------------------------------------------------
 * Worker 把中英两份数据打进包里（部署即生效，不做运行时回源）。
 * 数据字段与 /api/index.json 完全同构，额外带 colors（本地生成 CSS 用）。
 *
 * 用法（必须显式传语言，跑两次）：
 *   SITE_URL=https://paletteget.com SITE_BASE=/ SITE_LOCALE=en node build-data.mjs
 *   SITE_URL=https://paletteget.com SITE_BASE=/ SITE_LOCALE=zh node build-data.mjs
 *
 * 为什么从 src 的模块导入而不是抓线上 JSON：
 *   和站点构建共用同一套 l10n 逻辑，命名 / 场景 / 建议两个语言必然一致；
 *   抓线上反而引入网络依赖与缓存不一致的风险。
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const LOCALE = String(process.env.SITE_LOCALE || '').toLowerCase();
if (!['zh', 'en'].includes(LOCALE)) {
  console.error('必须设置 SITE_LOCALE=zh 或 en');
  process.exit(1);
}

// i18n 模块在 import 时读 process.env.SITE_LOCALE，因此必须先设 env 再 import
// —— 本脚本约定「env 先于运行」，这里用动态 import 保证顺序。
const { l10n, roleText } = await import('../src/i18n/palette.mjs');
const { localizedTag } = await import('../src/i18n/content.mjs');
const { absUrl } = await import('../src/lib/site.mjs');
const { ROLES } = await import('../src/data/schema.mjs');
const dataset = require('../src/data/palettes.json');

const platforms = ['app', 'web', 'miniapp'];
const palettes = {};
let total = 0;
for (const p of platforms) {
  palettes[p] = dataset[p].map((x) => {
    const lp = l10n(x, p); // 中文构建原样返回；英文构建切换名称/场景/建议/角色文案
    total += 1;
    return {
      id: x.id,
      name: lp.name,
      slug: x.slug,
      tags: x.tags.map(localizedTag),
      scene: lp.scene,
      advice: lp.advice,
      source: x.source,
      score: x.score,
      roles: x.roles,
      contrast: x.contrast,
      colors: lp.colors, // Worker 本地生成 CSS 变量用
      page: absUrl(`/palette-list/${p}/${x.slug}/`),
      json: absUrl(`/palette-list/${p}/${x.slug}/index.json`),
      css: absUrl(`/palette-list/${p}/${x.slug}/index.css`),
    };
  });
}

const roleDefinitions = Object.fromEntries(
  platforms.map((p) => [
    p,
    {
      label: undefined, // 由 worker.mjs 内置的平台标签补，避免引入整个 ui.mjs 词典
      roles: (ROLES[p] || []).map((r) => {
        const rt = roleText(p, r.key);
        return { key: r.key, label: rt.label, desc: rt.desc };
      }),
    },
  ])
);

const payload = {
  locale: LOCALE,
  generatedAt: new Date().toISOString().slice(0, 10),
  total,
  palettes,
  roleDefinitions,
};

const out = join(here, 'data', `palettes.${LOCALE}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(payload));
console.log(`✅ ${out}（${(JSON.stringify(payload).length / 1024).toFixed(1)} KB，${total} 套）`);
