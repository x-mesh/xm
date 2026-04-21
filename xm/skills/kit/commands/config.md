# xm config

xm manages shared settings at `.xm/config.json` that all tools (x-build, x-solver, x-op) reference.

## Commands

| Command | Description |
|---------|-------------|
| `xm config` | Interactive config wizard |
| `xm config show` | Show current settings (global + local + merged) |
| `xm config set <key> <value>` | Change a setting |
| `xm config get <key>` | Get a setting value |
| `xm config reset` | Reset config to defaults |

## Scope

Default: **global** (`~/.xm/config.json`). Use `--local` to write to project (`.xm/config.json`).

Exception: `budget` defaults to **local** (per-project budgets are more natural).

| Flag | Writes to |
|------|-----------|
| (default) | `~/.xm/config.json` |
| `--local` | `.xm/config.json` |
| `--global` | `~/.xm/config.json` (explicit) |

## Settings

| Key | Values | Default | Scope | Description |
|-----|--------|---------|-------|-------------|
| `mode` | `developer`, `normal` | `developer` | global | Output style |
| `model_profile` | `economy`, `default`, `max` | `default` | global | Cost intent (legacy `balanced`/`performance` auto-map to `default`/`max`) |
| `agent_max_count` | number (1-10) | `4` | global | Max parallel agents |
| `budget.max_usd` | number or null | `null` | local | Session budget limit ($) |
| `model_overrides` | `{"role": "model"}` | `{}` | global | Per-role model overrides on top of profile |

## Config Resolution

Settings are resolved in priority order:
1. Project-local (`.xm/config.json`)
2. Global (`~/.xm/config.json`)
3. Default values

## Interactive Config (`xm config` with no sub-command)

When `config` is called with no arguments, run an interactive wizard using AskUserQuestion.

**Step 1: Show current state**

Run via Bash:
```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/shared-config.mjs').then(m => m.cmdConfig(['show']))"
```

**Step 2: Ask what to configure**

Use AskUserQuestion:
```
설정할 항목을 선택하세요:

1) 모델 프로필 — economy / default / max
2) 예산 한도 — 세션당 최대 비용 ($)
3) 에이전트 수 — 병렬 에이전트 수 (1-10)
4) 모드 — developer / normal
5) 역할별 오버라이드 — 프로필 위에 개별 역할 모델 지정
0) 나가기
```

**Step 3: Execute based on choice**

| Choice | Action |
|--------|--------|
| 1 | AskUserQuestion: "1) economy (Sonnet 중심, 최대 절약) 2) default (Opus 중심, 권장) 3) max (전부 Opus)" → run `cmdConfig(['set', 'model_profile', selected])` |
| 2 | AskUserQuestion: "세션 예산 ($, 0=무제한):" → run `cmdConfig(['set', 'budget.max_usd', value], { local: true })` |
| 3 | AskUserQuestion: "에이전트 수 (1-10):" → run `cmdConfig(['set', 'agent_max_count', value])` |
| 4 | AskUserQuestion: "1) developer 2) normal" → run `cmdConfig(['set', 'mode', selected])` |
| 5 | AskUserQuestion: "형식: role=model (예: architect=opus), done으로 종료" → loop: run `cmdConfig(['set', 'model_overrides', JSON.stringify(overrides)])` |
| 0 | Exit |

After each setting change, show the updated value and ask "다른 설정도 변경할까요? (y/n)". If y, return to Step 2.

## CLI Config (`xm config set/get/show/reset`)

Run directly via Bash:
```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/shared-config.mjs').then(m => m.cmdConfig(['show']))"
node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/shared-config.mjs').then(m => m.cmdConfig(['set', 'KEY', 'VALUE']))"
node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/shared-config.mjs').then(m => m.cmdConfig(['get', 'KEY']))"
node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/shared-config.mjs').then(m => m.cmdConfig(['reset']))"
```

For `--local` scope, pass flags: `m.cmdConfig(['set', 'KEY', 'VALUE'], { local: true })`
