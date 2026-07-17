# xm config

`xm config` manages shared settings that every tool (x-build, x-solver, x-op) reads from `.xm/config.json` (project) or `~/.xm/config.json` (global). Keys, types, and default scopes are declared once in `config-schema.mjs` — the 30-key registry that is the single source of truth for validation and write-target defaults.

> **⚠ Call `xm config <command>` directly through the dispatcher. Claude Code's Bash tool starts a fresh shell on every invocation — shell functions defined in one call do NOT persist to the next, causing `command not found`. Never define a helper across calls; always use the dispatcher.**
>
> **Fallback** (only when `xm` is not in PATH — rare):
> ```bash
> XMCFG_CLI=$(ls -d ~/.claude/plugins/cache/xm/{x-build,xm}/*/lib/x-config-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XMCFG_CLI" <command> [args]
> ```

## Commands

| Command | Description |
|---------|-------------|
| `xm config` | Interactive wizard — **TTY only**, do not launch from the Bash tool (see Interactive Wizard) |
| `xm config show` | Print global + local + effective (merged) settings, plus a cross-vendor pointer |
| `xm config get <key>` | Print the merged effective value; the source tier is written to stderr |
| `xm config set <key> <value>` | Set a key; validated against the registry (warns but still saves) |
| `xm config phase` | Print the resolved per-phase model matrix (설계 / 구현 / 리뷰) |
| `xm config phase plan=M implement=M review=M` | Set models per phase — sugar over `model_overrides`, no new key |
| `xm config reset` | Reset config to defaults |

Flags: `--local` (project `.xm/`), `--global` (`~/.xm/`). Without a flag, the write target comes from each key's registry scope.

## Scope

Each key carries a default write scope from `config-schema.mjs`. `--local` / `--global` override it per write.

| Scope (schema) | Default target | Keys |
|----------------|----------------|------|
| global | `~/.xm/config.json` | `mode`, `model_profile`, `model_overrides`, `agent_max_count`, `gates.*`, `scan_roots`, `drift.drift_threshold`, `pipelines` |
| local | `.xm/config.json` | `budget.max_usd`, `budget.window_hours`, `budget.projects` |
| build-local | `.xm/build/config.json` (3-tier) | `worktree.*` — see Worktree below |

**Effective value + source.** `xm config get <key>` reports the merged value with the tier it resolved from (local > global > default) on stderr. `xm config show` prints each layer separately plus the merged result. Use these to surface "current value (source)" before every wizard edit.

**Registry validation.** `xm config set` checks the key against the registry: an unregistered key, a value outside an enum, a type mismatch, or an out-of-range number prints a `⚠` warning. The write still proceeds (back-compat) and the exit code stays 0 — a warning is not a failure, but surface it to the user.

### Worktree 3-tier

`worktree.*` resolves over three tiers, highest priority first:

**build-local (`.xm/build/config.json`) > shared (`.xm/config.json`) > global (`~/.xm/config.json`) > schema defaults**

`gate_policy` merges **per-key** across tiers (setting one severity list in one tier leaves the others resolved from lower tiers), while scalar `worktree.*` keys are whole-value overrides. `xm config set worktree.<key>` writes to **global** (default) or **shared** with `--local`. The **build-local tier is written only by the interactive terminal wizard** (category 5), because `xm config set` is 2-tier — do not claim you wrote build-local when you used `set`.

## Settings (registry)

Model / execution:

| Key | Values | Default | Scope |
|-----|--------|---------|-------|
| `mode` | `developer`, `normal` | `developer` | global |
| `model_profile` | `economy`, `default`, `max` | `default` | global |
| `model_overrides` | `{ "role": "model" }` | `{}` | global |
| `agent_max_count` | integer 1–10 | `4` | global |

