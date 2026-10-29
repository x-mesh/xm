---
name: wt
description: Session worktree — move the whole current session into a git-kit worktree cut from develop, open a PR from it, and remove the worktree after the PR merges. Use for "worktree로 작업", "이 세션을 worktree에서", "worktree에서 작업하고 PR", "격리해서 작업 후 부모로 머지", "/xm:wt", or when the user wants the ENTIRE session (not one task) to run in an isolated worktree.
model: sonnet
allowed-tools:
  - Bash
  - EnterWorktree
  - ExitWorktree
  - AskUserQuestion
  - Skill
---

# x-wt — Session Worktree

## Overview

`/xm:wt` runs the WHOLE current session inside an isolated git worktree and
delivers that work through a PR. Four verbs:

- **`/xm:wt start [<branch>]`** — refresh the parent, create a gk worktree from it, switch the session into it.
- **`/xm:wt pr`** — verify, then open (or update) a PR into the parent. The worktree stays for review fixes.
- **`/xm:wt land [<branch>]`** — after the PR merges, refresh the parent and remove the worktree and branch. With no PR, merge into the parent locally instead (no push).
- **`/xm:wt status`** — where the session is, and the PR state.

This is session-scoped isolation. It is NOT x-build's worktree mode
(`/xm:build run --worktrees`), which fans ONE worktree out PER task from a
project's task DAG. `/xm:wt` has no tasks and no gate panel.

**Mechanism split** (do not blur):
- `git-kit worktree acquire` creates the worktree under `~/.gk/worktree/<project>/<branch>` and records `branch.<branch>.gk-parent`.
- The harness tools `EnterWorktree(path)` / `ExitWorktree(keep)` move the SESSION cwd. They never create or delete the worktree: a worktree entered by `path` is never removed by `ExitWorktree`.
- `xm:write pr` writes and publishes the PR, including the branch push.
- `git-kit refresh` and `git-kit worktree remove` / `finish` do the integration and cleanup.

> `EnterWorktree` / `ExitWorktree` are harness (Claude Code) tools, not xm CLIs.
> If they are not already available, load them first:
> `ToolSearch("select:EnterWorktree,ExitWorktree")`.

## When to Use

- "worktree로 (전체) 작업하자", "이 세션을 worktree에서 돌려", "worktree에서 작업하고 PR 올리자"
- The user wants the current session's work isolated on its own branch and delivered as a PR.
- `/xm:wt`, `/xm:wt start`, `/xm:wt pr`, `/xm:wt land`, `/xm:wt status`.

## Do NOT Use When

- The user wants ONE task or parallel tasks isolated → `/xm:build run --worktrees`.
- The user wants several independent features as parallel PRs → `/xm:batch`.
- The user wants a plain branch (no separate working directory) → `git-kit switch` / `git switch -c`.
- The user only wants a subagent isolated → the Agent tool's `isolation: "worktree"`.
- The user never said "worktree" — do not put a session into a worktree unprompted.

## Core Process — route on the first token

`start` (empty / `start` / `go` / `new`) → §Start. `pr` (`pr` / `publish`) → §PR.
`land` (`land` / `finish` / `done`) → §Land. `status` → §Status. Any other first token
(`/xm:wt fix/x`) → §Start with that token as the branch name.

### Start

1. **Preconditions.**
   - In a git repo (`git rev-parse --is-inside-work-tree`). If not, stop and say so.
   - Not already in a `/xm:wt` worktree: if `git config --get branch.$(git branch --show-current).gk-parent` returns a value, tell the user to `/xm:wt pr`, `land`, or `status` instead of nesting.
   - Warn if the working tree is dirty: uncommitted changes stay in the CURRENT checkout and do NOT follow into the new worktree. Offer to commit first, or proceed.
