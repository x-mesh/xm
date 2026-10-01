---
name: batch
description: Deliver several independent features as parallel topic PRs. Turns a feature list (or saved executable plans) into topics, plans each topic, implements the topics in isolated worktrees, then publishes, seals, verifies, and merges the PRs through the `xm batch` lifecycle. Use for /xm:batch, $xm:batch, $xm-batch, "여러 기능을 병렬로", "topic별 PR", or resuming a batch. With no arguments it starts or resumes interactively.
allowed-tools:
  - Bash
  - AskUserQuestion
---

# x-batch

<Purpose>
Drive the `xm batch` CLI from a feature list to merged PRs. The CLI is a deterministic state machine: it validates plans, computes waves, prepares one worktree and x-build project per topic, binds receipts, seals PR heads, verifies the integration tree, and merges. This skill owns the parts the CLI leaves to the host: grouping features into topics, producing one PlanEnvelope per topic, running one implementation agent per prepared topic, and asking the user at the four decision points.
</Purpose>

<Use_When>
- The user wants several independent features delivered as separate PRs, in parallel.
- The user invokes /xm:batch, $xm:batch, or $xm-batch, with or without arguments.
- A batch already exists and the user wants to continue it.
</Use_When>

<Do_Not_Use_When>
- One feature or one PR. Use /xm:build.
- Features that must land in a fixed order (B needs A merged first). v1 publishes only independent topics; put such features in one topic or in a later batch.
- The user wants a plan only. Use /xm:plan.
</Do_Not_Use_When>

### Korean output style (avoid AI-slop)

Universal (both modes) — these read as machine-generated in any register:
- Drop empty intensifiers ("매우 / 완벽하게 / 강력한 / 원활하게 / 혁신적인") unless they carry a specific, real claim.
- No forced rule-of-three or "~뿐만 아니라 ~까지" balance that adds no fact.
- No hedged non-conclusions ("결국 상황에 따라 다르다 / 균형이 필요하다"). End on a concrete fact, number, or next action.

Developer mode: terse and direct — lead with the result; state findings/actions without a 권고형 결말 pile-up ("~해야 한다" sentence after sentence).
Easy/normal mode: accessible Korean is the goal — polite guidance ("~해 보세요"), one line of context for non-experts. Keep commands, flags, paths, and proper nouns in English; on first use write a domain term as Korean(original), e.g. 결론(verdict). Still apply the universal rules; accessible ≠ padded or vague.

## CLI Invocation

