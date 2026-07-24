# AI Web Studio

A white-label, single-page **AI Website Builder** UI — dark theme, glassmorphism, Tailwind CSS and vanilla JavaScript. No third-party AI or hosting branding anywhere in the interface.

## What's included

| File | Purpose |
|---|---|
| `public/index.html` | The complete front-end app (self-contained: markup, styles, logic) |
| `server.js` | Reference Express server with the two API routes stubbed out |
| `package.json` | Minimal manifest (`express` only) |

## Features

- **Hero / prompt state** — headline, large prompt textarea (`Ctrl+Enter` to submit), 6 one-click template chips (SaaS, Portfolio, Crypto Dashboard, Store, Restaurant, Blog).
- **Split-screen workspace** — left *Build Console* with chat bubbles + animated terminal build logs ("Analyzing prompt…", "Writing Tailwind CSS styles…", "Complete!") and a follow-up refine input; right panel with **Live Preview** (sandboxed iframe) and **Code Editor** tabs (syntax-highlighted, Copy Code button), plus desktop/tablet/mobile viewport toggles.
- **Header** — custom "AI Web Studio" branding, ⚡ PRO Plan + credits badge, New Project, Download Code (saves the generated `index.html`), and 🚀 Deploy Live.
- **Deploy modal** — animated deploying → success (live URL with Copy / Visit) → error states.
- **Mobile friendly** — panels collapse into a Chat / Output switcher below `768px`.

## API contract

The front-end calls these endpoints and degrades gracefully to a built-in mock engine when they're absent, so the UI is fully demoable before the backend is wired up:

```
POST /api/generate-code   { prompt, projectId, userId }  →  { code }
POST /api/deploy-vercel   { projectId, userId, code }    →  { url }
```

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Or open `public/index.html` directly in a browser — the mock engine keeps every flow working.
