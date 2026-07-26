/**
 * Voide Cloud Build Agent — runs on YOUR OWN Cloud Shell / VM (not on
 * Render, not part of the deployed Voide app). Exposes exactly one
 * endpoint, /build-apk, that compiles an Android project with Gradle and
 * returns the resulting APK.
 *
 * Security model:
 *   - Every request must carry the exact X-Secret-Key header (constant-time
 *     compared) matching CLOUD_BUILD_SECRET. No key, no response — not even
 *     an error that reveals anything.
 *   - There is no public/unauthenticated route of any kind, and no
 *     "download link" is ever created — the APK bytes are returned directly
 *     in the HTTP response to the one authenticated request that built it.
 *   - Every build runs in a FRESH, isolated temp directory that is deleted
 *     afterwards (success or failure) — nothing persists between builds.
 *   - File paths from the caller are validated before anything is written
 *     to disk: no "..", no absolute paths, and the resolved path is
 *     double-checked to still be inside that build's temp directory.
 *   - A hard time limit kills a stuck/hung Gradle process rather than
 *     letting it run forever.
 *
 * Setup on Cloud Shell:
 *   cd cloud-build-agent
 *   npm install
 *   export CLOUD_BUILD_SECRET="<a long random string — generate with: openssl rand -hex 32>"
 *   node build-agent.js
 *   # then expose it with ngrok (a DIFFERENT tunnel/port than any terminal
 *   # you run) — only Render should ever be given this URL:
 *   ngrok http 8787
 *
 * On Render, set:
 *   CLOUD_BUILD_AGENT_URL = the ngrok URL for THIS agent
 *   CLOUD_BUILD_SECRET    = the exact same string you exported above
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8787;
const SECRET = process.env.CLOUD_BUILD_SECRET || '';
const BUILD_TIMEOUT_MS = 7 * 60 * 1000; // keep this under Render's 8-minute wait

if (!SECRET) {
  console.error('CLOUD_BUILD_SECRET is not set — refusing to start (this agent must never run without it).');
  process.exit(1);
}

// Constant-time comparison so a mistyped/guessed secret can't be brute-forced
// via response-time differences.
function secretMatches(provided) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.use((req, res, next) => {
  if (!secretMatches(req.header('X-Secret-Key'))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// Rejects path traversal / absolute paths BEFORE anything touches disk, then
// re-checks the resolved path is still inside `root` as defense in depth.
function safeJoin(root, relPath) {
  const rel = String(relPath || '');
  if (!rel || rel.includes('\0') || /^([A-Za-z]:)?[/\\]/.test(rel) || rel.split(/[/\\]/).includes('..')) {
    throw new Error(`Rejected unsafe path: ${relPath}`);
  }
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`Rejected path escaping build directory: ${relPath}`);
  }
  return resolved;
}

function findApk(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of fs.readdirSync(cur)) {
      const full = path.join(cur, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (name.endsWith('.apk')) return full;
    }
  }
  return null;
}

function rmDirSafe(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

app.post('/build-apk', async (req, res) => {
  const { files } = req.body || {};
  if (!files || typeof files !== 'object' || !Object.keys(files).length) {
    return res.status(400).json({ error: 'files (path -> content map) is required' });
  }

  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voide-build-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const dest = safeJoin(buildDir, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, String(content ?? ''));
    }

    const hasWrapper = fs.existsSync(path.join(buildDir, 'gradlew'));
    if (hasWrapper) fs.chmodSync(path.join(buildDir, 'gradlew'), 0o755);
    const [cmd, args] = hasWrapper ? ['./gradlew', ['assembleDebug', '--no-daemon']] : ['gradle', ['assembleDebug', '--no-daemon']];

    const output = await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: buildDir, shell: false });
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Build timed out')); }, BUILD_TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`Gradle exited ${code}\n${out.slice(-2000)}`));
      });
    });

    const apkPath = findApk(path.join(buildDir, 'app', 'build', 'outputs')) || findApk(buildDir);
    if (!apkPath) throw new Error(`Build reported success but no .apk was found.\n${output.slice(-1000)}`);

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.send(fs.readFileSync(apkPath));
  } catch (err) {
    console.error('build failed:', err.message);
    res.status(500).json({ error: err.message.slice(0, 4000) });
  } finally {
    rmDirSafe(buildDir); // never let build artifacts or source persist
  }
});

app.listen(PORT, () => console.log(`Voide build agent listening on :${PORT} (secret required on every request)`));
