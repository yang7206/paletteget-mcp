/**
 * 发布包完整性检查（2026-10-28）
 * ------------------------------------------------------------
 * 为什么需要它：
 *   `package.json` 的 `files` 白名单里只写了 index.mjs，而 index.mjs 实际
 *   `import './color.mjs'` 与 `'./snippets.mjs'`。`npm run smoke` 是在仓库里跑的，
 *   那两个文件本来就在，所以 34 条断言全过——真发上去，用户 `npx paletteget-mcp`
 *   会在启动瞬间 ERR_MODULE_NOT_FOUND。
 *   判据必须是「真正打出来的 tarball 内容」，不是仓库里的文件系统。
 *
 * 做法：
 *   1. 读 npm pack --dry-run --json 的文件清单（就是用户会拿到的东西）
 *   2. 从 bin 入口出发，递归解析相对 import，逐个断言在清单里
 *   3. 顺带断言 bin 目标、LICENSE、README 都在
 *
 * 用法：npm run check:pack（已挂进 prepublishOnly，发布前自动拦）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const fail = [];
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => {
  console.log(`  ❌ ${m}`);
  fail.push(m);
};

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
// Windows 上 npm 是 .cmd，Node 20 起不允许直接 execFile 这类批处理，需走 shell
const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const info = JSON.parse(raw)[0];
const packed = new Set(info.files.map((f) => f.path.replace(/\\/g, '/')));
const sizeKb = (info.unpackedSize / 1024).toFixed(1);

console.log(`发布包检查 · ${pkg.name}@${pkg.version} · ${packed.size} 个文件 · 解包 ${sizeKb} kB`);

// 1. bin 目标必须在包里
const bins = Object.entries(pkg.bin || {}).map(([, p]) => p.replace(/^\.\//, ''));
for (const b of bins) {
  if (packed.has(b)) ok(`bin 入口在包里：${b}`);
  else bad(`bin 入口不在包里：${b}`);
}

// 2. 从入口出发递归解析相对 import
const seen = new Set();
const missing = new Set();
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    missing.add(file);
    return;
  }
  // 静态 import / 动态 import 里的相对路径都算
  const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of specs) {
    const rel = normalize(join(dirname(file), spec)).replace(/\\/g, '/');
    if (!seen.has(rel)) {
      if (!packed.has(rel)) missing.add(rel);
      walk(rel);
    }
  }
}

for (const b of bins) walk(b);

if (!missing.size) ok(`本地依赖全部在包里（共 ${seen.size} 个模块）`);
else for (const m of missing) bad(`缺少模块：${m} —— 装完会 ERR_MODULE_NOT_FOUND`);
if (missing.size) {
  console.log('     修法：把上面这些文件加进 package.json 的 files 数组');
}

// 3. 门面文件
for (const f of ['README.md', 'LICENSE']) {
  if (packed.has(f)) ok(`${f} 在包里`);
  else bad(`${f} 不在包里（npm 页面会缺内容 / 授权不明）`);
}

// 4. 不该进包的东西
for (const f of [...packed]) {
  if (/^(node_modules|data|\.wrangler)\//.test(f) || /\.(tgz|log|env)$/.test(f)) {
    bad(`不该发布的文件进了包：${f}`);
  }
}

console.log(fail.length ? `\n❌ ${fail.length} 项未通过` : '\n✅ 发布包完整');
process.exit(fail.length ? 1 : 0);
