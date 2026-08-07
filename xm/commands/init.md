---
name: init
description: Start a project (init <name>) or install xm global hooks into ~/.claude/ (init with no args)
---

# xm init — Project Start / Global Install

`init` is overloaded on its first argument:

- **`init <name>`** → start a project: create `.xm/build/projects/<name>` and register it. This is the common case.
- **`init`** (no args) → install the `trace-session` hook into `~/.claude/hooks/` and register Skill matchers in `~/.claude/settings.json`. Machine-level, once per machine, idempotent. `setup` is the explicit name for this and is preferred in new docs.

## Arguments

User provided: $ARGUMENTS

Routing — check the FIRST token:
- Empty → global `install` (then tell the user `xm init <name>` starts a project)
- `status`, `uninstall`, `install`, or `help` → global install route
- `--no-hooks` (and every flag except `--here`) → global install route; `--no-hooks` installs the CLI dispatcher without copying hooks
- `.` or `--here` → start a project named after the current directory
- **anything else** → treat it as a project name → run the project route below

Reserved words above can never be project names. When the user genuinely wants a project called `status`, use `xm build init status`.

## Project route

Do NOT load `setup-global.mjs` for this route. Run:

```bash
xm init <name>
```

The dispatcher creates the project via `x-build init` and registers it in `~/.xm/projects.json`. Report the created path and the suggested next step verbatim, then stop — do not chain into the phase workflow unless asked.

## Global install route — locate the setup script

Run this bash to resolve the setup-global.mjs path (prefers local repo, falls back to plugin cache latest version):

```bash
resolve_script() {
  if [ -f "xm/scripts/setup-global.mjs" ]; then
    echo "xm/scripts/setup-global.mjs"
    return
  fi
  local cache="$HOME/.claude/plugins/cache/xm/xm:kit"
  if [ -d "$cache" ]; then
    ls -d "$cache"/*/scripts/setup-global.mjs 2>/dev/null | sort -V | tail -1
  fi
}
SCRIPT="$(resolve_script)"
if [ -z "$SCRIPT" ] || [ ! -f "$SCRIPT" ]; then
  echo "xm: setup-global.mjs not found (looked in cwd + plugin cache)" >&2
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
✅ xm 전역 설치 완료. 새 Claude 세션부터 trace hook이 활성화됩니다.
```

On `NOT installed` after `install`, surface the stderr lines so the user can see which step failed.

When the invocation had no arguments, close with one extra line so the user learns the project form:

```
💡 프로젝트를 시작하려면: xm init <name>
```

## When to use

Project route:
- The user names a project to start ("aic 프로젝트 만들어줘", "start a project called aic")

Global install route:
- First-time setup on a new machine
- After `~/.claude/settings.json` was reset
- After the user asks "install xm globally" / "xm 전역 설치"
- `/xm:kit init` invocation in Claude Code

Do **not** invoke this command for project-local setup — trace-session is a user-level hook only.