2. **Pick the parent.** `--from <branch>` wins. Otherwise use `develop` when a local `develop` exists (`git rev-parse --verify --quiet refs/heads/develop`), else the base that `GK_AGENT=1 git-kit context` reports. The parent must be a LOCAL branch: `acquire --from origin/develop` skips the `gk-parent` record, and `pr` / `land` then have no target.
3. **Pick the branch name.** Use the name the user gave. Otherwise derive `<type>/<kebab-slug>` from the stated task, matching the repository's branch history (`fix/…`, `feat/…`, `docs/…`, `chore/…`). If there is no stated task, ask once.
4. **Refresh the long-lived branches** so the worktree starts from the remote tip:
   ```bash
   GK_AGENT=1 git-kit refresh
   ```
   `refresh` prints text only (no JSON envelope, even with `--json`) and only fast-forwards each branch to its own remote, so `main` is never moved to `develop`. Check the result yourself, in this order:
   - Non-zero exit → the fetch failed and `origin/<PARENT>` may be stale. Report the error and stop.
   - `git rev-parse --verify --quiet refs/remotes/origin/<PARENT>` fails → the parent has no remote branch, so there is nothing to compare and `pr` has no base on the remote. Say so and stop: the user can push the parent first, or pass `--from` with a branch that exists on the remote.
   - `git rev-parse <PARENT>` equals `git rev-parse origin/<PARENT>` → continue.
   - Otherwise `refresh` exited 0 but skipped the parent. If `git merge-base --is-ancestor <PARENT> origin/<PARENT>` succeeds, the parent is only behind and the fast-forward was skipped: report the refresh output and stop. If it fails, the parent has commits that are not on the remote: report them and stop, because starting from that tip would put unpushed work into the PR.
5. **Create the worktree:**
   ```bash
   GK_AGENT=1 git-kit worktree acquire <branch> --from <PARENT>
   ```
   Read `result.path`, `result.parent`, `result.reused`, and `result.init`. `result.parent` must equal `<PARENT>`. `reused: true` means the branch already had a worktree: say that you are resuming it, not starting fresh. `acquire` runs the `.gk.yaml` `worktree.init` bootstrap (for example `bun install`) by default; report a failed `init`.
6. **Enter it** — call `EnterWorktree` with `path: <result.path>`. Never pass `name`: that creates a second worktree under `.claude/worktrees/` from `origin/<default-branch>`, not from the parent.
7. **Report** (normal mode → Korean):
   ```
   🌿 worktree 진입: <branch>  (parent: <PARENT>)
      경로: <result.path>
      작업 후 /xm:wt pr 로 <PARENT> 대상 PR을 만드세요.
   ```

### PR

1. **Confirm the worktree.** `BRANCH=$(git branch --show-current)`, `PARENT=$(git config --get branch.$BRANCH.gk-parent)`. If `PARENT` is empty, this branch was not started by `/xm:wt`: stop and say so.
2. **Dirty-tree gate.** Run `git status --porcelain`. If it is non-empty, list the files and ask: commit the intended files (`GK_AGENT=1 git-kit commit`, staging only this work), or stop. Never commit everything to get past this gate.
3. **Something to publish?** `git rev-list --count $PARENT..HEAD`. If it is 0, there is no commit for a PR: say so and stop.
4. **Verify** (announce, keep light): run the project's check for the changed files. In this repository, run the `bun test <file>` files that cover the change; the full `bun test` takes about 15 minutes, so announce it before running it. Report failures and ask before opening a PR on failing code.
5. **Existing PR?** `gh pr view $BRANCH --json number,state,url`.
   - `OPEN` → this is a review fix. Ask once to push the new commits, then run `GK_AGENT=1 git-kit push` and branch on `state`. Report the PR URL. Offer `xm:write pr <number>` only if the body no longer matches the change.
   - `MERGED` → the PR is done: point to `/xm:wt land`.
   - `CLOSED` → show it and ask whether to open a new PR.
   - No PR: the command fails with `no pull requests found` → continue to step 6.
   - Any other failure (authentication, network, a remote that is not GitHub) → the PR state is unknown. Show the `gh` error and stop.
