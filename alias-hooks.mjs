/**
 * 给 Node 直接跑 src/ 模块用的路径别名钩子：把 '@/xxx' 解析到 '<repo>/src/xxx'。
 * 仅限本地工具脚本（build-data.mjs / smoke），运行时产物不经过这里。
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const SRC_ROOT = new URL('../src/', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    // 别名根固定指向仓库的 src/（本文件位于 mcp/ 下）
    const target = new URL('../src/' + specifier.slice(2), import.meta.url);
    const result = await next(target.href, context);
    // src 里有些模块 import palettes.json 没带 import attribute，Node 直接跑会报错，这里补上
    if (result.url?.endsWith('.json')) result.importAttributes = { type: 'json' };
    return result;
  }
  return next(specifier, context);
}

/**
 * src 是 Astro 代码，个别模块在模块顶层读 import.meta.env（Astro 注入的全量）。
 * Node 里没有这个对象，这里把它替换成 loader 预先挂在 globalThis 的等价物
 * （见 alias-loader.mjs：BASE_URL ← SITE_BASE，SITE ← SITE_URL）。
 */
export async function load(url, context, next) {
  if (url.startsWith(SRC_ROOT) && url.endsWith('.mjs')) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    if (source.includes('import.meta.env')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: source.replaceAll('import.meta.env', 'globalThis.__WB_ENV__'),
      };
    }
  }
  return next(url, context);
}
