# x-build worktree pipeline plan

> **검증 이력 (2026-07-02)**: 로컬 gk v0.106.0에서 gate 계약 전체(`--gate`/`--gate-phase`/`--gate-timeout`/`--gate-keep-patch`/`--panel-review`/`--resume-accept`) 실측 확인. codex 교차검증으로 3가지 보정 반영 — (1) root env 주입 계약(`X_BUILD_ROOT`/`X_PANEL_ROOT`) 신설, (2) gate-panel에 `--project` 필수화, (3) task-context 위치를 `.xm/` 밖으로 이동 + canonical 규칙. 추가로 finish 직렬화, `expected_files[]` 스키마, gate policy 보강(`block_contested`/transient 재시도), 실행 모드 결정 흐름을 반영했다.

## 한 줄 요약
`xm`은 PRD와 task DAG를 기준으로 병렬 가능한 feature 작업을 나누고, 각 작업을 `gk` worktree에 배치한 뒤, feature 단위 `xm build gate-panel`을 통과한 것만 `develop`에 모으는 orchestration layer가 된다. git/worktree/merge의 정확성은 `gk`에 위임하고, panel verdict를 merge-blocking policy로 바꾸는 책임은 `xm`이 가진다.

## 목표
- build 단계에서 만든 PRD와 task breakdown을 여러 feature worktree로 병렬 실행한다.
- 각 feature는 독립 worktree, 독립 branch, 독립 agent context를 갖는다.
- 완료된 feature는 `develop` merge 전에 `xm build gate-panel` review policy를 통과해야 한다.
- `develop`에는 통과한 feature만 누적하고, release 전에는 `main...develop` batch review를 다시 수행한다.
- 실패한 feature는 worktree를 보존해서 수정/재검토할 수 있게 한다.

## 비목표
- `xm`이 raw git merge, worktree cleanup, branch parent bookkeeping을 직접 구현하지 않는다.
- 여러 feature가 같은 파일을 수정하는 상황을 무리하게 자동 병렬화하지 않는다.
- `develop` merge 후 실패한 integration을 자동 revert하지 않는다. 증거와 복구 명령을 남기고 멈춘다.

## 권장 파이프라인
```text
main
  -> develop
      -> feat/task-a
      -> feat/task-b
      -> feat/task-c
```

1. `xm build`가 PRD와 task DAG를 만든다.
2. 병렬 가능한 ready tasks만 선택한다.
3. task마다 `gk worktree acquire --from develop`로 feature worktree를 만든다.
4. 각 worktree에서 agent가 구현과 local verification을 수행한다.
5. 완료 시 feature patch를 `xm build gate-panel`로 검증한다. 이 wrapper가 내부에서 `xm panel`을 실행하고, panel verdict를 gate exit code로 변환한다.
6. 통과한 feature만 `gk worktree finish --to develop`로 merge한다.
7. `develop`에 여러 feature가 모이면 release 전 `xm build review-integration`으로 batch integration review를 수행한다.

## CLI 제안
초기에는 dry-run과 manual handoff를 먼저 만든다.

```bash
xm build run --worktrees --base develop --gate panel --dry-run
```

자동 실행 단계:

```bash
xm build run \
  --worktrees \
  --base develop \
  --gate panel \
  --max-parallel 4 \
  --branch-prefix feat/ \
  --cleanup
```

운영 보조:

```bash
xm build worktrees status --json
xm build worktrees resume
xm build worktrees cleanup --merged
xm build gate-panel --project <project> --task T-003 --phase before --patch /tmp/gk-gate.patch --json
xm build review-integration --base main --target develop --json
```

## gk 호출 계약
> **구현 상태: gk v0.106.0에서 아래 계약이 전부 출하됨.** feature/명세가 아니라 실제 shipped 동작이다.

`xm`은 git 작업마다 `gk`를 agent mode로 호출한다.

```bash
GK_AGENT=1 git-kit worktree acquire <branch> --from develop
```

feature 완료:

```bash
GK_AGENT=1 git-kit worktree finish \
  --to develop \
  --gate "xm build gate-panel --project <project> --task T-003 --phase {phase} --patch {patch} --json" \
  --gate-phase before \
  --cleanup
```

gk template 변수에 `{project}`는 없으므로, xm이 fan-out 시점에 project 이름을 리터럴로 박아 gate command 문자열을 조립한다. `--project`가 필수인 이유: x-build CLI는 multi-active workspace에서 모든 write가 `findCurrentProject()`로 수렴하는 문제를 이미 경고하고 있어(`x-build-cli.mjs:45-46`), project를 명시하지 않으면 gate 결과가 엉뚱한 프로젝트에 기록될 수 있다.

