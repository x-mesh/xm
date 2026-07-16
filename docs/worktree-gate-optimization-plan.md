# worktree 게이트 최적화 설계 — 라운드 단축

Status: APPROVED (A/B/D/E/F/G 구현, C는 상향된 후속) · 2026-07-16
Origin: term-mesh 도그푸딩 실측 — 단일 태스크(t3)가 머지 게이트 4라운드 × 20~25분 소요.

## 1. 문제 정의

worktree 머지 게이트(gate-panel)가 수렴 루프의 이터레이터로 쓰이고 있다.
비싼 크로스벤더 패널(10~15분)이 "최종 확인"이 아니라 "지적 1건당 왕복 1회"의
디버깅 루프 역할을 하면서, 태스크당 벽시계 시간이 라운드 수에 비례해 늘어난다.

실측 (term-mesh t3): 1차 HIGH 3+3 → 2차 HIGH 3 → 3차 medium 3 → 4차 심사.
2차부터는 "직전 수정이 지적을 해소했나"만 보면 충분했지만 매 라운드 누적 diff
전체를 풀 패널로 재심사했다.

## 2. 현행 구조 (실측 facts)

| 항목 | 현행 | 근거 |
|------|------|------|
| 게이트 호출 | `gk worktree finish --gate "xm build gate-panel …" --gate-phase before` — finish/resume마다 실행 | `worktrees.mjs:526-532, 821` |
| 재라운드 비용 | 할인 없음 — 매 라운드 누적 patch 전체를 풀 패널 재심사 | `gate-panel.mjs:136-178` |
| 기본 정책 | `block_confirmed: [critical, high, medium]` — confirmed medium 1건 = 라운드 1회 추가 | `gate-panel.mjs:36-41`, `x-panel/gate.mjs:20-25` |
| 사전 수렴 | 에이전트 지침은 "quality checks" 한 줄뿐 — 저비용 셀프리뷰 단계 없음 | `worktrees.mjs:598` |
| 라운드 이력 | `panel-<phase>.json` 단일 파일 덮어쓰기 — 라운드 카운트 불가 | `gate-panel.mjs:218, 267` |
| release 모드 | **버그**: `gate_phase` enum에 `release`가 있지만 finish가 그대로 gk에 전달. gk는 `before\|after\|both`만 수용 → `release` 설정 시 게이트 깨짐 | `config-schema.mjs:333`, `worktrees.mjs:530`, gk v0.106 `--help` 실측 |
| 배치 리뷰 | `review-integration`(main…develop, phase=release, `__integration__`)은 구현·배선 완료 — per-task 생략과의 연결만 없음 | `worktrees.mjs:1137-1168`, `x-build-cli.mjs:130` |

설계 원칙: **수렴은 싸게, 확인은 비싸게 1회.** stale-결과 폐기와 side-effect
직렬화를 분리했듯, "지적 발견"(수렴 루프)과 "머지 판정"(게이트)을 분리한다.

## 3. 개선안

### A — 페이즈별 정책 오버레이 + 기본 완화 (S)

**Schema**: `gate_policy`에 선택적 페이즈 오버레이 키(`before`/`after`/`release`)를
추가한다. 각 오버레이는 부분 정책이며 flat base 위에 per-key로 얹힌다.

```jsonc
{
  "block_confirmed": ["critical", "high"],          // flat base (모든 phase)
  "block_unreviewed": ["critical", "high"],
  "block_contested": ["critical"],
  "allow_low": true,
  "release": { "block_confirmed": ["critical", "high", "medium"] }  // phase overlay
}
```

**해석 순서** (per-key shallow, 낮→높):
`DEFAULT_POLICY` flat → config flat → config[phase] → task.gate_policy flat → task.gate_policy[phase]

**새 기본값**: per-task 게이트(before/after)는 critical/high만 블로킹.
release 오버레이가 medium을 다시 블로킹에 포함 — medium은 릴리스 전 통합
리뷰에서 잡는다.

