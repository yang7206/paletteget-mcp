import { register } from 'node:module';
register(new URL('./alias-hooks.mjs', import.meta.url));

// src 里的模块读 import.meta.env（Astro 注入）；Node 下用环境变量等价替换（见 alias-hooks.mjs load 钩子）
globalThis.__WB_ENV__ = {
  BASE_URL: process.env.SITE_BASE || '/',
  SITE: process.env.SITE_URL || 'https://palette.example.com',
  SITE_LOCALE: process.env.SITE_LOCALE,
};