`gk --panel-review`는 `xm panel {patch} --json`의 축약 alias지만, x-build 자동 gate에는 쓰지 않는다. `gk`는 gate command의 exit code만 보는데, `xm panel --json`은 panel 실행 실패와 verdict 실패를 같은 의미로 만들지 않는다. x-build는 `xm build gate-panel` wrapper로 verdict policy를 exit code로 바꿔야 한다.

```bash
GK_AGENT=1 git-kit worktree finish --to develop --panel-review --gate-phase before --cleanup
```

위 명령은 수동 smoke review에는 유용하지만, "findings가 있으면 merge 차단"이라는 자동 gate 계약은 제공하지 않는다.

integration까지 확인하는 고신뢰 모드:

```bash
GK_AGENT=1 git-kit worktree finish \
  --to develop \
  --gate "xm build gate-panel --project <project> --task T-003 --phase {phase} --patch {patch} --json" \
  --gate-phase both \
  --cleanup
```

### finish 결과 envelope (agent mode)
`state`로 분기한다. `result.gate`가 gate 결과를 싣는다.

**2026-07-02 실측 보정 (v0.106.0)** — 계약 문서와 실제 출력의 차이 3가지, xm 파서는 이에 맞춰 구현됨:
- before gate 실패 시 `result.gate`는 **null**이고 gate exit code는 `error.message` 텍스트(`"... (exit 2)"`)에만 있다 — exit 1/2 구분(NEEDS_FIX vs BLOCKED)은 message 파싱으로.
- envelope 스트림이 케이스별로 다르다: `ok`/`paused`는 stdout, `blocked`는 **stderr**. paused 런은 stderr에 사람용 promote 진행 텍스트가 함께 나온다 — 파서는 두 스트림 모두 probe하고 혼합 스트림에서 JSON을 추출해야 한다.
- gate 자식 프로세스는 호출자 environ을 상속하고 cwd는 worktree다 (env 주입 유효).

- **성공**: `state:"ok"`, `result.gate = {phase, before, after, merged:true, run_id}` (before/after ∈ `passed|failed|skipped`).
- **before gate 실패**: `state:"blocked"` (exit 1), `error.code:"worktree_gate_before_failed"`, target 무변경. merge 안 됨.
- **after gate 실패**: `state:"paused"` (exit 3), `result.gate.{paused:true, merged:true, patch, recover[]}`. merge는 유지, cleanup 보류. `recover[]`는 resume/abort 쌍:
  - `[safe] git-kit worktree finish --to <base> --resume-accept [--cleanup ...]` — gate 결과 수용 후 마무리.
  - `[destructive] git -C <path> reset --hard <before>` 또는 `git update-ref refs/heads/<base> <before> <after>` — rewind.
- **merge conflict**: 기존 gk merge/promote pause 계약(`state:"paused"` + resume/abort remedies) 그대로.
- **lock 경합/dirty/target 미해석**: `state:"blocked"` (`worktree_gate_locked` / `worktree_gate_dirty` / `worktree_gate_no_target`).

xm은 after-gate paused를 받으면 사람이 검토 후 `--resume-accept`(수용) 또는 recover의 rewind(취소)를 실행한다. `--resume-accept`는 브랜치가 실제 target에 병합됐을 때만 cleanup하므로(미병합이면 gk가 `worktree_resume_not_merged`로 blocked) 오호출로 미병합 작업이 삭제되지 않는다.

## root env 주입 계약 (P0)
worktree 안에서 도는 모든 프로세스는 main repo의 `.xm/`을 봐야 한다. 그런데 현재 root 해석이 3계통으로 갈라져 있고, 이 중 둘은 worktree 폴백이 없다:

| 계통 | 해석 | worktree 폴백 |
|---|---|---|
| x-build core | `ROOT = X_BUILD_ROOT \|\| cwd/.xm/build` (`x-build/lib/x-build/core.mjs:30-34`) | **없음** — worktree 안에서는 항상 로컬 빈 상태를 본다 (tasks.json 접근 상실) |
| x-panel | `XM_ROOT = X_PANEL_ROOT \|\| cwd/.xm` (`x-panel/lib/x-panel/core.mjs:14-18`) | **없음** — worktree 안에서 만든 panel 아티팩트는 `--cleanup` 시 worktree와 함께 소멸 |
| shared-config | `resolveSharedRoot()`: `XM_ROOT` env → 로컬 `.xm` → main `.xm` (`x-build/lib/shared-config.mjs:56-74`) | 있음 (단, 로컬 `.xm`이 존재하면 로컬 우선) |

따라서 두 겹의 방어를 둔다:

1. **orchestrator env 주입** — worktree agent 환경과 `gk worktree finish` 호출 프로세스에 아래를 명시 설정한다. `XM_ROOT` 하나로는 안 된다 — x-build core와 x-panel은 그 변수를 읽지 않는다.

```bash
X_BUILD_ROOT=<main-repo>/.xm/build
X_PANEL_ROOT=<main-repo>/.xm
XM_ROOT=<main-repo>/.xm        # shared-config 계통용
```

2. **gate wrapper 자체 해석** — gk gate는 shell 미경유 argv 실행이다. **2026-07-02 실측(v0.106.0): gate 자식 프로세스는 호출자 environ을 상속하며 cwd는 worktree다** — env 주입 전략은 유효하다. 그래도 env가 없는 경로(수동 실행 등)에서도 동작하도록, `xm build gate-panel`은 `git rev-parse --git-common-dir`로 main repo root를 스스로 해석해 artifact 경로와 `X_PANEL_ROOT`를 설정한 뒤 `xm panel`을 실행한다.

## panel gate wrapper
`xm build gate-panel`은 x-build가 추가해야 하는 얇은 wrapper다. 이유는 명확하다: `gk` gate는 exit code만 판정하고, `xm panel --json`은 consensus findings가 있어도 정상 실행이면 exit 0으로 끝날 수 있다. 따라서 자동 merge gate에는 "panel 실행"과 "panel verdict policy"를 분리하면 안 된다.

```bash
xm build gate-panel \
  --project <project> \
  --task T-003 \
  --phase before \
  --patch /tmp/gk-gate.patch \
  --json
```

동작:
1. main repo root를 자체 해석한다(`git rev-parse --git-common-dir`) — env 미주입 상황에서도 artifact가 main `.xm/`에 남도록 (root env 주입 계약 참조).
2. `xm panel <patch> --json --source build:worktree --title "<task-id> <phase>"`를 실행한다.
3. panel JSON을 project-scoped artifact 경로에 저장한다.
4. `consensus[]`, `confirmed[]`, `unreviewed[]`, `contested[]`를 policy로 평가한다.
5. 통과면 exit 0, 차단이면 exit 1, wrapper 자체 오류면 exit 2로 종료한다. `gk` 입장에서는 1/2 모두 gate 실패지만, x-build artifact에는 원인을 구분해 남긴다.
6. exit 2 경로 중 transient 오류(provider timeout, 네트워크)는 1회 재시도한다 — panel cross의 transient-only 재시도 규칙과 동일. verdict 실패(exit 1)는 재시도하지 않는다.

기본 policy:
```json
{
  "block_confirmed": ["critical", "high", "medium"],
  "block_unreviewed": ["critical", "high"],
  "block_contested": ["critical"],
  "allow_low": true
}
```

`block_contested`가 필요한 이유: 종전 `allow_contested: true`는 severity 무관 일괄 허용이라, 한 모델이 critical로 지목하고 다른 모델이 반박한 finding이 자동 통과했다. contested critical은 사람 확인 없이 머지되면 안 된다.

task metadata에 `gate_policy` override를 허용한다. 실험적/공격적 접근이 필요한 task는 완화된 policy(예: medium 허용)로 gate를 통과시키되, override 사실을 artifact에 기록한다 — 공격성과 엄격한 gate는 상충하므로 task 단위 조절 없이는 NEEDS_FIX 반복만 늘어난다.

wrapper JSON 예:
```json
{
  "ok": false,
  "decision": "fail",
  "exit_code": 1,
  "task_id": "T-003",
  "phase": "before",
  "panel_run": "20260702-120102-123",
  "policy": {
    "block_confirmed": ["critical", "high", "medium"],
    "block_unreviewed": ["critical", "high"]
  },
  "blocking_findings": [
    {"severity": "high", "file": "src/auth.ts", "line": 42, "claim": "..."}
  ]
}
```

## task selection
`x-build`는 동시에 실행할 task를 아래 조건으로 제한한다.

- DAG dependency가 모두 완료된 ready task
- 예상 수정 파일이 겹치지 않는 task
- 같은 subsystem의 shared contract를 동시에 바꾸지 않는 task
- test fixture, generated file, lockfile처럼 충돌 가능성이 높은 파일을 공유하지 않는 task

파일 overlap을 알 수 없으면 병렬화하지 않고 순차 실행한다.

"예상 수정 파일"의 출처를 스키마로 못 박는다: 현재 tasks.json task 필드(`tasks.mjs:213-226`)에는 해당 정보가 없으므로, **plan 단계가 task별 `expected_files[]`를 tasks.json에 기록**하고 `plan-check`가 존재/형식을 검증한다. `expected_files`가 없거나 비어 있는 task는 병렬 후보에서 제외한다(위 순차 폴백 규칙 적용).

