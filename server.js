/**
 * AI Web Studio — Express backend (reference implementation)
 *
 * Serves the front-end from /public and exposes the two API routes the UI
 * calls. Replace the stubbed handlers with your real AI-generation and
 * deployment logic; the front-end already handles loading, success and
 * error states for both.
 */
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

app.listen(PORT, () => {
  console.log(`AI Web Studio running at http://localhost:${PORT}`);
});
