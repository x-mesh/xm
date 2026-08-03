#!/usr/bin/env bash
# xm umbrella installer for Claude Code and Codex CLI.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/x-mesh/xm/main/xm/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/x-mesh/xm/main/xm/scripts/install.sh | bash -s -- --yes
#   bash xm/scripts/install.sh
#   XM_BIN_DIR=~/bin bash xm/scripts/install.sh

set -euo pipefail

ASSUME_YES=0
ASSUME_NO=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --no|-n)  ASSUME_NO=1 ;;
    --help|-h)
      echo "Usage: install.sh [--yes|--no]"
      echo "  --yes  accept an available update without prompting"
      echo "  --no   decline an available update without prompting"
      exit 0
      ;;
    *) echo "xm install: unknown option '$arg'" >&2; exit 2 ;;
  esac
done
if [ "$ASSUME_YES" = "1" ] && [ "$ASSUME_NO" = "1" ]; then
  echo "xm install: --yes and --no cannot be used together" >&2
  exit 2
fi

BIN_DIR="${XM_BIN_DIR:-$HOME/.local/bin}"
REPO_RAW_URL="${XM_REPO_URL:-https://raw.githubusercontent.com/x-mesh/xm/main}"
REPO_ARCHIVE_URL="${XM_REPO_ARCHIVE_URL:-https://codeload.github.com/x-mesh/xm/tar.gz/refs/heads/main}"
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
REPO_ROOT=""
TEMP_BUNDLE=""

if [ -n "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  if [ -f "$SCRIPT_DIR/../../package.json" ] && [ -f "$SCRIPT_DIR/xm" ]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
  fi
fi

info()  { printf '\033[0;34m[xm]\033[0m %s\n' "$1"; }
ok()    { printf '\033[0;32m[xm]\033[0m %s\n' "$1"; }
warn()  { printf '\033[0;33m[xm]\033[0m %s\n' "$1"; }
error() { printf '\033[0;31m[xm]\033[0m %s\n' "$1" >&2; }

cleanup() {
  if [ -n "$TEMP_BUNDLE" ] && [ -d "$TEMP_BUNDLE" ]; then
    rm -rf -- "$TEMP_BUNDLE"
  fi
}
trap cleanup EXIT INT TERM

read_json_version() {
  local path="$1"
  [ -f "$path" ] || return 0
  node -e 'try { const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(j.version||""); } catch {}' "$path" 2>/dev/null
}

installed_version() {
  local version=""
  if [ -f "$HOME/.claude/plugins/installed_plugins.json" ]; then
    version="$(node -e '
      try {
        const d=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/plugins/installed_plugins.json","utf8"));
        const raw=(d.plugins||{})["xm@xm"];
        const entry=Array.isArray(raw)?raw[0]:raw;
        process.stdout.write(entry?.version||"");
      } catch {}
    ' 2>/dev/null)"
  fi
  if [ -z "$version" ]; then
    version="$(read_json_version "$HOME/plugins/xm/.codex-plugin/plugin.json")"
    version="${version%%+*}"
  fi
  printf '%s' "$version"
}

version_is_newer() {
  node -e '
    const parse=(v)=>String(v).split("+",1)[0].split("-",1)[0].split(".").map(Number);
    const a=parse(process.argv[1]), b=parse(process.argv[2]);
    for(let i=0;i<3;i++){ if((b[i]||0)>(a[i]||0)) process.exit(0); if((b[i]||0)<(a[i]||0)) process.exit(1); }
    process.exit(1);
  ' "$1" "$2"
}

confirm_update() {
  local current="$1" latest="$2" answer=""
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  if [ "$ASSUME_NO" = "1" ]; then return 1; fi
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '[xm] Update available: %s -> %s. Update now? [Y/n] ' "$current" "$latest" > /dev/tty
    IFS= read -r answer < /dev/tty || true
    case "$answer" in
      ""|y|Y|yes|YES|Yes) return 0 ;;
      *) return 1 ;;
    esac
  fi
  error "Update available: $current -> $latest. Re-run with --yes to update or --no to keep the current installation."
  exit 2
}

ensure_bundle() {
  if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/xm/lib/install/install-cli.mjs" ]; then
    printf '%s' "$REPO_ROOT"
    return 0
  fi

  local cache_cli=""
  cache_cli="$(find "$HOME/.claude/plugins/cache/xm/xm" -mindepth 4 -maxdepth 4 -path '*/lib/install/install-cli.mjs' -print 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$cache_cli" ]; then
    cd "$(dirname "$cache_cli")/../.." && pwd
    return 0
  fi

  command -v curl >/dev/null 2>&1 || { error "curl is required to install Codex support"; return 1; }
  command -v tar >/dev/null 2>&1 || { error "tar is required to install Codex support"; return 1; }
  TEMP_BUNDLE="$(mktemp -d "${TMPDIR:-/tmp}/xm-install-XXXXXX")"
  info "Downloading xm bundle for Codex..." >&2
  curl -fsSL "$REPO_ARCHIVE_URL" | tar -xz --strip-components=1 -C "$TEMP_BUNDLE"
  printf '%s' "$TEMP_BUNDLE"
}

# --- Preflight and source metadata ---
command -v node >/dev/null || { error "node not found — install Node.js first"; exit 1; }
command -v bun >/dev/null || warn "bun not found — required for 'xm dashboard'. Install: curl -fsSL https://bun.sh/install | bash"

MARKETPLACE_JSON=""
TARGET_VERSION=""
if [ -n "$REPO_ROOT" ]; then
  MARKETPLACE_JSON="$(<"$REPO_ROOT/.claude-plugin/marketplace.json")"
  TARGET_VERSION="$(read_json_version "$REPO_ROOT/package.json")"
