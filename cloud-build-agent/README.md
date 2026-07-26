# Voide Cloud Build Agent

Runs on **your own Cloud Shell / VM** — this is NOT deployed to Render and is
not part of the Voide web app. It's a small, standalone Express server that
compiles Android APKs on request from Voide's admin-only build feature.

## Why this is a separate, isolated piece

- No public/unauthenticated route of any kind — every request to `/build-apk`
  must carry the exact `X-Secret-Key` header (compared in constant time).
- No terminal, shell, or raw command access is ever exposed — the only thing
  this agent does is: receive files → run Gradle → return the APK bytes.
- No lingering download links are created — the APK is streamed straight back
  in the HTTP response to the one request that built it.
- Every build runs in a fresh temp directory that's deleted afterward
  (success or failure) — nothing persists between builds.
- Every file path from the caller is validated before touching disk (no
  `..`, no absolute paths, and the resolved path is re-checked to still be
  inside that build's temp directory) — path traversal is blocked.

## Setup

```bash
cd cloud-build-agent
npm install

# Generate a long random secret and keep it somewhere safe:
openssl rand -hex 32

export CLOUD_BUILD_SECRET="<paste the random string here>"
node build-agent.js
```

Then tunnel it with ngrok, **on a different port than any terminal/ttyd
session you may also be running**:

```bash
ngrok http 8787
```

## Wiring it up on Render

In Render → your Voide service → Environment, set:

| Key | Value |
|---|---|
| `CLOUD_BUILD_AGENT_URL` | the ngrok URL for *this* agent (e.g. `https://xxxx.ngrok-free.app`) |
| `CLOUD_BUILD_SECRET` | the exact same random string you exported above |
| `ADMIN_EMAIL` | your own Voide account's email — this is who's allowed to trigger a build |

Only a signed-in user whose email matches `ADMIN_EMAIL` will ever see the
**Build APK** button in Voide, and only that account's requests can reach
this agent at all — everyone else gets a plain 403 from Render before this
agent is ever contacted.

## What files to give it

Standard Android project files as plain text — `build.gradle`, `settings.gradle`,
`app/build.gradle`, `app/src/main/AndroidManifest.xml`, your Kotlin/Java
sources under `app/src/main/java/...`, and any XML resources. If your
project includes a `gradlew` wrapper script it will be used (and made
executable automatically); otherwise the agent falls back to your Cloud
Shell's system-installed `gradle` command.

Binary files (like a real `gradle-wrapper.jar`) can't be pasted as text, so
either rely on the system `gradle` install already on your Cloud Shell, or
regenerate the wrapper jar there once (`gradle wrapper`) rather than
transferring it through Voide's editor.
