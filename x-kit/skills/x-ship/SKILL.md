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

## Wiring

```
after: x-review
suggests: x-humble
```

# x-ship — Release Automation

Commit squash + version bump + push. Works with any git project.

## CLI

```bash
XMB="node x-build/lib/x-build-cli.mjs"
```

## Routing

| Argument | Mode |
|----------|------|
| (empty) | interactive — quality gates (test + review) then auto |
| `auto` | auto — squash + bump + push, no gates |
| `status` | status — show commits since last release |
| `dry-run` | dry-run — preview plan |
| `squash` | squash only |
| `patch` / `minor` / `major` | manual bump (skip bump confirmation) |

## AskUserQuestion Dark-Theme Rule

Output ALL context as markdown BEFORE calling AskUserQuestion. The `question` field is invisible on dark terminals — put key info in `header` and option `label`/`description` instead.

---

## Mode: status

```bash
$XMB release detect
```

Display the JSON output in readable format. Show changed plugins, WIP commits, recommendation.

---

## Mode: dry-run

```bash
$XMB release detect
$XMB release diff-report
```

Show what would happen without executing. Display squash plan, bump preview, push target.

---

## Mode: interactive

Pre-release pipeline with quality gates before auto flow.

### Step 0.1: Detect

```bash
$XMB release detect
```

If no changes → "✅ 릴리스할 변경사항이 없습니다." Exit.

### Step 0.2: Select pipeline (AskUserQuestion)

Options:
1. 테스트 → 리뷰 → 릴리스 (full pipeline)
2. 리뷰만 → 릴리스
3. 바로 릴리스 (auto mode)

### Step 0.3: Test gate (option 1 only)

```bash
$XMB release test [--command "bun test"]
```

If failed → AskUserQuestion: "1) 무시하고 계속  2) 릴리스 중단"

### Step 0.4: Review gate (option 1 or 2)

Invoke x-review: `/x-review diff $LAST_RELEASE..HEAD --preset quick`

- **LGTM** → proceed
- **Request Changes** → AskUserQuestion: "1) 무시하고 계속  2) 중단하고 수정"
- **Block** → exit

### Step 0.5: Proceed to auto flow

---

## Mode: auto

Full flow: detect → diff-report → squash → bump → commit → push → trace.

### Step 1: Detect

```bash
$XMB release detect
```

### Step 2: Squash decision (LLM judgment)

If `recommendation.squash` is true (WIP commits exist):

```bash
$XMB release diff-report
```

LLM analyzes diff-report and decides:
- **Option 1: Grouped squash** — group by scope, reset + re-commit per group
- **Option 2: Single squash** — `$XMB release squash`
- **Option 3: Keep as-is** — skip squash

For grouped squash, LLM executes:
```bash
$XMB release squash --since <ref>
# Then re-commit in groups (LLM stages files per group)
```

For single squash:
```bash
$XMB release squash
```

### Step 3: Bump type (LLM judgment)

Based on detect output, determine bump type:

| Change type | Bump |
|-------------|------|
| Bug fix, internal refactor | patch |
| New command/feature/export | minor |
| Breaking change (removed export) | major |
| Explicit in `$ARGUMENTS` | use that |

Confirm with user unless `$ARGUMENTS` specifies bump type.

### Step 4: Bump

**x-kit marketplace:**
```bash
$XMB release bump --patch --plugins x-build,x-dashboard
```
(Runs sync-bundle + tests automatically)

**Standalone project:**
```bash
$XMB release bump --patch --standalone
```

### Step 5: README check (LLM judgment, x-kit only)

| Change type | README action |
|-------------|---------------|
| New command/flag | Update README |
| User-visible behavior change | Update README |
| Internal refactor, bug fix | Skip — log: "README skip: {reason}" |

### Step 6: Commit message (LLM writes)

Format:
```
release: {name}@{version}

- {plugin}: {change summary}
```

### Step 7: Commit & Push

```bash
$XMB release commit --msg "release: ..." --push
```

### Step 8: Trace

```bash
$XMB release trace --from {old} --to {new} --bump {type} \
  --test-passed {true|false} --review-verdict {LGTM|null}
```

### Step 9: Output

```
🚀 Shipped!

  Version: {old} → {new}
  Commit: {hash}
  Push: origin/{branch} ✅
```

---

## Safety Rules

- **Squash local-only** — never squash pushed commits. Force push should not be needed.
- **No changes = no release**
- **Squash verification** — `git diff $PRE_SQUASH HEAD` must be empty
- **Not on main/develop = warn**
- **Rollback on failure** — save pre-squash HEAD, restore with `git reset --hard`
- **Push failure = keep commit** — instruct user to push manually

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "patch bump is safe, I'll use patch" | patch implies no behavior change. If behavior changed, bump minor. |
| "I'll squash later" | Squash before push or not at all. |
| "The user will confirm if they care" | Don't guess on irreversible operations. Ask before push. |
