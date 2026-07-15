---
name: wt
description: Session worktree — isolate the whole current session in a git worktree, then land it back to the parent branch. Use for "worktree로 작업", "이 세션을 worktree에서", "격리해서 작업하고 부모로 머지", "/xm:wt", or when the user wants the ENTIRE session (not one task) to run in an isolated worktree and later merge back.
model: sonnet
allowed-tools:
  - Bash
  - EnterWorktree
  - ExitWorktree
  - AskUserQuestion
---

# x-wt — Session Worktree

## Overview

`/xm:wt` runs the WHOLE current session inside an isolated git worktree, then
lands that work back onto the branch you started from. Two verbs:

- **`/xm:wt`** (or `/xm:wt start [name]`) — create a worktree, switch the session into it.
- **`/xm:wt land`** — merge the worktree branch into its parent (no push), return the session.

This is session-scoped isolation. It is NOT x-build's worktree mode
(`/xm:build run --worktrees`), which fans ONE worktree out PER task from a
project's task DAG. `/xm:wt` has no tasks and no gate panel — it is the thin
"work aside, then merge back" wrapper.

**Mechanism split** (do not blur):
- The harness tools `EnterWorktree` / `ExitWorktree` own the SESSION cwd switch.
- `git-kit promote` owns the merge-back (commit + merge into parent, no network).
- The skill just sequences them and records the parent so `land` merges correctly.

> `EnterWorktree` / `ExitWorktree` are harness (Claude Code) tools, not xm CLIs.
> If they are not already available, load them first:
> `ToolSearch("select:EnterWorktree,ExitWorktree")`.

## When to Use

- "worktree로 (전체) 작업하자", "이 세션을 worktree에서 돌려", "격리해서 작업 후 부모로 머지"
- The user wants the current session's ongoing work isolated on a throwaway branch, mergeable later.
- `/xm:wt`, `/xm:wt start`, `/xm:wt land`, `/xm:wt status`.

## Do NOT Use When

- The user wants ONE task or parallel tasks isolated → `/xm:build run --worktrees`.
- The user wants a plain branch (no separate working directory) → `git switch -c` / git-kit.
- The user only wants a subagent isolated → the Agent tool's `isolation: "worktree"`.
- The user never said "worktree" — do not put a session into a worktree unprompted.

## Core Process — route on the first token

`start` (empty / `start` / `go` / `new`) → §Start. `land` (`land` / `finish` / `done`) → §Land.
`status` → §Status.

### Start

1. **Preconditions.**
   - In a git repo (`git rev-parse --is-inside-work-tree`). If not, stop and say so.
   - Not already in a `/xm:wt` worktree — if `git config --get branch.$(git branch --show-current).gk-parent` returns a value, you are already in one; tell the user to `/xm:wt land` (or `status`) instead of nesting.
   - Warn if the working tree is dirty: uncommitted changes stay in the CURRENT directory and do NOT follow into a fresh worktree (see Rationalizations for `worktree.baseRef`). Offer to commit first, or proceed.
2. **Record the parent branch** BEFORE entering:
   ```bash
   PARENT=$(git branch --show-current)   # the branch land will merge back into
   ```
3. **Enter the worktree** — call the `EnterWorktree` tool (pass `name` only if the user named it; otherwise let it generate one). This switches the session cwd into a new worktree on a new branch.
4. **Persist the parent** so `land` (a separate invocation) knows the target:
   ```bash
   NEW=$(git branch --show-current)
   git config branch."$NEW".gk-parent "$PARENT"
   ```
5. **Report** (normal mode → Korean):
   ```
   🌿 worktree 진입: <NEW>  (parent: <PARENT>)
      경로: <worktree path>
      작업 후 /xm:wt land 로 <PARENT>에 머지하세요.
   ```

### Land

1. **Confirm you are in a `/xm:wt` worktree**: `PARENT=$(git config --get branch.$(git branch --show-current).gk-parent)`. If empty, this session was not started by `/xm:wt` — do NOT ExitWorktree; say so and stop.
2. **Verify before merge** (announce, keep light): run the project's quick check if one exists (`bun test` here, or the repo's verify). Report failures; ask before merging broken code.
3. **Merge into the parent** — `git-kit promote` commits any pending work, then merges the current branch into its `gk-parent` (the value from step 1). No push.
   ```bash
   GK_AGENT=1 git-kit promote
   ```
   Branch on the agent-mode `state`:
   - `ok` → merged. Continue to step 4.
   - `paused` (conflict) → **STOP.** Report the resume/abort command from `result`; do NOT ExitWorktree — the branch is not merged.
   - `blocked` / `error` → report `error.remedies[0]` (check its `safety` first); do not remove the worktree.
