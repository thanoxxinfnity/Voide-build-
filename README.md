# AI Web Studio

A white-label, single-page **AI Website Builder** — dark theme, glassmorphism, Tailwind CSS and vanilla JavaScript. No third-party branding anywhere in the interface. **Free forever** — no payments, no subscriptions. Every user gets a pool of free credits that refills automatically every 15 days.

## What's included

| File | Purpose |
|---|---|
| `public/index.html` | The complete front-end app (self-contained: markup, styles, logic) |
| `public/tailwind.css` | Compiled Tailwind build — no CDN dependency |
| `server.js` | Express server: code generation (Groq) + live deploy (Cloudflare) |
| `package.json` | Minimal manifest (`express` only) |

## Features

- **Hero / prompt state** — headline, large prompt textarea (`Ctrl+Enter` to submit), 6 one-click template chips (SaaS, Portfolio, Crypto Dashboard, Store, Restaurant, Blog).
- **Split-screen workspace** — left *Build Console* with chat bubbles + animated terminal build logs and a follow-up refine input; right panel with **Live Preview** (sandboxed iframe) and **Code Editor** tabs (syntax-highlighted, Copy Code), plus desktop/tablet/mobile viewport toggles.
- **Free credits** — every account starts with **499 credits** and gets a fresh **499 every 15 days**, fully automatic. The header badge shows how many are left and the days until the next refill; tap it any time for a reminder.
- **One-click deploy** — animated deploying → success (live URL with Copy / Visit) → error states.
- **Fully mobile friendly** — the header collapses to compact icon buttons, and below `768px` the workspace becomes a Chat / Output switcher.

## API contract

The front-end calls these two endpoints and degrades gracefully to a built-in demo engine when they're absent, so the UI is fully usable before the backend is wired up:

```
POST /api/generate-code   { prompt, projectId, userId }  →  { code }
POST /api/deploy-vercel   { projectId, userId, code }    →  { url }
```

## Code generation — Groq

`POST /api/generate-code` sends the prompt to Groq's chat-completions API and returns a complete, self-contained HTML document. Configure:

```
GROQ_API_KEY    your Groq API key
GROQ_MODEL      model id (optional, default: llama-3.3-70b-versatile)
```

Without `GROQ_API_KEY` the route returns `501` and the front-end falls back to its built-in themed demo generator, so the whole UI still works.

## Live deploy — Cloudflare Workers

`POST /api/deploy-vercel` publishes the generated HTML as a tiny Cloudflare Worker and returns its public `*.workers.dev` URL. Configure:

```
CLOUDFLARE_API_TOKEN    token with "Workers Scripts:Edit" permission
CLOUDFLARE_ACCOUNT_ID   your Cloudflare account id
```

It uploads a module Worker that serves the HTML, enables the `workers.dev` subdomain for that script, and resolves your account subdomain to build the final URL. Without the keys the route returns `501` and the UI shows a demo URL.

> **Note:** enable your `workers.dev` subdomain once in the Cloudflare dashboard (Workers & Pages → your subdomain) before the first live deploy.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Requires **Node 18+** (uses the built-in `fetch`, `FormData` and `Blob`). Or open `public/index.html` directly — the demo engine keeps every flow working.
