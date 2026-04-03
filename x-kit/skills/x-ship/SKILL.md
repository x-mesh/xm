---
name: x-ship
description: Release automation — commit squash, version bump, changelog, push. Works with any project.
---

<Purpose>
Squash WIP commits into meaningful units, bump versions, and push releases.
Works with x-kit marketplace plugins AND standalone projects.
</Purpose>

<Use_When>
- User says "ship", "release", "ship it", "릴리스", "배포"
- User wants to clean up commit history before release
- User wants to bump versions and push
</Use_When>

<Do_Not_Use_When>
- Deploy to production servers (use CI/CD or /land-and-deploy)
- Create a PR without releasing (use git directly)
</Do_Not_Use_When>

# x-ship — Release Automation

Commit squash + version bump + push. Works with any git project.

## Model Routing

| Subcommand | Model | Reason |
|------------|-------|--------|
| `status`, `dry-run` | **haiku** (Agent tool) | Read-only display |
| `squash` (auto-grouping) | main model | Requires reasoning about commit semantics |
| `release` (full flow) | main model | Multi-step orchestration |

## Mode Detection

Read mode from `.xm/config.json` (`mode` field). Default: `developer`.

## Arguments

User provided: `$ARGUMENTS`

## Routing

- Empty or `auto` → [Mode: auto] (squash + release)
- `status` → [Mode: status]
- `squash` → [Mode: squash only]
- `dry-run` → [Mode: dry-run]
- `patch` / `minor` / `major` → [Mode: manual bump]

---

## Mode: status

Show release state. Delegate to **haiku**.

```bash
# Last release tag/commit
LAST_RELEASE=$(git log --grep="^release:" --format="%h %s" -1 2>/dev/null || echo "none")

# Commits since last release
SINCE=$(git log --grep="^release:" --format=%H -1 2>/dev/null || git rev-list --max-parents=0 HEAD)
COMMITS=$(git log --oneline $SINCE..HEAD | head -20)
COUNT=$(git log --oneline $SINCE..HEAD | wc -l | tr -d ' ')
```

Output:
```
📊 x-ship Status

  Last release: {hash} {message}
  Commits since: {count}

  {commit list}

  Suggestion: {squash recommendation}
```

---

## Mode: dry-run

Preview without any changes. Delegate to **haiku**.

Same analysis as auto mode Steps 1-2, but output preview only:
```
🔍 [dry-run] Release Preview

  Squash plan:
    Group 1: "feat: cost efficiency improvements" (3 commits → 1)
    Group 2: "chore: remove .xm/ from history" (1 commit, keep as-is)
    Group 3: "docs: model routing" (2 commits → 1)

  Would bump: 1.19.16 → 1.19.17 (patch)
  Would push to: origin/main
```

---

## Mode: squash only

Run Step 1 (squash) without releasing.

---

## Mode: auto

Full flow: squash → bump → commit → push.

### Step 1: SQUASH — Commit Consolidation

#### 1.1 Identify range

```bash
# Find last release commit
LAST_RELEASE=$(git log --grep="^release:" --format=%H -1 2>/dev/null)

# If no release commit, use first commit
if [ -z "$LAST_RELEASE" ]; then
  LAST_RELEASE=$(git rev-list --max-parents=0 HEAD)
fi

# List commits since last release (exclude the release commit itself)
git log --oneline $LAST_RELEASE..HEAD
```

If 0 commits → "Nothing to release." Exit.
If 1-2 commits → Skip squash, proceed to Step 2.
If 3+ commits → Proceed with squash.

#### 1.2 Auto-group commits

Analyze commit messages and changed files to group by logical unit:

**Grouping rules (priority order):**

1. **Same prefix** — `feat:`, `fix:`, `chore:`, `docs:` with overlapping files → same group
2. **Same file set** — Commits touching the same files → same group
3. **Sequential related** — A commit that builds on the previous (e.g., "fix review issues" after "feat: add X") → merge into parent group
4. **Standalone** — Commits with distinct scope (e.g., `.gitignore` cleanup) → keep separate

**Output grouping plan:**

```
📦 커밋 정리 계획

  Group 1: feat: cost efficiency improvements (3 commits)
    e3f780f feat: add model profiles, strategy-aware cost multipliers
    32cd247 feat: improve cost efficiency — interactive config, review fixes
    9cf3442 merge: cost efficiency improvements
    → Squash into: "feat: add cost efficiency — model profiles, budget guards, interactive config"

  Group 2: chore: git cleanup (1 commit)
    92a0379 chore: remove .xm/ from tracking
    → Keep as-is

  Group 3: docs: model routing (3 commits)
    25e0dab feat: add interactive config wizard to SKILL.md
    0fd1c77 feat: add model routing tables to SKILL.md files
    3491cde docs: add model routing rules
    → Squash into: "feat: add model routing — haiku for display, sonnet+ for reasoning"
```