4. **Exit and clean up** — call `ExitWorktree` with `action: "remove"`. It will almost always REFUSE the first call with "N commits on <branch>": after a fast-forward promote the worktree branch and the parent point at the SAME commit, but ExitWorktree compares against the branch's ENTRY baseline, not the advanced parent — so it still counts the promoted commits as unmerged. Since step 3 reached `ok` (the parent now contains them), this is expected and the branch is redundant: re-invoke `ExitWorktree` with `action: "remove", discard_changes: true`. This is safe ONLY because promote already merged the commits into the parent — **never pass `discard_changes: true` if step 3 did not reach `ok`** (then the commits are genuinely unmerged and would be lost; use `action: "keep"` and report instead).
5. **Report** (normal mode → Korean):
   ```
   ✅ <NEW> → <PARENT> 머지 완료 (push 안 함).
      세션이 <PARENT>로 복귀했습니다.
      원격 반영은 git-kit land / push 로 직접 하세요.
   ```

### Status

Report where the session is: `git branch --show-current`, whether it is a
`/xm:wt` worktree (gk-parent set?), and `git-kit worktree` list for the repo.
Read-only — never create or remove anything under `status`.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll just `git merge` the branch by hand." | Use `git-kit promote`: it commits, resolves the fast-forward / merge-tree path, needs no parent checkout, and reads `gk-parent` so it merges into the branch you actually started from. Raw merge loses that and can land on the wrong base. |
| "I'll skip recording the parent — land will figure it out." | `land` is a SEPARATE invocation; nothing carries the parent across turns except the `branch.<name>.gk-parent` config you set at start. Skip it and `promote` falls back to the configured base, merging into the wrong branch. |
| "The tree is dirty but I'll enter a fresh worktree anyway." | With `worktree.baseRef=fresh` (default) the new worktree branches from origin/<default>; uncommitted changes in the current dir do NOT come along. Commit first, or set `worktree.baseRef=head` to branch from where you are. |
| "I'll push after promote to be safe." | `promote` is deliberately no-network (local integration). Never push without the user asking — pushing the parent is their call. |
| "Only one vendor / no gate, so I'll add a panel review here." | `/xm:wt` is the ungated wrapper by design. Gated per-task merges are `/xm:build run --worktrees`. Don't reinvent the gate here. |
| "I'll define a shell alias for the long git-kit command." | The Bash tool is stateless per call — an alias/function from one call is gone in the next. Call `git-kit` (or `GK_AGENT=1 git-kit`) directly every time. |
| "I'm in a worktree already, I'll just start another." | `EnterWorktree` refuses a nested create, and a `gk-parent` already set means you are mid-session. Land or exit first. |
| "ExitWorktree refused remove, so the land failed — I'll keep the worktree." | Expected: after a ff promote, ExitWorktree still counts the promoted commits against the branch's ENTRY baseline. If step 3 promote reached `ok`, the commits ARE on the parent — re-invoke with `discard_changes: true` (safe). Falling back to `keep` here just litters orphan worktrees. |

## Red Flags

- You called `EnterWorktree` without recording the parent branch first.
- You ran `ExitWorktree remove` while `git-kit promote` was `paused`/`error` — the branch was not merged and the work is now gone.
- You pushed (`git push` / `git-kit land`) during `land` without the user asking.
- You put the session into a worktree when the user never said "worktree".
- You inlined a task-gate / panel review — that belongs to `/xm:build run --worktrees`, not here.
- You defined a shell alias/function and reused it across Bash calls.

## Verification

- After `start`: `git branch --show-current` is the new branch AND `git config --get branch.<new>.gk-parent` returns the original branch.
- After `land` success: `git-kit promote` returned `ok` AND the parent branch now contains the worktree branch's HEAD (`git branch --contains` / the parent log shows the commit), the session cwd is back on the parent, and the worktree is gone (removed via `discard_changes: true` after the expected first-call refusal). Only fall back to `keep` when promote did NOT reach `ok`.
- You never pushed unless the user asked.
- On a `promote` conflict you stopped and surfaced the resume/abort command instead of removing the worktree.
