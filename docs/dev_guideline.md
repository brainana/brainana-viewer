# Local development

Run the Viewer in the **browser** (fast, hot reload) or **Electron** (packaged experience).
For installers see [desktop-app.md](desktop-app.md).

---

## Web dev (recommended)

**No build step.** Vite serves `src/` live with HMR. You run two processes in parallel.

### Steps

1. **Terminal 1 — start the API/data server**

   ```sh
   cd brainana-viewer
   npm run dev:server -- \
     --output-dir datasets/demo_viewer      # or your own /path/to/preprocessed/dataset
   ```

   No dataset of your own? The repo ships a trimmed demo subject in `datasets/demo_viewer/`
   (see [datasets/demo_viewer/README.md](../datasets/demo_viewer/README.md)) — the command
   above points at it as-is.

   Leave it running. **Restart this terminal** whenever you edit `server/**` or `packages/core-server/**`.

2. **Terminal 2 — start the Vite dev server**

   ```sh
   cd brainana-viewer
   npm run dev:web
   ```

   Leave it running. Edits to `src/**` hot-reload in the browser automatically.

3. **Open the app** — use the URL Vite prints (default http://localhost:5173).

### Ports

| Service | Default | Notes |
|---|---|---|
| Vite (client) | 5173 | `npm run dev:web -- --port 5175 --strictPort` if taken |
| Node API | 5173 | **Always pass `--port 5174`** so it doesn't collide with Vite (`dev:server` already does) |

If the API runs on a non-default port: `BRAINANA_DEV_PORT=<port> npm run dev:web`.

### Verify wiring

```sh
curl -s http://127.0.0.1:5174/api/health   # API direct
curl -s http://127.0.0.1:5173/api/health   # same, via Vite proxy
```

Both should return `{ "ok": true, ... }`.

---

## Desktop dev (Electron)

**Build first, every time.** `dev:desktop` runs `npm run build` then launches Electron with the server in-process. No HMR — re-run the command after any change.

### Steps

1. **Build and launch**

   ```sh
   cd brainana-viewer
   npm run dev:desktop
   ```

   This builds `apps/viewer/dist/`, then opens the Electron window.

2. **After code changes** — run `npm run dev:desktop` again (full rebuild + relaunch).

3. **Point at your data** — pass server flags the same way as web dev if needed: `--output-dir <path>` and `--port <n>` (the flags `runServerCli` parses; see `packages/core-server/main.mjs`).

Use desktop dev to verify window behavior and the in-process server. Use **web dev** for day-to-day iteration.

---

## Building an app file (per-OS distributable)

Dev commands (`dev:desktop`) launch Electron against your working tree — they don't
produce something you can hand to a user. To get a **standalone app file per OS**, run:

```sh
cd brainana-viewer
npm run dist:desktop     # build the SPA, then electron-builder → apps/viewer/release/
```

The output lands in `apps/viewer/release/` (gitignored). You get one app file per OS:

| OS | App file | How a user installs / runs it |
|---|---|---|
| macOS | `.dmg` (plus `.zip`) | open the dmg → drag `Brainana Viewer.app` to Applications → launch |
| Windows | `.exe` (NSIS installer) | run the installer → launch from the Start-menu shortcut |
| Linux | `.AppImage` (plus `.deb`) | AppImage: `chmod +x *.AppImage && ./Brainana*.AppImage`; deb: `sudo apt install ./*.deb` |

Targets and packaging are defined in [`apps/viewer/electron-builder.yml`](../apps/viewer/electron-builder.yml).

> **Build each OS on that OS.** electron-builder can't cross-compile these — a macOS
> `.dmg` must be built on macOS, a Windows `.exe` on Windows, etc. To produce all three
> from one push, use a CI matrix (macos / windows / ubuntu runners).

**First-launch warnings (v1 is unsigned):** macOS Gatekeeper → right-click → **Open**;
Windows SmartScreen → **More info → Run anyway**; Linux has no such gate. For signing,
notarization, native-module handling, and the full rationale, see
[desktop-app.md](desktop-app.md).

---

## What reloads automatically?

| You changed | Web dev | Desktop dev |
|---|---|---|
| `src/**` (UI, CSS, client logic) | ✅ HMR — nothing to do | ❌ re-run `dev:desktop` |
| `server/**`, `packages/core-server/**` | ❌ restart Terminal 1, reload browser | ✅ re-run `dev:desktop` (server restarts with app) |

---

## Command reference

| Command | Purpose |
|---|---|
| `npm run dev:web` | Vite + HMR (pair with `npm run server`) |
| `npm run dev:server -- --output-dir <path>` | API/data server for the paired `dev:web` flow — port 5174, guard off (`<path>` = `datasets/demo_viewer` for the bundled demo) |
| `npm run server -- --output-dir <path>` | API/data server, session token required (printed on startup) |
| `npm run dev:desktop` | Build + Electron |
| `npm run dist:desktop` | Build + electron-builder → per-OS app file in `apps/viewer/release/` |
| `npm run build` | Build static bundle → `dist/` |
| `npm start` | Serve last build in browser (no HMR) |
| `npm test` | Run tests |
| `npm run typecheck` | Type-check without building |

---

## Stopping / restarting dev servers

After changing `server/**` or `packages/core-server/**`, the browser has fresh
client code but the **Node API server is stale** — you must restart it (Vite/HMR
handles `src/**` on its own; just hard-reload with Ctrl/Cmd-Shift-R).

> **Shared box:** other users run their own `server.mjs` / viewer processes.
> **Only ever kill PIDs you own.** Always scope lookups to `$USER` so you never
> match someone else's process.

### 1. Identify your PID

List only *your* Vite + API dev processes, with PIDs:

```sh
# Your brainana-viewer dev processes only (scoped to your user)
pgrep -u "$USER" -af 'brainana-viewer/node_modules/.bin/vite|npm run server|npm run dev:web'
```

Or find what *you* have listening on the dev ports:

```sh
# Owner + PID of whatever holds 5173 (Vite) / 5174 (API)
ss -ltnp 2>/dev/null | grep -E ':(5173|5174)'
```

Confirm a PID is yours before killing it:

```sh
ps -o pid,user,cmd -p <PID>   # USER column must be you; cmd under /home/<you>/…
```

### 2. Kill it

```sh
# Restart only the API server: kill its PID, then relaunch Terminal 1
kill <API_PID>

# Full clean restart: kill both dev trees (children exit with the parents)
kill <DEV_WEB_PID> <SERVER_PID>
```

Only use `kill -9 <PID>` if a normal `kill` won't stop it. **Never** use
pattern-based mass kills (`pkill -f node`, `killall node`) on this box — they
will hit other users' processes.

### 3. Verify + restart

```sh
ss -ltnp 2>/dev/null | grep -E ':(5173|5174)'   # should print nothing once freed
```

Then relaunch per [Web dev](#web-dev-recommended) (Terminal 1 = `npm run server`,
Terminal 2 = `npm run dev:web`) and hard-reload the browser.

---

## Troubleshooting

**Manifest / "object is not iterable" errors after a server edit**
The browser has new client code but the Node server is stale. Restart Terminal 1, hard-reload the browser (Ctrl/Cmd-Shift-R).

**API 404 / can't list subjects**
API server not running, or port mismatch. Check `curl http://127.0.0.1:5174/api/health` and that Vite's proxy target matches (`BRAINANA_DEV_PORT`, default 5174).

**Port already in use**
```sh
ss -ltnp | grep -E ':(5173|5174)'
```
Use `--port` on the conflicting service, or kill your own stale process — see
[Stopping / restarting dev servers](#stopping--restarting-dev-servers).
