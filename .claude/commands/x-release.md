---
name: x-release
description: Release automation — detect changes, bump versions, update marketplace.json, commit, push
---

# x-release — Release Automation

Detect changed plugins, bump versions, update marketplace.json, commit, and push.
This command is for xm repo maintainers only.

## Arguments

User provided: $ARGUMENTS

## CLI

```bash
XMB="node x-build/lib/x-build-cli.mjs"
```

## Routing

- Empty or `auto` → [Mode: auto]
- `patch` / `minor` / `major` → [Mode: manual] (skip bump confirmation)
- `status` → Run `$XMB release detect` and display results
- `dry-run` → Run `$XMB release detect` and show what would happen without executing

---

## Mode: auto

### Step 1: Detect

```bash
$XMB release detect
```

Display the JSON output to the user in a readable format. If `changed_plugins` is empty:
> ✅ No changes detected. Nothing to release.

### Step 2: Decide (LLM judgment)

Based on detect output:

1. **Squash?** — If `recommendation.squash` is true, confirm with user then run:
   ```bash
   $XMB release squash
   ```

2. **Bump type?** — Look at the changes:
   - SKILL.md edits, bug fixes → `patch`
   - New commands/features → `minor`
   - Breaking changes → `major`
   - If `$ARGUMENTS` specifies `patch`/`minor`/`major`, use that directly

   Confirm bump type with user (AskUserQuestion) unless `$ARGUMENTS` specifies it.

### Step 3: Bump

```bash
$XMB release bump --patch --plugins x-build,x-dashboard
```

This automatically: updates all JSON files, runs sync-bundle, runs tests.
If tests fail, stop and fix.

### Step 4: README Check (LLM judgment)

Decide if README needs updating based on change type:

| Change type | README action |
|-------------|---------------|
| New command/subcommand/flag | Update README |
| Changed user-visible behavior | Update README |
| Internal refactor, bug fix | Skip — log decision |

If update needed, edit README.md (and README.ko.md) before committing.
If skipped, log: "README skip: {reason}"

### Step 5: Commit Message (LLM writes)

Write a commit message based on the changes. Format:
```
release: x-build@1.16.2, x-dashboard@0.4.2

- x-build: {change summary}
- x-dashboard: {change summary}
```

### Step 5.5: Source Integrity Check (mandatory)

Before committing, verify the source actually contains what the commit message claims. Step 3 runs `bun test`, which has historically left silent stashes behind — see mem-mesh `2089a55f` (X-9 incident): `gitRollbackTask` previously called `git stash push` without sha validation, so any test passing an invalid sha pocketed the working tree into a stash and the next commit captured the *pre-stash* (HEAD) state of the files. This produced a release `v2.1.0` whose commit message claimed an X-8 fix that wasn't actually in the code.

**Guard 1 — Stash leak detector (automated, halt on non-empty)**:

```bash
if [ -n "$(git stash list)" ]; then
  echo "❌ STOP: Stash non-empty after bump/test:"
  git stash list
  echo
  echo "   The working-tree changes this release claims may currently live in"
  echo "   a stash (left by bun test invoking gitRollbackTask or similar)."
  echo "   Inspect with: git stash show -p stash@{0}"
  echo "   Recover with: git stash pop stash@{0}"
  echo "   Then re-run Step 3 (release bump) and re-check this guard."
fi
```

If the stash list is non-empty, do **not** proceed to Step 6. Pop the relevant stash, re-run bump+test, and only continue when the list is clean.

**Guard 2 — Commit claim ↔ source match (LLM judgment, halt on mismatch)**:

For each "fix X by doing Y" bullet you are about to write into the commit message, grep the source for the literal code that delivers Y. Example:

- Claim: `gitAutoCommit scoped to <projectDir> instead of git add -A`
  - Grep: `grep -n "git add" x-build/lib/x-build/core.mjs`
  - Pass: result shows `git add ${JSON.stringify(pdir)}` (or equivalent), no `git add -A`
  - Fail: `git add -A` still present → **STOP**; fix is missing from source. Inspect stash list, diff vs HEAD, or re-apply the fix.

If any claim is unbacked by visible code, either (a) drop the claim from the commit message, or (b) restore the fix and re-verify. Never ship a release whose commit message describes code that isn't in the diff.

### Step 6: Commit & Push

```bash
$XMB release commit --msg "release: ..." --push
```

### Step 7: Deploy to Main

After Step 6 push, propagate the release to `main` so users see the new version when running `/plugin update`. Skip this step only if `$ARGUMENTS` contains `--no-deploy`.

