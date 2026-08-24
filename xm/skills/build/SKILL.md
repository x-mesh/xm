---
name: build
description: Repository-grounded planning with native execution and existing checks by default; legacy phase, worktree, and gate workflows are explicit opt-ins
allowed-tools:
  - AskUserQuestion
---

# x-build — Evidence → Plan → Native Execute

## Purpose

x-build의 기본 경로는 저장소 근거를 조사하고, 하나의 실행 가능한 계획을 만든 뒤, host native agent로 실행하고 기존 검증 명령을 수행하는 것입니다. 별도 project lifecycle, task database, worktree, meta-gate는 기본 경로에 포함하지 않습니다.

## Use When

- 사용자가 여러 파일이나 단계가 필요한 변경을 구현해 달라고 요청합니다.
- 구현 전에 저장소 조사와 명시적인 계획이 필요합니다.
- 사용자가 `build me ...` 또는 목표만 제시합니다.
- 사용자가 명시적으로 legacy `xm build` 명령을 요청합니다.

## Do Not Use When

- 한 파일의 명확한 소규모 수정처럼 별도 계획이 필요하지 않습니다.
- plan만 요청한 경우에는 x-plan을 사용합니다.
- Git 작업만 요청한 경우에는 git-kit을 사용합니다.

## Default Workflow

bare goal이나 `build me` 요청에는 다음 순서만 사용합니다.

1. 관련 코드 경로, public contract, 기존 구현, 관례, 테스트와 검증 명령을 조사합니다.
2. 사용자가 요청한 방법이 실제 목표를 달성하는지, 기능이 이미 있는지, 더 단순한 방법이 같은 결과를 내는지 판단합니다.
3. 하나의 짧은 실행 계획을 제시합니다. 각 task에는 목적, 예상 수정 파일, 실제 dependency, done criteria와 검증 명령만 포함합니다.
4. 방향 승인이 필요한 규모라면 계획을 보여주고 한 번만 승인받습니다. 저장소에서 확인할 수 있는 사실을 묻지 않습니다.
5. 승인된 task는 순차적으로 host native agent에 실행하는 것이 기본입니다. 독립성이 확인되고 예상 시간 절감이 orchestration 비용보다 클 때만 병렬화합니다.
6. 변경 때문에 실패할 수 있는 가장 가까운 기존 검증만 선택합니다. test, lint, build, review를 고정 checklist로 모두 실행하지 않습니다.
7. 확인된 결과, 실행하지 못한 검증과 남은 제한만 보고합니다.

기본 경로에서는 `.xm/build` project, phase state, PRD 복제본, task status, `run`, `task-check`, `review-group`, `group-check`, circuit breaker, forecast 또는 lifecycle quality gate를 만들거나 호출하지 않습니다.

## Execution Principles

### Smallest sufficient change

- 실제 목표를 충족하는 가장 작은 변경을 선택합니다.
- 요청하지 않은 abstraction, compatibility layer, configuration, telemetry, state tracking 또는 문서를 미리 추가하지 않습니다.
- 단순한 문제를 framework나 workflow로 확대하지 않습니다.
- 측정하지 않은 품질, 안전성 또는 성능 개선을 주장하지 않습니다.

### Fallbacks require evidence

fallback은 다음 조건을 모두 만족할 때만 추가합니다.

1. primary 경로에 구체적이고 현실적인 실패 조건이 확인됐습니다.
2. 명확히 실패시키는 것보다 fallback이 사용자 목표에 더 적합한 이유가 있습니다.
3. fallback이 실행됐다는 사실을 결과나 로그에서 확인할 수 있습니다.
4. primary와 fallback의 동작 차이가 명시돼 있습니다.
5. 두 경로를 각각 테스트할 수 있습니다.

조건이 부족하면 명확히 실패합니다. broad catch, 빈 결과 또는 임의 기본값으로 실패를 성공처럼 숨기지 않습니다.

### The request is also a hypothesis

- 요청한 방법이 underlying goal을 달성하는지 확인합니다.
- 기존 기능이나 더 단순한 대안이 있는지 먼저 조사합니다.
- 비용과 복잡도가 기대 효과보다 큰지 판단합니다.
- 보안, 데이터 손실, 호환성 또는 운영 위험을 불필요하게 높이면 그대로 구현하지 않습니다.
- 전제가 약하면 확인한 근거와 가장 저렴한 적정 대안을 제시합니다.
- 요구가 타당하면 추가 의식 없이 실행합니다.

### Validation over ritual

- 먼저 변경으로 인해 깨질 수 있는 동작을 식별합니다. 이를 직접 확인하는 가장 작고 관련성 높은 기존 검증만 실행합니다.
- test는 동작이나 회귀 위험이 있을 때, lint는 해당 파일에 적용되는 정적 규칙 위험이 있을 때, build는 compile/type/bundle/package 경계를 바꿀 때만 실행합니다.
- review는 사용자가 요청했거나 보안, 데이터 손실, migration, concurrency, public API 또는 넓은 diff처럼 재검토할 실질적 위험이 있을 때만 수행합니다.
- 관련 검증이 없거나 실행 가치가 없으면 생략하고 이유를 보고합니다. test, lint, build, review를 의식적으로 전부 실행하지 않습니다.
- 새 gate는 기존 검증이 놓치는 구체적인 실패를 대상으로 하고 고유 적발 효과를 측정할 수 있을 때만 제안합니다.
- 문제가 재현되지 않거나 더 단순한 방법이 목표를 달성하거나 성공을 관측할 수 없으면 작업을 축소하거나 중단합니다.

