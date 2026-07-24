# AI Web Studio

A white-label, single-page **AI Website Builder** — dark theme, glassmorphism, Tailwind CSS and vanilla JavaScript. No third-party branding anywhere in the interface. **Free forever** — no payments, no subscriptions. Every user gets a pool of free credits that refills automatically every 15 days.

## What's included

| File | Purpose |
|---|---|
| `public/index.html` | The complete front-end app (self-contained: markup, styles, logic) |
| `public/tailwind.css` | Compiled Tailwind build — no CDN dependency |
| `server.js` | Express server: code generation (Groq) + live deploy (Vercel) |
| `package.json` | Minimal manifest (`express` only) |

## Features

- **Hero / prompt state** — headline, large prompt textarea (`Ctrl+Enter` to submit), 6 one-click template chips (SaaS, Portfolio, Crypto Dashboard, Store, Restaurant, Blog).
- **Split-screen workspace** — left *Build Console* with chat bubbles + animated terminal build logs and a follow-up refine input; right panel with **Live Preview** (sandboxed iframe) and **Code Editor** tabs (syntax-highlighted, Copy Code), plus desktop/tablet/mobile viewport toggles.
- **Free credits** — every account starts with **499 credits** and gets a fresh **499 every 15 days**, fully automatic. The header badge shows how many are left and the days until the next refill; tap it any time for a reminder.
- **Deploy & Update** — one-click **Deploy Live** publishes the site; after that the same button becomes **Update Live** and every redeploy pushes your latest edits to the **same stable URL** — exactly like Replit.
- **Project history** — every generation, edit and deploy is saved. The **Projects** panel lets you reopen any past project (code, preview and live link restored) or delete it.
- **Chat-driven edits** — ask for a change in the Build Console and the AI rewrites the full site with your change applied; hit *Update Live* to push it live again.
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

## Live deploy — Vercel

`POST /api/deploy-vercel` publishes the generated HTML to Vercel and returns a stable production URL. Because every deploy uses the **same project name** (derived from the project id), each **Update Live** redeploys to the **same `https://<name>.vercel.app`** — so edits go live again and again without a new link. Configure:

```
VERCEL_TOKEN     your Vercel access token
VERCEL_TEAM_ID   team/scope id (optional — only for team accounts)
```

Vercel's Hobby (free) plan allows ~100 production deploys/day, which is plenty for iterating. Without the token the route returns `501` and the UI shows a demo URL.

### Optional — mirror to GitHub

If you also set a GitHub token, every deploy commits the project's `index.html` to a repo (created automatically), so your work is version-controlled too:

```
GITHUB_TOKEN    token with repo scope
GITHUB_OWNER    your GitHub username
```

This runs in the background and never blocks or fails a deploy.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Requires **Node 18+** (uses the built-in `fetch`, `FormData` and `Blob`). Or open `public/index.html` directly — the demo engine keeps every flow working.
