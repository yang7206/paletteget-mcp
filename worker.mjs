/**
 * PaletteGet MCP Worker（Remote MCP · Streamable HTTP）
 * ------------------------------------------------------------
 * 部署在 Cloudflare Workers，URL 直连：
 *   https://paletteget-mcp.<account>.workers.dev/mcp
 *
 * 与 stdio 版（index.mjs）的关系：
 *   · 四个工具（list_palettes / get_palette / suggest_palette / get_css_variables）
 *     的判定逻辑与返回格式保持一致；差异只在数据来源与传输层
 *   · 数据：构建期内联 data/palettes.{zh,en}.json（build-data.mjs 产出），
 *     部署即生效，不回源、无运行时外部依赖
 *   · 传输：MCP Streamable HTTP 的无状态子集（JSON 响应，不开 SSE），
 *     覆盖 ChatGPT 连接器 / Claude / Cursor 等 remote 客户端
 *
 * 为什么手写 JSON-RPC 而不用官方 SDK：
 *   官方 server SDK 的核心带 Node 内置模块依赖，Workers 兼容要挑入口；
 *   本服务只需 initialize / tools/list / tools/call / ping 四个方法，
 *   手写约 200 行，协议面窄、可测、零依赖，长期更稳。
 *
 * 数据刷新：重跑 build-data.mjs（两个语言各一次）→ wrangler deploy。
 * 建议挂进每日发布链路：海外同步之后追加这一步，数据与站点同频。
 */

import dataZh from './data/palettes.zh.json';
import dataEn from './data/palettes.en.json';