6. **Open the PR** — invoke the `xm:write` skill with the Skill tool:
   ```
   Skill: xm:write
   args: pr --base <PARENT>
   ```
   `--base` is required: `git-kit context` reports the repository's `base_branch` (here `main`), not the `gk-parent`, so without it the PR targets the wrong branch. `xm:write` shows the title, body, and target, asks once, and pushes the branch as part of that question. Do not run `git-kit push` or `gh pr create` yourself for a new PR.
7. **Report** (normal mode → Korean):
   ```
   📬 PR #<n> → <PARENT>: <url>
      worktree는 그대로 둡니다. 리뷰를 반영한 뒤 /xm:wt pr 로 다시 push하세요.
      병합되면 /xm:wt land 로 정리하세요.
   ```

### Land

1. **Resolve the branch and worktree.** Use `<branch>` when given, else the current branch. `PARENT=$(git config --get branch.<branch>.gk-parent)`. If it is empty: in the main checkout, list the gk worktrees whose branch has a `gk-parent` (`GK_AGENT=1 git-kit worktree list --json`) and ask which one; elsewhere stop and say this branch was not started by `/xm:wt`. Take the worktree path from the `worktree list` row for `<branch>`.
2. **Route on the PR.** `gh pr view <branch> --json number,state,url,headRefOid`.
   - `MERGED` → §Land after a merged PR.
   - `OPEN` → report the URL and stop. The PR is the integration path; do not merge locally around it.
   - `CLOSED` → show it and ask: keep the worktree, or remove it as abandoned (the branch is then deleted with `-D` only after the user agrees).
   - No PR: the command fails with `no pull requests found` → §Land without a PR.
   - Any other failure (authentication, network, a remote that is not GitHub) → the PR state is unknown, and an OPEN PR may exist. Show the `gh` error and stop. Never take §Land without a PR on a failed lookup.

#### Land after a merged PR

1. **Leave the worktree first.** If the session cwd is inside the worktree, call `ExitWorktree` with `action: "keep"`. It is a no-op when this session did not enter it. If `git rev-parse --show-toplevel` is still the worktree path afterwards (a session that was started inside it), stop and tell the user to run `/xm:wt land <branch>` from the main checkout: removing the worktree would delete the session's cwd. Run every later step from the main checkout (`git -C <path> rev-parse --git-common-dir` gives its `.git`).
2. **Nothing left behind.** `git -C <path> status --porcelain` must be empty, and `git rev-parse <branch>` must equal the PR's `headRefOid`. A dirty tree or a local tip that differs from the merged head means work that is not in the PR: list it and stop.
3. **Refresh the parent:** `GK_AGENT=1 git-kit refresh`, then diagnose the result with the same four cases as §Start step 4. Continue only when `<PARENT>` equals `origin/<PARENT>`. In every other case, report the diagnosis and stop.
4. **Archive the worktree state** as in §Archive the worktree state.
5. **Remove the worktree:** `GK_AGENT=1 git-kit worktree remove <path>`. Never pass `--force`.
6. **Delete the branch.** If `git merge-base --is-ancestor <branch> <PARENT>` succeeds (merge-commit merge), run `git branch -d <branch>`. `-d` checks the branch's upstream, and when `refresh --prune` has removed a deleted remote branch it checks HEAD instead, which may not be `<PARENT>`. If `-d` refuses, `--is-ancestor` has already proved that `<PARENT>` contains the branch, so run `git branch -D <branch>` without a new question. If `--is-ancestor` fails, the PR was squash- or rebase-merged: step 2 already proved the branch tip is the merged PR head, so show that and ask before `git branch -D <branch>`.
7. **Remote branch.** If `git ls-remote --exit-code --heads origin <branch>` exits 0, the remote branch still exists. Deleting it changes GitHub state: ask, and only on approval run `git push origin --delete <branch>`.
8. **Report** (normal mode → Korean):
   ```
   ✅ PR #<n> 병합 확인: <branch> → <PARENT>
      <PARENT>를 원격과 맞췄고, worktree와 로컬 브랜치를 지웠습니다.
      worktree의 .xm/: <보관 경로 | 없음>
      원격 브랜치: <삭제함 | 남겨 둠>
   ```

