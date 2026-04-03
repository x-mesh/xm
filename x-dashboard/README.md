# xm-dashboard — Web dashboard for .xm project state

Lightweight Bun HTTP server that reads `.xm/` state files and renders them as a browser dashboard. No build step, no dependencies.

## Quick Start

```bash
bun x-dashboard/lib/x-dashboard-server.mjs
# Opens http://127.0.0.1:19841
```

## Usage

### Standalone (default)

Runs until manually stopped. No idle timeout.

```bash
bun x-dashboard/lib/x-dashboard-server.mjs
bun x-dashboard/lib/x-dashboard-server.mjs --port 8080
```

### Stop

```bash
bun x-dashboard/lib/x-dashboard-server.mjs --stop
```

### Session mode

Exits automatically after 60 minutes of idle (no incoming requests).

```bash
bun x-dashboard/lib/x-dashboard-server.mjs --session
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port N` | `19841` | Port to listen on |
| `--stop` | — | Stop a running instance |
| `--session` | — | Enable 60 min idle timeout |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health: `status`, `version`, `uptime`, `port`, `pid` |
| `GET` | `/api/health` | Same as `/health` plus `mode` (`standalone` or `session`) |
| `GET` | `/shutdown` | Gracefully stop the server |
| `GET` | `/api/config` | Read `.xm/config.json` |
| `GET` | `/api/projects` | List all project manifests from `.xm/build/projects/` |
| `GET` | `/api/projects/:slug` | Single project: manifest, circuit-breaker, handoff, phases, context |
| `GET` | `/api/projects/:slug/tasks` | Tasks for a project (`phases/02-plan/tasks.json`) |
| `GET` | `/api/probe/latest` | Latest probe verdict (`.xm/probe/last-verdict.json`) |
| `GET` | `/api/probe/history` | All probe history entries, sorted newest first |
| `GET` | `/api/probe/history/:file` | Single probe history entry by filename (`.json` optional) |
| `GET` | `/api/solver` | List all solver problem manifests |
| `GET` | `/api/solver/:slug` | Single solver problem: manifest + phases |
| `GET` | `/api/metrics/sessions` | Session metrics from `.xm/build/metrics/sessions.jsonl`. Query: `?limit=50&offset=0` |

Static files under `public/` are served at their URL path. `/` resolves to `/index.html`.

## Architecture

```
Browser
  |
  | HTTP GET /api/*  or  static assets
  v
x-dashboard-server.mjs  (Bun HTTP, 127.0.0.1:19841)
  |
  |-- public/          (index.html, app.js, style.css)
  |
  +-- .xm/             (read-only, cwd of the invoking shell)
        |-- config.json
        |-- build/
        |     |-- projects/<slug>/
        |     |     |-- manifest.json
        |     |     |-- circuit-breaker.json
        |     |     |-- HANDOFF.json
        |     |     |-- phases/<phase>/status.json
        |     |     +-- context/*.md
        |     +-- metrics/sessions.jsonl
        |-- probe/
        |     |-- last-verdict.json
        |     +-- history/*.json
        +-- solver/
              +-- problems/<slug>/
                    |-- manifest.json
                    +-- phases/<phase>/status.json
```

### Process management

A PID file is written to `~/.xm/run/xdashboard-server.pid` on startup and removed on clean exit. Starting a second instance while one is already running will print an error and exit. `--stop` reads the PID file, sends `SIGTERM`, and waits up to 5 seconds for the process to exit.

### Security

Path traversal protection is applied to all file access: each URL segment is validated against `[a-zA-Z0-9_-]+` and all resolved paths are checked to stay within the intended base directory before any file is read.

## File Structure

```
x-dashboard/
  lib/
    x-dashboard-server.mjs   # Bun HTTP server
  public/
    index.html               # Dashboard UI
    app.js                   # Frontend logic (vanilla JS)
    style.css                # Styles
  test/                      # Test suite
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) — serves HTTP and reads files with zero npm dependencies
- **Frontend**: Vanilla HTML / JS / CSS — no framework, no bundler
- **Data source**: `.xm/` directory tree (JSON files written by x-build and related tools)

## Development

```bash
bun test x-dashboard/test/
```
