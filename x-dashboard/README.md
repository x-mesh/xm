# xm-dashboard — Web dashboard for .xm project state

Lightweight Bun HTTP server that reads `.xm/` state files and renders them as a browser dashboard. No build step, no dependencies.

## Quick Start

```bash
bun x-dashboard/lib/x-dashboard-server.mjs
# Opens http://127.0.0.1:19841
```

## Usage

### A. Claude Code 안에서 (스킬)

```
/x-kit:x-dashboard              # 대시보드 시작 (세션 모드, 60분 idle 자동 종료)
/x-kit:x-dashboard stop         # 대시보드 중지
/x-kit:x-dashboard status       # 상태 확인
/x-kit:x-dashboard open         # 브라우저에서 열기
```

세션 모드로 실행되며, Claude Code 세션이 끝나거나 60분간 요청이 없으면 자동 종료됩니다.

### B. 터미널 CLI에서 (직접 실행)

**시작:**

```bash
bun x-dashboard/lib/x-dashboard-server.mjs              # 독립 실행 (수동 종료 전까지 유지)
bun x-dashboard/lib/x-dashboard-server.mjs --port 8080   # 커스텀 포트
bun x-dashboard/lib/x-dashboard-server.mjs --session     # 세션 모드 (60분 idle 자동 종료)
```

**중지:**

```bash
bun x-dashboard/lib/x-dashboard-server.mjs --stop        # PID 파일로 실행 중인 인스턴스 종료
# 또는 Ctrl+C (포그라운드 실행 시)
```

**상태 확인:**

```bash
curl http://127.0.0.1:19841/health
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port N` | `19841` | 포트 지정 |
| `--stop` | — | 실행 중인 인스턴스 종료 |
| `--session` | — | 60분 idle 자동 종료 모드 |

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
| `GET` | `/api/search?q=keyword` | Cross-data search: projects, tasks, probes, solvers, context docs |

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