```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "✅ Already on $CURRENT_BRANCH — release pushed directly. No merge needed."
elif git merge-base --is-ancestor main HEAD 2>/dev/null; then
  # main is an ancestor of HEAD → fast-forward is safe
  git checkout main && \
    git merge "$CURRENT_BRANCH" --ff-only && \
    git push origin main && \
    git checkout "$CURRENT_BRANCH"
  echo "✅ main fast-forwarded to $(git rev-parse --short main) from $CURRENT_BRANCH"
else
  echo "⚠ main has diverged from $CURRENT_BRANCH — fast-forward not possible."
  echo "   Open a PR to merge: gh pr create --base main --head $CURRENT_BRANCH"
  echo "   Or rebase: git checkout $CURRENT_BRANCH && git rebase main && git push --force-with-lease"
fi
```

If main update fails or is skipped, **STOP** and report the issue — do not proceed to Step 9 with stale main.

### Step 8: Post-Merge Hunk Verification (if branch merge involved)

Skip if direct-push (no merge). Otherwise:

```bash
# Before merge
git diff main...HEAD --unified=0 > /tmp/pre-merge-hunks.diff
# After merge — verify hunks survived
node -e "
const fs = require('fs');
const diff = fs.readFileSync('/tmp/pre-merge-hunks.diff', 'utf8');
const files = [...new Set(diff.match(/^\+\+\+ b\/(.+)$/gm)?.map(l => l.slice(6)) || [])];
let dropped = 0;
for (const file of files) {
  if (!fs.existsSync(file)) { console.log('⚠ DELETED: ' + file); continue; }
  const fileSection = diff.split('diff --git').find(s => s.includes('+++ b/' + file)) || '';
  const addedLines = fileSection.match(/^\+(?!\+\+)(.+)$/gm)?.map(l => l.slice(1).trim()).filter(l => l.length > 3) || [];
  const content = fs.readFileSync(file, 'utf8');
  for (const line of addedLines) {
    if (!content.includes(line.trim())) { console.log('❌ DROPPED: ' + file + ' — ' + line.slice(0, 80)); dropped++; }
  }
}
if (dropped === 0) console.log('✅ All hunks preserved.');
else console.log('⚠ ' + dropped + ' hunks may have been dropped.');
"
rm -f /tmp/pre-merge-hunks.diff
```

### Step 8.5: Dashboard Live-Artifact Verification (if x-dashboard changed)

Skip unless this release touched `x-dashboard/public/**` or `x-dashboard/lib/**`. A long-lived dashboard server keeps serving whatever `public/` it was launched from, so a shipped UI fix can still render the *old* bundle to the user (the "수정했는데 왜 그대로?" trap — RV-1). Prove the running dashboard serves what was just released, using the bundle's content hash (`buildId`):

```bash
# Source bundle identity, from the working tree just released
SRC=$(bun x-dashboard/lib/x-dashboard-server.mjs --print-build-id | node -pe 'JSON.parse(require("fs").readFileSync(0)).buildId')
echo "source buildId: $SRC"

# Compare against what a running dashboard actually serves (if any)
RUN=$(curl -s http://127.0.0.1:19841/health | node -pe 'try{JSON.parse(require("fs").readFileSync(0)).buildId}catch{""}' 2>/dev/null)
if [ -z "$RUN" ]; then
  echo "ℹ dashboard not running — it will serve $SRC on next start"
elif [ "$RUN" = "$SRC" ]; then
  echo "✅ live dashboard serves the released bundle ($SRC)"
else
  echo "⚠ live dashboard serves a STALE bundle (running=$RUN, source=$SRC) — restarting…"
  xm dashboard restart >/dev/null 2>&1 || true
  sleep 1
  RUN2=$(curl -s http://127.0.0.1:19841/health | node -pe 'try{JSON.parse(require("fs").readFileSync(0)).buildId}catch{""}' 2>/dev/null)
  if [ "$RUN2" = "$SRC" ]; then
    echo "✅ restarted — now serving $SRC"
  else
    echo "❌ still stale after restart (running=$RUN2) — the plugin CACHE lags source."
    echo "   Run Step 9's '/plugin update xm@xm', then 'xm dashboard restart' to activate."
  fi
fi
```

Never claim a dashboard fix is live until the served `buildId` matches source. If the mismatch survives a restart, the cache copy is stale — defer to Step 9. The footer in the dashboard sidebar shows the same `buildId` (+ a `source`/`cache` badge), so the user can eyeball which bundle they are looking at.

### Step 9: Plugin Update Hint

After main is updated, print this exact message so the user knows how to activate the release in their environment:

```
🚢 Released to main. To activate in Claude Code:

  /plugin update xm@xm        # update bundle
  /reload-plugins             # apply changes

  Or from terminal:
    claude plugin update xm@xm
```

The hint is **always printed** after a successful Step 7 (regardless of which branch the release came from), so users never assume "released = activated".

---

## Mode: manual

When `$ARGUMENTS` contains `patch`, `minor`, or `major`:
- Skip Step 2 bump confirmation
- Apply specified bump to all changed plugins
- Otherwise same as auto

---

## Safety Rules

- **No changes = no release** (prevent empty commits)
- **Uncommitted changes = confirm first**
- **Not on main/develop = warn**
- **Push failure = keep commit** — instruct user to push manually
