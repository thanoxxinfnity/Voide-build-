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
});
