---
name: land
description: Drive one open PR from opened to merged in this session — wait for the external reviewer check, fix review items, answer or accept the rest, then merge with xm pr land
---

# x-land — PR Opened to Merged

<Purpose>
Drive ONE open PR to merge inside the current session. The reviewer (an external system, https://github.com/x-mesh/reviewer) only reviews. This session waits for the review, fixes the items, and merges. The merge itself is done by `xm pr land`, never by raw `gh pr merge`.
</Purpose>

<Use_When>
- "PR 머지까지 진행해줘", "리뷰 기다렸다가 고치고 머지", "land this PR", "/xm:land"
- A PR is already open and the reviewer posts a commit status with context `reviewer` on its head.
- Another skill hands over an opened PR and wants it merged.
</Use_When>

<Do_Not_Use_When>
- The PR is not open yet. Open it first (`xm:write` in `pr` mode).
- You only want a one-shot merge with no review loop. Run `xm pr land <pr> --yes` directly.
- You want to review a PR without fixing it. Use `xm:review`.
- Several PRs are queued. This skill handles exactly one PR.
</Do_Not_Use_When>

> **⚠ Call `xm pr land` directly. Claude Code's Bash tool starts a fresh shell on every invocation — shell functions (`xmb()`) defined in one call do NOT persist to the next, causing `command not found: xmb`. Never define a helper across calls; always use the dispatcher.**
>
> **Fallback** (only when `xm` is not in PATH — rare; `${CLAUDE_PLUGIN_ROOT}` is NOT exported to Bash subprocesses, so don't rely on it bare):
> ```bash
> XMB_CLI=$(ls -d ~/.claude/plugins/cache/xm/{build,xm}/*/lib/x-build-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XMB_CLI" pr land <args>
> ```
>
> **Forbidden:** `XMB="node ..."; $XMB pr land ...` — zsh treats the quoted string as a single command and fails.

## Arguments

```
/xm:land [<pr>] [--review reviewer|here|none] [--merge here|none] [--check <name>]
```

| Argument | Default | Meaning |
|----------|---------|---------|
| `<pr>` | PR of the current branch | PR number, URL, or branch |
| `--review` | `reviewer` | `reviewer`: wait for the external reviewer. `here`: run `xm:review` in this session. `none`: no review gate. |
| `--merge` | `here` | `here`: merge with `xm pr land`. `none`: stop after the review is clean and report the PR URL. |
| `--check` | `reviewer` | Name of the required commit status or check row |

`<name>` below means the value of `--check`. `<pr>` means the resolved PR. Resolve `<owner>/<repo>` with `gh repo view --json nameWithOwner -q .nameWithOwner`.

`--review none` is allowed only when the user chose it. Never pick `none` on your own to get past a failing or missing check.

## Core Process

### Step 1 — Orient

1. Run `GK_AGENT=1 git-kit context --include=remotes` and `gh pr view <pr> --json number,url,state,headRefName,headRefOid`.
2. If the PR is not open, report it and stop.
3. If the working tree has unrelated changes, tell the user and commit only the files each fix touches (Step 5).

### Step 2 — Wait for the review (`--review reviewer`)

Wait for the required check without merging:

```bash
xm pr land <pr> --wait --timeout 900 --require-check <name> --dry-run --json
```

`900` seconds is the default. If the user gave another timeout, use it and remember the value for the report. Exit code 2 means blocked or awaiting confirmation; it is expected here. Read `required_checks[]` (`name`, `status`, `description`) and branch on `status`:

| Status | Action |
|--------|--------|
| `passed` | Go to Step 3 and read the review. |
| `failed` | Go to Step 3. A review may exist and carry items to fix. |
| `pending` after timeout | Report that the review is still running with the timeout used. Stop. Never merge. |
| `missing` after timeout | Report "no reviewer check appeared" (user-facing: "reviewer 체크가 나타나지 않았습니다") with the timeout used. Stop. Nothing is merged. |

### Step 3 — Read the review

Do not filter comments by commit. Reply comments can sit on an older commit.

```bash
gh api repos/<owner>/<repo>/pulls/<pr>/reviews --paginate
gh api repos/<owner>/<repo>/pulls/<pr>/comments --paginate
gh pr view <pr> --json headRefOid -q .headRefOid
```

1. Find reviews whose body ends with the hidden marker `<!-- reviewer-agent:v1 {...} -->`. Parse its JSON: `sha` is the reviewed head, `round` is the review round, `findings` is the item count.
2. **Gate:** the fix loop starts only when a review whose marker `sha` equals the current head SHA exists. Take the latest such review.
3. If no such review exists and the required check is `failed`, the reviewer did not review this head. Report the check `description` and stop. Causes: review start cap reached (`리뷰 시작 한도 도달`, default 4 per PR), `리뷰 실패`, `게시 실패`, `검토 미완료`. Never merge around it.
4. If the check is `passed` and no review matches the head, treat the review as missing: report it and stop.

### Step 4 — Sort the items

Read the review body groups and every inline comment of the PR:

- Body groups: the blocking group (차단), `#### 수정 권장 N건`, `#### 참고 N건`. Items are labelled `L1`, `L2`, ...
- Inline comments start with `**[리뷰어 · <심각도> · <묶음> · L<n>]**` and carry `<!-- reviewer-ledger-item:L<n> -->`.
- An item is closed when a later reply says `**[리뷰어 · L<n>]** 고침 확인 \`<sha>\``, or when a `/reviewer accept L<n> ...` reply exists. Skip closed items.

| Group | Action |
|-------|--------|
| 차단 (blocking) | Fix every one. See Step 6 for acceptance. |
| 수정 권장 | Fix it, OR reply `/reviewer accept L<n> <reason>` on its inline comment. |
| 참고 | Leave. Nothing is needed. |

Reply to an item with `gh api repos/<owner>/<repo>/pulls/<pr>/comments/<comment_id>/replies -f body='/reviewer accept L<n> <reason>'`. Give a concrete reason that names why the fix is not worth it.

If no blocking or 수정 권장 item is open, go to Step 8.

### Step 5 — Fix, commit, push

1. Fix only the open items. Do not widen scope.
2. Run the project's tests and lint for the touched files.
3. Commit with `GK_AGENT=1 git-kit commit -m "<message>" -- <files>`. Branch on the JSON `state`: `ok` continues; `blocked`, `paused`, or `error` means read `error.remedies[]`, run the first safe remedy, and never fall back to raw `git commit`.
4. Push with `GK_AGENT=1 git-kit push`. Branch on `state` the same way.
5. Count this as one fix push.
6. Return to Step 2. The new head needs a new review.

### Step 6 — Limits and stops

Use AskUserQuestion and stop the loop when any of these holds:

- **Two fix pushes done** and the latest review still has items to fix. Never push a third fix on your own.
- **Round 3 or more.** The latest marker `round` is 3 or more and items still need a fix.
- **Churn.** More than half of the new items come from lines the previous fix changed. Compare the new inline comments' paths and lines with the previous fix diff (`git diff <before>..<after>`).
- **Blocking acceptance.** You think a blocking item should be accepted instead of fixed. Ask with the item, its severity, and your reason. Write `/reviewer accept L<n> <reason>` only after the user approves in that answer. Never accept a blocking item on your own.

Offer these options: fix once more, accept the listed items with a stated reason, or stop here and hand over. Report the remaining items either way.

### Step 7 — `--review here` and `--review none`

- `here`: run the `xm:review` skill on the PR diff and fix Medium and higher findings using the same fix limits (Steps 5 and 6). Then land with `--require-review` (Step 8).
- `none`: skip Steps 2 to 4. Land without a required check (Step 8) only because the user chose `none`.

### Step 8 — Merge

`--merge none`: stop once the review is clean. Report the PR URL and that the PR is not merged.

`--merge here` with `--review reviewer`:

```bash
xm pr land <pr> --wait --require-check <name> --yes
```

`--merge here` with `--review here`:

```bash
xm pr land <pr> --wait --require-review --yes
```

`--merge here` with `--review none`:

```bash
xm pr land <pr> --wait --yes
```

If the command stays blocked, read `blocker` and `required_checks[]` from `--json` output and report them. A failed, errored, or capped reviewer check is reported with its description and is never merged around. Do not use `--allow-no-checks`, raw `gh pr merge`, or `--admin` to pass a gate.

### Step 9 — Report

Normal mode output examples:

```
머지했습니다: PR #<n> (<url>)
   리뷰 라운드 <R>, 수정 푸시 <k>회, 수용한 안건 <list>
```

```
reviewer 체크가 나타나지 않았습니다 (대기 <timeout>초). 머지하지 않았습니다.
```

```
reviewer 체크가 실패했습니다: <description>. 머지하지 않았습니다. 사람 판단이 필요합니다.
```

```
리뷰가 깨끗합니다. --merge none이라 머지하지 않았습니다: <url>
```

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "The check is still missing, so I'll merge with `--allow-no-checks`" | A missing reviewer check means no review happened. Report "no reviewer check appeared" with the timeout and stop. |
| "The reviewer hit its start cap, but the code looks fine" | A capped check is a failure that needs a human. Report the description. Never merge around it. |
| "I'll filter comments to the head commit to save output" | Reply comments such as `고침 확인` can sit on an older commit. Filtering shows closed items as open. Read every comment with `--paginate`. |
| "The check is green, so any review text is current" | Only a review whose marker `sha` equals the current head counts. An older round describes older code. |
| "This blocking item is a false alarm, I'll accept it myself" | Accepting a blocking item removes the only merge gate. Ask the user with the item and the reason. |
| "One more fix push will clear the last items" | The budget is two fix pushes. At round 3 or when fixes cause new items, more patching loops. Stop and ask. |
| "수정 권장 items do not block, so I'll skip them" | Each one needs a fix or a `/reviewer accept L<n> <reason>` reply. Skipping leaves the ledger open. |
| "I'll pick `--review none` because the reviewer is slow" | `none` is the user's choice, not a workaround. Raise the timeout or ask. |

## Red Flags

- You are about to run `gh pr merge` or pass `--admin` or `--allow-no-checks`.
- You wrote `/reviewer accept` for a blocking item without an AskUserQuestion answer.
- You are about to push a third fix, or a fix at round 3 or later.
- You read review text without comparing marker `sha` to the head.
- You listed comments with a `commit_id` filter.

## Verification

- After the wait: `required_checks[]` shows the check status, and the status you act on matches it.
- Before any fix: a review marker with `sha` equal to `gh pr view <pr> --json headRefOid` exists.
- After each push: `GK_AGENT=1 git-kit push` returned `state: "ok"`, and `gh pr view <pr> --json headRefOid` shows the new head.
- After the merge: `xm pr land` JSON shows `status` merged and a `merge_commit`. `gh pr view <pr> --json state -q .state` prints `MERGED`.
- For `--merge none`: confirm the report names the PR URL and says nothing was merged.