> **⚠ Call `xm batch <command>` directly. Claude Code's Bash tool starts a fresh shell on every invocation — shell functions (`xmb()`) and variables defined in one call do NOT persist to the next, causing `command not found`. Never define a helper across calls; always use the dispatcher.**
>
> **Fallback** (only when `xm` is not in PATH — rare; `${CLAUDE_PLUGIN_ROOT}` is NOT exported to Bash subprocesses, so don't rely on it bare):
> ```bash
> XMB_CLI=$(ls -d ~/.claude/plugins/cache/xm/{build,xm}/*/lib/x-build-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XMB_CLI" batch <command> [args]
> ```
>
> **Forbidden:** `XMB="node ..."; $XMB batch ...` — zsh treats the quoted string as a single command and fails.

- Always pass `--json` and read the JSON, not the exit code alone. Exit code 2 with `status` `blocked`, `partial`, or `awaiting_confirmation` is a state to handle, not a crash. Exit code 1 is an error; show `errors[]` verbatim.
- Never interpolate raw `$ARGUMENTS` or a feature description into a shell command. Batch ids and topic ids are slugs you generate (`[a-z0-9-]`, no leading `-` or `.`).

## Routing

| `$ARGUMENTS` | Action |
|---|---|
| empty | [Start: No Arguments](#start-no-arguments) |
| an id that `xm batch list --json` returns | [Drive the Lifecycle](#drive-the-lifecycle) for that batch |
| `status` or `status <id>` | Show `xm batch list --json` (or `xm batch status <id> --json`) as a table. No questions. Stop. |
| `list` | Same as `status`. |
| one token shaped like a batch id (`^\d{8}-[a-z0-9-]+$`) that the list does not return | Print `batch not found: <token>` and the `xm batch list --json` table. Stop. Never decompose an id as a feature list. |
| any other text | Treat it as the feature list. Go to [Decompose Into Topics](#decompose-into-topics). |

## Gate Rules

The user answers at four gates only. Everything between gates runs without questions.

| Gate | When | Question |
|---|---|---|
| 1 | Before planning | Topic set, base branch, number of planning agents |
| 2 | After `run` prepares a wave | Approve every topic plan and start N implementation agents (covers later waves) |
| 3 | After every topic is `verified` | Push branches and create PRs; seal and integration verify follow automatically |
| 4 | After `integration_verified` | Merge the sealed PRs in order |

For every gate and every menu in this skill:
1. Print the context as markdown first (table of topics, counts, paths). Put the key fact in the option `description` too; some terminals hide prose behind the picker.
2. Call AskUserQuestion exactly once. 2–4 options, recommended option first with " (Recommended)". Do not add an "Other" option; the tool adds it. The user's edits arrive through Other.
3. Never ask in plain text. Never pick for the user. Stop and wait.
4. Before any gate that starts agents, state the agent count in one line.

## Start: No Arguments

1. Run `xm batch list --json`.
2. Resumable rows have `active: true` and `topic_count > 0`. A row with `topic_count: 0` is an abandoned `init`: show it in the table as `비어 있음` and never offer it for resume. If any resumable row exists, print the batches as a table (id, status, topics, updated). Rows with `status: unreadable` go in the table with their `error`. Ask once:
   - `<id> 이어하기 (Recommended)` — the most recent active batch; description: its status and next step.
   - A second active batch, if one exists.
   - `새 batch 시작`
   Resuming goes to [Drive the Lifecycle](#drive-the-lifecycle). `새 batch 시작` continues with step 3.
3. Run `xm batch candidates --json`.
   - Print `excluded` as one line, e.g. `제외된 plan: incomplete 2, registered 1`. Print each `warnings[]` line.
   - **No candidates:** collect the feature list (step 4).
   - **One or more candidates:** ask the source once. Options: `기능 목록 입력 (Recommended)` — description "기능을 나열하면 topic으로 묶고 topic마다 plan을 만듭니다"; `저장된 plan 선택` — description "실행 가능한 plan N개 중에서 고릅니다".
4. Collect the feature list. Ask once: question `이번 batch로 만들 기능을 Other 칸에 한 줄에 하나씩 적어 주세요.`; options `다음 메시지로 보내기` (description "이 질문을 닫고 다음 메시지에 기능 목록 작성"), `취소`. Text in Other is the list. If the user picks `다음 메시지로 보내기`, reply `기능 목록을 다음 메시지로 보내 주세요.` and stop; treat the next message as the list. `취소` stops.
5. Pick saved plans (when chosen). Print every candidate as a table: number, goal, created_at, task_count, `expected_files_complete`, path. Ask once with `multiSelect: true`. Options are the four newest candidates (label: goal, shortened to 40 characters; description: number, date, task count). Other takes more numbers, e.g. `5, 7`. Each chosen plan is one topic; the topic id is a slug of its goal. Saved plans are already executable, so no planning agent runs. Ask Gate 1 with the topic table (topic, goal, `expected_files`, base) and options `승인하고 등록 (Recommended)` (description "plan 에이전트 없이 바로 등록"), `취소`. Then go to [Register](#register).

A batch uses one source. Do not mix saved plans and new features in one batch.

## Decompose Into Topics

Group the features into topics before any agent runs. Read enough of the repository (file layout, entry points) to estimate each feature's files.

- One topic is one reviewable PR. Features that touch the same files belong to the same topic.
- No topic may depend on another topic in this batch. If feature B needs feature A, put both in one topic, or move B to a later batch and mark it in the table as `다음 batch`.
- Topic ids: short slugs (`auth-api`, `search-ui`). Batch id: `<yyyymmdd>-<slug>`; if `xm batch list --json` already has it, append `-2`, `-3`.
- Base branch: `develop` if `git rev-parse --verify --quiet refs/heads/develop` or `refs/remotes/origin/develop` succeeds, else `main`, else `master`.
- More than 6 topics is a smell. Say so in the table note; the scheduler still serializes overlapping topics into later waves.

**Gate 1.** Print:

```markdown
| topic | 포함 기능 | 예상 파일 범위 |
|-------|-----------|----------------|
| auth-api | 로그인 API, 토큰 갱신 | src/auth/** |
| search-ui | 검색 화면 | src/search/** |

- batch: 20261001-auth-search · base: develop
- 다음 batch로 미룬 기능: (없음)
- 다음 단계: topic마다 plan 에이전트 1개, 총 2개
```

Options: `승인하고 plan 작성 (Recommended)` (description "plan 에이전트 N개 실행"), `취소`. Edits through Other: apply them, print the table again, and ask Gate 1 again (at most twice; then stop and ask for an explicit list).

## Plan Each Topic

Announce `plan 에이전트 N개 실행` in one line. Then call the Agent tool once per topic, all in one message, `subagent_type: "general-purpose"`, `run_in_background: true`, no `model` parameter (planning needs repository reasoning; never haiku). Wait for every completion notification before continuing.

Planning agent prompt (fill every `<…>`):

```text
You are planning one topic of an xm batch. Do not edit source files.
Repository root: <absolute repo root>
Topic: <topic-id>
Features:
<one bullet per feature>
Estimated scope (verify against the code): <paths>
Constraint: this topic must be implementable and mergeable without the other topics in the batch.

Use the Skill tool to invoke `xm:plan` in Standard mode for these features. Run every `xm plan` command from the repository root. The first persist adds `--output .xm/plan/<batch-id>-<topic-id>`; every later persist uses `--session <batch-id>-<topic-id>` instead.
You cannot ask the user anything. Resolve discoverable and safe_default questions from repository evidence. For user_owned or blocking_unknown questions, persist the incomplete session (questions.json) and stop; do not guess to make the plan executable.

Your final message must be only this JSON:
{"topic":"<topic-id>","envelope":"<absolute path to envelope.json or null>","session":"<run-id or null>","executable":true|false,"questions":[{"id":"q1","question":"…","options":["…","…"]}],"note":"<one line>"}
```

After all agents return:
1. Run `xm batch candidates --json`. A topic is ready only when its `envelope` path appears in `candidates`. Trust this list over the agent's own `executable` claim.
2. For each topic that has `questions`: print the topic name and why each question matters, then ask once with up to 3 questions (one AskUserQuestion call per topic; 2–4 options each, from the agent's options). Send the answers to that agent with SendMessage: `Continue the same xm:plan session (--session <run-id>) with these answers, persist, and return the same JSON.` Do this round once per topic.
3. Re-run `xm batch candidates --json`. Topics still missing are dropped: list them with the reason (`questions unresolved`, `plan not executable`) and the session path so the user can finish them with /xm:plan.
4. No ready topic → report and stop.

## Register

Run only after every kept topic's plan is final. `batch add` pins each plan file by sha256; if the file changes later, every batch command blocks with `plan source changed after registration`. Never re-run `xm plan --output` on a registered name.

```bash
xm batch init <batch-id> --json
xm batch add <batch-id> <topic-id> --plan <envelope path> --json   # once per topic
xm batch plan <batch-id> --json
```

Show the waves from `schedule.waves` (e.g. `wave 1: auth-api, search-ui (parallel)`). Then continue with the lifecycle.

## Drive the Lifecycle

Loop: run `xm batch status <batch-id> --json`, decide the next action, run it, repeat. Stop at a gate, a failure menu, or a terminal state. The JSON carries `topics[]` (with `runtime` and `publication`), `schedule`, `execution` (`base_ref`, `wave`), `seal`, `integration`, and `merge`.

**While every topic status is `pending`, `preparing`, `blocked`, `awaiting_approval`, `prepared`, or `verified`, decide by topic statuses** (`topics[].status`), checked in this order. The batch-level `status` is ambiguous here: a verified wave 1 next to a prepared wave 2 reads `partially_verified`. As soon as any topic is `published` or `merged`, use the second table.

| Topic statuses | Action |
|---|---|
| no topics | Report `batch has no topics` and stop. Start a new batch instead |
| any `blocked` | [Failure Menu](#failure-menu) |
| any `awaiting_approval` | Gate 2 (skip it when this conversation already answered Gate 2 for this batch), then `xm batch approve <batch-id> --json`, then [Implementation Agents](#implementation-agents) |
| any `prepared` | If this conversation started agents for them, wait for the notifications. Otherwise start agents from the `prepared` handoffs in `xm batch resume <batch-id> --json`. Then `xm batch collect <batch-id> --json` |
| any `pending` or `preparing` | `xm batch run <batch-id> --json`; add `--base <base>` only when `execution` is null |
| all `verified` | Gate 3 |

**Once any topic is `published` or `merged`, decide by the batch `status`:**

| status | Action |
|---|---|
| `partially_published` | Some pushes or PRs failed → [Failure Menu](#failure-menu). Retrying runs `publish --yes`, so it needs a Gate 3 answer in this conversation |
| `published` | `git fetch <remote> <execution.base_ref>` (remote from `topics[].publication.remote`), then `xm batch seal <batch-id> --json` |
| `sealed` | `xm batch verify <batch-id> --json` |
| `integration_verified` | Gate 4 |
| `merge_pending` | A merge queue or required check still runs. Without a Gate 4 answer in this conversation, ask Gate 4 first; then `xm batch merge <batch-id> --yes --json` confirms the pending PR and continues |
| `merged` | [Final Report](#final-report) |
| `integration_failed`, `integration_paused`, `merge_blocked`, `merge_partial`, `unreadable` | [Failure Menu](#failure-menu) |

**Gate 2.** After `run`, every topic in the wave is `awaiting_approval` with a passing `plan-check`. Print one row per topic (topic, branch, worktree path, `runtime.plan_check`) and the remaining waves from `schedule.waves`. Options: `승인하고 구현 시작 (Recommended)` (description "구현 에이전트 N개 실행, 이후 wave M개 topic 포함"), `중단 (상태 유지)`.

**Gate 3.** Run `xm batch publish <batch-id> --dry-run --json`. Print one row per topic: branch → base, PR title, remote. Options: `push하고 PR 생성 (Recommended)` (description "PR N개 생성 후 seal과 통합 검증(검증 명령, release gate-panel 리뷰)까지 자동 진행"), `중단 (상태 유지)`. On approval: `xm batch publish <batch-id> --yes --json`, then continue the loop (fetch, seal, verify).

**Gate 4.** Run `xm batch merge <batch-id> --dry-run --json`. Print the merge order: order, topic, PR number, sealed head (short), expected tree (short). Options: `merge 진행 (Recommended)` (description "PR N개를 순서대로 merge하고 최종 tree를 확인"), `중단 (상태 유지)`. On approval: `xm batch merge <batch-id> --yes --json`.

`중단 (상태 유지)` at any gate: print `/xm:batch <batch-id>로 이어서 진행할 수 있습니다.` and stop. The manifest keeps the state.

## Implementation Agents

`xm batch approve` (and `xm batch resume`) returns `topics[]` handoffs. Start one agent per handoff whose `status` is `prepared`: announce `구현 에이전트 N개 실행`, then one Agent call per topic in one message, `subagent_type: "general-purpose"`, `run_in_background: true`, no `model` parameter (code generation; never haiku). Wait for every notification, then run `xm batch collect <batch-id> --json`.

Implementation agent prompt (fill from the handoff):

```text
You implement one topic of an xm batch inside its own git worktree.
Topic: <id>   Project: <project>   Branch: <branch>   Base: <base_ref> @ <base_sha>
Worktree: <cwd>

Run EVERY Bash command in this exact form (the Bash tool starts a fresh shell each call):
  cd '<cwd>' && X_BUILD_ROOT='<env.X_BUILD_ROOT>' X_PANEL_ROOT='<env.X_PANEL_ROOT>' XM_ROOT='<env.XM_ROOT>' <command>

Loop:
1. Run `xm build run-status --project <project> --json`. If `all_done` is true, go to step 4. Otherwise run `xm build run --project <project> --json`; it returns the next tasks, each with prompt, expected_files, task_check_command, on_complete, and on_fail. If it returns no task while `all_done` is false, report the run-status JSON as a failure and stop.
2. For each task, in order:
   a. Implement it. Edit only files inside the worktree, within the task's expected_files. Files that were untracked before your first task (for example a lockfile that the worktree bootstrap created) are not your work: never commit them.
   b. Commit only the task's files: git add -A -- <each path in expected_files> && git commit -m "<task id>: <task name>". If expected_files is empty, name each path you edited instead; never stage `.` or run `git add -A` without paths.
   c. Run task_check_command. If it starts with `x-build `, run it as `xm build ` plus the rest; the `x-build` binary is usually not on PATH. If it fails, fix, commit, and re-run (at most 2 fix attempts). If it still fails, run on_fail and go to step 4.
   d. Run on_complete.
3. Go to step 1.
4. Run `xm build run-status --project <project> --json`, then `git status --porcelain`. Nothing may be uncommitted outside .xm/, TASK-CONTEXT.md, and the files that were untracked before your first task.

Never: push, create PRs, run any `xm batch` command, start agents, edit outside the worktree, or rewrite existing commits.
Your final message must be only this JSON:
{"topic":"<id>","status":"done|failed","commits":<n>,"failed_tasks":["<task id>"],"note":"<one line>"}
```

Commit before `task_check_command`: `collect` re-runs every task check on the final HEAD and `publish` requires a clean worktree, so uncommitted work fails both. Stage only the task's files: `collect` and `publish` reject any committed file outside the topic's `expected_files` with `scope_drift`. Untracked files that the worktree bootstrap left (`runtime.bootstrap_untracked`) do not count against a clean worktree.

## Failure Menu

Print, per failing topic: id, status, `runtime.stage`, `runtime.last_error.code`, `runtime.last_error.message`, and each `runtime.recover[]` command. For integration and merge failures, print `integration.last_error`, `integration.recover`, or `merge.error` from `xm batch status <batch-id> --json`. Then ask once:

- `재시도 (Recommended)` — `xm batch resume <batch-id> --json` for `blocked` topics (it retries only blocked topics and returns current handoffs); otherwise re-run the command of the stage that failed (`collect`, `publish --yes`, `verify`, or `merge --yes`). A `--yes` retry counts as that gate's answer only when the user picked this option.
- `중단 (상태 유지)` — stop; the state stays for `/xm:batch <batch-id>`.

`scope_drift` lists committed files outside the plan. For a file listed in `runtime.bootstrap_untracked`, `재시도` runs `git rm --cached -- <file>` and `git commit -m "chore: drop worktree bootstrap file"` in the topic worktree (same `cd` and env prefix as the agent), then re-runs `collect`. Any other file is a scope decision: show it, offer only `중단 (상태 유지)`, and let the user re-plan the topic or remove the file.

Run a `recover[]` command only after printing it and only when its `safety` is `safe`. A paused integration merge (`integration_paused`) needs conflict resolution in the integration worktree; report it and stop unless the user explicitly asks you to resolve it. Never delete `.xm/batches/<id>/` files to get past a failure.

## Final Report

Report in Korean, result first:
- PRs merged, in order, with numbers and URLs.
- Final base commit and that its tree matches the verified integration tree.
- Topics dropped or deferred to a later batch, with reasons.
- Files to clean up are not deleted automatically: list the topic worktree paths.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The feature list is clear, so I can skip Gate 1 and start planning." | Gate 1 fixes the PR boundaries and starts N paid agents. A wrong grouping costs a full plan-and-implement cycle per topic. Ask once. |
| "Feature B needs A, but I'll register B with `--depends-on` anyway." | `publish` refuses dependent topics, so the batch stalls after implementation. Merge A and B into one topic or defer B. |
| "The planning agent said `executable: true`, so the plan is ready." | Only `xm batch candidates --json` is authoritative. An agent can report success for a plan the validator rejects. |
| "I'll fix a typo in a registered plan file." | The plan is sha-pinned. Any byte change blocks every batch command. Plans are final before `batch add`. |
| "`git add -A` is simpler than listing the task's files." | It also stages files the worktree bootstrap created, such as a fresh lockfile, and every topic PR then carries them. `collect` rejects that as `scope_drift`. Stage the task's `expected_files` only. |
| "Committing after task-check keeps commits tidy." | The check's fingerprint is bound to HEAD. Commit first, then check; `collect` re-checks the final HEAD anyway. |
| "The user approved the batch, so publish and merge need no question." | Gates 3 and 4 change GitHub state. Earlier approval does not cover them. |
| "A topic failed; I'll delete its receipt and re-run." | Receipts are the evidence chain. Use `resume` and the `recover[]` commands; deleting state hides the failure. |
| "Each topic agent can fan out its own agents for speed." | v1 parallelizes across topics only. Nested fan-out multiplies cost and breaks the single-writer worktree. |

## Red Flags

- An AskUserQuestion outside the four gates, the start questions, a planning question round, or the failure menu.
- An Agent call with `model: "haiku"`, or one agent per task instead of one per topic.
- A Bash command for a topic that does not start with `cd '<cwd>' &&`.
- `xm batch publish --yes` or `xm batch merge --yes` without the matching gate answer in this conversation.

## Verification

- After Register: `xm batch status <batch-id> --json` shows every kept topic and a non-null `schedule`.
- After implementation: `xm batch collect <batch-id> --json` reports `ok: true` for every topic before Gate 3.
- After merge: `xm batch status <batch-id> --json` shows `merged`, and the final report quotes `final.tree_oid` equal to the integration `tree_oid`.
