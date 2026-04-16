---
name: init
description: Install x-kit global hooks (trace-session) and settings into ~/.claude/
---

# x-kit init — Global Install

Install the `trace-session` hook globally into `~/.claude/hooks/` and register Skill matchers in `~/.claude/settings.json`. Idempotent — safe to re-run.

## Arguments

User provided: $ARGUMENTS

Routing:
- Empty → `install`
- `status` → show current install state and exit
- `uninstall` → remove hook + settings entries
- `--no-hooks` → install CLI dispatcher only (skip hook copy)

## Locate the setup script

Run this bash to resolve the setup-global.mjs path (prefers local repo, falls back to plugin cache latest version):

```bash
resolve_script() {
  if [ -f "x-kit/scripts/setup-global.mjs" ]; then
    echo "x-kit/scripts/setup-global.mjs"
    return
  fi
  local cache="$HOME/.claude/plugins/cache/x-kit/x-kit"
  if [ -d "$cache" ]; then
    ls -d "$cache"/*/scripts/setup-global.mjs 2>/dev/null | sort -V | tail -1
  fi
}
SCRIPT="$(resolve_script)"
if [ -z "$SCRIPT" ] || [ ! -f "$SCRIPT" ]; then
  echo "x-kit: setup-global.mjs not found (looked in cwd + plugin cache)" >&2
  exit 1
fi
```

## Dispatch

- `$ARGUMENTS` empty or `install` → `node "$SCRIPT" install`
- `status` → `node "$SCRIPT" status`
- `uninstall` → `node "$SCRIPT" uninstall`
- `--no-hooks` → `node "$SCRIPT" install --no-hooks`

Pass the resolved script path verbatim; do not re-resolve per subcommand.

## Output

Print the command output as-is. On success (`overall: OK`), close with:

```
✅ x-kit 전역 설치 완료. 새 Claude 세션부터 trace hook이 활성화됩니다.
```

On `NOT installed` after `install`, surface the stderr lines so the user can see which step failed.

## When to use

- First-time setup on a new machine
- After `~/.claude/settings.json` was reset
- After the user asks "install x-kit globally" / "x-kit 전역 설치"
- `/x-kit init` invocation in Claude Code

Do **not** invoke this command for project-local setup — trace-session is a user-level hook only.
