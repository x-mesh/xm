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

#### 2.2 Detect changed sub-plugins (x-kit marketplace only)

When project type is `x-kit marketplace`, map changed files to sub-plugins:

```bash
# Get changed files since last release (post-squash)
git diff --name-only $LAST_RELEASE..HEAD
```

| Path pattern | Sub-plugin |
|-------------|-----------|
| `x-agent/**` | x-agent |
| `x-build/**` | x-build |
| `x-op/**` | x-op |
| `x-kit/**` | x-kit |
| `x-eval/**` | x-eval |
| `x-review/**` | x-review |
| `x-trace/**` | x-trace |
| `x-memory/**` | x-memory |
| `x-solver/**` | x-solver |
| `x-probe/**` | x-probe |
| `x-humble/**` | x-humble |
| `x-ship/**` | x-ship (bundled in x-kit) |

Display per-plugin change summary:
```
📊 변경된 플러그인:
  x-kit    🔄 5 files (lib/shared-config.mjs, lib/x-build/core.mjs, ...)
  x-build  🔄 2 files (lib/x-build/tasks.mjs, skills/x-build/SKILL.md)
  x-agent  ✅ no changes
```

#### 2.3 Determine bump level

If explicit (`patch`/`minor`/`major` in args) → use that for all changed plugins.

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

#### 2.4 Update version files

**x-kit marketplace:**

For each changed sub-plugin:
1. Read `{plugin}/.claude-plugin/plugin.json` → Edit version field
2. Read `.claude-plugin/marketplace.json` → Edit matching plugin version
3. If x-kit (meta bundle) is not in changed list but any sub-plugin changed → bump x-kit too (patch)
4. Update `package.json` → sync root version with x-kit version

**Node.js project:**
- `package.json` → version field

**Others:**
- Update the detected version file, or create git tag

### Step 3: README SYNC (x-kit marketplace only)

**이 단계는 스킵할 수 없다.**

For each changed plugin, delegate a **sonnet agent** with this prompt:

```
## README Sync Check

Plugin: {plugin_name}
SKILL.md path: {plugin}/skills/{plugin}/SKILL.md
README.md section: find by "### {plugin_name}" or plugin description

1. Read SKILL.md and README.md section for this plugin
2. Compare and produce a diff checklist:

| Item | SKILL.md | README | Action |
|------|----------|--------|--------|
| Description | "..." | "..." | UPDATE / OK |
| Commands | cmd1, cmd2 | cmd1 | ADD cmd2 |
| Options/flags | ... | ... | ADD / OK |

3. For each ADD/UPDATE, produce the specific Edit
4. If all OK: "README up to date for {plugin_name}"

Rules:
- README is concise — not a SKILL.md copy
- Only add/update what changed
- Both README.md (English) and README.ko.md (Korean) must stay in sync
```

Run agents for all changed plugins in parallel.

**Checklist (must pass before Step 4):**
- [ ] Every changed plugin has a README section
- [ ] New commands/options reflected in README
- [ ] README.md and README.ko.md are in sync

### Step 4: COMMIT + PUSH

```bash
git add -A
git commit -m "release: {name}@{version}

{per-plugin changelog summary}
- {plugin1}: {change description}
- {plugin2}: {change description}"

git push origin {branch}
```

**If squash was performed:** history was rewritten, so force push is required.
```bash
git push origin {branch} --force
```
Confirm force push with AskUserQuestion before executing.

### Step 5: OUTPUT

```
🚀 Shipped!

  Squashed: {N} commits → {M} commits
  Version: {old} → {new}
  Branch: {branch}
  Commit: {hash}
  Push: origin/{branch} ✅

  Changed plugins:
    x-kit    1.19.16 → 1.19.17
    x-build  1.13.0  → 1.13.0 (no change)

  Users can update:
    /x-kit update
    /reload-plugins
```

---

## Safety Rules

- **No changes = no release** — prevent empty releases
- **Squash verification** — always `git diff $CURRENT HEAD` before/after to confirm no code lost
- **Not on main = warn** — "현재 브랜치가 main이 아닙니다. 계속?"
- **Force push after squash** — squash rewrites history, confirm with user before force push
- **Rollback on failure** — save pre-squash HEAD (`CURRENT`), restore with `git reset --hard $CURRENT` on any error
- **README sync mandatory** — never skip Step 3 for x-kit marketplace releases

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

For standalone projects, Step 2.2 (sub-plugin detection) and Step 3 (README sync) are skipped.

---

## Migration from x-release

x-ship supersedes x-release. During the transition period both coexist.

| Feature | x-release | x-ship |
|---------|-----------|--------|
| Commit squash | ❌ | ✅ Step 1 |
| Version bump | ✅ | ✅ Step 2 |
| Sub-plugin detection | ✅ | ✅ Step 2.2 |
| README sync | ✅ | ✅ Step 3 |
| Force push safety | ❌ | ✅ |
| Non x-kit projects | ❌ | ✅ |
| Dry-run preview | ❌ | ✅ |

Once x-ship is validated in 2-3 releases, x-release can be retired.
