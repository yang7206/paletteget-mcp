/**
 * 多端代码片段（MCP 自包含实现）
 * ------------------------------------------------------------
 * ⚠️ 与站点 src/lib/export.mjs 是同一套模板的第二份实现（MCP 是独立子包）。
 *    命名规则（Android snake_case + color_ 前缀 / iOS 与 Flutter camelCase /
 *    小程序 kebab-case）属于跨端约定，两处必须一致。
 *
 *    对照脚本：node scripts/check-theme-parity.mjs（七种格式逐字比对）
 */

export const toSnake = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
export const toKebab = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const rgbOf = (hex) => {
  const h = String(hex).replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
};

const headerText = (name, platform, contrast) => {
  const base = platform ? `${name} · ${platform}` : `${name}`;
  const text = contrast?.textOnBg;
  return text ? `${base} · text on background ${text.ratio}:1 (${text.level})` : base;
};

/** Web 三种：CSS 变量 / SCSS 变量 / Tailwind 配置 */
export function webSnippets({ name, colors, lang }) {
  const list = (colors || []).filter((c) => c && c.hex);
  const twComment = lang === 'en' ? `// tailwind.config.js: ${name}` : `// tailwind.config.js：${name}`;

  const css = `:root {\n${list.map((c) => `  --color-${c.key}: ${c.hex}; /* ${c.label} */`).join('\n')}\n}`;
  const scss = list.map((c) => `$color-${c.key}: ${c.hex}; // ${c.label}`).join('\n');
  const tailwind = `${twComment}\nmodule.exports = {\n  theme: {\n    extend: {\n      colors: {\n${list
    .map((c) => `        '${c.key}': '${c.hex}',`)
    .join('\n')}\n      },\n    },\n  },\n};`;

  return { css, scss, tailwind };
}

/** 移动端 / 小程序四种 */
export function mobileSnippets({ name, platform, colors, contrast }) {
  const list = (colors || []).filter((c) => c && c.hex);

  const android = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- ' + headerText(name, platform, contrast) + ' -->',
    '<resources>',
    ...list.map((c) => `    <color name="color_${toSnake(c.key)}">${c.hex.toUpperCase()}</color>`),
    '</resources>',
  ].join('\n');

  const ios = [
    `// ${headerText(name, platform, contrast)}`,
    'import UIKit',
    '',
    'enum PaletteColor {',
    ...list.map((c) => {
      const { r, g, b } = rgbOf(c.hex);
      return [
        `    /// ${c.label} · ${c.hex}`,
        `    static let ${c.key} = UIColor(red: ${r}/255.0, green: ${g}/255.0, blue: ${b}/255.0, alpha: 1.0)`,
      ].join('\n');
    }),
    '}',
  ].join('\n');

  const flutter = [
    `// ${headerText(name, platform, contrast)}`,
    "import 'package:flutter/material.dart';",
    '',
    'class PaletteColors {',
    ...list.map((c) => `  static const Color ${c.key} = Color(0xFF${c.hex.slice(1).toUpperCase()});`),
    '}',
  ].join('\n');

  const wxss = [
    `/* ${headerText(name, platform, contrast)} */`,
    'page {',
    ...list.map((c) => `  --color-${toKebab(c.key)}: ${c.hex}; /* ${c.label} */`),
    '}',
  ].join('\n');

  return { android, ios, flutter, wxss };
}

export const SNIPPET_TARGETS = ['android', 'ios', 'flutter', 'wxss', 'css', 'scss', 'tailwind'];

/** 色阶导出片段（对应站点 src/lib/scale.mjs，parity 逐字比对） */
export function scaleSnippets({ scale, name = 'brand' }) {
  const css = `:root {\n${scale.map((x) => `  --${name}-${x.step}: ${x.hex};`).join('\n')}\n}`;
  const tailwind = `module.exports = {\n  theme: {\n    extend: {\n      colors: {\n        ${name}: {\n${scale
    .map((x) => `          ${x.step}: '${x.hex}',`)
    .join('\n')}\n        },\n      },\n    },\n  },\n};`;
  return { css, tailwind };
}
