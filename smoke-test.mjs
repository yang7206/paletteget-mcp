#!/usr/bin/env node
/**
 * MCP server 冒烟测试
 * ------------------------------------------------------------
 *   cd mcp && npm install && npm run smoke
 *
 * 直接按 MCP 的 stdio 协议（换行分隔的 JSON-RPC）跟服务端对话，
 * 把 9 个工具全跑一遍并断言输出，不需要真实 MCP 客户端。
 *
 * 数据源：默认用**本地构建产物**起一个夹具服务（把 dist/ 里的中英数据集
 * 按线上路径结构喂给服务端，并把 payload 里的绝对地址改写成 localhost），
 * 因此离线可跑、不依赖外网。想打真实线上数据：
 *   PALETTEGET_API=https://paletteget.com/api/index.json npm run smoke
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/* ---------------- 1. 准备数据源 ---------------- */

let apiEn = process.env.PALETTEGET_API;
let apiZh = process.env.PALETTEGET_API_ZH;
let fixture = null;

if (!apiEn) {
  // 国内构建的产物结构：中文在根、英文在 /en/
  const zhFile = resolve(here, '../dist/api/index.json');
  const enFile = resolve(here, '../dist/en/api/index.json');
  if (!existsSync(zhFile) || !existsSync(enFile)) {
    console.error('❌ 没找到构建产物。先跑 `npm run build`，或用 PALETTEGET_API 指向线上站点。');
    process.exit(1);
  }

  const port = 8787 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;
  // 构建产物里的绝对地址带着挂载前缀（/palette）与占位域名，这里改写成夹具地址
  const stripMount = (p) => p.replace(/^\/palette(?=\/|$)/, '');
  const rewrite = (file) => {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    for (const platform of Object.keys(d.palettes || {})) {
      for (const p of d.palettes[platform]) {
        for (const k of ['page', 'json', 'css']) {
          if (p[k]) p[k] = origin + stripMount(new URL(p[k]).pathname);
        }
      }
    }
    return JSON.stringify(d);
  };
  const payloadEn = rewrite(enFile);
  const payloadZh = rewrite(zhFile);

  fixture = createServer((req, res) => {
    const path = stripMount(new URL(req.url, origin).pathname);
    if (path === '/api/index.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(payloadEn);
    }
    if (path === '/zh/api/index.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(payloadZh);
    }
    const file = resolve(here, `../dist${path}`);
    if (path.endsWith('.css') && existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      return res.end(readFileSync(file));
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => fixture.listen(port, '127.0.0.1', r));

  apiEn = `${origin}/api/index.json`;
  apiZh = `${origin}/zh/api/index.json`;
  console.log(`夹具数据源已启动：${origin}（英文 /api、中文 /zh/api）\n`);
} else {
  console.log(`使用指定数据源：${apiEn}\n`);
}

/* ---------------- 2. 启动服务端 ---------------- */

const child = spawn(process.execPath, [resolve(here, 'index.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, PALETTEGET_API: apiEn, PALETTEGET_API_ZH: apiZh },
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let seq = 0;
const rpc = (method, params) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => rej(new Error(`${method} 超时`)), 30000);
  });
const notify = (method, params) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const textOf = (msg) => msg?.result?.content?.[0]?.text ?? '';
const cleanup = () => {
  try { child.kill(); } catch { /* 忽略 */ }
  try { fixture?.close(); } catch { /* 忽略 */ }
};

try {
  console.log('=== 1. 握手 ===');
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  });
  check('initialize', init.result?.serverInfo?.name === 'paletteget',
    `${init.result?.serverInfo?.name}@${init.result?.serverInfo?.version}`);
  notify('notifications/initialized', {});

  console.log('=== 2. 工具清单 ===');
  const tools = (await rpc('tools/list', {})).result?.tools ?? [];
  check('返回 9 个工具', tools.length === 9, tools.map((t) => t.name).join(', '));
  for (const want of [
    'list_palettes',
    'get_palette',
    'suggest_palette',
    'get_css_variables',
    'check_contrast',
    'suggest_text_color',
    'get_platform_snippet',
    'get_color_scale',
    'darken_palette',
  ]) {
    check(`含工具 ${want}`, tools.map((t) => t.name).includes(want));
  }

  console.log('=== 3. list_palettes ===');
  const t1 = textOf(await rpc('tools/call', { name: 'list_palettes', arguments: { platform: 'web', limit: 3 } }));
  check('返回 3 条列表', t1.includes('共 3 套'), t1.split('\n')[0]);
  const firstSlug = (t1.match(/slug: (\S+)/) || [])[1];
  check('列表含 slug', Boolean(firstSlug), firstSlug);

  console.log('=== 4. suggest_palette（中文关键词）===');
  const t2 = textOf(await rpc('tools/call', { name: 'suggest_palette', arguments: { query: '深色 记账', limit: 3 } }));
  check('中文关键词有命中', t2.includes('命中'), (t2.split('\n')[1] || t2).slice(0, 60));

  console.log('=== 5. suggest_palette（英文关键词）===');
  const t3 = textOf(await rpc('tools/call', { name: 'suggest_palette', arguments: { query: 'fresh blog', limit: 3 } }));
  check('英文关键词有命中', t3.includes('命中'), (t3.split('\n')[1] || t3).slice(0, 60));

  console.log('=== 6. get_palette ===');
  const parsed = JSON.parse(textOf(await rpc('tools/call', { name: 'get_palette', arguments: { slug: firstSlug, platform: 'web' } })));
  check('返回完整数据', Boolean(parsed.roles && parsed.contrast), `角色 ${Object.keys(parsed.roles || {}).length} 个`);
  check('中英双名', Boolean(parsed.name), `${parsed.name}${parsed.nameZh ? ' / ' + parsed.nameZh : ''}`);

  console.log('=== 7. get_css_variables ===');
  const css = textOf(await rpc('tools/call', { name: 'get_css_variables', arguments: { slug: firstSlug, platform: 'web' } }));
  check('返回 CSS 变量', css.includes('--color-'),
    (css.split('\n').find((l) => l.includes('--color-')) || '').trim());

  console.log('=== 8. get_platform_snippet ===');
  const snipAndroid = textOf(await rpc('tools/call', {
    name: 'get_platform_snippet',
    arguments: { slug: firstSlug, platform: 'web', target: 'android' },
  }));
  check('Android 片段是合法 XML 头', snipAndroid.startsWith('<?xml'), snipAndroid.split('\n')[0]);
  check('Android 资源名用 color_ 前缀 + snake_case',
    /<color name="color_[a-z0-9_]+">#[0-9A-F]{6}<\/color>/.test(snipAndroid),
    (snipAndroid.split('\n').find((l) => l.includes('<color ')) || '').trim());
  const snipWxss = textOf(await rpc('tools/call', {
    name: 'get_platform_snippet',
    arguments: { slug: firstSlug, platform: 'web', target: 'wxss' },
  }));
  check('小程序片段是 page{} 里的 kebab-case 变量',
    snipWxss.includes('page {') && /--color-[a-z0-9-]+: #[0-9a-f]{6}/.test(snipWxss),
    (snipWxss.split('\n').find((l) => l.includes('--color')) || '').trim());
  const snipBad = textOf(await rpc('tools/call', {
    name: 'get_platform_snippet',
    arguments: { slug: firstSlug, target: 'nope' },
  }));
  check('非法 target 有提示', snipBad.includes('target 只支持'), snipBad.slice(0, 40));

  console.log('=== 9. get_color_scale ===');
  const scaleTxt = textOf(await rpc('tools/call', {
    name: 'get_color_scale',
    arguments: { color: '#4c8df6' },
  }));
  check('列出 50 到 900 共 10 阶', ['50:', '100:', '500:', '900:'].every((k) => scaleTxt.includes(k)), scaleTxt.split('\n')[1]);
  check('500 阶就是基准色本身', /- 500: #4c8df6/.test(scaleTxt));
  const scaleCss = textOf(await rpc('tools/call', {
    name: 'get_color_scale',
    arguments: { color: '#4c8df6', format: 'css' },
  }));
  check('format=css 输出 10 条变量', (scaleCss.match(/--brand-\d+/g) || []).length === 10);
  const scaleBad = textOf(await rpc('tools/call', {
    name: 'get_color_scale',
    arguments: { color: 'nope' },
  }));
  check('非法色值有提示', scaleBad.includes('合法的基准色'), scaleBad.slice(0, 30));

  console.log('=== 10. check_contrast ===');
  const cc = textOf(await rpc('tools/call', {
    name: 'check_contrast',
    arguments: { foreground: '#e8ecf4', background: '#12161f' },
  }));
  check('算出已知对比度 15.29:1', cc.includes('15.29:1'), cc.split('\n')[0]);
  check('同时给正文级与大字级判定', cc.includes('正文级') && cc.includes('大字级'));

  console.log('=== 11. suggest_text_color ===');
  const stc = textOf(await rpc('tools/call', {
    name: 'suggest_text_color',
    arguments: { background: '#1f5f5b', limit: 4 },
  }));
  check('给出候选并标推荐', stc.includes('推荐'), stc.split('\n')[1] || stc.slice(0, 40));
  check('候选带 X.XX:1 形式对比度', /- #[0-9a-f]{6}\s+\d+\.\d{2}:1/.test(stc));

  console.log('=== 12. darken_palette ===');
  const dp = textOf(await rpc('tools/call', {
    name: 'darken_palette',
    arguments: { slug: firstSlug, platform: 'web' },
  }));
  check('输出深色 roles', dp.includes('深色版本 roles'), dp.split('\n')[0]);
  check('输出实测对比度', dp.includes('实测对比度') && /\d+\.\d{2}:1/.test(dp));
  check('声明这是推导而非库条目', dp.includes('不是配色库里的条目'));

  console.log('=== 13. 错误处理 ===');
  const bad = textOf(await rpc('tools/call', { name: 'get_palette', arguments: { slug: 'no-such-slug' } }));
  check('不存在的 slug 有友好提示', bad.includes('没找到'), bad.slice(0, 40));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed ? '❌' : '✅'} 冒烟测试：${results.length - failed}/${results.length} 通过`);
  cleanup();
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('❌ 测试异常：', err.message);
  cleanup();
  process.exit(1);
}
