# paletteget-mcp

<p>
  <a href="https://paletteget.com"><img alt="site" src="https://img.shields.io/badge/site-paletteget.com-2563eb"></a>
  <img alt="palettes" src="https://img.shields.io/badge/palettes-100-0e9aa7">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-111827">
</p>

An MCP server for the [PaletteGet](https://paletteget.com) color palette library: 100 palettes
across App, Web and Mini App UIs, each organized into 10 design roles and checked against WCAG
contrast requirements.

It exists so your AI coding tool stops inventing hex values. Instead of guessing, the model calls
a tool and gets the real role colors, the measured contrast ratios, and the pairing advice that
ships with the palette.

No API key, no sign-up.

## Use the hosted endpoint (nothing to install)

```
https://paletteget-mcp.y7206062.workers.dev/mcp
```

```json
{
  "mcpServers": {
    "paletteget": {
      "type": "http",
      "url": "https://paletteget-mcp.y7206062.workers.dev/mcp"
    }
  }
}
```

ChatGPT: Settings → Connectors → Add custom connector → paste the URL.

The hosted server embeds the dataset at deploy time, so it never depends on the site being
reachable and answers in a few milliseconds.

## Or run it locally (stdio)

### From npm, no clone

```bash
npx -y paletteget-mcp
```

```json
{
  "mcpServers": {
    "paletteget": {
      "command": "npx",
      "args": ["-y", "paletteget-mcp"]
    }
  }
}
```

Behind a proxy, set `PALETTEGET_PROXY=http://127.0.0.1:7897` in the server's `env` block.

### From source

```bash
git clone https://github.com/yang7206/paletteget-mcp.git
cd paletteget-mcp
npm install
```

```json
{
  "mcpServers": {
    "paletteget": {
      "command": "node",
      "args": ["/absolute/path/to/paletteget-mcp/index.mjs"]
    }
  }
}
```

The stdio server fetches live data from the public JSON endpoints and caches it for 10 minutes.

## Tools

| Tool | What it does |
|---|---|
| `list_palettes` | List palettes, optionally filtered by platform (`app` / `web` / `miniapp`) or tag |
| `get_palette` | Full data for one palette: role colors, contrast results, human-written pairing advice |
| `suggest_palette` | Recommend palettes from keywords in English or Chinese, and say what matched |
| `get_css_variables` | CSS custom properties for a palette, ready to paste |
| `check_contrast` | WCAG contrast between any two colors, with both the body-text and large-text verdicts |
| `suggest_text_color` | Readable text colors for a given background: same-hue tints and shades plus black and white, ranked by contrast |
| `darken_palette` | Derive a dark-mode version of a light palette with published rules, and the measured contrast of every pair |
| `get_platform_snippet` | Paste-ready code for one palette: Android `colors.xml`, iOS `UIColor`, Flutter `Color`, mini program `wxss`, CSS, SCSS or Tailwind |
| `get_color_scale` | Expand one base color into a 50 to 900 scale, with white and black contrast per step; JSON, CSS or Tailwind output |

Example call and result:

```
suggest_palette { "query": "dark finance dashboard", "limit": 2 }

- Ink Blue Night / 墨蓝夜（app，分 94）
  slug: mo-lan-ye　主色: #4c8df6
  场景: Finance & analytics apps (dark mode)
  命中: 标签:dark, 场景:finance
```

## Environment variables (stdio server)

| Variable | Default | Purpose |
|---|---|---|
| `PALETTEGET_API` | `https://paletteget.com/api/index.json` | Override the dataset URL |
| `PALETTEGET_API_ZH` | derived (`/zh/api/index.json`) | Override the Chinese dataset URL |
| `PALETTEGET_CACHE_MS` | `600000` | Cache lifetime in milliseconds |
| `PALETTEGET_PROXY` | none | Route requests through a proxy, e.g. `http://127.0.0.1:7897`. Also honours `HTTPS_PROXY`. |

Behind a firewall, Node's built-in `fetch` ignores the usual proxy variables, so set
`PALETTEGET_PROXY` explicitly.

## Test

```bash
npm run smoke
```

The smoke test speaks the MCP stdio protocol directly and exercises every tool against a local
fixture, so it runs offline. Point `PALETTEGET_API` at the live site to test against production.

## Maintaining the hosted worker

The worker (`worker.mjs`) is a hand-written, stateless subset of MCP Streamable HTTP
(`initialize`, `tools/list`, `tools/call`, `ping`) with no SDK dependency, which keeps it small and
Workers-native.

```bash
# 1. Regenerate the embedded dataset (run both locales)
SITE_URL=https://paletteget.com SITE_LOCALE=zh node --import ./alias-loader.mjs build-data.mjs
SITE_URL=https://paletteget.com SITE_LOCALE=en node --import ./alias-loader.mjs build-data.mjs

# 2. Local check
npx wrangler dev          # POST JSON-RPC to http://127.0.0.1:8787/mcp

# 3. Deploy (needs CLOUDFLARE_API_TOKEN with Workers Scripts:Edit)
npx wrangler deploy
```

`build-data.mjs` reuses the site's own i18n modules through `alias-hooks.mjs`, so names, scenes and
advice stay identical to the published site. `data/` is generated at build time and never committed.

## Data and license

Code is MIT (see `LICENSE`). Palette data comes from [paletteget.com](https://paletteget.com) and
may be reused freely in personal and commercial projects; a credit link is appreciated.

Machine-readable forms of the same data, if you would rather skip MCP entirely:

- Full dataset: `https://paletteget.com/api/index.json`
- One palette: `https://paletteget.com/palette-list/{platform}/{slug}/index.json`
- CSS variables: `https://paletteget.com/palette-list/{platform}/{slug}/index.css`
- Agent guide: `https://paletteget.com/llms.txt`