#### 1.3 Confirm with user

Use AskUserQuestion:
```
커밋을 정리할까요?

1) 위 계획대로 squash (추천)
2) 모든 커밋을 하나로 squash
3) 그대로 유지 (squash 안 함)
4) 직접 수정
```

#### 1.4 Execute squash

**Method: soft reset + re-commit** (rebase보다 안전)

```bash
# Save current HEAD
CURRENT=$(git rev-parse HEAD)

# Soft reset to last release (keeps all changes staged)
git reset --soft $LAST_RELEASE

# Now re-commit in groups
# For each group, selectively stage and commit
```

For single squash (option 2):
```bash
git reset --soft $LAST_RELEASE
git commit -m "feat: [generated summary of all changes]"
```

For grouped squash (option 1):
```bash
git reset --soft $LAST_RELEASE

# Group 1: stage specific files and commit
git reset HEAD -- .  # unstage all
git add [group1 files]
git commit -m "[group1 message]"

# Group 2: stage and commit
git add [group2 files]
git commit -m "[group2 message]"

# Group 3: remaining files
git add -A
git commit -m "[group3 message]"
```

#### 1.5 Verify squash

```bash
# Verify no changes lost
git diff $CURRENT HEAD  # should be empty
```

If diff is non-empty → rollback: `git reset --hard $CURRENT`

### Step 2: VERSION BUMP

#### 2.1 Detect project type

| Marker file | Project type | Version location |
|-------------|-------------|-----------------|
| `.claude-plugin/marketplace.json` | x-kit marketplace | marketplace.json + plugin.json + package.json |
| `package.json` (no marketplace) | Node.js project | package.json |
| `Cargo.toml` | Rust project | Cargo.toml |
| `pyproject.toml` | Python project | pyproject.toml |
| `go.mod` | Go project | git tags only |
| None | Generic | git tags only |

#### 2.2 Determine bump level

If explicit (`patch`/`minor`/`major` in args) → use that.

Otherwise auto-detect from squashed commit messages:

| Commit prefix | Bump |
|--------------|------|
| `fix:`, `chore:`, `docs:` | patch |
| `feat:` | minor |
| `BREAKING CHANGE:` or `!:` | major |

Take the highest level across all commits.

Confirm with AskUserQuestion:
```
버전을 어떻게 올릴까요? (현재: X.Y.Z)

1) patch (X.Y.Z+1) — 버그 수정, 문서 (추천)
2) minor (X.Y+1.0) — 새 기능
3) major (X+1.0.0) — breaking change
```

#### 2.3 Update version files

For x-kit marketplace:
- `{plugin}/.claude-plugin/plugin.json` → version field
- `.claude-plugin/marketplace.json` → matching plugin version
- `package.json` → version field

For Node.js:
- `package.json` → version field

For others:
- Update the detected version file

### Step 3: README SYNC

For x-kit marketplace only. Check if SKILL.md changes need README updates.

Same logic as x-release Step 3.5 — delegate agent to compare SKILL.md vs README sections.

Skip for non-marketplace projects.

### Step 4: COMMIT + PUSH

```bash
git add -A
git commit -m "release: {name}@{version}

{changelog summary from squashed commits}"

git push origin {branch}
```

### Step 5: OUTPUT

```
🚀 Shipped!

  Squashed: {N} commits → {M} commits
  Version: {old} → {new}
  Branch: {branch}
  Commit: {hash}
  Push: origin/{branch} ✅

  Users can update:
    /x-kit update
    /reload-plugins
```

---

## Safety Rules

- **No changes = no release** — prevent empty releases
- **Squash verification** — always `git diff` before/after to confirm no code lost
- **Not on main = warn** — "현재 브랜치가 main이 아닙니다. 계속?"
- **Force push after squash** — squash rewrites history, force push required. Confirm with user.
- **Rollback on failure** — save pre-squash HEAD, restore on any error

---

## Standalone Usage (non x-kit projects)

x-ship works in any git project:

```
/x-ship              # auto: squash + bump + push
/x-ship status       # show commits since last release
/x-ship squash       # squash only, no release
/x-ship dry-run      # preview plan
/x-ship patch        # explicit patch bump
```

Version detection adapts to project type (package.json, Cargo.toml, pyproject.toml, git tags).
No `.xm/config.json` required — works with defaults.
