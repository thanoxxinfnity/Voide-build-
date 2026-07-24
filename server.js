/**
 * AI Web Studio — Express backend
 *
 * Serves the front-end from /public and exposes two API routes:
 *   POST /api/generate-code   → generates a full HTML website from a prompt (Groq)
 *   POST /api/deploy-vercel   → publishes the site to a live URL (Vercel)
 *
 * Everything is FREE — no billing, no payments. Users get a pool of free
 * credits that refills automatically (handled entirely on the front-end).
 *
 * Configure with environment variables (all optional — without them the
 * front-end falls back to its built-in demo engine so the UI stays usable):
 *
 *   GROQ_API_KEY               your Groq API key (code generation)
 *   GROQ_MODEL                 model id (default: llama-3.3-70b-versatile)
 *
 *   VERCEL_TOKEN               Vercel access token (live deploy)
 *   VERCEL_TEAM_ID             team/scope id (optional, only for team accounts)
 *
 *   GITHUB_TOKEN               optional — mirror each project to a GitHub repo
 *   GITHUB_OWNER               your GitHub username (required if GITHUB_TOKEN set)
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*  Authentication — email + password, hashed, signed tokens          */
/*  No third-party auth deps; users persist to data/users.json.       */
/* ------------------------------------------------------------------ */
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let store = { secret: null, users: {} };
let storeWritable = true;

function saveStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(store));
  } catch (err) {
    storeWritable = false; // fall back to in-memory for this session
  }
}
function loadStore() {
  try { store = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { /* fresh store */ }
  if (!store.users) store.users = {};
  if (!store.secret) { store.secret = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex'); saveStore(); }
}
loadStore();

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', store.secret).update(body).digest());
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', store.secret).update(body).digest());
  if (sig !== expected) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
  catch { return null; }
  if (p.exp && Date.now() > p.exp) return null;
  return p;
}
function bearer(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

app.post('/api/auth/signup', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (store.users[email]) return res.status(409).json({ error: 'Account already exists — please sign in' });

  const { salt, hash } = hashPassword(password);
  const user = { id: 'user_' + crypto.randomBytes(6).toString('hex'), email, salt, hash, createdAt: Date.now() };
  store.users[email] = user;
  saveStore();
  const token = signToken({ uid: user.id, email, exp: Date.now() + TOKEN_TTL });
  res.json({ token, user: { id: user.id, email } });
});

app.post('/api/auth/login', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const user = store.users[email];
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  const token = signToken({ uid: user.id, email, exp: Date.now() + TOKEN_TTL });
  res.json({ token, user: { id: user.id, email } });
});

app.get('/api/auth/me', (req, res) => {
  const p = verifyToken(bearer(req));
  if (!p) return res.status(401).json({ error: 'not authenticated' });
  res.json({ user: { id: p.uid, email: p.email } });
});

/* ------------------------------------------------------------------ */
/*  Code generation — OpenAI-compatible chat completions              */
/*                                                                    */
/*  Works with any OpenAI-style provider (Groq, OpenAI, OpenRouter,   */
/*  Together, Mistral, local LLMs, …). The server proxies the request */
/*  so custom models added in the UI Settings work without CORS       */
/*  issues and keys never touch third-party browser code.             */
/* ------------------------------------------------------------------ */

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = [
  'You are an expert front-end engineer and UI designer.',
  'Generate a COMPLETE, single-file, production-ready website as ONE HTML document.',
  'Rules:',
  '- Return ONLY raw HTML. Start with <!DOCTYPE html> and end with </html>.',
  '- No markdown, no code fences, no explanations before or after.',
  '- Inline ALL CSS inside a <style> tag and ALL JS inside a <script> tag — the file must work standalone.',
  '- Modern, beautiful, responsive design that looks great on mobile and desktop.',
  '- Use semantic HTML, accessible markup, and tasteful animations.',
  '- Do NOT reference any external files, frameworks, or CDNs — everything self-contained.',
].join('\n');

function providerError(status, detail) {
  const err = new Error(`provider responded ${status}`);
  err.status = status;
  err.detail = String(detail || '').slice(0, 300);
  return err;
}

// --- OpenAI-compatible (OpenAI, Groq, OpenRouter, Together, Mistral, local) ---
async function callOpenAI({ endpoint, apiKey, model }, system, user) {
  let base = String(endpoint || '').trim().replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 8000,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw providerError(r.status, await r.text().catch(() => ''));
  const d = await r.json();
  return d?.choices?.[0]?.message?.content || '';
}

// --- Anthropic (Claude) ---
async function callAnthropic({ endpoint, apiKey, model }, system, user) {
  const url = (String(endpoint || '').trim().replace(/\/+$/, '')) || 'https://api.anthropic.com/v1/messages';
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw providerError(r.status, await r.text().catch(() => ''));
  const d = await r.json();
  return (d?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') || '';
}

// --- Google Gemini ---
async function callGemini({ endpoint, apiKey, model }, system, user) {
  const base = (String(endpoint || '').trim().replace(/\/+$/, '')) || 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey || '')}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8000 },
    }),
  });
  if (!r.ok) throw providerError(r.status, await r.text().catch(() => ''));
  const d = await r.json();
  return (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('') || '';
}

// Dispatch to the right API based on provider type.
function callProvider(cfg, system, user) {
  switch (cfg.type) {
    case 'anthropic': return callAnthropic(cfg, system, user);
    case 'gemini':    return callGemini(cfg, system, user);
    default:          return callOpenAI(cfg, system, user); // openai / openrouter / custom / groq
  }
}

