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
const http = require('http');
const { WebSocketServer } = require('ws');

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
  if (!store.teams) store.teams = {};
  if (!store.projects) store.projects = {};
  if (!store.joinRequests) store.joinRequests = {};
  if (!store.secret) { store.secret = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex'); saveStore(); }
}
loadStore();

/* ================================================================
 *  Model Load Balancing — track active requests per model
 *  If one model hits 40/40 capacity, route to next available
 * ================================================================ */
const modelQueues = new Map(); // model name → { active: count, max: 40 }

function getAvailableModel(preferredModel) {
  // If a preferred model is specified and has capacity, use it
  if (preferredModel) {
    if (!modelQueues.has(preferredModel)) {
      modelQueues.set(preferredModel, { active: 0, max: 40 });
    }
    const q = modelQueues.get(preferredModel);
    if (q.active < q.max) return preferredModel;
  }

  // Find the first model with available capacity, or use the one with least load
  let bestModel = null;
  let bestLoad = Infinity;

  for (const [name, q] of modelQueues) {
    if (q.active < q.max && q.active < bestLoad) {
      bestModel = name;
      bestLoad = q.active;
    }
  }

  // If no models have capacity yet, initialize a new model (11th onwards)
  if (!bestModel && modelQueues.size > 0) {
    const modelNum = modelQueues.size + 1;
    bestModel = `model-${modelNum}`;
    modelQueues.set(bestModel, { active: 1, max: 40 });
    return bestModel;
  }

  return bestModel || 'default';
}

function trackModelRequest(modelName, operation) {
  if (!modelQueues.has(modelName)) {
    modelQueues.set(modelName, { active: 0, max: 40 });
  }
  const q = modelQueues.get(modelName);
  if (operation === 'start') {
    q.active++;
  } else if (operation === 'end') {
    q.active = Math.max(0, q.active - 1);
  }
}

// A short, permanent, random handle@domain — used for a user's personal
// mailbox address and for a team's shareable join code. Never regenerated.
function genHandle(domain) {
  return crypto.randomBytes(4).toString('hex') + '@' + domain;
}
function ensureInbox(user) {
  if (user && !user.inboxAddress) { user.inboxAddress = genHandle('voide.mail'); saveStore(); }
  return user?.inboxAddress;
}

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

// Everything that actually DOES something (generate, deploy, save/load
// projects, teams) requires a signed-in account — attaches req.auth = { uid, email }.
function requireAuth(req, res, next) {
  const p = verifyToken(bearer(req));
  if (!p || !p.email) return res.status(401).json({ error: 'Sign in required' });
  req.auth = p;
  ensureInbox(store.users[p.email]);
  next();
}

app.post('/api/auth/signup', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (store.users[email]) return res.status(409).json({ error: 'Account already exists — please sign in' });

  const { salt, hash } = hashPassword(password);
  const user = { id: 'user_' + crypto.randomBytes(6).toString('hex'), email, salt, hash, createdAt: Date.now() };
  ensureInbox(user);
  store.users[email] = user;
  saveStore();
  const token = signToken({ uid: user.id, email, exp: Date.now() + TOKEN_TTL });
  res.json({ token, user: { id: user.id, email, mailbox: user.inboxAddress } });
});

app.post('/api/auth/login', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const user = store.users[email];
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  ensureInbox(user);
  const token = signToken({ uid: user.id, email, exp: Date.now() + TOKEN_TTL });
  res.json({ token, user: { id: user.id, email, mailbox: user.inboxAddress } });
});

app.get('/api/auth/me', (req, res) => {
  const p = verifyToken(bearer(req));
  if (!p) return res.status(401).json({ error: 'not authenticated' });
  const user = store.users[p.email];
  res.json({ user: { id: p.uid, email: p.email, mailbox: ensureInbox(user) } });
});

/* ------------------------------------------------------------------ */
/*  Google / Firebase sign-in                                         */
/*                                                                    */
/*  Only PUBLIC config is used: the browser signs in with Firebase    */
/*  and sends its ID token; the server verifies it against Google's   */
/*  public certificates (RS256) and the project id — NO admin SDK and */
/*  NO service-account private key required. Configure with:          */
/*    FIREBASE_PROJECT_ID   (required to enable Google sign-in)       */
/*    FIREBASE_API_KEY      (public web api key, for the browser)     */
/*    FIREBASE_AUTH_DOMAIN / _APP_ID / _MESSAGING_SENDER_ID (optional)*/
/* ------------------------------------------------------------------ */
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let googleCerts = { at: 0, keys: {} };

async function getGoogleCerts() {
  if (Date.now() - googleCerts.at < 3600000 && Object.keys(googleCerts.keys).length) return googleCerts.keys;
  const r = await fetch(GOOGLE_CERTS_URL);
  if (!r.ok) throw new Error('could not fetch Google certificates');
  googleCerts = { at: Date.now(), keys: await r.json() };
  return googleCerts.keys;
}
function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Verify a Firebase ID token (RS256, Google-signed) without any admin SDK.
async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  let header, payload;
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString());
    payload = JSON.parse(b64urlToBuf(parts[1]).toString());
  } catch { throw new Error('malformed token'); }
  if (header.alg !== 'RS256') throw new Error('unexpected algorithm');

  const cert = (await getGoogleCerts())[header.kid];
  if (!cert) throw new Error('unknown signing key');

  const v = crypto.createVerify('RSA-SHA256');
  v.update(parts[0] + '.' + parts[1]);
  v.end();
  if (!v.verify(cert, b64urlToBuf(parts[2]))) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('token expired');
  if (payload.aud !== projectId) throw new Error('wrong audience');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('wrong issuer');
  if (!payload.sub) throw new Error('missing subject');
  return payload;
}

