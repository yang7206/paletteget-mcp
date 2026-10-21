#!/usr/bin/env node
/**
 * PaletteGet MCP server
 * ------------------------------------------------------------
 * 把配色库接进支持 MCP 的 AI 编码工具（Claude Desktop / Cursor / Windsurf 等），
 * 让模型可以直接「查配色」而不是靠记忆编色值。
 *
 * 数据来源：线上公开的静态端点，无需 API key：
 *   英文（规范）：https://paletteget.com/api/index.json
 *   中文：        https://paletteget.com/zh/api/index.json
 * 两个语言的数据都会加载：这样用户用中文提问（「护眼 深色 记账」）也能匹配到
 * 英文站里那些英文场景描述。本地缓存 10 分钟。
 *
 * 为什么用低层 Server API（而不是 McpServer + zod）：低层 API 的 inputSchema
 * 就是普通 JSON Schema，不引入 zod 版本兼容问题，长期更稳。
 *
 * 环境变量：
 *   PALETTEGET_API       覆盖英文数据集地址（默认见上）
 *   PALETTEGET_API_ZH    覆盖中文数据集地址（默认按英文地址推导）
 *   PALETTEGET_CACHE_MS  缓存时长（默认 600000）
 *   PALETTEGET_PROXY     走代理访问（如 http://127.0.0.1:7897）；
 *                        也接受标准的 HTTPS_PROXY / https_proxy
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// 可选代理：Node 内置 fetch 不读 HTTP_PROXY，需要显式装 ProxyAgent。
// 国内网络环境下把 PALETTEGET_PROXY 指向本地代理即可（不设则直连）。
const PROXY = process.env.PALETTEGET_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '';
if (PROXY) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(PROXY));
    console.error(`[paletteget-mcp] 已启用代理：${PROXY}`);
  } catch {
    console.error('[paletteget-mcp] 未安装 undici，代理设置被忽略（将直连）');
  }
}

const API_EN = process.env.PALETTEGET_API || 'https://paletteget.com/api/index.json';
// 中文数据集地址：从英文地址推导（同域下的 /zh/ 前缀），也允许显式覆盖
const API_ZH =
  process.env.PALETTEGET_API_ZH ||
  API_EN.replace(/(\/api\/index\.json)$/, '/zh$1');
const CACHE_MS = Number(process.env.PALETTEGET_CACHE_MS || 600000);

const PLATFORMS = ['app', 'web', 'miniapp'];

/* ---------------- 数据加载与缓存 ---------------- */

let cache = { at: 0, palettes: null };

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'paletteget-mcp' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/**
 * 载入并合并中英数据集
 * 返回 [{ slug, platform, nameEn, nameZh, sceneEn, sceneZh, tagsEn, tagsZh, roles, contrast, score, ... }]
 */
async function loadPalettes() {
  if (cache.palettes && Date.now() - cache.at < CACHE_MS) return cache.palettes;

  const [en, zh] = await Promise.all([
    fetchJson(API_EN),
    fetchJson(API_ZH).catch(() => null), // 中文数据集拿不到也不致命
  ]);

  const index = new Map();
  for (const platform of Object.keys(en.palettes || {})) {
    for (const p of en.palettes[platform]) {
      index.set(`${platform}/${p.slug}`, {
        slug: p.slug,
        platform,
        nameEn: p.name,
        sceneEn: p.scene,
        tagsEn: p.tags || [],
        roles: p.roles,
        contrast: p.contrast,
        score: p.score,
        source: p.source,
        adviceEn: p.advice,
        page: p.page,
        json: p.json,
        css: p.css,
      });
    }
  }
  if (zh?.palettes) {
    for (const platform of Object.keys(zh.palettes)) {
      for (const p of zh.palettes[platform]) {
        const item = index.get(`${platform}/${p.slug}`);
        if (!item) continue;
        item.nameZh = p.name;
        item.sceneZh = p.scene;
        item.tagsZh = p.tags || [];
        item.adviceZh = p.advice;
      }
    }
  }

  const palettes = [...index.values()];
  cache = { at: Date.now(), palettes };
  return palettes;
}

/* ---------------- 文本工具 ---------------- */

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

/** 关键词打分：标签命中权重最高，其次场景、名称 */
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

/* ---------------- 工具定义 ---------------- */

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

/* ---------------- 请求处理 ---------------- */

async function callTool(name, args = {}) {
  const palettes = await loadPalettes();

  if (name === 'list_palettes') {
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
    let list = palettes;
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
    const hit = palettes.find(
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

    let pool = palettes;
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
    const hit = palettes.find(
      (p) => p.slug.toLowerCase() === slug && (!args.platform || p.platform === args.platform)
    );
    if (!hit) return `没找到 slug 为「${args.slug}」的配色。`;
    if (!hit.css) return `该配色没有 CSS 端点：${hit.nameEn}`;
    const res = await fetch(hit.css, { headers: { 'user-agent': 'paletteget-mcp' } });
    if (!res.ok) return `拉取 CSS 失败：HTTP ${res.status}`;
    return await res.text();
  }

  return `未知工具：${name}`;
}

/* ---------------- 启动 ---------------- */

const server = new Server(
  { name: 'paletteget', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const text = await callTool(name, args || {});
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `调用失败：${err instanceof Error ? err.message : String(err)}` }],
    };
  }
});

await server.connect(new StdioServerTransport());