const SERVER_INFO = { name: 'paletteget-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PLATFORMS = ['app', 'web', 'miniapp'];
const PLATFORM_LABEL = { app: 'App', web: 'Web', miniapp: 'Mini App' };

/* ---------------- 数据合并（中英并取，与 stdio 版同构） ---------------- */

function mergePalettes() {
  const index = new Map();
  const eat = (data, suffix) => {
    for (const platform of Object.keys(data.palettes || {})) {
      for (const p of data.palettes[platform]) {
        const key = `${platform}/${p.slug}`;
        const item = index.get(key) || {
          slug: p.slug,
          platform,
          roles: p.roles,
          contrast: p.contrast,
          score: p.score,
          source: p.source,
          page: p.page,
          json: p.json,
          css: p.css,
        };
        item[`name${suffix}`] = p.name;
        item[`scene${suffix}`] = p.scene;
        item[`tags${suffix}`] = p.tags || [];
        item[`advice${suffix}`] = p.advice;
        item[`colors${suffix}`] = p.colors || [];
        index.set(key, item);
      }
    }
  };
  eat(dataEn, 'En');
  eat(dataZh, 'Zh');
  return [...index.values()];
}

const PALETTES = mergePalettes();

/* ---------------- 工具：文本格式化与检索（照搬 stdio 版） ---------------- */

const fmtPalette = (p) => {
  const names = p.nameZh && p.nameZh !== p.nameEn ? `${p.nameEn} / ${p.nameZh}` : p.nameEn;
  const primary = p.roles?.primary || p.roles?.theme || Object.values(p.roles || {})[0];
  return [
    `- ${names}（${p.platform}，分 ${p.score ?? '—'}）`,
    `  slug: ${p.slug}　主色: ${primary}`,
    `  场景: ${p.sceneEn}${p.sceneZh ? `（${p.sceneZh}）` : ''}`,
    `  标签: ${[...new Set([...(p.tagsEn || []), ...(p.tagsZh || [])])].join(', ')}`,
  ].join('\n');
};

function scoreMatch(p, tokens) {
  const hay = {
    tags: [...(p.tagsEn || []), ...(p.tagsZh || [])].join(' ').toLowerCase(),
    scene: `${p.sceneEn || ''} ${p.sceneZh || ''}`.toLowerCase(),
    name: `${p.nameEn || ''} ${p.nameZh || ''}`.toLowerCase(),
  };
  let score = 0;
  const hits = [];
  for (const tk of tokens) {
    if (hay.tags.includes(tk)) { score += 3; hits.push(`标签:${tk}`); }
    else if (hay.scene.includes(tk)) { score += 2; hits.push(`场景:${tk}`); }
    else if (hay.name.includes(tk)) { score += 1; hits.push(`名称:${tk}`); }
  }
  return { score, hits };
}

/* ---------------- 工具：CSS 变量本地生成（与站点 /index.css 端点同格式） ---------------- */

function cssVariables(p) {
  const r = p.roles || {};
  const colors = p.colorsEn?.length ? p.colorsEn : p.colorsZh || [];
  const semantic = [
    ['--color-primary', r.primary ?? r.theme ?? r.btn],
    ['--color-primary-dark', r.primaryDark ?? r.primaryHover ?? r.primaryActive],
    ['--color-primary-light', r.primaryLight ?? r.btnDisabled ?? r.tag],
    ['--color-secondary', r.secondary],
    ['--color-accent', r.accent ?? r.price],
    ['--color-success', r.success],
    ['--color-warning', r.warning],
    ['--color-danger', r.danger],
    ['--color-bg', r.bg],
    ['--color-surface', r.surface ?? r.card],
    ['--color-border', r.border ?? r.divider],
    ['--color-text', r.text ?? r.textMain],
    ['--color-text-sub', r.textSub],
  ];
  const names = p.nameZh && p.nameZh !== p.nameEn ? `${p.nameEn} / ${p.nameZh}` : p.nameEn;
  return `/* ${names} — ${PLATFORM_LABEL[p.platform] || p.platform} palette
 * PaletteGet · WCAG-checked color roles
 * Page: ${p.page}
 * Scene: ${p.sceneEn}${p.sceneZh ? ` / ${p.sceneZh}` : ''}
 */

:root {
${semantic.filter(([, v]) => Boolean(v)).map(([k, v]) => `  ${k}: ${v};`).join('\n')}

  /* Raw roles */
${colors.map((c) => `  --${c.key}: ${c.hex}; /* ${c.label} */`).join('\n')}
}
`;
}

/* ---------------- 工具分发 ---------------- */

async function callTool(name, args = {}) {
  if (name === 'list_palettes') {
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
    let list = PALETTES;
    if (args.platform) list = list.filter((p) => p.platform === args.platform);
    if (args.tag) {
      const tag = String(args.tag).toLowerCase();
      list = list.filter((p) =>
        [...(p.tagsEn || []), ...(p.tagsZh || [])].some((t) => t.toLowerCase().includes(tag))
      );
    }
    list = list.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
    if (!list.length) return '没有匹配的配色，试试放宽平台或标签条件。';
    return `共 ${list.length} 套：\n${list.map(fmtPalette).join('\n')}`;
  }

  if (name === 'get_palette') {
    const slug = String(args.slug || '').toLowerCase();
    const hit = PALETTES.find(
      (p) => p.slug.toLowerCase() === slug && (!args.platform || p.platform === args.platform)
    );
    if (!hit) return `没找到 slug 为「${args.slug}」的配色（可用 list_palettes 或 suggest_palette 查找）。`;
    return JSON.stringify(
      {
        slug: hit.slug,
        platform: hit.platform,
        name: hit.nameEn,
        nameZh: hit.nameZh,
        scene: hit.sceneEn,
        sceneZh: hit.sceneZh,
        tags: [...new Set([...(hit.tagsEn || []), ...(hit.tagsZh || [])])],
        score: hit.score,
        roles: hit.roles,
        contrast: hit.contrast,
        advice: hit.adviceEn,
        adviceZh: hit.adviceZh,
        css: hit.css,
        page: hit.page,
      },
      null,
      2
    );
  }

  if (name === 'suggest_palette') {
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 5;
    const tokens = String(args.query || '')
      .toLowerCase()
      .split(/[\s,，、/]+/)
      .filter(Boolean);
    if (!tokens.length) return '请给一些关键词，例如「深色 记账」或「fresh blog」。';

    let pool = PALETTES;
    if (args.platform) pool = pool.filter((p) => p.platform === args.platform);
    const ranked = pool
      .map((p) => ({ p, ...scoreMatch(p, tokens) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.p.score || 0) - (a.p.score || 0))
      .slice(0, limit);

    if (!ranked.length) {
      return `没有配色命中「${args.query}」。可用标签示例：暗黑 / Dark、清新 / Fresh、商务 / Business、国风 / Heritage、莫兰迪 / Morandi。`;
    }
    return ranked
      .map((r) => `${fmtPalette(r.p)}\n  命中: ${r.hits.join('、')}`)
      .join('\n\n');
  }

  if (name === 'get_css_variables') {
    const slug = String(args.slug || '').toLowerCase();
    const hit = PALETTES.find(
      (p) => p.slug.toLowerCase() === slug && (!args.platform || p.platform === args.platform)
    );
    if (!hit) return `没找到 slug 为「${args.slug}」的配色。`;
    return cssVariables(hit);
  }

  return { __unknownTool: name };
}

/* ---------------- 工具清单（与 stdio 版同一套 schema） ---------------- */

const TOOLS = [
  {
    name: 'list_palettes',
    description:
      '列出配色库中的配色，可按平台（app / web / miniapp）与标签过滤。返回名称、slug、主色、场景与标签。',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: PLATFORMS, description: '平台，不填则三端都列' },
        tag: { type: 'string', description: '标签过滤，支持中英文，如 暗黑 / Dark' },
        limit: { type: 'number', description: '最多返回几条，默认 10' },
      },
    },
  },
  {
    name: 'get_palette',
    description: '取某一套配色的完整数据：角色色值（主色 / 功能色 / 中性色）、对比度、人工搭配建议。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '配色 slug，如 jing-hu-lan' },
        platform: { type: 'string', enum: PLATFORMS, description: '平台，不填则在三端中查找该 slug' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'suggest_palette',
    description:
      '按自然语言关键词推荐配色（中英文均可），例如「护眼的深色记账 App」「清新博客」。会说明每个结果命中了什么。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分隔，如「深色 记账」' },
        platform: { type: 'string', enum: PLATFORMS },
        limit: { type: 'number', description: '最多返回几条，默认 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_css_variables',
    description: '取一套配色的 CSS 自定义属性（可直接粘进项目），含语义化变量名。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '配色 slug' },
        platform: { type: 'string', enum: PLATFORMS },
      },
      required: ['slug'],
    },
  },
];

