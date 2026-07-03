#!/usr/bin/env bash
# sync-bundle.sh — Sync standalone plugin files to xm bundle
# Run from repo root: ./scripts/sync-bundle.sh
# Source of truth: standalone plugin directories
# Plugin naming: source dirs keep x-{name}/, skills dirs use {name}/ (no x- prefix)

set -euo pipefail
cd "$(dirname "$0")/.."

CHECK_MODE=0
case "${1:-}" in
  --check)
    CHECK_MODE=1
    shift
    ;;
  -h|--help)
    echo "Usage: bash scripts/sync-bundle.sh [--check]"
    echo "  default   sync standalone plugin sources into xm/"
    echo "  --check   verify source and bundle are in sync without writing files"
    exit 0
    ;;
  "")
    ;;
  *)
    echo "sync-bundle.sh: unknown argument: $1" >&2
    exit 2
    ;;
esac
if [ "$#" -gt 0 ]; then
  echo "sync-bundle.sh: unknown argument: $1" >&2
  exit 2
fi

ERRORS=0

ensure_dir() {
  if [ "$CHECK_MODE" -eq 0 ]; then
    mkdir -p "$1"
  fi
}

record_error() {
  ERRORS=$((ERRORS + 1))
}

sync_file() {
  local src="$1" dst="$2"
  if [ ! -f "$src" ]; then
    echo "  MISSING SOURCE $src"
    record_error
    return
  fi
  ensure_dir "$(dirname "$dst")"
  if [ ! -f "$dst" ]; then
    if [ "$CHECK_MODE" -eq 1 ]; then
      echo "  MISSING $dst (from $src)"
      record_error
      return
    fi
  fi
  if diff -q "$src" "$dst" > /dev/null 2>&1; then
    echo "  OK   $dst"
  else
    if [ "$CHECK_MODE" -eq 1 ]; then
      echo "  DIVERGED $dst"
      record_error
    else
      cp "$src" "$dst"
      echo "  SYNC $dst"
    fi
  fi
}

remove_obsolete_file() {
  local path="$1"
  if [ -f "$path" ]; then
    if [ "$CHECK_MODE" -eq 1 ]; then
      echo "  OBSOLETE $path"
      record_error
    else
      rm -f "$path"
      echo "  REMOVE $path"
    fi
  fi
}