### finish 직렬화
gk gate는 target merge lock 하에서 실행되므로, panel이 도는 동안(분 단위) develop lock이 점유된다. `--max-parallel`로 여러 feature가 동시에 finish에 도달하면 나머지는 `worktree_gate_locked` blocked를 받는다. blocked-재시도 churn 대신 **xm이 finish 호출 자체를 자체 큐로 직렬화**한다(한 번에 하나). `worktree_gate_locked` 재시도는 외부 프로세스가 lock을 잡은 경우를 위한 방어용으로만 남긴다(1회, backoff).

## worktree context
각 worktree에는 task context를 plain markdown으로 남긴다.

```text
<worktree>/TASK-CONTEXT.md
```

**`.xm/` 아래 두면 안 된다** (종전안 `.xm/task-context.md`는 폐기): worktree-로컬 `.xm/`이 생기는 순간 shared-config의 `resolveSharedRoot()`가 로컬을 우선해 공유 상태 해석이 갈라진다 (root env 주입 계약 참조). branch에 커밋되지 않도록 `worktree.init` 부트스트랩 또는 `.git/info/exclude`로 제외한다.

**canonical 규칙**: 정본은 artifact 쪽 `.xm/build/projects/<project>/worktrees/<task-id>/task-context.md`다. worktree의 `TASK-CONTEXT.md`는 acquire/resume 시점에 정본에서 재생성되는 스냅샷이며, 내용 수정은 artifact에만 한다 — 두 사본이 sync 규칙 없이 공존하면 어느 쪽이 근거인지 애매해진다.

내용:

```markdown
# Task
<task id and title>

## Scope
<PRD slice>

## Done Criteria
- ...

## Expected Files
- ...

## Dependencies
- ...

## Verification
- ...
```

이 파일은 agent handoff, review, failure recovery에서 공통 근거가 된다.

## 상태 모델
x-build의 canonical task status는 현재 `pending|ready|running|completed|failed|cancelled`다. 이 plan은 1차 구현에서 core `TASK_STATES`를 늘리지 않는다. 대신 worktree-specific 상태를 artifact의 `worktree_status`로 둔다.

`tasks.json.status`:
- `running`: worktree가 살아 있고 구현/검증/review/fix/blocked 판단을 기다리는 상태
- `completed`: gate 통과 후 target merge와 cleanup/accept가 끝난 상태
- `failed`: 사람이 task를 포기하거나 terminal failure로 닫은 상태

`run.json.worktree_status`:

```text
READY -> WORKTREE_CREATED -> RUNNING -> VERIFYING -> REVIEWING -> MERGING -> DONE
                                      -> BLOCKED
                                      -> NEEDS_FIX
```

`xm build gate-panel`이 policy fail을 내면 `tasks.json.status`는 `running`으로 유지하고, `run.json.worktree_status`를 `NEEDS_FIX`로 둔다. feature worktree는 삭제하지 않는다. `run-status --json`은 이 artifact를 읽어 `worktree_tasks[]`로 노출해야 하며, `NEEDS_FIX`/`BLOCKED` task를 단순 stale RUNNING으로 되돌리면 안 된다.

### gk state → xm task state 매핑
gk finish는 `state`로 결과를 알린다. xm은 이렇게 접는다(이 매핑이 정본 — 아래 "실패 처리"·"검증 계획"도 이를 따른다):

| gk `state` | 조건 | x-build canonical / worktree status |
|---|---|---|
| `ok` | merge + gate 통과 | `completed` / `DONE` |
| `blocked` (`worktree_gate_before_failed`) | before gate 실패, target 무변경, merge 안 됨 | `running` / `NEEDS_FIX` |
| `blocked` (`worktree_gate_dirty`) | 미커밋 트리 | `running` / `NEEDS_FIX` |
| `blocked` (`worktree_gate_locked`) | target lock 경합 | `running` / `MERGING` 유지 후 재시도 |
| `blocked` (`worktree_gate_no_target`) | parent/base 미해석 | `running` / `BLOCKED` |
| `paused` (after gate 실패) | merge 유지, cleanup 보류, `recover[]` 제공 | `running` / `BLOCKED` |
| `paused` (merge conflict) | gk가 충돌로 멈춤 | `running` / `BLOCKED` |

핵심: **before 실패는 `blocked`(되돌릴 것 없음 → `NEEDS_FIX`), after 실패는 `paused`(develop이 이미 바뀜 → `BLOCKED` + 복구 결정)**. 둘 다 `tasks.json.status`를 새 enum으로 바꾸지 않고 artifact status로 표현한다.