Vendor model mapping (global — a separate axis from `model_overrides`; layered over cost-engine's built-in `VENDOR_MODELS`):

| Key | Values | Default | Scope |
|-----|--------|---------|-------|
| `vendor_models` | `{ vendor: { tier: "model[:effort]" } }` | `{}` | global |
| `vendor_profiles` | `{ vendor: economy\|default\|max }` | `{}` | global |

Budget (default scope: local):

| Key | Values | Default | Scope |
|-----|--------|---------|-------|
| `budget.max_usd` | number or `null` | `null` (unlimited) | local |
| `budget.window_hours` | number or `null` | `null` (acts as 24h) | local |
| `budget.projects` | `{ "proj": { "max_usd": N } }` | `{}` | local |

Phase gates (`auto` / `human-verify` / `quality`):

| Key | Default | Scope |
|-----|---------|-------|
| `gates.research-exit` | `human-verify` | global |
| `gates.plan-exit` | `human-verify` | global |
| `gates.execute-exit` | `auto` | global |
| `gates.verify-exit` | `quality` | global |
| `gates.close-exit` | `auto` | global |

Worktree (build-local 3-tier; runtime source = `WORKTREE_CONFIG_DEFAULTS`):

| Key | Values | Default |
|-----|--------|---------|
| `worktree.enabled` | boolean | `true` |
| `worktree.base` | string | `develop` |
| `worktree.branch_prefix` | string | `feat/` |
| `worktree.max_parallel` | integer ≥1 | `4` |
| `worktree.gate` | string | `panel` |
| `worktree.gate_phase` | `before`, `after`, `release` | `before` |
| `worktree.gate_policy` | `{ block_confirmed, block_unreviewed, block_contested, allow_low }` | see schema |
| `worktree.preflight` | boolean | `true` |
| `worktree.cleanup` | boolean | `true` |
| `worktree.review_integration_max_bytes` | number or `null` | `null` |
| `worktree.gate_lock_backoff_ms` | integer ≥0 | `250` |

Misc (global):

| Key | Values | Default |
|-----|--------|---------|
| `scan_roots` | array of paths | `[]` |
| `drift.drift_threshold` | number 0–1 | `0.7` |
| `pipelines` | `{ "name": [plugin, ...] }` | `{}` |

Panel (owned by x-panel; editable from BOTH `xm panel setup` and the `xm config` wizard). `models` / `judge` delegate to `xm panel setup` (panel owns their validation); `timeout_s` / `model_overrides` are direct config writes:

| Key | Values | Default |
|-----|--------|---------|
| `panel` | object | `{}` |
| `panel.timeout_s` | integer ≥ 30 | `600` |
| `panel.model_overrides` | `{ "vendor": "model" }` | `{}` |

## Phase presets (`xm config phase`)

`phase` expands a per-phase model choice into `model_overrides` for that phase's roles (`PHASE_ROLE_GROUPS` in cost-engine):

| Slot | Roles |
|------|-------|
| `plan` (설계) | architect, planner, critic, security, researcher |
| `implement` (구현) | executor, deep-executor, designer, debugger |
| `review` (리뷰) | reviewer, verifier |

Values: `haiku` / `sonnet` / `opus` / `default` (`default` removes that slot's overrides → back to profile). Example: `xm config phase plan=opus implement=sonnet review=opus`.

## Config Resolution

Settings resolve in priority order:

1. Project-local (`.xm/config.json`)
2. Global (`~/.xm/config.json`)
3. Schema defaults

`worktree.*` inserts the build-local tier (`.xm/build/config.json`) above project-local for its keys only.

## Interactive Wizard (7 categories)

The terminal CLI (`xm config` with no subcommand) opens a menu-driven wizard. **Do NOT launch it from the Bash tool** — the wizard requires a TTY, the Bash tool has none, so a bare `xm config` exits 1 and prints a pointer to the non-interactive subcommands. Instead, reproduce the wizard yourself with AskUserQuestion, applying each choice through `xm config set` / `xm config phase`. The menu items and key coverage below match the CLI wizard 1:1.

**Step 1 — show current state**

```bash
xm config show
```

**Step 2 — pick a category** (AskUserQuestion):

```
설정할 항목을 선택하세요:

1) 모델        프로필 · 역할 오버라이드 · 페이즈별 모델
2) 예산        세션/프로젝트 비용 상한 (기본 스코프: local)
3) 실행        병렬 에이전트 수
4) 게이트      페이즈 종료 게이트 (auto / human-verify / quality)
5) worktree    병렬 worktree 실행 (build-local 3-tier)
6) 기타        mode · drift · scan_roots · pipelines
7) panel       cross-vendor 프로바이더 (models/judge · timeout_s · model_overrides)
0) 나가기
```

**Step 3 — per-category actions.** For every edit, first run `xm config get <key>` (or `xm config show`) to display the current effective value and its source tier, then apply:

| Category | AskUserQuestion → apply |
|----------|-------------------------|
| 1 모델 | (a) 프로필: economy / default / max → `xm config set model_profile <v>`. (b) 역할별 오버라이드: read `xm config get model_overrides`, merge the chosen `role=model`, write the full object with `xm config set model_overrides '{...}'`. (c) 페이즈별 모델: run `xm config phase` to show the matrix, ask one question per slot (프로필 기본값 / haiku / sonnet / opus), then `xm config phase plan=<m> implement=<m> review=<m>` with only the changed slots. (d) vendor 모델 매핑: `xm config set vendor_models.<vendor>.<tier> <model[:effort]>` (예: `vendor_models.codex.opus "gpt-5.6-sol"`); 벤더별 프로필은 `xm config set vendor_profiles.<vendor> <economy\|default\|max>`. effort 접미사 허용값: `minimal`/`low`/`medium`/`high`/`xhigh`. |
| 2 예산 | 세션 최대 비용 → `xm config set budget.max_usd <n> --local` (0 or `null` = 무제한). 추적 윈도우 → `xm config set budget.window_hours <n> --local`. 프로젝트별 예산 → read current, merge, `xm config set budget.projects '{"my-app":{"max_usd":5}}' --local`. |
| 3 실행 | 에이전트 수 (1–10) → `xm config set agent_max_count <n>`. |
| 4 게이트 | Pick a gate (research/plan/execute/verify/close-exit), then a value → `xm config set gates.<name> <auto\|human-verify\|quality>`. |
| 5 worktree | Scalar keys → `xm config set worktree.<key> <value>` (global) or add `--local` for the shared tier. gate_policy severity lists → read `xm config get worktree.gate_policy`, merge the one subkey, write the full object. **build-local tier is not writable via `set`** — tell the user to run `xm config` in a real terminal (category 5) for `.xm/build/config.json`. |
| 6 기타 | mode → `xm config set mode <developer\|normal>`. drift → `xm config set drift.drift_threshold <0–1>`. scan_roots → `xm config set scan_roots '["~/work"]'`. pipelines → `xm config set pipelines '{"review":["x-review","x-eval"]}'`. |
| 7 panel | Editable. `models` → `xm panel setup --models claude,codex,agy [--global]` (delegated; panel validates + merges per-key). `judge` → `xm panel setup --judge rule [--global]` (only `rule` is implemented). `timeout_s` → `xm config set panel.timeout_s <n≥30>` (direct). `model_overrides` (`{ vendor: model }`, bare `--models` names resolve to it) → read `xm config get panel.model_overrides`, merge, `xm config set panel.model_overrides '{"cursor":"kimi-k2.5"}'`. Note panel's own merge is per-key project(.xm) > global(~/.xm). |

After each change, re-run `xm config get <key>` to confirm the new value and source, then ask "다른 설정도 변경할까요? (y/n)". If yes, return to Step 2.

**Shadow warning.** Before writing to global while a local layer sets the same top-level key (or to shared/global while a higher worktree tier sets it), warn the user that the write will not reach the effective value, and confirm before proceeding — mirroring the CLI wizard.

## CLI Config (non-interactive)

```bash
xm config show
xm config get mode                       # value on stdout, source tier on stderr
xm config set agent_max_count 10         # global (schema default)
xm config set budget.max_usd 5 --local   # project .xm/
xm config set vendor_models.codex.opus "gpt-5.6-sol"   # vendor tier → model[:effort]
xm config phase plan=opus implement=sonnet review=opus
xm config reset --local
```