근거: term-mesh 실측에서 4라운드 중 후반 라운드가 medium-only 블로킹으로
연장됐고, medium 지적은 "머지 금지"보다 "릴리스 전 처리"가 비용 대비 적정.
(실측 1건 기반 — 데이터가 쌓이면 재조정. L9 정신으로 근거를 여기 명시)

**advisory 기록**: `evaluateVerdict`가 `blocking` 외에 `advisory`를 반환 —
confirmed인데 블로킹 리스트에 없는 medium (low는 `allow_low` 규칙 유지).
아티팩트에 `advisory_findings`로 저장하고, 사람이 읽는 출력에
`xm build later add "…" --source gate-panel` 제안을 출력한다.
v1은 자동 later add 안 함 (라운드 간 중복 방지 설계가 선행돼야 함).

**검증** (`x-panel/gate.mjs` mergePolicy): 오버레이 키는
`{block_confirmed, block_unreviewed, block_contested, allow_low}`의 부분집합만
허용, 그 외 미지 키·미지 severity는 에러. 오타가 게이트를 조용히 끄는
기존 N3 방어선을 오버레이에도 동일 적용.

**호환성**:
- 기존 flat `gate_policy` 설정은 그대로 동작 (오버레이 없으면 전 phase 동일).
- **기본값 변화는 semi-breaking**: 기존에 막히던 confirmed medium이 per-task에서
  안 막힘 → CHANGELOG 명시. 구 동작 복원은 config 1줄
  (`"gate_policy": {"block_confirmed": ["critical","high","medium"]}`).
- PARALLEL COPY 락스텝: `x-build/gate-panel.mjs`와 `x-panel/gate.mjs` 동시 수정.
- 대시보드: gate_policy 그리드는 미지 서브키를 보존 round-trip
  (`widget-serialize.mjs:144-148`) → 오버레이가 지워지지 않음. 그리드 편집 대상은
  flat base 유지, 오버레이는 CLI/JSON 편집 (UI 확장은 후속).

### B — `gate_phase: release` 실배선 (M)

- `planWorktrees`/`finishWorktrees`: `gate_phase === 'release'`이면 gk finish
  argv에서 `--gate`/`--gate-phase`를 생략 — per-task는 무게이트 머지.
  plan/status 출력에 `gate: panel (deferred to release integration)` 표기.
- 현행 버그(‘release’가 gk로 새는 경로)는 이 분기로 함께 해소.
- **release 가드 (v1 = 가시화)**: `review-integration` 아티팩트에 target HEAD sha를
  기록하고, `worktrees status`가 "release gate: pending / stale(HEAD 변경) / pass"를
  표시. ship 하드 차단은 x-ship 연동이 필요해 후속으로 분리.
- 상태 매핑 무변경: 이 모드에선 before-gate 실패 상태 자체가 발생하지 않음.

### C — 재라운드 delta 심사 (L, 후속 — 단 우선순위 상향)

라운드당 시간(10~15분 패널)의 최대 레버. A~G가 라운드 **수**를 줄이는 반면
C는 남는 진짜 라운드(critical/high)의 **재검증 비용**을 2~5분으로 줄인다.
이번 구현 직후 최우선 후속으로 착수한다.

두 가지 경로 후보 ("이전 blocking findings 해소 확인 + 수정 delta 신규 스캔"):

- C1: `xm panel followup` 세션 resume 재사용 — 각 저자 모델에 수정 diff를 주고
  자기 지적의 해소 여부를 묻는다 (세션 만료 시 stateless fallback 기존 존재).
- C2: 신규 `xm panel regate <run> --patch <fix-delta>` — 이전 verdict의 blocking
  findings + delta만으로 축소 패널 1회.

미해결 설계 문제 → 별도 문서로: fix-delta 산출(gk는 누적 patch만 제공 —
`--gate-keep-patch`로 이전 patch 보관 후 interdiff vs `git range-diff`),
판정 규칙(전 findings resolved AND delta 신규 critical/high 없음 → pass),
세션 만료 라이브 검증(빅뱃5 후속과 공유).

