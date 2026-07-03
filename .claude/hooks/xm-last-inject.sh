#!/usr/bin/env bash
# .claude/hooks/xm-last-inject.sh
#
# SessionStart hook: surface the xm cross-tool activity ledger (.xm/last.json)
# as a short "what did each tool last touch" note in the session's opening
# context. Reuses x-trace-cli's own `last` / `status` subcommands — this hook
# only formats their JSON; it never reimplements git counting or ledger reads.
#
# Example additionalContext:
#   [xm activity — recent tool actions]
#   build: 47c4fd2 (5 commits ago, phase-2 done)
#   review: 47c4fd2 (0 commits ago, reviewed)
#
# FM7 (never delay or break session start): every failure path — missing CLI,
# absent jq, a slow/hung CLI, unparseable output, or an empty ledger — emits a
# bare `{}` and exits 0. stderr is muted throughout, so the hook adds at most a
# few lines of context and can never block or fail the session.

# Emit an empty (no-op) hook result and exit successfully. The single escape
# hatch every guard below uses so the session always starts.
emit_empty() { printf '{}\n'; exit 0; }

# Without jq we cannot build/escape JSON safely — degrade to no injection.
command -v jq >/dev/null 2>&1 || emit_empty

# --- locate x-trace-cli.mjs --------------------------------------------------
# Order: local source -> xm bundle mirror -> newest plugin-cache copy
# (x-trace plugin preferred, then the xm bundle). $CLAUDE_PROJECT_DIR is set for
# SessionStart hooks; fall back to this script's own repo root so a manual run
# from any cwd still resolves the source copy.
ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
fi

CLI=""
for cand in \
  "$ROOT/x-trace/lib/x-trace-cli.mjs" \
  "$ROOT/xm/lib/x-trace-cli.mjs"; do
  if [ -f "$cand" ]; then CLI="$cand"; break; fi
done
if [ -z "$CLI" ]; then
  # Newest versioned copy from the plugin cache (sort -V picks the highest).
  CLI="$(ls -d "$HOME"/.claude/plugins/cache/xm/{x-trace,xm}/*/lib/x-trace-cli.mjs 2>/dev/null | sort -V | tail -1)"
fi
[ -n "$CLI" ] && [ -f "$CLI" ] || emit_empty

# --- run the CLI under a hard time budget -----------------------------------
# node startup + a couple of git calls is normally <1s; the budget only guards a
# pathological git state. Prefer coreutils timeout; otherwise a portable
# background + watchdog kill so macOS (no `timeout` by default) never hangs the
# session. stderr is discarded either way.
run_capped() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@" 2>/dev/null
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@" 2>/dev/null
  else
    "$@" 2>/dev/null &
    local pid=$!
    # Watchdog detached from the capture pipe (</dev/null >/dev/null) so command
    # substitution returns as soon as the real process exits, not after `secs`.
    ( sleep "$secs"; kill -9 "$pid" ) </dev/null >/dev/null 2>&1 &
    local watcher=$!
    wait "$pid" 2>/dev/null
    kill "$watcher" 2>/dev/null
  fi
}

# Ledger (ref + status per tool). Must be present, valid JSON, and non-empty.
LAST_JSON="$(run_capped 8 node "$CLI" last --json)"
[ -n "$LAST_JSON" ] || emit_empty
printf '%s' "$LAST_JSON" | jq -e 'type == "object" and (length > 0)' >/dev/null 2>&1 || emit_empty

# commits_since enrichment is best-effort — on failure fall back to an empty map
# and the summary simply omits the "N commits ago" clause.
STATUS_JSON="$(run_capped 8 node "$CLI" status --json)"
printf '%s' "$STATUS_JSON" | jq -e 'type == "object"' >/dev/null 2>&1 || STATUS_JSON='{}'

# --- build the SessionStart additionalContext -------------------------------
# One line per tool (max 3): "<tool>: <ref7> (<N> commits ago, <status>)". When
# commits_since is unavailable the clause collapses to just the status string.
OUT="$(jq -n --argjson last "$LAST_JSON" --argjson status "$STATUS_JSON" '
  ( [ $last | to_entries[]
      | select(.value != null and .value.ref != null)
      | .key as $tool
      | (.value.ref | if test("^[0-9a-f]{7,40}$") then .[0:7] else . end) as $sref
      | (.value.status // "no status") as $st
      | ($status[$tool].commits_since) as $n
      | (if $n == null then $st
         else "\($n) commit\(if $n == 1 then "" else "s" end) ago, \($st)" end) as $paren
      | "\($tool): \($sref) (\($paren))"
    ] | sort | .[0:3] ) as $lines
  | if ($lines | length) == 0 then {}
    else { hookSpecificOutput: { hookEventName: "SessionStart",
           additionalContext: ("[xm activity — recent tool actions]\n" + ($lines | join("\n"))) } }
    end
' 2>/dev/null)"

[ -n "$OUT" ] || emit_empty
printf '%s\n' "$OUT"