else
  command -v curl >/dev/null 2>&1 || { error "curl is required for a remote install"; exit 1; }
  MARKETPLACE_JSON="$(curl -fsSL "$REPO_RAW_URL/.claude-plugin/marketplace.json" 2>/dev/null || true)"
  TARGET_VERSION="$(printf '%s' "$MARKETPLACE_JSON" | node -e '
    let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
      try { const j=JSON.parse(s); process.stdout.write((j.plugins||[]).find(p=>p.name==="xm")?.version||""); } catch {}
    });
  ' 2>/dev/null)"
fi
if [ -z "$TARGET_VERSION" ]; then
  error "Could not determine the xm version to install"
  exit 1
fi

CURRENT_VERSION="$(installed_version)"
if [ -n "$CURRENT_VERSION" ] && version_is_newer "$CURRENT_VERSION" "$TARGET_VERSION"; then
  if ! confirm_update "$CURRENT_VERSION" "$TARGET_VERSION"; then
    ok "Kept xm $CURRENT_VERSION. No files were changed."
    exit 0
  fi
  DO_UPDATE=1
else
  DO_UPDATE=0
  if [ -n "$CURRENT_VERSION" ] && [ "${CURRENT_VERSION%%+*}" != "${TARGET_VERSION%%+*}" ]; then
    warn "Installed xm $CURRENT_VERSION is newer than installer $TARGET_VERSION; no files were changed."
    exit 0
  fi
fi

# --- Install dispatcher ---
mkdir -p "$BIN_DIR"
DEST="$BIN_DIR/xm"
if [ -n "$REPO_ROOT" ]; then
  info "Local install from $REPO_ROOT/xm/scripts/xm"
  cp "$REPO_ROOT/xm/scripts/xm" "$DEST"
else
  info "Downloading dispatcher..."
  curl -fsSL "$REPO_RAW_URL/xm/scripts/xm" -o "$DEST"
fi
chmod +x "$DEST"
ok "Installed dispatcher: $DEST"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn "$BIN_DIR is not on PATH."
  warn "Add to your shell profile: export PATH=\"$BIN_DIR:\$PATH\""
fi

# --- Install or update Claude marketplace plugins ---
PLUGINS=""
if [ -n "$MARKETPLACE_JSON" ]; then
  PLUGINS="$(printf '%s' "$MARKETPLACE_JSON" | node -e '
    let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
      try { const j=JSON.parse(s); process.stdout.write((j.plugins||[]).map(p=>p.name).join(" ")); } catch {}
    });
  ' 2>/dev/null)"
fi

if command -v claude >/dev/null 2>&1; then
  info "Registering xm marketplace..."
  claude plugin marketplace add x-mesh/xm >/dev/null 2>&1 || true
  if [ "$DO_UPDATE" = "1" ]; then
    info "Updating xm marketplace and installed plugins..."
    claude plugin marketplace update xm >/dev/null 2>&1 || warn "Marketplace refresh failed; continuing with cached metadata."
  else
    info "Installing missing xm plugins via claude CLI..."
  fi

  INSTALLED_REG="$HOME/.claude/plugins/installed_plugins.json"
  for plugin in $PLUGINS; do
    if [ -f "$INSTALLED_REG" ] && grep -q "\"$plugin@xm\"" "$INSTALLED_REG" 2>/dev/null; then
      if [ "$DO_UPDATE" = "1" ]; then
        info "  → $plugin (update)"
        claude plugin update "$plugin@xm" -s user >/dev/null 2>&1 || warn "    update failed: $plugin@xm"
      else
        info "  → $plugin (already installed)"
      fi
    else
      info "  → $plugin (install)"
      claude plugin install "$plugin@xm" -s user >/dev/null 2>&1 || warn "    install failed: $plugin@xm"
    fi
  done
  ok "Claude plugins are ready. Run /reload-plugins in Claude Code to activate them."
else
  warn "claude CLI not on PATH — skipping Claude plugin install."
fi

# --- Install/repair Linux Codex global integration ---
if command -v codex >/dev/null 2>&1; then
  BUNDLE_ROOT="$(ensure_bundle)"
  case "$BUNDLE_ROOT" in
    "${TMPDIR:-/tmp}"/xm-install-*) TEMP_BUNDLE="$BUNDLE_ROOT" ;;
  esac
  BUNDLE_XM="$BUNDLE_ROOT/xm"
  [ -d "$BUNDLE_XM/lib" ] || BUNDLE_XM="$BUNDLE_ROOT"
  INSTALL_CLI="$BUNDLE_XM/lib/install/install-cli.mjs"
  if [ ! -f "$INSTALL_CLI" ]; then
    error "Codex installer not found in $BUNDLE_ROOT"
    exit 1
  fi
  info "Installing xm for Codex (global)..."
  node "$INSTALL_CLI" --target codex --global --yes --force \
    --skills-dir "$BUNDLE_XM/skills" --lib-dir "$BUNDLE_XM/lib"
  info "Refreshing Codex plugin cache..."
  if ! codex plugin add xm@personal; then
    error "Codex plugin activation failed: codex plugin add xm@personal"
    exit 1
  fi
  codex features enable hooks >/dev/null 2>&1 || warn "Could not enable Codex hooks automatically; run: codex features enable hooks"
  ok "Codex integration installed. Start a new Codex thread to load xm skills."
else
  warn "codex CLI not on PATH — skipping Codex integration."
fi

# --- Verify dispatcher when a backing lib is available ---
if "$DEST" version >/dev/null 2>&1; then
  ok "xm CLI ready. Try: xm help"
else
  warn "Dispatcher installed, but no Claude plugin cache is available yet; Codex skills are still installed independently."
fi