## artifact 저장
각 task run은 project-scoped 경로 아래에 기록한다.

```text
.xm/build/projects/<project>/worktrees/<task-id>/
  run.json
  task-context.md
  panel-before.json
  panel-after.json
  patch-before.diff
  patch-after.diff
```

`run.json` 최소 필드:

```json
{
  "task_id": "T-003",
  "branch": "feat/T-003-search-index",
  "worktree": "/path/to/worktree",
  "base": "develop",
  "task_status": "running",
  "worktree_status": "RUNNING",
  "gk_runs": [],
  "panel_artifacts": [],
  "gk_gate_run_id": null,
  "last_error": null,
  "recover": []
}
```

gk도 gate run마다 자체 감사 파일을 `<git-common-dir>/gk/worktree-gate/<run-id>-<phase>.json`(linked worktree 공유)에 남기고, finish 결과 envelope의 `result.gate.run_id`로 그 id를 돌려준다. xm은 `gk_gate_run_id`로 gk 감사 레코드를 역참조하면 되고, `panel-*.json`은 xm이 직접 `xm panel`을 gate로 실행할 때의 verdict 저장용으로 유지한다(둘은 상보적: gk=merge 기준·SHA·patch 경로, xm=verdict 해석). `--gate-keep-patch`를 주면 gk가 patch 파일도 남기므로 xm이 복사 없이 참조할 수 있다.

## config 제안
```json
{
  "worktree": {
    "enabled": true,
    "base": "develop",
    "branch_prefix": "feat/",
    "max_parallel": 4,
    "gate": "panel",
    "gate_phase": "before",
    "gate_policy": {
      "block_confirmed": ["critical", "high", "medium"],
      "block_unreviewed": ["critical", "high"],
      "block_contested": ["critical"],
      "allow_low": true
    },
    "preflight": true,
    "cleanup": true
  }
}
```

`gate_phase` 기본값은 `before`다. `both`는 느리지만 integration risk가 큰 변경에 쓴다.

## 실행 모드 결정 — worktree를 쓸지 말지는 어디서 정하는가
별도 파이프라인이나 마법사를 만들지 않는다. worktree fan-out은 x-build 라이프사이클(Research→Plan→Execute→Verify→Close)의 **Execute phase 실행 백엔드**이고, 결정은 기존 컨벤션 위 3층으로 쌓는다:

| 층 | 표면 | 역할 |
|---|---|---|
| 1. config | `worktree.enabled` 등 위 config | 프로젝트 지속 정책 (model_overrides→profile 체인과 같은 위상) |
| 2. CLI 플래그 | `run --worktrees` / `--no-worktrees` | 런 단위 오버라이드. 명시되면 3층 질문 생략 |
| 3. phase gate | Execute 진입 시 기존 AskUserQuestion에 흡수 | dry-run 요약과 함께 실행 모드 확인. 새 확인 지점을 만들지 않는다 |

3층의 절반은 묻는 게 아니라 **계산**이다. worktree 모드가 의미 있는 조건(병렬 안전 ready task ≥ 2)은 DAG와 `expected_files[]`에서 기계적으로 나온다:

- 병렬 가능 task ≥ 2 AND config enabled → phase gate에서 fan-out을 추천 옵션으로 제안
- 병렬 가능 task 1개 이하 또는 overlap 정보 없음 → 묻지 않고 순차 실행, 이유 한 줄 출력
- 플래그 명시 → 묻지 않음

**dashboard는 결정 지점이 아니다.** x-dashboard는 `.xm` 상태의 read-only 뷰어로 유지하고, 역할은 실행 후 관찰(`worktree_tasks[]` 상태, gate 결과, 병합 여부)로 한정한다. 웹을 컨트롤 플레인으로 만들면 CLI/스킬/웹 3면의 상태 동기화 문제가 생기고, 개입 지점(after-gate paused의 resume-accept 등)은 어차피 터미널의 gk 명령이다.

**구동 모드 2가지**를 모두 지원한다:
- **interactive orchestrator** — `/xm:build` 세션이 worktree cwd로 subagent를 fan-out. env 주입(root env 주입 계약)은 subagent spawn 시점에 수행.
- **headless CLI** — agent 없이 사람이 각 worktree에서 작업하고, 같은 명령 표면(`worktrees status/resume`, gate-panel)으로 마무리.

