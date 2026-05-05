#!/usr/bin/env bash
# test-install.sh — smoke test the multi-tool installer in an isolated tmp dir.
#
# Walks every target through install → verify → tamper → uninstall and prints
# a pass/fail report. Use this before shipping or as a one-shot sanity check.
#
#   bash xm/scripts/test-install.sh                # all 5 targets
#   bash xm/scripts/test-install.sh cursor codex   # subset

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO/xm/lib/install/install-cli.mjs"
SKILLS="$REPO/xm/skills"
LIB="$REPO/xm/lib"

TARGETS=("$@")
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=(cursor codex kiro antigravity opencode)
fi

TMP="$(mktemp -d -t xm-install-smoke-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  ❌ %s\n' "$1"; }
hr()   { printf -- '----------------------------------------\n'; }

# Seed the tmp project with a Claude settings.json so hook renderers have data.
mkdir -p "$TMP/.claude"
cp "$REPO/.claude/settings.json" "$TMP/.claude/settings.json"

# Optionally seed user content in AGENTS.md so we can verify preservation.
cat > "$TMP/AGENTS.md" <<'EOF'
# my own AGENTS.md

This is user-authored content that must survive xm install/uninstall.
EOF

cd "$TMP"

# Always-on regression: skills.checksums.json self-consistency.
hr
echo "[checksum self-check]"
if node "$REPO/xm/scripts/skills-checksum.mjs" --check >/dev/null; then
  ok "skills.checksums.json verified"
else
  fail "skills.checksums.json out of date"
fi

for TARGET in "${TARGETS[@]}"; do
  hr
  echo "[$TARGET] install"
  if node "$CLI" --target "$TARGET" --skills-dir "$SKILLS" --lib-dir "$LIB" >/dev/null; then
    ok "install --target $TARGET"
  else
    fail "install --target $TARGET"
    continue
  fi

  echo "[$TARGET] idempotency"
  BEFORE="$(find . \( -path ./.claude -o -name '*.lock' \) -prune -o -type f -print | sort | xargs -I {} shasum -a 256 {} 2>/dev/null | shasum -a 256)"
  node "$CLI" --target "$TARGET" --skills-dir "$SKILLS" --lib-dir "$LIB" >/dev/null
  AFTER="$(find . \( -path ./.claude -o -name '*.lock' \) -prune -o -type f -print | sort | xargs -I {} shasum -a 256 {} 2>/dev/null | shasum -a 256)"
  if [[ "$BEFORE" == "$AFTER" ]]; then
    ok "idempotent re-run (zero diff)"
  else
    fail "idempotent re-run (diff detected)"
  fi

  echo "[$TARGET] verify (clean)"
  if node "$CLI" --verify --target "$TARGET" >/dev/null; then
    ok "--verify reports clean"
  else
    fail "--verify reports clean"
  fi

  # tamper → expect non-zero exit on --verify (multi-tool coverage of the
  # supply-chain regression path that test/install.test.mjs only exercises
  # for cursor today).
  TAMPER=""
  case "$TARGET" in
    cursor)      TAMPER=".cursor/rules/xm-build.mdc" ;;
    codex)       TAMPER=".codex/prompts/xm-build.md" ;;
    kiro)        TAMPER=".kiro/steering/xm-build.md" ;;
    antigravity) TAMPER=".agent/skills/xm-build.md" ;;
    opencode)    TAMPER=".opencode/skills/xm-build/SKILL.md" ;;
  esac
  if [[ -n "$TAMPER" && -f "$TAMPER" ]]; then
    cp "$TAMPER" "$TAMPER.orig"
    echo "tampered" >> "$TAMPER"
    if ! node "$CLI" --verify --target "$TARGET" >/dev/null 2>&1; then
      ok "--verify rejects tampered $TAMPER"
    else
      fail "--verify did NOT reject tampered $TAMPER"
    fi
    mv "$TAMPER.orig" "$TAMPER"
  fi

  # AGENTS.md preservation check (codex / antigravity only).
  if [[ "$TARGET" == "codex" || "$TARGET" == "antigravity" ]]; then
    if grep -q "user-authored content" AGENTS.md; then
      ok "AGENTS.md user content preserved"
    else
      fail "AGENTS.md user content lost"
    fi
    if grep -q "<!-- xm:BEGIN v2 -->" AGENTS.md; then
      ok "AGENTS.md xm marker present"
    else
      fail "AGENTS.md xm marker missing"
    fi
  fi
done

hr
echo "[uninstall]"
if node "$CLI" --uninstall --target "$(IFS=,; echo "${TARGETS[*]}")" >/dev/null; then
  ok "uninstall --target ${TARGETS[*]}"
else
  fail "uninstall"
fi

if grep -q "user-authored content" AGENTS.md 2>/dev/null; then
  ok "AGENTS.md user content survives uninstall"
else
  fail "AGENTS.md user content lost on uninstall"
fi
if grep -q "<!-- xm:BEGIN v2 -->" AGENTS.md 2>/dev/null; then
  fail "xm marker still present after uninstall"
else
  ok "xm marker removed after uninstall"
fi

hr
printf 'Result: %d passed, %d failed\n' "$PASS" "$FAIL"
echo "tmp: $TMP (cleaned on exit)"
exit $(( FAIL == 0 ? 0 : 1 ))