## Planning Contract

- 기본 planning은 x-plan Standard의 inspect → clarify → draft → critique → finalize 방식을 따릅니다.
- Quick은 사용자가 명시적으로 요청할 때만 사용합니다.
- 질문은 user-owned blocker로 제한하며 최대 3개를 한 번에 묻습니다.
- 계획은 확인된 경로, API와 검증 명령만 사용합니다. 추측으로 executable 상태를 만들지 않습니다.
- plan artifact가 필요하면 x-plan의 `.xm/plan` 저장만 사용합니다. 같은 내용을 `.xm/build`에 복제하지 않습니다.

## Native Execution Contract

- agent batch 전에 실제 사용할 model과 task 수를 한 줄로 알립니다.
- task prompt에 Execution Principles와 task-specific done criteria를 포함합니다.
- 순차 실행이 기본입니다. 병렬 실행은 예상 수정 파일, 공유 상태, dependency와 검증 환경이 모두 독립적이고 측정 가능한 시간 이득이 예상될 때만 허용합니다.
- 병렬화를 위해 task를 억지로 분해하거나 worktree를 만들지 않습니다.
- agent의 완료 주장을 그대로 신뢰하지 않고 변경 파일과 기존 검증 결과를 확인합니다.
- native 실행 실패 시 임의로 legacy harness로 fallback하지 않습니다. 실패 원인을 보고하고 같은 native 경로에서 수정하거나 사용자 결정을 요청합니다.

## Explicit Legacy Opt-In

기존 CLI는 호환성을 위해 남아 있지만 사용자가 명령이나 기능을 명시한 경우에만 실행합니다.

- `xm build init|status|next|research|legacy-plan|phase|gate|tasks|steps|run|quality|close`
- `xm build run --worktrees`
- `xm build task-check|review-group|group-check`
- forecast, effectiveness, export와 기타 분석 명령

legacy 명령은 요청한 명령까지만 실행합니다. 다음 phase, gate 또는 worktree workflow를 자동으로 연결하지 않습니다.

### Worktree execution

Legacy experimental opt-in only입니다. 사용자가 worktree 실행을 명시했을 때만 사용합니다. 측정된 작은 task에서는 pass-rate 향상 없이 overhead가 발생했음을 밝힙니다. 쓰기 범위가 불확실하면 worktree 병렬화를 추측하지 않고 native sequential 실행을 제안합니다.

## Routing

- no arguments: 사용자가 달성하려는 목표를 한 문장으로 묻습니다.
- bare goal / `build me ...`: Default Workflow를 실행합니다.
- `plan ...`: x-plan과 동일한 engine으로 계획을 만들어 `.xm/plan`에 저장하고, 계획이 executable이면 현재 프로젝트로 자동 import해 PRD·task·step을 생성합니다. draft이면 import하지 않고 이유를 알립니다. 이 alias는 deprecated이며 새 사용자는 `xm plan`을 사용합니다.
- `legacy-plan ...`: 기존 x-build PRD·task·phase planner를 명시적으로 실행합니다.
- 명시적인 legacy subcommand: 해당 `xm build` 명령만 실행합니다.
- 병렬 실행, `worktree`, `task-check`, `review-group`, `group-check`는 명시적 요청이나 위의 독립성·효용 조건 없이는 자동 선택하지 않습니다.

## Model Disclosure

native agent batch 전에 실제 model을 알립니다. 여러 model이면 task별로 구분합니다. model을 확인할 수 없으면 추측하지 말고 provider default라고 표시합니다.

### Korean output style (avoid AI-slop)

Universal (both modes):
- Drop empty intensifiers ("매우 / 완벽하게 / 강력한 / 원활하게 / 혁신적인") unless they carry a specific, real claim.
- No forced rule-of-three or "~뿐만 아니라 ~까지" balance that adds no fact.
- No hedged non-conclusions ("결국 상황에 따라 다르다 / 균형이 필요하다"). End on a concrete fact, number, or next action.

Developer mode: terse and direct — lead with the result; state findings/actions without a 권고형 결말 pile-up.
Easy/normal mode: accessible Korean, polite guidance, and short explanations for unfamiliar terms. Keep commands, flags, paths, and proper nouns in English.

## References

legacy CLI의 정확한 명령과 JSON contract가 필요할 때만 다음 문서를 읽습니다.

- `references/commands.md`
- `references/cli-skill-protocol.md`
- `references/environment-detection.md`

## Codex Runtime Mapping

- `$ARGUMENTS`는 현재 skill mention 뒤의 사용자 입력입니다.
- Default Workflow 실행은 Codex native subagent 또는 `codex exec`를 사용합니다.
- plan은 x-plan skill을 사용하고, legacy CLI는 `xm build <command>`를 그대로 호출합니다.
- user-owned blocker와 방향 승인만 structured user-input을 사용합니다.