#### Archive the worktree state

Each checkout keeps its own gitignored `.xm/`: review runs, review budget, triage, and any
`later` item or inbox entry recorded while the session was inside the worktree.
`git-kit worktree remove` deletes ignored files with the worktree, so move `.xm/` out first.
Run this from the main checkout, after `ExitWorktree`.

1. If `<path>/.xm` does not exist, skip this section.
2. Look for records that belong in the main backlog: `find <path>/.xm -name later.json` and `<path>/.xm/inbox/*.json`. If any exist, list them for the user: they are archived, not merged, so the main checkout's `xm build later list` and `xm inbox list` do not show them.
3. Move the directory to `.xm/archive/wt/<branch>` in the main checkout. A `/` in the branch name becomes a subdirectory. If that path already exists, append `-<UTC timestamp>`:
   ```bash
   mkdir -p .xm/archive/wt/<branch-parent-dirs>
   mv <path>/.xm .xm/archive/wt/<branch>
   ```
   `.xm/` is gitignored in both checkouts, so the move changes no tracked file.

#### Land without a PR

Local integration, no network: merge into the parent with `git-kit worktree finish`.

1. **Run inside the worktree.** If the session is not in it, call `EnterWorktree` with `path: <worktree path>`.
2. **Verify before merge**, as in §PR step 4. Ask before merging failing code.
3. **Dirty-tree gate BEFORE finish.** If `git status --porcelain` is non-empty, list the files and ask: commit the intended work first, OR acknowledge that `finish` will auto-commit EVERYTHING — including unrelated and untracked files — as separate, unreviewed commits onto the parent. gk's own gated finish path refuses a dirty tree for this reason; the ungated path has no such guard, so you are the guard.
4. **Merge only.** `finish` wraps `promote` (commit + one-hop merge into `gk-parent`, no push). Do not pass `--cleanup` / `--delete-branch`: they remove the worktree before its `.xm/` is archived.
   ```bash
   GK_AGENT=1 git-kit worktree finish
   ```
   Branch STRICTLY on the JSON `state` — NEVER the exit code (gated finish uses exit 3 as a normal paused flow):
   - `ok` → merged. Continue to step 5.
   - `error` whose message contains `promote failed` / `exit 3` → a merge CONFLICT paused in disguise; the merge is mid-flight INSIDE the worktree. Do NOT ExitWorktree and do NOT discard anything: run `GK_AGENT=1 git-kit context` in the worktree, report the conflict state and the resume/abort options, then **STOP**.
   - `blocked` / any other `error` → check whether the parent already contains the branch (`git branch --contains`). If yes, the merge STANDS: report that and continue to step 5. If no, follow `error.remedies[0]` after checking its `safety`. Never remove the worktree yourself.
5. **Return the session** — call `ExitWorktree` with `action: "keep"`. Run every later step from the main checkout.
6. **Archive the worktree state** as in §Archive the worktree state.
7. **Remove the worktree and branch:** `GK_AGENT=1 git-kit worktree remove <path>` (never `--force`), then `git branch -d <branch>`. `promote` merged the branch into `<PARENT>`, so if `-d` refuses and `git merge-base --is-ancestor <branch> <PARENT>` succeeds, run `git branch -D <branch>`. If `--is-ancestor` fails, the merge did not land: stop and report.
8. **Report** (normal mode → Korean):
   ```
   ✅ <branch> → <PARENT> 로컬 머지 완료 (push 안 함).
      worktree와 브랜치를 지웠습니다. worktree의 .xm/: <보관 경로 | 없음>
      원격 반영은 git-kit land / push 로 직접 하세요.
   ```

### Status

