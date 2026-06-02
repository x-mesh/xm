#!/usr/bin/env bash
# sync-bundle.sh — Sync standalone plugin files to xm bundle
# Run from repo root: ./scripts/sync-bundle.sh
# Source of truth: standalone plugin directories
# Plugin naming: source dirs keep x-{name}/, skills dirs use {name}/ (no x- prefix)

set -euo pipefail
cd "$(dirname "$0")/.."

ERRORS=0

sync_file() {
  local src="$1" dst="$2"
  if [ ! -f "$src" ]; then
    echo "  SKIP $src (not found)"
    return
  fi
  mkdir -p "$(dirname "$dst")"
  if diff -q "$src" "$dst" > /dev/null 2>&1; then
    echo "  OK   $dst"
  else
    cp "$src" "$dst"
    echo "  SYNC $dst"
  fi
}

remove_obsolete_file() {
  local path="$1"
  if [ -f "$path" ]; then
    rm -f "$path"
    echo "  REMOVE $path"
  fi
}

# Mirror every *.md inside a source directory to a destination directory.
# Creates the destination if missing; no-op on empty source.
mirror_md_dir() {
  local src="$1" dst="$2"
  [ -d "$src" ] || return 0
  mkdir -p "$dst"
  shopt -s nullglob
  for f in "$src"/*.md; do
    sync_file "$f" "$dst/$(basename "$f")"
  done
  shopt -u nullglob
}

echo "=== Syncing SKILL.md files ==="
for plugin in build op solver eval review trace memory humble probe agent dashboard humanize sync; do
  src="x-$plugin/skills/$plugin/SKILL.md"
  dst="xm/skills/$plugin/SKILL.md"
  sync_file "$src" "$dst"
done

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
sync_file "x-build/lib/default-config.json" "xm/lib/default-config.json"

echo ""
echo "=== Syncing x-memory lib files ==="
sync_file "x-memory/lib/x-memory-cli.mjs" "xm/lib/x-memory-cli.mjs"
for f in commands.mjs core.mjs store.mjs; do
  sync_file "x-memory/lib/x-memory/$f" "xm/lib/x-memory/$f"
done

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
mkdir -p "xm/lib/x-sync"
shopt -s nullglob
for f in x-sync/lib/x-sync/*.mjs; do
  sync_file "$f" "xm/lib/x-sync/$(basename "$f")"
done
shopt -u nullglob
# Server entry — sync-server.mjs resolves it at ../x-sync-server.mjs relative to lib/x-sync/
sync_file "x-sync/lib/x-sync-server.mjs" "xm/lib/x-sync-server.mjs"

echo ""
echo "=== Syncing x-trace lib files ==="
sync_file "x-trace/lib/x-trace/trace-writer.mjs" "xm/lib/x-trace/trace-writer.mjs"

echo ""
echo "=== Syncing x-dashboard lib + public ==="
sync_file "x-dashboard/lib/x-dashboard-server.mjs" "xm/lib/x-dashboard-server.mjs"
mkdir -p "xm/public"
shopt -s nullglob
for f in x-dashboard/public/*; do
  sync_file "$f" "xm/public/$(basename "$f")"
done
shopt -u nullglob

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
for plugin in build op solver eval review trace memory humble probe agent dashboard humanize sync; do
  src="x-$plugin/skills/$plugin/SKILL.md"
  dst="xm/skills/$plugin/SKILL.md"
  if [ -f "$src" ] && [ -f "$dst" ] && ! diff -q "$src" "$dst" > /dev/null 2>&1; then
    echo "  DIVERGED: $dst"
    DIVERGED=$((DIVERGED + 1))
  fi
done

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

if ! diff -q "x-sync/lib/x-sync-server.mjs" "xm/lib/x-sync-server.mjs" > /dev/null 2>&1; then
  echo "  DIVERGED: xm/lib/x-sync-server.mjs"
  DIVERGED=$((DIVERGED + 1))
fi

if ! diff -q "x-trace/lib/x-trace/trace-writer.mjs" "xm/lib/x-trace/trace-writer.mjs" > /dev/null 2>&1; then
  echo "  DIVERGED: xm/lib/x-trace/trace-writer.mjs"
  DIVERGED=$((DIVERGED + 1))
fi

if ! diff -q "x-dashboard/lib/x-dashboard-server.mjs" "xm/lib/x-dashboard-server.mjs" > /dev/null 2>&1; then
  echo "  DIVERGED: xm/lib/x-dashboard-server.mjs"
  DIVERGED=$((DIVERGED + 1))
fi

shopt -s nullglob
for f in x-dashboard/public/*; do
  if ! diff -q "$f" "xm/public/$(basename "$f")" > /dev/null 2>&1; then
    echo "  DIVERGED: xm/public/$(basename "$f")"
    DIVERGED=$((DIVERGED + 1))
  fi
done
shopt -u nullglob

if [ "$DIVERGED" -eq 0 ]; then
  echo "  All files in sync."
else
  echo "  $DIVERGED file(s) still diverged!"
  exit 1
fi