### D — 셀프리뷰 수렴 지침 (S)

task-context Verification 섹션(`worktrees.mjs:597-599`)에 추가:

- Before running finish, self-review your FULL diff at low cost (async/race
  state transitions, error paths, boundary values). The merge gate is an
  expensive cross-vendor panel (~10-15 min per round) — converge cheaply first.
- If the gate fails, fix the whole CATEGORY of each finding (one async-race
  finding → audit every async state transition), not just the quoted line.
  Partial fixes cost another full gate round.

근거: term-mesh 2~4차는 전부 "1차 지적 범주(async race)의 잔여 표면" —
범주 단위 수정 지침이 있었으면 1라운드로 수렴 가능했다.

### E — 라운드 캡 (S)

- **라운드 카운트**: gate-panel이 기존 아티팩트를 읽어 `round`를 계산 —
  직전 decision이 `fail`이면 `prev.round + 1`, `pass`(base drift 재게이트)면 1로
  리셋. fail 시 덮어쓰기 전에 `panel-<phase>.round-<N>.json`으로 이전 아티팩트
  보존 (판정 감사 가능성 유지).
- **강등 규칙**: `round > worktree.gate_max_rounds`(신규 config 키, 기본 2,
  0 = 캡 없음)이면 해당 실행의 유효 정책에서 `medium`을 블로킹 리스트에서
  제거 (advisory로 강등). **critical/high는 어떤 라운드에도 강등되지 않는다.**
- 아티팩트에 `round` + `demotions: [{severity, reason: 'round_cap', round}]`
  기록 — `policy_overridden`(사용자 의도)과 별개 필드 (자동 강등은 사용자
  오버라이드가 아님).
- 기본 2의 근거는 실측 1건 (3라운드째부터 medium-only) — 문서에 명시하고
  config로 조정 가능하게.
- 라운드 카운트는 **패널이 실제 돈 fail만** 증가시킨다 (pre-gate fail-fast는
  카운트 유지) — 저비용 실패가 medium 강등을 조기 트리거하면 안 됨.
- 덮어쓰기 전 이전 아티팩트는 `panel-<phase>.attempt-<k>.json`으로 무조건 보존
  (pass/fail/pre-gate 모두) — 판정 감사 이력.

### F — pre-gate 구조화 (S~M)

D(프롬프트 규율)의 구조적 승격. `worktree.pre_gate` config 키(문자열 템플릿,
기본 null=비활성)가 설정되면 gate-panel 래퍼가 **패널 앞에** 해당 명령을 직접
실행한다.

- **실행 계약**: gk gate와 동일하게 공백 토큰화 + no-shell. `{patch}` 토큰을
  patch 경로로 치환 (`{patch}` 부재 시 마지막 인자로 append). 패널과 동일한
  root env(X_PANEL_ROOT/XM_ROOT/X_BUILD_ROOT) 주입.
  타임아웃 `X_BUILD_PRE_GATE_TIMEOUT_MS` (기본 5분).
- **exit 코드 계약**:
  - `0` → 통과, 패널 진행
  - `1` → **fail-fast**: 패널을 돌리지 않고 gate 전체가 exit 1.
    stdout이 `{findings:[{severity,file,line,claim}]}` JSON이면 그 findings를
    `kind: 'pre_gate'`로 blocking에 채택, 아니면 output tail을 기록.
  - `≥2`/spawn 실패/타임아웃 → **경고 후 패널 진행** (pre-gate는 최적화이지
    정확성 게이트가 아님 — 인프라 고장이 머지를 막으면 안 되지만, L6에 따라
    stderr에 크게 남기고 아티팩트 `pre_gate.status: 'error'`로 기록).
- 아티팩트에 `pre_gate: { cmd, exit_code, status, duration_ms, output_tail? }` 기록.
- 효과: fail 라운드의 최악 비용 10~15분 → pre-gate 실행 시간(1~3분).

### G — gate fail 시 findings 자동 피드백 (S)

