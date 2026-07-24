/**
 * AI Web Studio — Express backend
 *
 * Serves the front-end from /public and exposes two API routes:
 *   POST /api/generate-code   → generates a full HTML website from a prompt (Groq)
 *   POST /api/deploy-vercel    → publishes the site to a live URL (Cloudflare Workers)
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
 *   CLOUDFLARE_API_TOKEN       token with "Workers Scripts:Edit" permission
 *   CLOUDFLARE_ACCOUNT_ID      your Cloudflare account id
 */
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*  Code generation — Groq                                            */
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

/**
 * POST /api/generate-code
 * Body:    { prompt: string, projectId?: string, userId?: string }
 * Returns: { code: string }  — a complete HTML document
 */
app.post('/api/generate-code', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  if (!process.env.GROQ_API_KEY) {
    return res.status(501).json({ error: 'GROQ_API_KEY not configured' });
  }

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.7,
        max_tokens: 8000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('Groq error:', r.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'generation service error' });
    }

    const data = await r.json();
    let code = data?.choices?.[0]?.message?.content || '';

    // Strip accidental markdown fences if the model added them.
    code = code.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();

    if (!code || !/<html|<!doctype/i.test(code)) {
      return res.status(502).json({ error: 'generation returned invalid HTML' });
    }
    return res.json({ code });
  } catch (err) {
    console.error('generate-code failed:', err.message);
    return res.status(502).json({ error: 'generation service unreachable' });
  }
});

/* ------------------------------------------------------------------ */
/*  Deploy — Cloudflare Workers (serves the generated HTML live)      */
/* ------------------------------------------------------------------ */

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cfSubdomain(accountId, token) {
  const r = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  return d?.result?.subdomain || null;
}

/**
 * POST /api/deploy-vercel
 * Body:    { projectId?: string, userId?: string, code: string }
 * Returns: { url: string } — the live deployment URL
 */
app.post('/api/deploy-vercel', async (req, res) => {
  const { projectId, code } = req.body || {};
  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }

  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    return res.status(501).json({ error: 'Cloudflare deploy not configured' });
  }

  // A safe, unique script name (lowercase letters, digits, dashes only).
  const scriptName = (
    'site-' + String(projectId || Math.random().toString(36).slice(2, 8))
  )
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 54);

  // A tiny module Worker that serves the generated HTML on every request.
  const workerCode =
    'const html = ' + JSON.stringify(code) + ';\n' +
    'export default {\n' +
    '  async fetch() {\n' +
    '    return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8" } });\n' +
    '  }\n' +
    '};\n';

  try {
    // 1) Upload the Worker script (ES module, multipart form).
    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-11-01' })
    );
    form.append(
      'worker.js',
      new Blob([workerCode], { type: 'application/javascript+module' }),
      'worker.js'
    );

    const up = await fetch(
      `${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: form }
    );
    if (!up.ok) {
      const detail = await up.text().catch(() => '');
      console.error('CF upload error:', up.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'deploy upload failed' });
    }

    // 2) Enable the workers.dev subdomain route for this script.
    await fetch(
      `${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }
    );

    // 3) Resolve the account's workers.dev subdomain to build the public URL.
    const sub = await cfSubdomain(accountId, token);
    if (!sub) return res.status(502).json({ error: 'could not resolve workers.dev subdomain' });

    return res.json({ url: `https://${scriptName}.${sub}.workers.dev` });
  } catch (err) {
    console.error('deploy failed:', err.message);
    return res.status(502).json({ error: 'deploy service unreachable' });
  }
});

app.listen(PORT, () => {
  console.log(`AI Web Studio running at http://localhost:${PORT}`);
  console.log(`  Code generation : ${process.env.GROQ_API_KEY ? 'Groq (live)' : 'demo engine (no GROQ_API_KEY)'}`);
  console.log(`  Deploy          : ${process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID ? 'Cloudflare (live)' : 'demo URL (no Cloudflare keys)'}`);
});