# Mirror every *.md inside a source directory to a destination directory.
# Creates the destination if missing; no-op on empty source.
mirror_md_dir() {
  local src="$1" dst="$2"
  [ -d "$src" ] || return 0
  ensure_dir "$dst"
  shopt -s nullglob
  for f in "$src"/*.md; do
    sync_file "$f" "$dst/$(basename "$f")"
  done
  shopt -u nullglob
}

echo "=== Syncing SKILL.md files ==="
for plugin in build op solver eval review trace memory humble probe agent dashboard humanize sync recall panel; do
  src="x-$plugin/skills/$plugin/SKILL.md"
  dst="xm/skills/$plugin/SKILL.md"
  sync_file "$src" "$dst"
done

echo ""
echo "=== Syncing plugin commands into bundle ==="
# Every plugin's commands/*.md → xm/commands/. ADDITIVE: xm-native commands
# (handoff/handon/init/kit/ship/sync/xm) have no x-<plugin> source and are left
# untouched. Mirror wholesale (no hardcoded plugin list) so a new plugin's
# command — e.g. panel.md, recall.md — ships into the bundle automatically (L8).
shopt -s nullglob
for cmddir in x-*/commands; do
  mirror_md_dir "$cmddir" "xm/commands"
done
shopt -u nullglob

echo ""
echo "=== Syncing shared docs ==="
sync_file "docs/korean-output-style.md" "xm/docs/korean-output-style.md"

echo ""
echo "=== Syncing x-build lib files ==="
shopt -s nullglob
for f in x-build/lib/x-build/*.mjs; do
  sync_file "$f" "xm/lib/x-build/$(basename "$f")"
done
shopt -u nullglob
remove_obsolete_file "xm/lib/x-build/parking-lot.mjs"
sync_file "x-build/lib/x-build-cli.mjs" "xm/lib/x-build-cli.mjs"
sync_file "x-build/lib/x-config-cli.mjs" "xm/lib/x-config-cli.mjs"
sync_file "x-build/lib/shared-config.mjs" "xm/lib/shared-config.mjs"
sync_file "x-build/lib/config-schema.mjs" "xm/lib/config-schema.mjs"
sync_file "x-build/lib/cli-prompts.mjs" "xm/lib/cli-prompts.mjs"
sync_file "x-build/lib/cli-messages.mjs" "xm/lib/cli-messages.mjs"
sync_file "x-build/lib/default-config.json" "xm/lib/default-config.json"

echo ""
echo "=== Syncing x-memory lib files ==="
sync_file "x-memory/lib/x-memory-cli.mjs" "xm/lib/x-memory-cli.mjs"
for f in commands.mjs core.mjs store.mjs; do
  sync_file "x-memory/lib/x-memory/$f" "xm/lib/x-memory/$f"
done

echo ""
echo "=== Syncing x-recall lib files ==="
sync_file "x-recall/lib/x-recall-cli.mjs" "xm/lib/x-recall-cli.mjs"
ensure_dir "xm/lib/x-recall"
# Mirror all *.mjs wholesale so dependency modules ship automatically (L8).
shopt -s nullglob
for f in x-recall/lib/x-recall/*.mjs; do
  sync_file "$f" "xm/lib/x-recall/$(basename "$f")"
done
shopt -u nullglob

echo ""
echo "=== Syncing x-panel lib files ==="
sync_file "x-panel/lib/x-panel-cli.mjs" "xm/lib/x-panel-cli.mjs"
ensure_dir "xm/lib/x-panel"
shopt -s nullglob
for f in x-panel/lib/x-panel/*.mjs; do
  sync_file "$f" "xm/lib/x-panel/$(basename "$f")"
done
shopt -u nullglob

echo ""
echo "=== Syncing x-solver lib files ==="
# Mirror all *.mjs wholesale so dependency modules (e.g. convergence.mjs) ship automatically.
# default-config.json is intentionally excluded: it would collide with x-build's at xm/lib/default-config.json.
shopt -s nullglob
for f in x-solver/lib/*.mjs; do
  sync_file "$f" "xm/lib/$(basename "$f")"
done
shopt -u nullglob

echo ""
echo "=== Syncing x-sync lib files ==="
ensure_dir "xm/lib/x-sync"
shopt -s nullglob
for f in x-sync/lib/x-sync/*.mjs; do
  sync_file "$f" "xm/lib/x-sync/$(basename "$f")"
done
shopt -u nullglob
# Server entry — sync-server.mjs resolves it at ../x-sync-server.mjs relative to lib/x-sync/
sync_file "x-sync/lib/x-sync-server.mjs" "xm/lib/x-sync-server.mjs"

echo ""
echo "=== Syncing x-trace lib files ==="
sync_file "x-trace/lib/x-trace-cli.mjs" "xm/lib/x-trace-cli.mjs"
ensure_dir "xm/lib/x-trace"
# Mirror all *.mjs wholesale so dependency modules (trace-writer.mjs, last-store.mjs)
# ship automatically — a hardcoded trace-writer-only sync silently drops last-store.mjs
# and the CLI (L8).
shopt -s nullglob
for f in x-trace/lib/x-trace/*.mjs; do
  sync_file "$f" "xm/lib/x-trace/$(basename "$f")"
done
shopt -u nullglob

echo ""
echo "=== Syncing x-dashboard lib + public ==="
sync_file "x-dashboard/lib/x-dashboard-server.mjs" "xm/lib/x-dashboard-server.mjs"
ensure_dir "xm/public"
# Mirror public/ wholesale including subdirectories (e.g. vendor/) so bundled assets
# ship automatically — a flat public/* glob silently drops vendor/*.js (L8).
while IFS= read -r f; do
  rel="${f#x-dashboard/public/}"
  ensure_dir "xm/public/$(dirname "$rel")"
  sync_file "$f" "xm/public/$rel"
done < <(find x-dashboard/public -type f)

echo ""
echo "=== Syncing references ==="
mirror_md_dir "references" "xm/references"

echo ""
echo "=== Syncing op strategies ==="
mirror_md_dir "x-op/skills/op/strategies" "xm/skills/op/strategies"

echo ""
echo "=== Syncing op references ==="
mirror_md_dir "x-op/skills/op/references" "xm/skills/op/references"

echo ""
echo "=== Syncing agent autonomous ==="
mirror_md_dir "x-agent/skills/agent/autonomous" "xm/skills/agent/autonomous"

echo ""
echo "=== Syncing agent references ==="
mirror_md_dir "x-agent/skills/agent/references" "xm/skills/agent/references"

echo ""
echo "=== Syncing agent flow (skill doc + engine) ==="
# flow.md sits beside SKILL.md; flow/ holds the Workflow engine (.mjs, not *.md),
# so mirror the whole flow/ tree by file type, not just *.md (L8: mirror wholesale).
sync_file "x-agent/skills/agent/flow.md" "xm/skills/agent/flow.md"
if [ -d "x-agent/skills/agent/flow" ]; then
  while IFS= read -r f; do
    rel="${f#x-agent/skills/agent/flow/}"
    ensure_dir "xm/skills/agent/flow/$(dirname "$rel")"
    sync_file "$f" "xm/skills/agent/flow/$rel"
  done < <(find x-agent/skills/agent/flow -type f)
fi

echo ""
echo "=== Syncing build references ==="
mirror_md_dir "x-build/skills/build/references" "xm/skills/build/references"

echo ""
echo "=== Syncing build commands ==="
mirror_md_dir "x-build/skills/build/commands" "xm/skills/build/commands"

echo ""
echo "=== Syncing build phases ==="
mirror_md_dir "x-build/skills/build/references/phases" "xm/skills/build/references/phases"

echo ""
echo "=== Syncing review lenses ==="
mirror_md_dir "x-review/skills/review/lenses" "xm/skills/review/lenses"

echo ""
echo "=== Syncing review references ==="
mirror_md_dir "x-review/skills/review/references" "xm/skills/review/references"

echo ""
echo "=== Syncing eval judges ==="
mirror_md_dir "x-eval/skills/eval/judges" "xm/skills/eval/judges"

echo ""
echo "=== Syncing eval subcommands ==="
mirror_md_dir "x-eval/skills/eval/subcommands" "xm/skills/eval/subcommands"

echo ""
echo "=== Syncing eval references ==="
mirror_md_dir "x-eval/skills/eval/references" "xm/skills/eval/references"

echo ""
echo "=== Syncing solver commands ==="
mirror_md_dir "x-solver/skills/solver/commands" "xm/skills/solver/commands"

echo ""
echo "=== Syncing solver references ==="
mirror_md_dir "x-solver/skills/solver/references" "xm/skills/solver/references"

echo ""
echo "=== Syncing probe sessions ==="
mirror_md_dir "x-probe/skills/probe/sessions" "xm/skills/probe/sessions"

echo ""
echo "=== Syncing trace subcommands ==="
mirror_md_dir "x-trace/skills/trace/subcommands" "xm/skills/trace/subcommands"

echo ""
echo "=== Syncing humble sessions ==="
mirror_md_dir "x-humble/skills/humble/sessions" "xm/skills/humble/sessions"

echo ""
echo "=== Syncing memory references ==="
mirror_md_dir "x-memory/skills/memory/references" "xm/skills/memory/references"

echo ""
echo "=== Syncing humanize references ==="
mirror_md_dir "x-humanize/skills/humanize/references" "xm/skills/humanize/references"

echo ""
echo "=== Verifying all synced ==="
DIVERGED=0
for plugin in build op solver eval review trace memory humble probe agent dashboard humanize sync recall panel; do
  src="x-$plugin/skills/$plugin/SKILL.md"
  dst="xm/skills/$plugin/SKILL.md"
  if [ -f "$src" ] && [ -f "$dst" ] && ! diff -q "$src" "$dst" > /dev/null 2>&1; then
    echo "  DIVERGED: $dst"
    DIVERGED=$((DIVERGED + 1))
  fi
done

shopt -s nullglob
for cmddir in x-*/commands; do
  for f in "$cmddir"/*.md; do
    dst="xm/commands/$(basename "$f")"
    if [ -f "$dst" ] && ! diff -q "$f" "$dst" > /dev/null 2>&1; then
      echo "  DIVERGED: $dst"
      DIVERGED=$((DIVERGED + 1))
    elif [ ! -f "$dst" ]; then
      echo "  MISSING: $dst (from $f)"
      DIVERGED=$((DIVERGED + 1))
    fi
  done
done
shopt -u nullglob

shopt -s nullglob
for f in x-build/lib/x-build/*.mjs; do
  dst="xm/lib/x-build/$(basename "$f")"
  if ! diff -q "$f" "$dst" > /dev/null 2>&1; then
    echo "  DIVERGED: $dst"
    DIVERGED=$((DIVERGED + 1))
  fi
done
shopt -u nullglob

for pair in \
  "x-build/lib/shared-config.mjs:xm/lib/shared-config.mjs" \
  "x-build/lib/config-schema.mjs:xm/lib/config-schema.mjs" \
  "x-build/lib/cli-prompts.mjs:xm/lib/cli-prompts.mjs" \
  "x-build/lib/cli-messages.mjs:xm/lib/cli-messages.mjs" \
  "x-build/lib/default-config.json:xm/lib/default-config.json"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  if ! diff -q "$src" "$dst" > /dev/null 2>&1; then
    echo "  DIVERGED: $dst"
    DIVERGED=$((DIVERGED + 1))
  fi
done

shopt -s nullglob
for f in x-solver/lib/*.mjs; do
  dst="xm/lib/$(basename "$f")"
  if ! diff -q "$f" "$dst" > /dev/null 2>&1; then
    echo "  DIVERGED: $dst"
    DIVERGED=$((DIVERGED + 1))
  fi
done
shopt -u nullglob

for pair in \
  "x-memory/lib/x-memory-cli.mjs:xm/lib/x-memory-cli.mjs" \
  "x-memory/lib/x-memory/commands.mjs:xm/lib/x-memory/commands.mjs" \
  "x-memory/lib/x-memory/core.mjs:xm/lib/x-memory/core.mjs" \
  "x-memory/lib/x-memory/store.mjs:xm/lib/x-memory/store.mjs"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  if ! diff -q "$src" "$dst" > /dev/null 2>&1; then
    echo "  DIVERGED: $dst"
    DIVERGED=$((DIVERGED + 1))
  fi
done

shopt -s nullglob
for f in x-sync/lib/x-sync/*.mjs; do
  dst="xm/lib/x-sync/$(basename "$f")"
  if ! diff -q "$f" "$dst" > /dev/null 2>&1; then
    echo "  DIVERGED: $dst"
    DIVERGED=$((DIVERGED + 1))
  fi
done
shopt -u nullglob

if ! diff -q "x-recall/lib/x-recall-cli.mjs" "xm/lib/x-recall-cli.mjs" > /dev/null 2>&1; then
  echo "  DIVERGED: xm/lib/x-recall-cli.mjs"
  DIVERGED=$((DIVERGED + 1))
fi
shopt -s nullglob
for f in x-recall/lib/x-recall/*.mjs; do
  dst="xm/lib/x-recall/$(basename "$f")"
  if ! diff -q "$f" "$dst" > /dev/null 2>&1; then
    echo "  DIVERGED: $dst"
    DIVERGED=$((DIVERGED + 1))
  fi
done
shopt -u nullglob

if ! diff -q "x-panel/lib/x-panel-cli.mjs" "xm/lib/x-panel-cli.mjs" > /dev/null 2>&1; then
  echo "  DIVERGED: xm/lib/x-panel-cli.mjs"
  DIVERGED=$((DIVERGED + 1))
fi
shopt -s nullglob
for f in x-panel/lib/x-panel/*.mjs; do
  dst="xm/lib/x-panel/$(basename "$f")"
  if ! diff -q "$f" "$dst" > /dev/null 2>&1; then
    echo "  DIVERGED: $dst"
    DIVERGED=$((DIVERGED + 1))
  fi
done
shopt -u nullglob

if ! diff -q "x-sync/lib/x-sync-server.mjs" "xm/lib/x-sync-server.mjs" > /dev/null 2>&1; then
  echo "  DIVERGED: xm/lib/x-sync-server.mjs"
  DIVERGED=$((DIVERGED + 1))
fi

if ! diff -q "x-trace/lib/x-trace-cli.mjs" "xm/lib/x-trace-cli.mjs" > /dev/null 2>&1; then
  echo "  DIVERGED: xm/lib/x-trace-cli.mjs"
  DIVERGED=$((DIVERGED + 1))
fi
shopt -s nullglob
for f in x-trace/lib/x-trace/*.mjs; do
  dst="xm/lib/x-trace/$(basename "$f")"
  if ! diff -q "$f" "$dst" > /dev/null 2>&1; then
    echo "  DIVERGED: $dst"
    DIVERGED=$((DIVERGED + 1))
  fi
done
shopt -u nullglob

if ! diff -q "x-dashboard/lib/x-dashboard-server.mjs" "xm/lib/x-dashboard-server.mjs" > /dev/null 2>&1; then
  echo "  DIVERGED: xm/lib/x-dashboard-server.mjs"
  DIVERGED=$((DIVERGED + 1))
fi

if ! diff -q "x-agent/skills/agent/flow.md" "xm/skills/agent/flow.md" > /dev/null 2>&1; then
  echo "  DIVERGED: xm/skills/agent/flow.md"
  DIVERGED=$((DIVERGED + 1))
fi
if [ -d "x-agent/skills/agent/flow" ]; then
  while IFS= read -r f; do
    rel="${f#x-agent/skills/agent/flow/}"
    if ! diff -q "$f" "xm/skills/agent/flow/$rel" > /dev/null 2>&1; then
      echo "  DIVERGED: xm/skills/agent/flow/$rel"
      DIVERGED=$((DIVERGED + 1))
    fi
  done < <(find x-agent/skills/agent/flow -type f)
fi

while IFS= read -r f; do
  rel="${f#x-dashboard/public/}"
  if ! diff -q "$f" "xm/public/$rel" > /dev/null 2>&1; then
    echo "  DIVERGED: xm/public/$rel"
    DIVERGED=$((DIVERGED + 1))
  fi
done < <(find x-dashboard/public -type f)

if [ "$DIVERGED" -eq 0 ]; then
  echo "  All files in sync."
else
  echo "  $DIVERGED file(s) still diverged!"
  ERRORS=$((ERRORS + DIVERGED))
fi

echo ""
echo "=== Verifying skills checksum ==="
if [ "$CHECK_MODE" -eq 1 ]; then
  if ! node xm/scripts/skills-checksum.mjs --check; then
    record_error
  fi
else
  node xm/scripts/skills-checksum.mjs
fi

if [ "$ERRORS" -eq 0 ]; then
  if [ "$CHECK_MODE" -eq 1 ]; then
    echo "Bundle check passed."
  else
    echo "Bundle sync complete."
  fi
else
  echo "$ERRORS bundle sync issue(s) detected."
  exit 1
fi