현재 gate fail → NEEDS_FIX 상태만 남고 findings 전달은 오케스트레이터의 수동
릴레이. `finishOne`이 NEEDS_FIX 결과를 받으면:

1. `panel-<phase>.json` 아티팩트를 읽어 (decision=fail일 때만)
2. 마커(`<!-- xm:gate-findings:start/end -->`)로 구분된 "Gate Findings" 섹션을
   워크트리 `TASK-CONTEXT.md`와 canonical task-context 아티팩트에
   **replace-or-append** (라운드마다 중복 누적 금지, 최신 라운드로 교체)
3. 섹션에는 blocking findings + advisory + **범주-수정 지시**("지적된 줄이
   아니라 그 범주 전체를 수정하라")를 포함
4. `registerWorktreeExclude`를 재호출해 스냅샷이 워크트리를 dirty로 만들지
   않게 보장 (dirty guard 오탐 방지)
5. 실패는 stderr 경고로만 — findings 주입 실패가 finish 흐름을 깨면 안 됨

효과: 수정 에이전트가 findings를 구조화된 형태로 즉시 수신 — 오케스트레이터
릴레이 턴 제거 + 범주-수정 프레이밍 일관 적용.

## 4. 상호작용

- A가 들어가면 E의 실효 범위가 줄어든다 (medium이 기본 비블로킹이므로).
  E는 사용자가 정책을 다시 조인 경우(`medium` 재추가)의 안전판으로 존치.
- D와 F는 같은 목표(패널 전 수렴)의 프롬프트/구조 이중화 — F가 켜져 있으면
  D는 fail-fast 이전에 손을 덜 타게 하는 보조.
- G는 A의 advisory와 결합 — 수정 에이전트가 blocking뿐 아니라 advisory도
  받아 다음 라운드 전에 함께 처리할 수 있음.
- B는 나머지와 직교 — 모드 선택(per-task 게이트 vs 최종 1회)의 문제.
- C는 독립적으로 나중에 얹을 수 있음 (재라운드 자체를 싸게).

## 5. 태스크 분해 (권장 순서)

| # | 내용 | 파일 | 크기 |
|---|------|------|------|
| 1 | A: 정책 오버레이 + 기본 완화 + advisory | `x-panel/lib/x-panel/gate.mjs`, `x-panel-cli.mjs`, `x-build/lib/x-build/gate-panel.mjs`, `worktree-shared.mjs`, `config-schema.mjs`, 테스트 | S-M |
| 2 | E: 라운드 캡 + 아티팩트 이력 | `gate-panel.mjs`, `worktree-shared.mjs`, `config-schema.mjs`, 테스트 | S |
| 3 | F: pre-gate 구조화 | `gate-panel.mjs`, `worktree-shared.mjs`, `config-schema.mjs`, 테스트 | S-M |
| 4 | G: findings 자동 피드백 | `worktrees.mjs`, 테스트 | S |
| 5 | B: release 배선 + status 가시화 | `worktrees.mjs`, 테스트 | M |
| 6 | D: 지침 텍스트 | `worktrees.mjs` | S |
| 7 | C: delta 재심사 — 설계 문서 → 구현 (우선순위 상향, 이번 랜딩 직후 착수) | 신규 docs + `x-panel` | L |

주의: `xm/lib/**` 미러는 직접 수정 금지 — 릴리스 sync(`scripts/sync-bundle.sh`)가
처리 (Edit Policy).

## 6. 테스트 계획

- gate.mjs: 오버레이 병합/검증 (미지 phase 키, 미지 severity, 비객체 오버레이 → 에러)
- gate-panel: phase별 유효 정책 해석, advisory 분리, round 증가/리셋, 강등 기록,
  round-N 아티팩트 보존
- worktrees: `gate_phase=release`에서 gk argv에 `--gate` 부재, plan 출력 표기
- config-cli: `worktree.gate_max_rounds` 등록/검증
- 기존 `test/worktrees/gate-panel.test.mjs`의 기본 정책 기대값 갱신 (semi-breaking)
