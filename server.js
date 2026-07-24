/**
 * AI Web Studio — Express backend (reference implementation)
 *
 * Serves the front-end from /public and exposes the API routes the UI calls.
 *
 * Billing / Autopay: powered by Razorpay Subscriptions (UPI Autopay / card
 * e-mandate). Set these env vars to go live:
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET     — API keys
 *   RAZORPAY_PLAN_PRO_MONTHLY                — plan id (₹499/month)
 *   RAZORPAY_PLAN_PRO_YEARLY                 — plan id (₹4,999/year)
 *   RAZORPAY_WEBHOOK_SECRET                  — webhook signing secret
 * Without keys, billing runs in demo mode (instantly-active subscriptions)
 * so the front-end remains fully functional during development.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ */
/*  Billing configuration                                             */
/* ------------------------------------------------------------------ */
const PLANS = {
  pro_monthly: { label: 'Pro Monthly', amount: 49900,  currency: 'INR', months: 1,  razorpayPlanId: process.env.RAZORPAY_PLAN_PRO_MONTHLY },
  pro_yearly:  { label: 'Pro Yearly',  amount: 499900, currency: 'INR', months: 12, razorpayPlanId: process.env.RAZORPAY_PLAN_PRO_YEARLY },
};

// In-memory store for the demo — replace with your database.
const db = { subscriptions: new Map() };

let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  try {
    const Razorpay = require('razorpay');
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  } catch (err) {
    console.warn('razorpay package unavailable — billing runs in demo mode');
  }
}

function nextBillingAt(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

/* ------------------------------------------------------------------ */
/*  Payment webhook — the heart of Autopay automation.                */
/*  Registered BEFORE express.json() because signature verification   */
/*  requires the raw request body.                                    */
/* ------------------------------------------------------------------ */
app.post('/api/billing/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (secret) {
    const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    if (expected !== req.headers['x-razorpay-signature']) {
      return res.status(400).json({ error: 'invalid signature' });
    }
  }

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); }
  catch { return res.status(400).json({ error: 'bad payload' }); }

  const sub = event.payload && event.payload.subscription && event.payload.subscription.entity;
  const userId = sub && sub.notes && sub.notes.userId;
  if (!userId) return res.json({ ok: true });

  switch (event.event) {
    // Mandate authorized, or a recurring auto-debit succeeded:
    // extend the plan for another cycle. This fires automatically on
    // every renewal — the user never has to pay manually again.
    case 'subscription.activated':
    case 'subscription.charged': {
      const planId = sub.notes.planId;
      const months = (PLANS[planId] && PLANS[planId].months) || 1;
      db.subscriptions.set(userId, {
        id: sub.id, planId, status: 'active', autopay: true,
        nextBillingAt: nextBillingAt(months),
      });
      break;
    }
    // Auto-debit failed repeatedly, user cancelled the mandate, or the
    // subscription ran out: turn Autopay off.
    case 'subscription.halted':
    case 'subscription.cancelled':
    case 'subscription.expired': {
      const cur = db.subscriptions.get(userId);
      if (cur) db.subscriptions.set(userId, { ...cur, status: 'cancelled', autopay: false });
      break;
    }
  }
  res.json({ ok: true });
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*  Code generation & deploy                                          */
/* ------------------------------------------------------------------ */

/**
 * POST /api/generate-code
 * Body:    { prompt: string, projectId: string, userId: string }
 * Returns: { code: string }  — a complete HTML document
 */
app.post('/api/generate-code', async (req, res) => {
  const { prompt, projectId, userId } = req.body || {};
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // TODO: call your AI provider here and return the generated HTML.
  // const code = await generateWebsite({ prompt, projectId, userId });
  // return res.json({ code });

  return res.status(501).json({ error: 'generate-code not implemented yet' });
});

/**
 * POST /api/deploy-vercel
 * Body:    { projectId: string, userId: string, code: string }
 * Returns: { url: string } — the live deployment URL
 */
app.post('/api/deploy-vercel', async (req, res) => {
  const { projectId, userId, code } = req.body || {};
  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }

  // TODO: push the code to your hosting provider and return the live URL.
  // const url = await deployProject({ projectId, userId, code });
  // return res.json({ url });

  return res.status(501).json({ error: 'deploy not implemented yet' });
});

/* ------------------------------------------------------------------ */
/*  Billing routes                                                    */
/* ------------------------------------------------------------------ */

/**
 * POST /api/billing/subscribe
 * Body: { planId: 'pro_monthly' | 'pro_yearly', userId: string }
 *
 * Live mode  → { subscriptionId, checkoutUrl }
 *   The user authorizes the recurring mandate (UPI Autopay / card
 *   e-mandate) on the hosted checkout page; the webhook above flips the
 *   subscription to active and every future cycle is charged
 *   automatically by the gateway.
 * Demo mode  → { subscription } — instantly active.
 */
app.post('/api/billing/subscribe', async (req, res) => {
  const { planId, userId } = req.body || {};
  const plan = PLANS[planId];
  if (!plan || !userId) {
    return res.status(400).json({ error: 'valid planId and userId are required' });
  }

  if (razorpay && plan.razorpayPlanId) {
    try {
      const sub = await razorpay.subscriptions.create({
        plan_id: plan.razorpayPlanId,
        total_count: planId === 'pro_yearly' ? 5 : 60, // auto-debits covered by the mandate
        customer_notify: 1,
        notes: { userId, planId },
      });
      db.subscriptions.set(userId, { id: sub.id, planId, status: 'created', autopay: true });
      return res.json({ subscriptionId: sub.id, checkoutUrl: sub.short_url });
    } catch (err) {
      console.error('subscription create failed:', err.message);
      return res.status(502).json({ error: 'payment gateway error' });
    }
  }

  const subscription = {
    id: 'sub_demo_' + crypto.randomBytes(4).toString('hex'),
    planId, status: 'active', autopay: true,
    nextBillingAt: nextBillingAt(plan.months),
  };
  db.subscriptions.set(userId, subscription);
  return res.json({ subscription, demo: true });
});

/**
 * GET /api/billing/status?userId=…
 * Polled by the front-end while the user completes the hosted checkout.
 */
app.get('/api/billing/status', (req, res) => {
  res.json({ subscription: db.subscriptions.get(req.query.userId) || null });
});

/**
 * POST /api/billing/cancel
 * Body: { userId: string, subscriptionId: string }
 * Cancels the Autopay mandate at the end of the current cycle — the plan
 * stays active until the period the user already paid for runs out.
 */
app.post('/api/billing/cancel', async (req, res) => {
  const { userId } = req.body || {};
  const sub = db.subscriptions.get(userId);
  if (!sub) return res.status(404).json({ error: 'no active subscription' });

  if (razorpay && !sub.id.startsWith('sub_demo_')) {
    try {
      await razorpay.subscriptions.cancel(sub.id, true); // cancel at cycle end
    } catch (err) {
      console.error('subscription cancel failed:', err.message);
      return res.status(502).json({ error: 'payment gateway error' });
    }
  }

  const updated = { ...sub, status: 'cancelled', autopay: false };
  db.subscriptions.set(userId, updated);
  res.json({ subscription: updated });
});

app.listen(PORT, () => {
  console.log(`AI Web Studio running at http://localhost:${PORT}`);
  console.log(`Billing mode: ${razorpay ? 'LIVE (gateway connected)' : 'DEMO (no gateway keys set)'}`);
});