// Public config the browser needs to run Firebase sign-in.
app.get('/api/auth/config', (req, res) => {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!projectId || !apiKey) return res.json({ firebase: null });
  res.json({
    firebase: {
      apiKey,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
      projectId,
      appId: process.env.FIREBASE_APP_ID || undefined,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || undefined,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`,
    },
  });
});

app.post('/api/auth/google', async (req, res) => {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return res.status(501).json({ error: 'Google sign-in not configured' });
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  let payload;
  try { payload = await verifyFirebaseIdToken(idToken, projectId); }
  catch (err) { return res.status(401).json({ error: 'Invalid Google sign-in: ' + err.message }); }

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'No email on this Google account' });

  let user = store.users[email];
  if (!user) {
    user = { id: 'user_' + crypto.randomBytes(6).toString('hex'), email, provider: 'google', createdAt: Date.now() };
    store.users[email] = user;
  }
  ensureInbox(user);
  saveStore();
  const token = signToken({ uid: user.id, email, exp: Date.now() + TOKEN_TTL });
  res.json({ token, user: { id: user.id, email, mailbox: user.inboxAddress } });
});

/* ------------------------------------------------------------------ */
/*  Teams — real team formation.                                      */
/*  Creating a team generates a permanent, random join code (looks     */
/*  like an email — e.g. 9f3e21ab@voide.team). The creator is the      */
/*  "leader" (owner). Anyone can request to join with that code; the   */
/*  request lands in the owner's personal mailbox with a 10-minute     */
/*  OTP for reference and one-click Approve/Deny. Members can chat in  */
/*  a simple shared team thread.                                      */
/* ------------------------------------------------------------------ */
function teamsForEmail(email) {
  return Object.values(store.teams)
    .filter((t) => t.members.some((m) => m.email === email))
    .map(backfillTeam);
}
function teamRole(team, email) {
  const m = team.members.find((m) => m.email === email);
  return m ? m.role : null;
}
// Defensive backfill for teams created before code/description/chat existed.
function backfillTeam(team) {
  if (!team.code) team.code = genHandle('voide.team');
  if (!team.chat) team.chat = [];
  if (team.description === undefined) team.description = '';
  return team;
}

app.get('/api/teams', requireAuth, (req, res) => {
  res.json({ teams: teamsForEmail(req.auth.email) });
});

app.post('/api/teams', requireAuth, (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60);
  const description = String((req.body || {}).description || '').trim().slice(0, 240);
  if (!name) return res.status(400).json({ error: 'Team name is required' });
  const team = {
    id: 'team_' + crypto.randomBytes(6).toString('hex'),
    name,
    description,
    code: genHandle('voide.team'),
    ownerEmail: req.auth.email,
    members: [{ email: req.auth.email, role: 'owner' }],
    chat: [],
    createdAt: Date.now(),
  };
  store.teams[team.id] = team;
  saveStore();
  res.json({ team });
});

app.delete('/api/teams/:id/members/:email', requireAuth, (req, res) => {
  const team = store.teams[req.params.id];
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const target = String(req.params.email || '').trim().toLowerCase();
  const isOwner = teamRole(team, req.auth.email) === 'owner';
  if (!isOwner && target !== req.auth.email) return res.status(403).json({ error: 'Only the team owner can remove members' });
  if (target === team.ownerEmail) return res.status(400).json({ error: "Can't remove the team owner" });
  team.members = team.members.filter((m) => m.email !== target);
  saveStore();
  res.json({ team: backfillTeam(team) });
});

app.delete('/api/teams/:id', requireAuth, (req, res) => {
  const team = store.teams[req.params.id];
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (teamRole(team, req.auth.email) !== 'owner') return res.status(403).json({ error: 'Only the team owner can delete the team' });
  delete store.teams[req.params.id];
  // Orphaned team projects fall back to personal projects for their creator, rather than vanishing.
  Object.values(store.projects).forEach((p) => { if (p.teamId === req.params.id) p.teamId = null; });
  saveStore();
  res.json({ ok: true });
});

// Team group chat — any member can post text and/or an image; returns
// the last 200 messages. Images travel as data URLs, capped at ~250KB.
app.post('/api/teams/:id/chat', requireAuth, (req, res) => {
  const team = store.teams[req.params.id];
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (teamRole(team, req.auth.email) === null) return res.status(403).json({ error: "You're not a member of this team" });
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  const image = (req.body || {}).image;
  const hasImage = typeof image === 'string' && image.startsWith('data:image/');
  if (!text && !hasImage) return res.status(400).json({ error: 'Message is empty' });
  if (image && !hasImage) return res.status(400).json({ error: 'Invalid image' });
  if (hasImage && image.length > 350000) return res.status(400).json({ error: 'Image too large (max ~250KB)' });
  backfillTeam(team);
  const message = {
    id: 'msg_' + crypto.randomBytes(4).toString('hex'),
    fromEmail: req.auth.email,
    text,
    image: hasImage ? image : null,
    createdAt: Date.now(),
  };
  team.chat.push(message);
  if (team.chat.length > 200) team.chat = team.chat.slice(-200);
  saveStore();
  res.json({ message });
});

/* ------------------------------------------------------------------ */
/*  Mailbox — every signed-in user gets one, permanent, auto-generated */
/*  (e.g. a1b2c3d4@voide.mail). It's where join requests for teams you */
/*  own land (with a 10-minute reference OTP + one-click Approve/Deny) */
/*  and where you can track the status of requests you've sent.       */
/* ------------------------------------------------------------------ */
const JOIN_REQUEST_TTL = 10 * 60 * 1000; // 10 minutes

function liveStatus(r) {
  if (r.status === 'pending' && Date.now() > r.expiresAt) return 'expired';
  return r.status;
}

app.get('/api/inbox', requireAuth, (req, res) => {
  const me = req.auth.email;
  const incoming = Object.values(store.joinRequests)
    .filter((r) => r.toEmail === me)
    .map((r) => ({ ...r, status: liveStatus(r) }))
    .sort((a, b) => b.createdAt - a.createdAt);
  const sent = Object.values(store.joinRequests)
    .filter((r) => r.fromEmail === me)
    .map((r) => ({ ...r, otp: undefined })) // the OTP is only ever shown to the owner who has to act on it
    .map((r) => ({ ...r, status: liveStatus(r) }))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ address: ensureInbox(store.users[me]), incoming, sent });
});

// Request to join a team by its code — creates a 10-min OTP'd request in
// the owner's mailbox. Idempotent: re-using the same code while a request
// is already pending just returns that same request.
app.post('/api/teams/join', requireAuth, (req, res) => {
  const code = String((req.body || {}).code || '').trim().toLowerCase();
  if (!code) return res.status(400).json({ error: 'Enter a team code' });
  const team = Object.values(store.teams).find((t) => backfillTeam(t).code === code);
  if (!team) return res.status(404).json({ error: 'No team found with that code' });
  if (teamRole(team, req.auth.email) !== null) return res.status(400).json({ error: "You're already a member of this team" });

  const existing = Object.values(store.joinRequests).find(
    (r) => r.teamId === team.id && r.fromEmail === req.auth.email && liveStatus(r) === 'pending',
  );
  if (existing) return res.json({ request: { ...existing, otp: undefined } });

  const request = {
    id: 'req_' + crypto.randomBytes(6).toString('hex'),
    teamId: team.id,
    teamName: team.name,
    fromEmail: req.auth.email,
    toEmail: team.ownerEmail,
    otp: String(crypto.randomInt(100000, 999999)),
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + JOIN_REQUEST_TTL,
  };
  store.joinRequests[request.id] = request;
  saveStore();
  res.json({ request: { ...request, otp: undefined } });
});

function resolveJoinRequest(req, res, decision) {
  const request = store.joinRequests[req.params.id];
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.toEmail !== req.auth.email) return res.status(403).json({ error: 'Not your request to resolve' });
  if (liveStatus(request) !== 'pending') return res.status(400).json({ error: `This request is already ${liveStatus(request)}` });

  request.status = decision;
  request.resolvedAt = Date.now();
  if (decision === 'approved') {
    const team = store.teams[request.teamId];
    if (!team) return res.status(404).json({ error: 'That team no longer exists' });
    if (!team.members.some((m) => m.email === request.fromEmail)) {
      team.members.push({ email: request.fromEmail, role: 'member' });
    }
  }
  saveStore();
  res.json({ request });
}
app.post('/api/inbox/:id/approve', requireAuth, (req, res) => resolveJoinRequest(req, res, 'approved'));
app.post('/api/inbox/:id/deny', requireAuth, (req, res) => resolveJoinRequest(req, res, 'denied'));

/* ------------------------------------------------------------------ */
/*  Projects — real, server-side build history.                       */
/*  Every generation is saved here (not just localStorage) so it's    */
/*  available from any device once signed in, and can be shared with  */
/*  a team by setting teamId to a team the user belongs to.           */
/* ------------------------------------------------------------------ */
function canAccessProject(project, email) {
  if (project.ownerEmail === email) return true;
  if (!project.teamId) return false;
  const team = store.teams[project.teamId];
  return !!team && team.members.some((m) => m.email === email);
}

app.get('/api/projects', requireAuth, (req, res) => {
  const myTeamIds = new Set(teamsForEmail(req.auth.email).map((t) => t.id));
  const mine = Object.values(store.projects).filter(
    (p) => p.ownerEmail === req.auth.email || (p.teamId && myTeamIds.has(p.teamId)),
  );
  mine.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ projects: mine });
});

app.post('/api/projects', requireAuth, (req, res) => {
  const body = req.body || {};
  const id = String(body.id || '').trim() || ('proj_' + crypto.randomBytes(6).toString('hex'));
  const existing = store.projects[id];
  if (existing && !canAccessProject(existing, req.auth.email)) {
    return res.status(403).json({ error: "You don't have access to this project" });
  }
  if (body.teamId) {
    const team = store.teams[body.teamId];
    if (!team || teamRole(team, req.auth.email) === null) {
      return res.status(403).json({ error: "You're not a member of that team" });
    }
  }
  const code = typeof body.code === 'string' ? body.code : (existing?.code || '');
  const files = body.files && typeof body.files === 'object' ? body.files : (existing?.files || { 'index.html': code });
  // Replit-style: the conversation is part of the project's history too —
  // saved server-side so it follows the user to any device.
  const chat = Array.isArray(body.chat)
    ? body.chat.slice(-120).map((m) => ({
        role: m.role === 'user' ? 'user' : 'ai',
        text: String(m.text || '').slice(0, 2000),
        ts: Number(m.ts) || Date.now(),
      }))
    : (existing?.chat || []);
  const project = {
    id,
    ownerEmail: existing ? existing.ownerEmail : req.auth.email,
    teamId: body.teamId || existing?.teamId || null,
    name: String(body.name || existing?.name || 'Untitled project').slice(0, 120),
    mode: body.mode || existing?.mode || 'website',
    code,
    files,
    chat,
    deployedUrl: body.deployedUrl !== undefined ? body.deployedUrl : (existing?.deployedUrl || null),
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  store.projects[id] = project;
  saveStore();
  res.json({ project });
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const project = store.projects[req.params.id];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!canAccessProject(project, req.auth.email)) return res.status(403).json({ error: "You don't have access to this project" });
  delete store.projects[req.params.id];
  saveStore();
  res.json({ ok: true });
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
  'You are a senior product designer + front-end engineer who builds the kind of sites featured on Awwwards and Land-book — not generic template output. Every build should look like it came from a real design studio, not a website builder.',
  '',
  'THINKING FIRST (shown to user):',
  '- Analyze the requirements in detail',
  '- Plan the architecture and components',
  '- Consider responsive design and accessibility',
  '- Think through interactions and animations',
  '- Review for best practices before coding',
  '',
  'Then generate a COMPLETE, single-file, production-ready website as ONE HTML document.',
  '',
  'DESIGN QUALITY BAR (non-negotiable):',
  '- Write REAL, specific, on-brief copy everywhere — headlines, body text, testimonials, prices, names. NEVER "Lorem ipsum", "Company Name", "Your text here", or other placeholders.',
  '- Pick ONE deliberate visual direction (e.g. "dark glassmorphism with violet-cyan gradients" or "warm editorial with serif headlines") and apply it with total consistency — same corner-radius scale, same spacing scale (e.g. 4/8/16/24/40/64px), same 2-3 font pairing, same color system with one accent used sparingly for emphasis.',
  '- Typography does real work: a clear size/weight hierarchy (large confident headlines, comfortable body line-height ~1.6-1.7), generous whitespace — never cramped, never centered-everything.',
  '- Every interactive element gets a real hover/focus/active state (transform, shadow, or color shift) — nothing should look static or default-browser.',
  '- Layout depth: layered backgrounds (gradients, subtle grid/noise/blur), asymmetric or grid-based sections instead of everything centered in a single column, real card/section boundaries via shadow or border, not just background-color changes.',
  '- Mobile is a first-class layout, not a squashed desktop — rethink multi-column sections as stacked/scrollable on small screens.',
  'Rules:',
  '- Return ONLY raw HTML. Start with <!DOCTYPE html> and end with </html>.',
  '- No markdown, no code fences, no explanations before or after.',
  '- Inline ALL CSS inside a <style> tag and ALL JS inside a <script> tag — the file must work standalone.',
  '- Use semantic HTML, accessible markup (proper contrast, focus-visible states, alt text), and tasteful animations (CSS transitions/keyframes + IntersectionObserver reveal-on-scroll by default — every site should feel alive as the user scrolls, not appear all at once).',
  '- Do NOT reference any external files, frameworks, or CDNs — everything self-contained — EXCEPT: Google Fonts (https://fonts.googleapis.com) for real typography, and the two libraries below when the brief calls for them:',
  '  • three.js (https://unpkg.com/three@0.160.0/build/three.module.js) — for real, code-generated 3D scenes (rotating hero object, particle field, product viewer, WebGL background). Build actual Three.js geometry/materials/lights/camera + a requestAnimationFrame render loop — never reference an external .glb/.obj model file, since none exists; procedurally build shapes (icosahedron, torus, particles, extruded text) or simple primitives composed together.',
  '  • GSAP + ScrollTrigger (https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js and .../ScrollTrigger.min.js) — for scroll-driven animations (pin sections, parallax, staggered reveals, timeline-based scroll storytelling).',
  '- Only load three.js / GSAP when the brief actually asks for 3D or rich scroll animation — a simple landing page should stay CDN-free and fast.',
  '- Where a photo or illustration would make the site better, use <img src="ai-img: short vivid description of the image"> (up to 3 per site, always include width/height CSS) — the platform replaces these with real AI-generated images automatically.',
  '- If the brief mentions a logo/brand mark, use <img src="ai-logo: short description of the logo concept"> once in the header — the platform generates a real logo image for it.',
].join('\n');

// Canvas Mode — for building 2D games/interactive graphics with <canvas>.
const CANVAS_SYSTEM_PROMPT = [
  'You are an expert game developer specializing in the HTML5 Canvas API.',
  'Generate a COMPLETE, single-file, playable 2D game or interactive graphics demo as ONE HTML document.',
  'Rules:',
  '- Return ONLY raw HTML. Start with <!DOCTYPE html> and end with </html>.',
  '- No markdown, no code fences, no explanations before or after.',
  '- Use a full-viewport <canvas> element with a requestAnimationFrame game loop, all in one inline <script> tag.',
  '- Inline ALL CSS inside a <style> tag — the file must work fully standalone, no external files or CDNs.',
  '- Implement real game mechanics: player input (keyboard/touch), collision detection, score, win/lose states, and a restart flow.',
  '- Make it visually polished: gradients, particle/glow effects, smooth animation, juicy game-feel — not a bare wireframe.',
  '- Support both desktop (keyboard) and mobile (on-screen touch controls or swipe/tap) input.',
  '- Keep it performant: a clean draw loop, no memory leaks, no external assets.',
].join('\n');

function providerError(status, detail) {
  const detailStr = String(detail || '');
  let message = `provider responded ${status}`;

  // Handle rate limit (429) with friendly error
  if (status === 429) {
    // Try to extract retry time from Groq error message
    const retryMatch = detailStr.match(/try again in (\d+[hms]+)/i);
    const retryTime = retryMatch ? retryMatch[1] : '1-2 hours';
    message = `API rate limit reached. Rate limits reset in ${retryTime}. Try switching to a custom model in Settings → Models (OpenAI, Claude, Gemini) or wait for the limit to reset.`;
  } else if (status === 401 || status === 403) {
    message = 'API key invalid or unauthorized. Check your model settings and API key.';
  } else if (status === 500 || status === 502 || status === 503) {
    message = 'API server error. Please try again in a few moments.';
  }

  const err = new Error(message);
  err.status = status;
  err.detail = detailStr.slice(0, 500);
  return err;
}

// Fill in sensible official endpoints when the user leaves the field blank,
// and repair half-pasted URLs (e.g. "https://api.anthropic.com" without the
// /v1/messages path) so adding a model "just works".
const DEFAULT_ENDPOINTS = {
  openai:     'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic:  'https://api.anthropic.com/v1/messages',
  gemini:     'https://generativelanguage.googleapis.com/v1beta',
};
function normalizeProviderCfg(cfg) {
  const type = cfg.type || 'openai';
  let ep = String(cfg.endpoint || '').trim().replace(/\/+$/, '');
  if (!ep) ep = DEFAULT_ENDPOINTS[type] || DEFAULT_ENDPOINTS.openai;
  if (type === 'anthropic' && !/\/messages$/.test(ep)) {
    ep = ep.replace(/\/v1$/, '') + '/v1/messages';
  }
  return { ...cfg, type, endpoint: ep, model: String(cfg.model || '').trim() };
}

// --- OpenAI-compatible (OpenAI, Groq, OpenRouter, Together, Mistral, local) ---
async function callOpenAI({ endpoint, apiKey, model }, system, user, opts = {}) {
  let base = String(endpoint || '').trim().replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: opts.maxTokens || 8000,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw providerError(r.status, await r.text().catch(() => ''));
  const d = await r.json();
  return d?.choices?.[0]?.message?.content || '';
}

// --- Anthropic (Claude) ---
async function callAnthropic({ endpoint, apiKey, model }, system, user, opts = {}) {
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
      max_tokens: opts.maxTokens || 8000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw providerError(r.status, await r.text().catch(() => ''));
  const d = await r.json();
  return (d?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') || '';
}

// --- Google Gemini ---
async function callGemini({ endpoint, apiKey, model }, system, user, opts = {}) {
  const base = (String(endpoint || '').trim().replace(/\/+$/, '')) || 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey || '')}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: opts.maxTokens || 8000 },
    }),
  });
  if (!r.ok) throw providerError(r.status, await r.text().catch(() => ''));
  const d = await r.json();
  return (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('') || '';
}

// Dispatch to the right API based on provider type.
function callProvider(cfg, system, user, opts) {
  const c = normalizeProviderCfg(cfg);
  switch (c.type) {
    case 'anthropic': return callAnthropic(c, system, user, opts);
    case 'gemini':    return callGemini(c, system, user, opts);
    default:          return callOpenAI(c, system, user, opts); // openai / openrouter / custom / groq
  }
}

/* ------------------------------------------------------------------ */
/*  Hugging Face + smart fallback chain                               */
/*                                                                    */
/*  With HF_API_TOKEN set, generation runs through Hugging Face's     */
/*  OpenAI-compatible router across SEVERAL powerful models, one by   */
/*  one — if a model is rate-limited, loading or down, the next one   */
/*  answers instead. Groq (if configured) is the final fallback, so   */
/*  users basically never see a rate-limit error.                     */
/* ------------------------------------------------------------------ */
const HF_TOKEN = process.env.HF_API_TOKEN || process.env.HUGGINGFACE_API_KEY || '';
const HF_ROUTER = 'https://router.huggingface.co/v1';

// Ordered: DeepSeek-V3 first — the strongest all-round pick for BOTH design
// taste (real, non-generic copy and layout judgement) and clean code, ahead
// of the coder-specialist models which are more correctness- than
// aesthetics-tuned. Any model that errors/rate-limits simply gets skipped.
const HF_CHAT_MODELS = (process.env.HF_CHAT_MODELS || [
  'deepseek-ai/DeepSeek-V3-0324',
  'Qwen/Qwen2.5-Coder-32B-Instruct',
  'meta-llama/Llama-3.3-70B-Instruct',
  'Qwen/Qwen2.5-72B-Instruct',
  'mistralai/Mistral-Small-24B-Instruct-2501',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

// Text-to-image models for pictures INSIDE generated websites.
const HF_IMAGE_MODELS = (process.env.HF_IMAGE_MODELS || [
  'black-forest-labs/FLUX.1-schnell',
  'stabilityai/stable-diffusion-xl-base-1.0',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

// The default engine chain: every HF model in order, then Groq.
function defaultChain() {
  const chain = [];
  if (HF_TOKEN) {
    for (const m of HF_CHAT_MODELS) {
      chain.push({ type: 'openai', endpoint: HF_ROUTER, apiKey: HF_TOKEN, model: m });
    }
  }
  if (process.env.GROQ_API_KEY) {
    chain.push({ type: 'openai', endpoint: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY, model: GROQ_MODEL });
  }
  return chain;
}

// Try each engine in order until one answers.
async function callWithFallback(chain, system, user, opts) {
  let lastErr = null;
  for (const cfg of chain) {
    try {
      const out = await callProvider(cfg, system, user, opts);
      if (out && String(out).trim()) return { raw: out, model: cfg.model };
      lastErr = new Error('empty response');
    } catch (err) {
      console.warn(`model ${cfg.model} failed (${err.status || '?'}): ${err.message.slice(0, 120)} — trying next`);
      lastErr = err;
    }
  }
  throw lastErr || new Error('no models configured');
}

// Generate one image via HF (tries each image model), → data URL or null.
// kind: 'photo' (default) or 'logo' (adds vector/icon/transparent styling to the prompt).
async function hfGenerateImage(prompt, kind = 'photo') {
  if (!HF_TOKEN) return null;
  const finalPrompt = kind === 'logo'
    ? `minimalist vector logo icon, ${prompt}, flat design, clean lines, centered, simple bold shapes, white background, professional brand mark`
    : String(prompt);
  for (const model of HF_IMAGE_MODELS) {
    try {
      const r = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: finalPrompt.slice(0, 400) }),
      });
      if (!r.ok) { console.warn(`image model ${model} → ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1000) continue; // an error blob, not an image
      const mime = r.headers.get('content-type') || 'image/jpeg';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err) {
      console.warn(`image model ${model} failed: ${err.message.slice(0, 100)}`);
    }
  }
  return null;
}