/**
 * POST /api/generate-code
 * Body:    { prompt, projectId?, userId?, provider? }
 *   provider (optional) — a user-added model from Settings:
 *     { type: 'openai'|'anthropic'|'gemini', endpoint?, apiKey, model }
 *   When absent, the server's default Groq config is used.
 * Returns: { code: string }  — a complete HTML document
 */
app.post('/api/generate-code', async (req, res) => {
  const { prompt, provider } = req.body || {};
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // Pick the provider: a user-supplied model wins, else server Groq.
  let cfg;
  if (provider && provider.model && (provider.endpoint || provider.type === 'anthropic' || provider.type === 'gemini')) {
    cfg = {
      type: provider.type || 'openai',
      endpoint: provider.endpoint || '',
      apiKey: provider.apiKey || '',
      model: provider.model,
    };
  } else if (process.env.GROQ_API_KEY) {
    cfg = { type: 'openai', endpoint: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY, model: GROQ_MODEL };
  } else {
    return res.status(501).json({ error: 'no model configured — add one in Settings or set GROQ_API_KEY' });
  }

  let raw;
  try {
    raw = await callProvider(cfg, SYSTEM_PROMPT, prompt);
  } catch (err) {
    console.error('generation error:', err.message, err.detail || '');
    return res.status(502).json({ error: err.detail ? `${err.message}: ${err.detail}` : err.message });
  }

  // Strip accidental markdown fences if the model added them.
  const code = String(raw || '').replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!code || !/<html|<!doctype/i.test(code)) {
    return res.status(502).json({ error: 'generation returned invalid HTML' });
  }
  return res.json({ code });
});

/* ------------------------------------------------------------------ */
/*  Deploy — Vercel (publishes the generated HTML to a live URL)      */
/*                                                                    */
/*  Deploying with the SAME project name every time (derived from     */
/*  projectId) means every "Update" redeploys to the same stable      */
/*  https://<name>.vercel.app production URL — exactly like Replit.    */
/*  Optionally mirrors the code to a GitHub repo (GITHUB_TOKEN) so    */
/*  every project is version-controlled too.                          */
/* ------------------------------------------------------------------ */

// Turn a projectId into a safe, stable Vercel/GitHub project name.
function projectName(projectId) {
  return ('site-' + String(projectId || Math.random().toString(36).slice(2, 8)))
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 52);
}

// Best-effort mirror of the current code to a GitHub repo (create or update).
// Never blocks deployment — failures are logged and ignored.
async function mirrorToGitHub(name, code) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;
  const owner = process.env.GITHUB_OWNER;
  if (!owner) return;

  const gh = (url, opts = {}) =>
    fetch(`https://api.github.com${url}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ai-web-studio',
        ...(opts.headers || {}),
      },
    });

  try {
    // Ensure the repo exists (ignore "already exists" errors).
    await gh('/user/repos', {
      method: 'POST',
      body: JSON.stringify({ name, private: false, auto_init: true }),
    });

    // Look up the existing file sha (needed to update in place).
    let sha;
    const cur = await gh(`/repos/${owner}/${name}/contents/index.html`);
    if (cur.ok) sha = (await cur.json()).sha;

    await gh(`/repos/${owner}/${name}/contents/index.html`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Update site via AI Web Studio',
        content: Buffer.from(code, 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
      }),
    });
  } catch (err) {
    console.warn('GitHub mirror skipped:', err.message);
  }
}

/**
 * POST /api/deploy-vercel
 * Body:    { projectId?: string, userId?: string, code: string }
 * Returns: { url: string } — the live production URL (stable across updates)
 */
app.post('/api/deploy-vercel', async (req, res) => {
  const { projectId, code } = req.body || {};
  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }

  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    return res.status(501).json({ error: 'VERCEL_TOKEN not configured' });
  }

  const name = projectName(projectId);
  const teamId = process.env.VERCEL_TEAM_ID;
  const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';

  try {
    const r = await fetch(`https://api.vercel.com/v13/deployments${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        target: 'production', // production → stable <name>.vercel.app URL
        files: [
          { file: 'index.html', data: Buffer.from(code, 'utf8').toString('base64'), encoding: 'base64' },
        ],
        projectSettings: { framework: null },
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('Vercel error:', r.status, JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: data?.error?.message || 'deploy failed' });
    }

    // Mirror to GitHub in the background (does not delay the response).
    mirrorToGitHub(name, code);

    // Prefer the stable production alias; fall back to the project domain.
    const alias = Array.isArray(data.alias) && data.alias.length ? data.alias[0] : `${name}.vercel.app`;
    return res.json({ url: `https://${alias}` });
  } catch (err) {
    console.error('deploy failed:', err.message);
    return res.status(502).json({ error: 'deploy service unreachable' });
  }
});

app.listen(PORT, () => {
  console.log(`AI Web Studio running at http://localhost:${PORT}`);
  console.log(`  Code generation : ${process.env.GROQ_API_KEY ? 'Groq (live)' : 'demo engine (no GROQ_API_KEY)'}`);
  console.log(`  Deploy          : ${process.env.VERCEL_TOKEN ? 'Vercel (live)' : 'demo URL (no VERCEL_TOKEN)'}`);
  console.log(`  GitHub mirror   : ${process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER ? 'on' : 'off'}`);
  console.log(`  Auth            : ${storeWritable ? 'file store (data/users.json)' : 'in-memory (disk not writable)'}`);
});