### 기대 효과와 비용 (정직 버전)
- **wall-clock**: 이득은 정확히 병렬 안전 task 수에서 나오되, gate-panel(feature당 분 단위)과 finish 직렬화가 직렬 꼬리로 남는다. task 3개 × 20분 기준 순차 ~60분 → worktree ~35분 추정(3배 아님). 잘게 쪼개진 task는 acquire/컨텍스트 오버헤드 비중이 커져 오히려 손해일 수 있다.
- **공격성**: 격리가 주는 "실패해도 되는 권리"가 본질적 이득. blast radius가 branch 하나로 끝나므로 리스크 큰 접근을 시도할 수 있고, develop에는 gate 통과분만 닿는다. 단 엄격한 gate 아래서 공격적 코드는 NEEDS_FIX로 돌아오므로, task별 `gate_policy` override(panel gate wrapper 참조)와 함께 써야 실효가 있다.
- **비용**: 토큰 비용은 wall-clock과 반대로 움직인다 — 병렬 agent는 컨텍스트를 공유하지 않고 panel도 feature 수 × 모델 수만큼 돈다. 시간이 절반이어도 비용은 늘 수 있다.
- **사람 병목**: 1인 운영에서는 NEEDS_FIX 수정·paused 판단·phase 확인이 병렬 수만큼 쌓이고 이건 병렬화되지 않는다. `max_parallel`은 2~3에서 시작해 실제 개입 빈도를 보고 조정한다(4는 상한이지 기본 권장이 아니다).

## release 전 batch review
feature 단위 review는 develop에 들어갈 최소 품질 gate다. release 전에는 별도 batch review가 필요하다.

```bash
xm build review-integration --base main --target develop --json
```

내부 동작:
```bash
git diff --binary main...develop > /tmp/develop-integration.patch
xm build gate-panel --project <project> --task __integration__ --phase release --patch /tmp/develop-integration.patch --json
```

feature review는 "이 feature가 들어가도 되는가"를 본다. batch review는 "여러 feature가 함께 있을 때 깨지는가"를 본다.

세부 규칙:
- **task id 예약**: `__integration__` 접두/전용 id를 쓴다 — 사용자가 만든 실제 task id(`integration` 등)와의 네임스페이스 충돌 방지.
- **phase enum**: gate-panel의 phase는 `{before, after, release}`로 명시한다. gk `--gate-phase`의 `before|after|both`와는 별개 축(gk는 실행 시점, xm은 verdict 문맥).
- **patch 크기 가드**: feature가 쌓일수록 `main...develop` patch가 커지고 거대 patch에서 panel 품질이 떨어진다. 크기 상한을 config로 두고 초과 시 subsystem별 분할 리뷰 또는 경고 후 진행을 택한다. 상한 값은 판단으로 정하지 말고 실제 panel 런의 품질 저하 지점을 측정해서 정한다 (L9 교훈: 수치 threshold는 시뮬레이션/실측에서).

## preflight
worktree fan-out 전에 아래를 확인한다. 실패하면 worktree를 만들지 않는다.

```bash
git-kit worktree finish --help | grep -q -- --gate   # capability probe — 버전 문자열 비교(>= v0.106.0)보다 정확
xm panel doctor --json
GK_AGENT=1 git-kit context --include=precheck,remotes
```

버전 문자열 비교 대신 capability probe를 쓰는 이유: 빌드/설치 드리프트로 버전 표기와 실제 표면이 어긋날 수 있다(이 문서 검증 중에도 stale 바이너리 스냅샷으로 0.105.0이 관측된 적 있음). gate 표면 미지원이면 worktree fan-out을 실행하지 않고 **degraded 모드**로 떨어진다: xm이 gk 명령을 실행하는 대신 실행 계획만 출력하는 manual handoff. `--dry-run`은 gk gate 표면에 의존하지 않으므로 구버전에서도 동작해야 한다.

preflight 결과는 project artifact에 저장한다.

```text
.xm/build/projects/<project>/worktrees/preflight.json
```

## 실패 처리
gk `state`/`error.code` 기준(위 매핑 표):
- worktree 생성 실패: gk `error`/`blocked` → `worktree_status: BLOCKED`, gk `error.remedies[]`를 저장한다.
- agent 구현 실패: `worktree_status: NEEDS_FIX`, worktree 유지 (gk 호출 전 단계).
- local verification 실패: `worktree_status: NEEDS_FIX`, gate(finish) 호출 생략 가능.
- panel before policy fail: `xm build gate-panel` exit 1 → gk `blocked`(`worktree_gate_before_failed`) → `worktree_status: NEEDS_FIX`, merge 금지·target 무변경.
- panel wrapper/runtime failure: `xm build gate-panel` exit 2 → gk `blocked`(`worktree_gate_before_failed`) → `worktree_status: BLOCKED`, panel/gate infra 확인 필요.
- merge conflict: gk `paused`(gk merge/promote 계약) → `worktree_status: BLOCKED`, resume/abort command 저장.
- panel after 실패: gk `paused`(exit 3, `result.gate.paused`) → `worktree_status: BLOCKED`, develop 변경 상태·`result.gate.patch`·`recover[]`를 저장하고 cleanup 금지.