/* ---------------- JSON-RPC / Streamable HTTP ---------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'content-type, mcp-session-id, last-event-id, mcp-protocol-version, authorization',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

async function handleRpcMessage(msg) {
  // 通知（无 id）：按规范不回内容，调用方收到 202
  if (msg.id === undefined || msg.id === null) return null;

  const { method, params = {}, id } = msg;

  if (method === 'initialize') {
    const requested = String(params.protocolVersion || '');
    return rpcResult(id, {
      protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'PaletteGet is a library of WCAG-checked color palettes for App / Web / Mini App UIs. ' +
        'Use suggest_palette for natural-language recommendations, get_palette for exact role hex values, ' +
        'get_css_variables for ready-to-paste CSS custom properties.',
    });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      const out = await callTool(name, args || {});
      if (out && typeof out === 'object' && out.__unknownTool) {
        return rpcError(id, -32602, `未知工具：${out.__unknownTool}`);
      }
      return rpcResult(id, { content: [{ type: 'text', text: String(out) }] });
    } catch (err) {
      return rpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: `调用失败：${err instanceof Error ? err.message : String(err)}` }],
      });
    }
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function handleMcpPost(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }

  // JSON-RPC 支持批量；MCP 实践里以单条为主，批量也能处理
  const messages = Array.isArray(body) ? body : [body];
  if (!messages.length || messages.some((m) => m?.jsonrpc !== '2.0' || typeof m?.method !== 'string')) {
    return json(rpcError(null, -32600, 'Invalid Request'), 400);
  }

  const results = [];
  for (const msg of messages) {
    const r = await handleRpcMessage(msg);
    if (r) results.push(r);
  }

  if (!results.length) return new Response(null, { status: 202, headers: CORS });
  return json(Array.isArray(body) ? results : results[0]);
}

const endpointInfo = () => ({
  name: SERVER_INFO.name,
  version: SERVER_INFO.version,
  transport: 'mcp-streamable-http (stateless, JSON responses)',
  endpoint: '/mcp',
  tools: TOOLS.map((t) => t.name),
  palettes: PALETTES.length,
  site: 'https://paletteget.com',
  docs: 'https://paletteget.com/docs/',
});

const ENDPOINT_INFO = () => json(endpointInfo());

/** Smithery 等目录在扫描失败时的静态兜底（/.well-known/mcp/server-card.json） */
const SERVER_CARD = () => ({
  serverInfo: { name: 'PaletteGet', version: SERVER_INFO.version },
  authentication: { required: false },
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
  resources: [],
  prompts: [],
});

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (pathname === '/.well-known/mcp/server-card.json') return json(SERVER_CARD());

    if (pathname === '/mcp') {
      if (request.method === 'POST') return handleMcpPost(request);
      // 无状态服务不提供 SSE 流。GET 返回 200 + 说明，而不是 405：
      // 目录类聚合器会拿 GET 探活，405 会被判成「服务坏了」。
      if (request.method === 'GET') {
        return json({
          ...endpointInfo(),
          note: 'This server is stateless. POST JSON-RPC to /mcp; it answers with plain JSON and does not open an SSE stream.',
        });
      }
      return json(rpcError(null, -32000, 'Method not allowed'), 405);
    }

    // 根路径与其它路径：给人类/客户端一个可读的服务说明
    return ENDPOINT_INFO();
  },
};
