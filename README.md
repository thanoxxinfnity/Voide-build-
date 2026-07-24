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
POST /api/generate-code      { prompt, projectId, userId }  →  { code }
POST /api/deploy-vercel      { projectId, userId, code }    →  { url }
POST /api/billing/subscribe  { planId, userId }             →  { checkoutUrl } | { subscription }
GET  /api/billing/status     ?userId=…                      →  { subscription }
POST /api/billing/cancel     { userId, subscriptionId }     →  { subscription }
POST /api/billing/webhook    (gateway → server)             →  { ok }
```

## Payment automation (Autopay)

Recurring billing is fully automated — the user pays once to authorize a mandate, and every renewal after that is charged automatically:

1. **Subscribe** — the plan badge (or running out of credits) opens the Billing modal. Choosing *Pro Monthly ₹499* or *Pro Yearly ₹4,999* calls `POST /api/billing/subscribe`.
2. **Mandate setup** — in live mode the server creates a Razorpay Subscription and returns its hosted `checkoutUrl`, where the user authorizes a **UPI Autopay / card e-mandate**. The front-end polls `GET /api/billing/status` until it flips to active.
3. **Auto-renewal** — the gateway auto-debits each cycle and fires `subscription.charged` to `POST /api/billing/webhook` (HMAC-verified), which extends the plan — zero manual payments.
4. **Failure & cancel** — `subscription.halted` / `.cancelled` webhooks turn Autopay off; **Cancel Autopay** in the modal cancels at cycle end, so Pro stays active for the period already paid.

Live mode needs these env vars (demo mode works without them — subscriptions activate instantly so the whole flow is testable):

```
RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET      API keys
RAZORPAY_PLAN_PRO_MONTHLY / _PRO_YEARLY    plan ids created in the dashboard
RAZORPAY_WEBHOOK_SECRET                    webhook signing secret
```

The gateway is server-side only — per the white-label rules, no payment-provider branding appears anywhere in the UI ("Secure UPI Autopay / card e-mandate").

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Or open `public/index.html` directly in a browser — the mock engine keeps every flow working.