// A pretty gradient SVG stand-in when image generation isn't available.
function placeholderImage(text, kind = 'photo') {
  const label = String(text || 'image').slice(0, 40).replace(/[<>&"]/g, '');
  if (kind === 'logo') {
    const initial = label.trim().charAt(0).toUpperCase() || 'V';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#06b6d4"/></linearGradient></defs><rect width="160" height="160" rx="32" fill="url(#g)"/><text x="80" y="104" font-family="sans-serif" font-size="72" font-weight="700" fill="#fff" text-anchor="middle">${initial}</text></svg>`;
    return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#06b6d4"/></linearGradient></defs><rect width="800" height="500" fill="url(#g)"/><text x="400" y="255" font-family="sans-serif" font-size="26" fill="rgba(255,255,255,.85)" text-anchor="middle">${label}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

// Replace <img src="ai-img: description"> / <img src="ai-logo: description">
// placeholders the model emitted with real HF-generated images (max 3 photos
// + 1 logo per site; graceful SVG fallback if generation is unavailable).
async function inlineAiImages(html) {
  let out = html;

  const logoMatches = [...out.matchAll(/src=["']ai-logo:\s*([^"']{2,200})["']/gi)];
  if (logoMatches.length) {
    const desc = logoMatches[0][1].trim();
    const img = (await hfGenerateImage(desc, 'logo')) || placeholderImage(desc, 'logo');
    out = out.split(`ai-logo: ${desc}`).join(img).split(`ai-logo:${desc}`).join(img);
    out = out.replace(/src=["']ai-logo:\s*([^"']{2,200})["']/gi, (_, d) => `src="${placeholderImage(d, 'logo')}"`);
  }

  const matches = [...out.matchAll(/src=["']ai-img:\s*([^"']{3,200})["']/gi)];
  if (matches.length) {
    const unique = [...new Set(matches.map((m) => m[1].trim()))].slice(0, 3);
    for (const desc of unique) {
      const img = (await hfGenerateImage(desc, 'photo')) || placeholderImage(desc, 'photo');
      out = out.split(`ai-img: ${desc}`).join(img).split(`ai-img:${desc}`).join(img);
    }
    // Any leftovers (beyond the 3-image budget) get placeholders too.
    out = out.replace(/src=["']ai-img:\s*([^"']{3,200})["']/gi, (_, d) => `src="${placeholderImage(d, 'photo')}"`);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/*  Text-to-speech — real, human-sounding Indian-accent voice          */
/*  (AI4Bharat's Indic Parler-TTS, via Hugging Face). Used to read     */
/*  chat replies aloud on request — not a robotic browser voice.       */
/* ------------------------------------------------------------------ */
const HF_TTS_MODEL = process.env.HF_TTS_MODEL || 'ai4bharat/indic-parler-tts';
const TTS_VOICE_DESC = process.env.HF_TTS_VOICE_DESC
  || 'Divya speaks with a warm, natural Indian English accent, at a moderate pace with clear expression, in a calm indoor studio with no background noise.';

async function hfGenerateSpeech(text) {
  if (!HF_TOKEN) return null;
  try {
    const r = await fetch(`https://router.huggingface.co/hf-inference/models/${HF_TTS_MODEL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: String(text).slice(0, 900), parameters: { description: TTS_VOICE_DESC } }),
    });
    if (!r.ok) { console.warn(`TTS model → ${r.status}`); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 500) return null;
    const mime = r.headers.get('content-type') || 'audio/wav';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (err) {
    console.warn(`TTS failed: ${err.message.slice(0, 100)}`);
    return null;
  }
}

/**
 * POST /api/generate-code   (requires Authorization: Bearer <token>)
 * Body:    { prompt, projectId?, userId?, provider?, mode? }
 *   provider (optional) — a user-added model from Settings:
 *     { type: 'openai'|'anthropic'|'gemini', endpoint?, apiKey, model }
 *   When absent, the server's default Groq config is used.
 *   mode (optional) — 'canvas' generates a playable HTML5 Canvas game
 *     instead of a website; anything else (or absent) generates a website.
 * Returns: { code: string }  — a complete HTML document
 */
app.post('/api/generate-code', requireAuth, async (req, res) => {
  const { prompt, provider, mode } = req.body || {};
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  const systemPrompt = mode === 'canvas' ? CANVAS_SYSTEM_PROMPT : SYSTEM_PROMPT;

  // A user-supplied model wins; otherwise the smart fallback chain
  // (all Hugging Face models one by one, then Groq) handles it.
  const chain = (provider && provider.model)
    ? [{ type: provider.type || 'openai', endpoint: provider.endpoint || '', apiKey: provider.apiKey || '', model: provider.model }]
    : defaultChain();

  if (!chain.length) {
    return res.status(501).json({ error: 'No AI model configured. Add one in Settings → Models, or set HF_API_TOKEN / GROQ_API_KEY in environment variables.' });
  }

  const modelName = chain[0].model;
  const availableModel = getAvailableModel(modelName);
  trackModelRequest(availableModel, 'start');

  let raw;
  try {
    // Rich, detailed sites (real copy, full design system, 3D/animation
    // code) run long — 8000 tokens was truncating output mid-file on
    // anything non-trivial, which is what "cheap/broken" output usually
    // was. 16k gives real headroom for a complete, un-cut document.
    ({ raw } = await callWithFallback(chain, systemPrompt, prompt, { maxTokens: 16000 }));
  } catch (err) {
    trackModelRequest(availableModel, 'end');
    console.error('generation error:', err.message, err.detail || '');
    return res.status(502).json({ error: err.detail ? `${err.message}: ${err.detail}` : err.message });
  }

  trackModelRequest(availableModel, 'end');

  // Strip accidental markdown fences if the model added them.
  let code = String(raw || '').replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!code || !/<html|<!doctype/i.test(code)) {
    return res.status(502).json({ error: 'generation returned invalid HTML' });
  }
  // The model got cut off mid-document (hit the token limit) — best-effort
  // close whatever's open so the preview isn't a blank/broken page, and log
  // it so we can see how often this actually happens.
  if (!/<\/html>\s*$/i.test(code)) {
    console.warn(`generation truncated (${code.length} chars) — closing tags best-effort`);
    if (/<script(?![^>]*\/>)[^>]*>(?![\s\S]*<\/script>)/i.test(code)) code += '\n</script>';
    if (!/<\/body>/i.test(code)) code += '\n</body>';
    if (!/<\/html>/i.test(code)) code += '\n</html>';
  }
  // Swap ai-img placeholders for real AI-generated images (HF) or pretty SVGs.
  try { code = await inlineAiImages(code); } catch { /* images are best-effort */ }
  return res.json({ code });
});

/**
 * POST /api/generate-image   (requires Authorization: Bearer <token>)
 * Body: { prompt, kind? 'photo'|'logo' } → { image: <data URL> }
 * Direct text-to-image (or logo) via the Hugging Face image-model chain —
 * used for standalone "generate a logo/image" chat requests.
 */
app.post('/api/generate-image', requireAuth, async (req, res) => {
  const { prompt, kind } = req.body || {};
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt is required' });
  const k = kind === 'logo' ? 'logo' : 'photo';
  const img = await hfGenerateImage(prompt, k);
  if (!img) return res.status(501).json({ error: 'Image generation needs HF_API_TOKEN configured', image: placeholderImage(prompt, k) });
  res.json({ image: img });
});

/**
 * POST /api/text-to-speech   (requires Authorization: Bearer <token>)
 * Body: { text } → { audio: <data URL> }
 * Reads text aloud with a real, human-sounding Indian-accent voice
 * (AI4Bharat Indic Parler-TTS) — not a robotic browser voice.
 */
app.post('/api/text-to-speech', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });
  const audio = await hfGenerateSpeech(text);
  if (!audio) return res.status(501).json({ error: 'Voice needs HF_API_TOKEN configured (ai4bharat/indic-parler-tts)' });
  res.json({ audio });
});

/* ------------------------------------------------------------------ */
/*  Conversational chat — the Build Console answers normal messages    */
/*  like a person (any language) instead of force-building a website. */
/* ------------------------------------------------------------------ */
const CHAT_SYSTEM_PROMPT = [
  'You are Voide AI — the friendly assistant inside an AI website builder (like Replit/Bolt/Lovable).',
  'The user is chatting with you, NOT asking for code right now.',
  'Rules:',
  '- ALWAYS reply in the SAME language/style the user wrote in (Hindi, English, Hinglish, anything).',
  '- Be warm, natural and concise (2-5 sentences). No code, no HTML.',
  '- If it fits naturally, end with one short line about what you can do: build complete websites & landing pages, build HTML5 canvas games, edit projects through follow-up messages, and deploy sites live in one click.',
  '- If the user seems to describe a website idea, invite them to say "build it" / "bana do" and you will build it.',
].join('\n');

app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, history, provider } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'message is required' });

  const chain = (provider && provider.model)
    ? [{ type: provider.type || 'openai', endpoint: provider.endpoint || '', apiKey: provider.apiKey || '', model: provider.model }]
    : defaultChain();
  if (!chain.length) return res.status(501).json({ error: 'no model configured' });

  // Fold recent turns into the prompt so replies stay in context.
  const turns = Array.isArray(history) ? history.slice(-10) : [];
  const convo = turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${String(t.content || '').slice(0, 500)}`).join('\n');
  const userMsg = (convo ? `Conversation so far:\n${convo}\n\n` : '') + `User's new message: ${String(message).slice(0, 2000)}`;

  try {
    // Chat replies are short — cap tokens so BYOK credits are never wasted.
    const { raw } = await callWithFallback(chain, CHAT_SYSTEM_PROMPT, userMsg, { maxTokens: 512 });
    const reply = String(raw || '').trim().slice(0, 4000);
    if (!reply) return res.status(502).json({ error: 'empty reply' });
    res.json({ reply });
  } catch (err) {
    console.error('chat error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/test-model   (requires Authorization: Bearer <token>)
 * Body: { provider: { type, endpoint?, apiKey, model } }
 * Makes a ~10-token ping to the user's model so they can verify a newly
 * added key/model id actually works — without wasting their credits.
 */
app.post('/api/test-model', requireAuth, async (req, res) => {
  const { provider } = req.body || {};
  if (!provider || !provider.model) return res.status(400).json({ ok: false, error: 'provider.model is required' });
  const cfg = { type: provider.type || 'openai', endpoint: provider.endpoint || '', apiKey: provider.apiKey || '', model: provider.model };
  try {
    const raw = await callProvider(cfg, 'You are a connectivity check.', 'Reply with exactly: OK', { maxTokens: 16 });
    res.json({ ok: true, reply: String(raw || '').trim().slice(0, 50) });
  } catch (err) {
    res.status(200).json({ ok: false, error: (err.detail ? `${err.message} — ${err.detail}` : err.message).slice(0, 400) });
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

// Best-effort mirror of the project's files to a GitHub repo (create or
// update each one). Never blocks deployment — failures are logged and ignored.
async function mirrorToGitHub(name, files) {
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

    for (const [path, content] of Object.entries(files)) {
      let sha;
      const cur = await gh(`/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`);
      if (cur.ok) sha = (await cur.json()).sha;

      await gh(`/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: 'Update site via AI Web Studio',
          content: Buffer.from(content || '', 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      });
    }
  } catch (err) {
    console.warn('GitHub mirror skipped:', err.message);
  }
}

/**
 * POST /api/deploy-vercel   (requires Authorization: Bearer <token>)
 * Body:    { projectId?: string, userId?: string, code: string, files?: object, vercelToken?: string }
 *   files (optional) — a multi-file project { path: content }; when absent,
 *   falls back to a single index.html made from `code`.
 *   vercelToken (optional) — user's own Vercel token for deployment to their account
 * Returns: { url: string } — the live production URL (stable across updates)
 */
app.post('/api/deploy-vercel', requireAuth, async (req, res) => {
  const { projectId, code, files, vercelToken } = req.body || {};
  const fileMap = files && typeof files === 'object' && Object.keys(files).length ? files : { 'index.html': code };
  if (!fileMap['index.html']) {
    return res.status(400).json({ error: 'code is required' });
  }

  // Use user-provided token if available, otherwise fall back to server token
  const token = vercelToken || process.env.VERCEL_TOKEN;
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
        files: Object.entries(fileMap).map(([file, data]) => ({
          file, data: Buffer.from(data || '', 'utf8').toString('base64'), encoding: 'base64',
        })),
        projectSettings: { framework: null },
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('Vercel error:', r.status, JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: data?.error?.message || 'deploy failed' });
    }

    // Mirror to GitHub in the background (does not delay the response).
    mirrorToGitHub(name, fileMap);

    // Prefer the stable production alias; fall back to the project domain.
    const alias = Array.isArray(data.alias) && data.alias.length ? data.alias[0] : `${name}.vercel.app`;
    return res.json({ url: `https://${alias}` });
  } catch (err) {
    console.error('deploy failed:', err.message);
    return res.status(502).json({ error: 'deploy service unreachable' });
  }
});

/**
 * POST /api/deploy-vercel/domain   (requires Authorization: Bearer <token>)
 * Body:    { projectId: string, domain: string }
 * Returns: { domain, verified, verification: [...] }
 *   verified=false means Vercel needs DNS records added first — the
 *   `verification` array lists exactly what to add (type/name/value).
 */
app.post('/api/deploy-vercel/domain', requireAuth, async (req, res) => {
  const { projectId, domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const token = process.env.VERCEL_TOKEN;
  if (!token) return res.status(501).json({ error: 'VERCEL_TOKEN not configured' });

  const name = projectName(projectId);
  const teamId = process.env.VERCEL_TEAM_ID;
  const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';

  try {
    const r = await fetch(`https://api.vercel.com/v10/projects/${encodeURIComponent(name)}/domains${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: domain }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Vercel domain error:', r.status, JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: data?.error?.message || 'Could not add that domain' });
    }
    return res.json({ domain: data.name, verified: !!data.verified, verification: data.verification || [] });
  } catch (err) {
    console.error('domain attach failed:', err.message);
    return res.status(502).json({ error: 'Vercel unreachable' });
  }
});

/* ------------------------------------------------------------------ */
/*  Real-time collab — live presence + live code sync over WebSocket. */
/*  One "room" per projectId. Anyone who can access the project (its  */
/*  owner, or a member of the team it's shared with) can join; edits  */
/*  are relayed to everyone else in the room as they happen — this is */
/*  what powers multiple people building the same project together,  */
/*  live, like Replit's multiplayer.                                  */
/* ------------------------------------------------------------------ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // projectId -> Map<ws, email>

function broadcastPresence(projectId) {
  const room = rooms.get(projectId);
  if (!room) return;
  const payload = JSON.stringify({ type: 'presence', users: [...new Set(room.values())] });
  for (const ws of room.keys()) { if (ws.readyState === ws.OPEN) ws.send(payload); }
}

wss.on('connection', (ws, req) => {
  let projectId, email;
  try {
    const url = new URL(req.url, 'http://localhost');
    projectId = url.searchParams.get('projectId');
    const auth = verifyToken(url.searchParams.get('token'));
    if (!projectId || !auth?.email) { ws.close(1008, 'unauthorized'); return; }
    const existingProject = store.projects[projectId];
    if (existingProject && !canAccessProject(existingProject, auth.email)) { ws.close(1008, 'forbidden'); return; }
    email = auth.email;
  } catch { ws.close(1008, 'bad request'); return; }

  if (!rooms.has(projectId)) rooms.set(projectId, new Map());
  const room = rooms.get(projectId);
  room.set(ws, email);
  broadcastPresence(projectId);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'code_update' && typeof msg.code === 'string') {
      const file = typeof msg.file === 'string' ? msg.file.slice(0, 200) : 'index.html';
      const payload = JSON.stringify({ type: 'code_update', file, code: msg.code, fromEmail: email });
      for (const [peer] of room) {
        if (peer !== ws && peer.readyState === peer.OPEN) peer.send(payload);
      }
    }
  });

  ws.on('close', () => {
    room.delete(ws);
    if (room.size === 0) rooms.delete(projectId);
    else broadcastPresence(projectId);
  });
});

server.listen(PORT, () => {
  console.log(`AI Web Studio running at http://localhost:${PORT}`);
  console.log(`  Code generation : ${HF_TOKEN ? `Hugging Face chain (${HF_CHAT_MODELS.length} models)${process.env.GROQ_API_KEY ? ' + Groq fallback' : ''}` : process.env.GROQ_API_KEY ? 'Groq only' : 'none (set HF_API_TOKEN or GROQ_API_KEY)'}`);
  console.log(`  Image generation: ${HF_TOKEN ? `Hugging Face (${HF_IMAGE_MODELS.length} models)` : 'off (set HF_API_TOKEN)'}`);
  console.log(`  Deploy          : ${process.env.VERCEL_TOKEN ? 'Vercel (live)' : 'demo URL (no VERCEL_TOKEN)'}`);
  console.log(`  GitHub mirror   : ${process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER ? 'on' : 'off'}`);
  console.log(`  Auth            : ${storeWritable ? 'file store (data/users.json)' : 'in-memory (disk not writable)'}`);
  console.log(`  Google sign-in  : ${process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_API_KEY ? `on (project ${process.env.FIREBASE_PROJECT_ID})` : 'off (set FIREBASE_PROJECT_ID + FIREBASE_API_KEY)'}`);
  console.log(`  Live collab     : ws://localhost:${PORT}/ws`);
});
