# AI Web Studio

A white-label, single-page **AI Website Builder** — dark theme, glassmorphism, Tailwind CSS and vanilla JavaScript. No third-party branding anywhere in the interface. **Free forever** — no payments, no subscriptions. Every user gets a pool of free credits that refills automatically every 15 days.

## What's included

| File | Purpose |
|---|---|
| `public/index.html` | The complete front-end app (self-contained: markup, styles, logic) |
| `public/tailwind.css` | Compiled Tailwind build — no CDN dependency (rebuild with `npx tailwindcss@3 -c tailwind.config.js -i <(printf '@tailwind base;@tailwind components;@tailwind utilities;') -o public/tailwind.css --minify` after adding new classes to `index.html`) |
| `server.js` | Express server: code generation (Groq), live deploy (Vercel), auth/teams/projects API, and a WebSocket server for real-time multiplayer |
| `package.json` | Minimal manifest (`express` + `ws`) |

## Features

- **Hero / prompt state** — headline, large prompt textarea (`Ctrl+Enter` to submit), 6 one-click template chips (SaaS, Portfolio, Crypto Dashboard, Store, Restaurant, Blog).
- **Split-screen workspace** — left *Build Console* with chat bubbles + animated terminal build logs and a follow-up refine input; right panel with **Live Preview** (sandboxed iframe) and a **live, editable Code Editor** (type directly in it — the preview updates as you go, Copy Code), plus desktop/tablet/mobile viewport toggles.
- **Real-time multiplayer** — like Replit, more than one person can build the same project together live. Everyone who has a project open shows up as an avatar stack in the Code Editor tab, and edits made there are broadcast to everyone else's editor and preview instantly over WebSocket (`ws://.../ws`) — no refresh needed. (Simple last-write-wins sync, not full operational-transform — two people editing the exact same line at the exact same instant can overwrite each other, same as pasting over someone mid-edit.)
- **Free credits** — every account starts with **499 credits** and gets a fresh **499 every 15 days**, fully automatic. The header badge shows how many are left and the days until the next refill; tap it any time for a reminder.
- **Deploy & Update** — one-click **Deploy Live** publishes the site; after that the same button becomes **Update Live** and every redeploy pushes your latest edits to the **same stable URL** — exactly like Replit.
- **Project history** — every generation, edit and deploy is saved. The **Projects** panel lets you reopen any past project (code, preview and live link restored) or delete it.
- **Chat-driven edits** — ask for a change in the Build Console and the AI rewrites the full site with your change applied; hit *Update Live* to push it live again.
- **Agentic build flow** — a prompt **clarity score** (0–100); below 95 the AI runs a short **clarification quiz** (option chips + free-text "Other", any language) until the brief is clear, then builds **step-by-step** with **thinking bubbles** narrating each stage ("analyzing… designing… writing HTML… animating… reviewing"). *Thorough mode* paces it deliberately for higher quality.
- **Any model, any company** — add unlimited models in **Settings → Models**: OpenAI, Anthropic (Claude), Google (Gemini), OpenRouter or any OpenAI-compatible endpoint. Each has the right fields; the server proxies the right API shape.
- **Canvas Game mode** — a mode toggle on the hero screen switches from building websites to building playable **HTML5 Canvas games** (endless runners, shooters, breakout, platformers…), with its own template gallery and a dedicated game-dev system prompt. Canvas projects have **no Deploy button** — they're for trying ideas — until you hit **Export to AI Builder**, which unlocks Deploy Live for that project. Builds still spend credits either way.
- **Secrets / env vars** — a private vault (Settings → Secrets). Values never appear in chat; the AI only sees secret **names** to wire placeholders. Paste an API key into chat and a **"Add to secrets"** prompt appears so it's stored safely instead.
- **File upload** — attach images, 3D models (`.glb/.gltf`), video or assets to a prompt (great for 3D/animated sites; CDN libraries like three.js/GSAP are allowed for those builds).
- **Sign in / Sign up required** — real email + password accounts (server-side, scrypt-hashed, signed session tokens). Generating, deploying, downloading, Settings and Projects are all gated behind sign-in — the hero and template gallery are browsable, but the moment you hit **Generate App** (or any other real action) while signed out, sign-in opens with a benefits list and the app **automatically continues your build the instant you're signed in**.
- **Real, server-side build history** — every project is saved to your account (`data/users.json`), not just the browser — sign in on any device and your projects, team memberships and Team Studio content are exactly as you left them.
- **Teams, with a real mailbox** — every signed-in user gets a permanent, auto-generated mailbox address (e.g. `a1b2c3d4@voide.mail`). Create a team in **Settings → Team** (name + a short project description) and it gets its own permanent, random join code (e.g. `9f3e21ab@voide.team`) — the team's "leader" is whoever created it. Anyone can paste that code into **Join a team** to request access; the request lands in the leader's **Mailbox** (header button, with a badge for pending requests) with a 10-minute reference OTP and one-click **Approve/Deny** — no typing codes back and forth. Approved members can see, reopen and edit the team's shared projects, chat in a simple per-team thread, and pick "Build here" so their next builds save to the team instead of their personal history.
- **Fully mobile friendly** — the header collapses to compact icon buttons, and below `768px` the workspace becomes a Chat / Output switcher.

## API contract

The front-end calls these endpoints and degrades gracefully to a built-in demo engine when they're absent, so the UI is fully usable before the backend is wired up:

```
POST   /api/auth/signup     { email, password }                       →  { token, user }
POST   /api/auth/login      { email, password }                       →  { token, user }
GET    /api/auth/me         (Authorization: Bearer <token>)           →  { user }
GET    /api/auth/config     →  { firebase: <public web config> | null }
POST   /api/auth/google     { idToken }                               →  { token, user }

# Everything below requires Authorization: Bearer <token> — signed out gets 401.
POST   /api/generate-code   { prompt, provider?, mode? }              →  { code }
POST   /api/deploy-vercel   { projectId, code }                       →  { url }
GET    /api/projects        →  { projects: [...] }         (yours + any team's)
POST   /api/projects        { id?, name, mode, code, deployedUrl?, teamId? }  →  { project }
DELETE /api/projects/:id    →  { ok: true }
GET    /api/teams           →  { teams: [...] }             (teams you belong to; each has code, description, members, chat)
POST   /api/teams           { name, description? }          →  { team }   (generates a permanent random join code)
POST   /api/teams/join      { code }                        →  { request }  (creates a 10-min OTP request in the owner's mailbox)
DELETE /api/teams/:id/members/:email →  { team }             (owner, or leave yourself)
DELETE /api/teams/:id       →  { ok: true }                  (owner only)
POST   /api/teams/:id/chat  { text }                         →  { message }  (member only)
GET    /api/inbox           →  { address, incoming: [...], sent: [...] }  (your mailbox)
POST   /api/inbox/:id/approve →  { request }                 (one-click — adds the requester to the team)
POST   /api/inbox/:id/deny    →  { request }
```

## Accounts (sign in / sign up)

Email + password auth is built in — no third-party service. Passwords are hashed with `scrypt` (Node's `crypto`), and sessions are stateless **HMAC-signed tokens** (30-day expiry) verified on each request. Users persist to `data/users.json` (git-ignored); if the disk isn't writable the store falls back to in-memory for the session. Set `AUTH_SECRET` to keep tokens valid across restarts:

```
AUTH_SECRET   optional — signing secret for session tokens (random per boot if unset)
```

The hero screen and template gallery are browsable signed-out, but generating, deploying, downloading and Settings/Projects all require an account — that's what makes build history and teams real instead of per-browser localStorage.

### Google sign-in (Firebase)

A **"Continue with Google"** button appears when Firebase is configured. The browser signs in with the Firebase Web SDK (loaded lazily) and sends its **ID token**; the server verifies it against Google's public RS256 certificates and the project id — so **no Admin SDK and no service-account private key are needed** (never put that JSON in the repo — if it's ever shared, rotate it). Only public config is used:

```
FIREBASE_PROJECT_ID          required — enables Google sign-in + token verification
FIREBASE_API_KEY             required — public web api key for the browser
FIREBASE_AUTH_DOMAIN         optional — defaults to <projectId>.firebaseapp.com
FIREBASE_APP_ID              optional
FIREBASE_MESSAGING_SENDER_ID optional
```

Get these from Firebase Console → Project settings → **your Web app's config**. Enable Google as a sign-in provider and add your domain (localhost is allowed by default) under Authentication → Settings → Authorized domains.

## Code generation — Groq (default) + custom models

`POST /api/generate-code` returns a complete, self-contained HTML document. It works with **any OpenAI-compatible chat-completions API**. The server default is Groq:

```
GROQ_API_KEY    your Groq API key
GROQ_MODEL      model id (optional, default: llama-3.3-70b-versatile)
```

Without `GROQ_API_KEY` the route returns `501` and the front-end falls back to its built-in themed demo generator, so the whole UI still works.

### Custom models (Settings → Add Model)

Users can add their own models from the **Settings** panel — no code changes, no env vars. Each model needs a **name**, an **API base URL** (e.g. `https://api.openai.com/v1`), a **model id** (e.g. `gpt-4o-mini`) and an **API key**. The active model is used for both generating and editing sites.

The request body accepts an optional `provider`:

```
POST /api/generate-code { prompt, provider: { type, endpoint, apiKey, model } }
```

`type` is one of `openai` (default, also OpenRouter/Together/Mistral/local), `anthropic` (Claude) or `gemini` (Google). The server proxies the call in that provider's native shape — OpenAI chat-completions, Anthropic `/v1/messages`, or Gemini `:generateContent` — so there are no browser CORS issues and keys travel only to your own backend. For Claude and Gemini the endpoint is optional (the official URL is used). Model settings are stored in the browser's `localStorage`.

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

## Deploy to Render (free)

This repo ships with a `render.yaml` **Blueprint** so Render can set everything up automatically:

1. Push this repo to GitHub (already done if you're reading this on GitHub).
2. Go to [render.com](https://render.com) → **New** → **Blueprint** → connect this repo.
3. Render reads `render.yaml` and creates a **free Web Service** with `npm install` / `npm start` already wired up.
4. Fill in the environment variables it asks for (all optional — the app runs fine with none of them, using demo fallbacks):

   | Variable | Needed for |
   |---|---|
   | `GROQ_API_KEY` | live code generation (default model) |
   | `VERCEL_TOKEN` | live "Deploy / Update" to a real URL |
   | `VERCEL_TEAM_ID` | only if your Vercel token belongs to a team |
   | `GITHUB_TOKEN` + `GITHUB_OWNER` | optional GitHub mirror of each deploy |
   | `FIREBASE_PROJECT_ID` + `FIREBASE_API_KEY` | Google sign-in |

   `AUTH_SECRET` is auto-generated by Render so login sessions survive restarts — you don't need to set it.
5. Click **Apply** — Render builds and gives you a live `https://<your-service>.onrender.com` URL.

No blueprint? You can also just **New → Web Service** manually, point it at this repo, and set Build Command `npm install` / Start Command `npm start` — same result, just done by hand instead of `render.yaml` doing it for you.

> Free Render web services spin down after 15 minutes idle and take ~30–50s to wake back up on the next request — normal on the free tier, not a bug.
