# Run Doc — InTab Dev Server (Freebuff Preview)

Project: InTab (React 19 + Vite 8 + Tailwind 4, TypeScript)
Workspace: `/Users/william.le/Documents/DeveloperUtils` (this thread's workspace == the main checkout)

## 1. Reproduce the artifacts a fresh checkout needs

- **Dependencies:** already installed (`node_modules/` present). For a fresh clone:
  ```bash
  cd /Users/william.le/Documents/DeveloperUtils
  npm install
  ```
  (npm project — `package-lock.json` is the lockfile; do not use pnpm/yarn/bun.)
- **Env files:** `.env` already exists at the project root (contains `VITE_VAULT_KEY`). For a fresh clone, copy it from the main checkout and/or reference `.env.example` for the full template:
  ```bash
  cp /Users/william.le/Documents/DeveloperUtils/.env <fresh-checkout>/.env
  ```
  Server-side secrets (`LEMON_SQUEEZY_API_KEY`) live in Vercel env vars only — never in files here.

## 2. Run the dev server

- Default port **5173** (Vite default; confirmed free in this environment).
  Port 5199 is held by another thread's preview — do not use it.
- `launchctl submit` fails inside the app sandbox (last exit code 1 with an empty log),
  and bare `nohup … &` gets reaped by the command runner. The proven detached recipe
  (same one the "Website Design Audit Review" thread uses) is **detached GNU screen**:
  ```bash
  screen -dmS freebuff-preview-df77c218 bash -c \
    'cd /Users/william.le/Documents/DeveloperUtils && \
     export PATH=/Users/william.le/.nvm/versions/node/v24.11.1/bin:$PATH && \
     exec node_modules/.bin/vite --port 5173 --strictPort \
     > /Users/william.le/Documents/DeveloperUtils/src/.freebuff/preview-df77c218-5476-4f30-a1a0-341eb6e77902.log 2>&1'
  ```
- The explicit `PATH` export is required — node comes from nvm and is invisible to
  non-interactive shells.
- **Log:** `/Users/william.le/Documents/DeveloperUtils/src/.freebuff/preview-df77c218-5476-4f30-a1a0-341eb6e77902.log`
- **Verify:** `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/` → `200`
- **Stop:** `screen -S freebuff-preview-df77c218 -X quit`
- Health-check proven at registration: Vite 8.3.0 ready, HTTP 200, dashboard renders,
  Settings → Cloud Sync tab opens, zero console errors.