Report where the session is: `git branch --show-current`, its `gk-parent`, the
PR state (`gh pr view --json number,state,url`, or "no PR"), and
`GK_AGENT=1 git-kit worktree list` for the repo. Read-only — never create,
push, or remove anything under `status`.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "`EnterWorktree(name)` is one call; acquire plus `path` is two." | `name` creates the worktree under `.claude/worktrees/` from `origin/<default-branch>` (`main`) and records no `gk-parent`. The PR then misses every unreleased `develop` commit and `land` has no target. Create with `acquire --from <PARENT>`, enter by `path`. |
| "I'll fast-forward `main` to `develop` so both match before starting." | `main` is the released state; it trails `develop` between releases on purpose. Moving it releases unreleased work. `git-kit refresh` aligns each branch with its OWN remote, which is what the start needs. |
| "`xm:write` finds the base by itself." | It uses the `base_branch` that `git-kit context` reports, which is `main` here even for a branch cut from `develop`. Pass `--base <gk-parent>`. |
| "I'll push the branch first, then call `xm:write`." | `xm:write pr` folds the push into its one publish question. A separate push is a second prompt and publishes before the user saw the PR text. |
| "The PR is open, so `land` can merge it locally to save time." | The PR is the integration path: CI and review run there. Merging around it lands unreviewed code. Wait for the merge, then `land`. |
| "The PR merged, so `git branch -D` is fine." | Only after the local tip equals the PR's `headRefOid` and the worktree is clean. A commit made after the merge exists nowhere else; `-D` deletes it. |
| "`ExitWorktree(remove)` cleans up in one step." | A worktree entered by `path` is never removed by `ExitWorktree`, and it only acts on worktrees this session entered. gk created it; `git-kit worktree remove` removes it. |
| "The remote branch is stale, I'll delete it with the local one." | Deleting a remote branch changes GitHub state. Ask first. |
| "Non-zero exit code, so the finish failed." | Gated finish uses exit 3 as its normal paused flow. Branch only on the `state` field. |
| "`finish --cleanup` does the merge and the cleanup in one call." | It deletes the worktree with its gitignored `.xm/`: review runs, triage, and any `later` item recorded inside the worktree. Merge with `finish`, archive `.xm/`, then remove. |
| "finish returned an error, so the worktree is junk — I'll remove it." | An error containing `exit 3` is a wrapped merge conflict: the merge is half-done inside the worktree. Preserve it and surface the conflict. |
| "I'll define a shell alias for the long git-kit command." | The Bash tool is stateless per call — an alias/function from one call is gone in the next. Call `GK_AGENT=1 git-kit` directly every time. |

## Red Flags

- You called `EnterWorktree` with `name` instead of the `path` from `acquire`.
- You passed a remote ref (`origin/develop`) to `acquire --from`, so no `gk-parent` was recorded.
- You moved `main` to match `develop` before starting.
- You invoked `xm:write pr` without `--base <gk-parent>`.
- You pushed a new branch yourself before `xm:write` asked.
- You merged locally while the branch had an `OPEN` PR, or read a failed `gh pr view` as "no PR".
- You deleted a branch with `-D`, or removed a worktree, without checking it is clean and equal to the merged PR head.
- You deleted a remote branch without asking.
- You ran `worktree remove` while the session cwd was inside that worktree.
- You judged `finish` by its exit code instead of the `state` field.
- You removed a worktree before moving its `.xm/` to `.xm/archive/wt/<branch>`.

## Verification

- After `start`: `git branch --show-current` is the new branch, `git config --get branch.<branch>.gk-parent` returns the parent, the cwd is under `~/.gk/worktree/<project>/`, and `git merge-base --is-ancestor origin/<PARENT> HEAD` succeeds.
- After `pr`: `gh pr view --json baseRefName,url` shows `baseRefName` equal to the `gk-parent`, and the worktree still exists.
- After `land` with a merged PR: the worktree path is gone from `git-kit worktree list`, `git rev-parse --verify --quiet refs/heads/<branch>` fails unless the user declined the `-D` for a squash- or rebase-merged branch, the parent equals its remote, and the remote branch was deleted only with the user's approval.
- After `land` without a PR: `finish` returned `state:"ok"`, the parent contains the branch's commits, the worktree and branch are gone, and nothing was pushed.
- After either `land`: if the worktree had a `.xm/`, it now exists at `.xm/archive/wt/<branch>` in the main checkout.