### NEEDS_FIX 재개와 base 드리프트
develop에 다른 feature가 누적되는 동안 NEEDS_FIX worktree는 낡아간다. gk의 target lock은 merge 시점의 textual 일관성은 보장하지만, 오래된 base 위에서 고친 코드의 semantic 충돌은 못 막는다. `xm build worktrees resume`은 re-gate 전에 develop 기준 rebase/sync 단계(`gk sync` 또는 rebase)를 수행하고, 충돌 시 gk pause 계약대로 멈춘다.

### run.json writer 소유권
`run.json`(worktree_status 포함)의 writer는 **orchestrator 단일**로 못 박는다. worktree 안 agent는 run.json을 직접 쓰지 않고, 산출물/로그로 신호를 남기면 orchestrator가 상태를 접는다. agent와 orchestrator가 같은 파일을 쓰면 동시 쓰기 clobber가 난다. 단일 writer가 어려운 지점이 생기면 append-only 이벤트 파일로 대체한다.

## 구현 단계
1. `x-build/lib/x-build/worktrees.mjs`를 추가하고 `x-build-cli.mjs`에 `worktrees`, `gate-panel`, `review-integration` command를 등록한다.
2. project-scoped artifact 경로(`.xm/build/projects/<project>/worktrees/`)와 `run.json.worktree_status` schema를 추가한다. plan 산출물에 `expected_files[]` 필드를 추가하고 `plan-check` 검증을 연결한다.
3. `xm build gate-panel` wrapper를 만든다. main root 자체 해석, `xm panel` 실행, verdict policy 평가(`--project` 필수), transient 재시도, artifact 저장, exit code 변환을 담당한다.
4. `xm build run --worktrees --dry-run`으로 ready task, 병렬 batch, branch name, expected worktree path, gk command plan만 출력한다. capability probe preflight와 degraded(manual handoff) 모드를 함께 구현한다 — dry-run은 gk gate 표면에 의존하지 않는다.
5. `worktree acquire`와 `TASK-CONTEXT.md` 생성(artifact 정본 → worktree 스냅샷), root env 주입(`X_BUILD_ROOT`/`X_PANEL_ROOT`/`XM_ROOT`)을 자동화한다.
6. 완료된 worktree를 대상으로 `gk worktree finish --gate "xm build gate-panel ..."`를 호출하는 `xm build worktrees resume`을 추가한다. finish는 자체 큐로 직렬화하고, resume은 re-gate 전 base rebase/sync를 수행한다.
7. `run-status --json`에 `worktree_tasks[]`를 추가하고, `NEEDS_FIX`/`BLOCKED` artifact를 stale RUNNING reconcile에서 보호한다.
8. `--max-parallel` 자동 실행과 Execute phase gate의 실행 모드 추천(계산된 병렬 가능 task 수 기반)을 추가한다.
9. release 전 `main...develop` batch review command를 `xm build review-integration`으로 포장한다(크기 가드 포함).

## 검증 계획
- dry-run이 gk command를 실행하지 않고 정확한 plan만 출력한다.
- branch name collision이 있으면 deterministic suffix를 붙인다.
- 파일 overlap이 있는 task는 같은 batch에 배치하지 않는다.
- `xm build gate-panel`은 confirmed high finding이 있는 panel JSON을 exit 1로 변환한다.
- `xm build gate-panel`은 panel 실행 실패를 exit 2로 변환하고 artifact에 `decision:"error"`를 남긴다.
- gk `state`가 "gk state → xm task state 매핑" 표대로 접힌다(before `blocked`→`NEEDS_FIX`, after `paused`→`BLOCKED` — 둘을 구분).
- panel before 실패 시 gk가 `blocked`를 내고 `develop` SHA가 변하지 않는다.
- panel after 실패 시 gk가 `paused`(exit 3)를 내고 cleanup이 수행되지 않으며 `result.gate.recover[]`·patch·감사 파일이 남는다.
- `--resume-accept`를 미병합 브랜치에 호출하면 gk가 `worktree_resume_not_merged`로 blocked해 worktree/branch가 삭제되지 않는다.
- `NEEDS_FIX`/`BLOCKED` worktree artifact가 있는 RUNNING task는 stale reconcile로 `pending`이 되지 않는다.
- stale RUNNING task 중 worktree artifact가 없거나 worktree/branch가 사라진 항목만 reconcile 대상이 된다.
- worktree 안에서 실행된 gate-panel이 panel/verdict artifact를 worktree-로컬이 아닌 **main repo `.xm/`**에 저장한다 (env 미주입 상황 포함 — wrapper 자체 해석 경로 검증).
- `--project`가 다른 활성 프로젝트가 2개 이상일 때 gate 결과가 지정 프로젝트에만 기록된다.
- gk state→xm 매핑은 실제 gk 없이도 검증 가능해야 한다: envelope JSON(`ok|blocked|paused` × error.code 조합)을 뱉는 **fake-gk stub**으로 매핑 표 전체를 계약 테스트한다. 실 gk 통합 검증은 별도 스모크로 분리.
- 동시 finish 2건 시나리오에서 xm 큐가 직렬 실행하고, `worktree_gate_locked`는 외부 lock 홀더 상황에서만 발생한다.
- contested critical finding이 있는 panel JSON은 exit 1로 차단된다(`block_contested`).
- transient panel 실패(timeout)는 1회 재시도 후에만 exit 2가 된다. verdict 실패는 재시도되지 않는다.

## gk 계약 (v0.106.0 구현 완료)
아래는 종전 "요구사항"이 아니라 gk v0.106.0에서 **출하된** 기능이다. xm은 이 표면에 맞춰 빌드한다. (2026-07-02 로컬 실측: `git-kit version 0.106.0`, `worktree finish --help`에서 gate 플래그 전체 확인. 단 preflight는 버전 비교가 아니라 capability probe로 — preflight 절 참조.)

- ✅ `git-kit worktree acquire <branch> --from <base>` — worktree 생성/재사용, gk-parent 기록, `worktree.init` 부트스트랩.
- ✅ `git-kit worktree finish --to <base>` — 기본 `gk promote`(로컬), `--push`면 `gk land --to`.
- ✅ generic `--gate <command-template>` — 공백 tokenize 후 각 `{token}`을 단일 argv로 치환, **shell 미경유(injection 없음)**. 정밀 제어는 반복형 `--gate-arg <token>`, `xm panel` 축약은 `--panel-review`.
- ✅ `--gate-phase before|after|both`(기본 `before`), `--gate-timeout <dur>`, `--gate-keep-patch`.
- ✅ **target branch merge lock** — `(git-common-dir + target)` 파일 lock(`<git-common-dir>/gk/locks/`). lock 하에서 target SHA를 고정한 뒤 patch를 만들어, gate가 승인한 patch와 실제 merge patch가 병렬 finish 사이에서도 일치. live holder는 `blocked`, stale은 자동 회수.
- ✅ gate template 변수: `{patch} {source} {target} {base_sha} {head_sha} {target_before_sha} {target_after_sha} {phase}`.
- ✅ agent envelope 안정화: `state` ∈ `ok|blocked|paused|error`, `result.gate.*`, `error.remedies[{command,safety}]`. before 실패=`blocked`(exit1·target 무변경), after 실패=`paused`(exit3·merge 유지·`recover[]`).
- ✅ `--resume-accept` — after-gate paused 수용(재merge 없이 cleanup). 브랜치 미병합이면 `worktree_resume_not_merged`로 blocked해 데이터 손실 방지.
- ✅ 안전 가드: `--push` + `--gate-phase after|both` 조합 거부(published 통합은 abort 불가), 미커밋 트리 `blocked`.
- ✅ gate run 감사 파일 `<git-common-dir>/gk/worktree-gate/<run-id>-<phase>.json`(linked worktree 공유, `both`는 before/after 각각).
- ⚠ `--panel-review`는 `xm panel` 실행 alias일 뿐이며, panel verdict를 merge-blocking exit code로 바꾸지는 않는다. x-build 자동 gate는 `xm build gate-panel`을 사용한다.

### xm이 아직 채워야 하는 gk 갭
- gk rollout 5단계(`gk fleet`/`gk worktree list`에 gate paused 노출)는 미구현 — xm은 당장 `result.gate.paused`/exit3와 감사 파일로 paused를 감지한다.
- release 전 batch review(`main...develop`)는 gk verb가 아니라 `xm build review-integration`이 raw `git diff --binary`로 patch를 만들고 `xm build gate-panel` policy를 적용한다.

## xm에 남는 책임
- PRD/task DAG 품질 (`expected_files[]` 포함)
- 병렬화 가능한 task 판정과 실행 모드 추천
- agent prompt와 context 생성
- worktree agent/gate 프로세스에 대한 root env 주입 (`X_BUILD_ROOT`/`X_PANEL_ROOT`/`XM_ROOT`)
- finish 호출 직렬화 큐
- `xm build gate-panel` wrapper와 panel verdict policy
- worktree artifact status와 `run-status --json` 통합
- `.xm/` artifact 저장과 recall
- develop integration review 타이밍 결정
