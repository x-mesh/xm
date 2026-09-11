# PRD: Attention Queue — 게이트가 틀린 순간만 모으는 주의력 라우터

## At a Glance

> 요약: 리뷰 결과를 전부 읽는 대신, "게이트 판정이 실제와 어긋난 순간"만 주당 몇 건으로 추려서 보여주는 기능.

xm의 게이트는 지금 통과/차단을 판정하지만, **그 판정이 맞았는지는 아무도 기록하지 않는다.** `triage-ledger.jsonl`이 "지적한 것 중 헛스윙 비율"(정밀도)은 알려주지만, "통과시켰는데 나중에 터진 것"(재현율)은 구조적으로 관측 불가다. 그 결과 게이트 정책 변경(`docs/worktree-gate-optimization-plan.md` §3A의 per-task medium 비블로킹 전환)이 옳았는지 검증할 데이터가 없고, 문서에도 "실측 1건 기반 — 데이터가 쌓이면 재조정"이라고 명시돼 있다.

이 프로젝트는 네 종류의 **불일치 신호**를 수집해 하나의 랭킹된 큐로 만든다. (1) 앞단 게이트를 통과한 코드에서 릴리스 리뷰가 찾아낸 지적(escape), (2) 벤더 판정이 갈린 지적(contested), (3) 코드를 일부러 망가뜨렸는데 테스트가 침묵한 지점(surviving mutant), (4) false_positive로 기각했는데 되살아난 지적(revived dismissal). 판정이 일치한 케이스는 정보량이 0이므로 수집하지 않는다.

핵심 안전장치: **v1은 어떤 머지 판정도 바꾸지 않는다.** 게이트 exit code 계약(0/1/2)과 `DEFAULT_POLICY`는 그대로이고, 신규 수집기는 기존 아티팩트를 읽기만 한다. 변이 프로브(F3)만 유일하게 쓰기 부작용이 있는데, 워크트리 내부에서만 동작하고 실행 후 원복을 불변식으로 강제한다.

■ Diagram: Pipeline
■ Purpose: 기존 아티팩트 → 순수 수집기 → 순수 집계기 → 큐. LLM 호출 경로가 없다는 것이 핵심.

```
  [기존 아티팩트 — 읽기 전용]              [신규 수집]
  ┌────────────────────────┐          ┌──────────────────┐
  │ panel-before.json      │          │ probe-<task>.json│
  │ panel-after.json       │          │ (F3 변이 프로브)  │
  │ panel-release.json     │          └────────┬─────────┘
  │ panel-*.attempt-N.json │                   │
  │ triage-ledger.jsonl    │                   │
  └───────────┬────────────┘                   │
              │                                │
              ▼                                │
  ┌────────────────────────────────┐           │
  │ collectors (부작용 있음, fs 접근) │           │
  │  F1 escape-collect             │           │
  │  F4 revive-detect              │           │
  └───────────┬────────────────────┘           │
              │ append-only                    │
              ▼                                │
        (escape-ledger.jsonl) ◀────────────────┘
              │
              ▼
  ┌────────────────────────────────┐
  │ aggregators (PURE — no fs/cfg) │
  │  escape-ledger.mjs             │  ◀── review-precision.mjs 와 동일 계약
  │  attention-rank.mjs            │
  └───────────┬────────────────────┘
              │
      ┌───────┴────────┐
      ▼                ▼
  [xm build        [x-dashboard
   attention]       attention panel]
```

■ Legend:
  - `[ ]` : 실행 단위 / 커맨드
  - `( )` : 데이터 파일 (append-only jsonl)
  - `──▶` : 동기 읽기/쓰기
  - `◀──` : 계약 준수 방향

■ Key Notes:
  1. 집계 계층은 `review-precision.mjs`의 PURE 계약(fs·config·import 없음)을 그대로 따른다. x-dashboard가 x-build core를 import 할 수 없기 때문에 이 제약은 협상 불가다.
  2. LLM 호출이 파이프라인 어디에도 없다. 비용 증분 0이 설계 목표다. 판정은 LLM에 위임하지 않고 **샘플링만** 기계가 한다.
  3. F1/F2/F4는 기존 아티팩트만으로 즉시 데이터가 나온다. F3만 신규 수집이 필요하다.

---

## 0. Assumptions & Open Questions

> 요약: 릴리스 패널이 이미 머지된 코드를 본다는 전제와, 게이트 아티팩트가 "무엇을 심사했는지"를 남긴다는 전제 위에 서 있다. 후자는 검증 전.

### Assumptions (confidence-tagged)

- **[A1, high]** `review-integration`(phase=release, task=`__integration__`)은 per-task 게이트를 이미 통과해 머지된 변경분을 대상으로 돈다. → 근거: `worktrees.mjs:1137-1168`, `DEFAULT_POLICY.release` 오버레이가 medium을 "릴리스 전 통합 리뷰에서 잡는다"는 전제로 설계됨.
- **[A2, high]** 패널 verdict의 `contested` 버킷은 벤더 간 판정 불일치를 의미하며, 현재 `block_contested: ['critical']` 때문에 critical 미만 contested는 차단도 기록도 되지 않고 사라진다. → 근거: `gate-panel.mjs` `evaluateVerdict`, `DEFAULT_POLICY`.
- **[A3, high]** `triage-ledger.jsonl`은 append-only이고 `reviewed_commit` + `finding_id` + `file`을 보존하므로 조인 키로 쓸 수 있다. → 근거: `review-precision.mjs` `buildLedgerRow`.
- **[A4, medium]** 각 프로젝트에서 테스트 명령을 설정 또는 탐지로 알아낼 수 있다(F3 전제). → Validation: 상위 3개 도그푸딩 레포(xm, term-mesh, headroom)에서 `package.json` scripts만으로 탐지 가능한지 먼저 확인. 불가하면 `probe.test_command` 설정 키를 필수로 전환.
- **[A5, medium]** 변이 대상을 태스크 diff가 건드린 줄로 한정해도 유의미한 생존 변이가 나온다. → Validation: xm 자신의 최근 10개 태스크에 소급 적용해 생존 변이 ≥1건 나오는 태스크 비율 측정. 30% 미만이면 범위를 파일 단위로 확대.

### Open Questions

- **[Q1] 게이트 아티팩트가 "심사 범위"를 남기는가?** `gate-panel`은 `--patch <path>`를 받지만, `panel-<phase>.json`이 그 patch의 파일 목록(또는 해시)을 보존하는지 확인하지 못했다. 보존하지 않으면 F1의 `escape_class` 중 `not_reviewed`와 `reviewed_missed`를 구분할 수 없다. → **Status: blocking**. 해소 경로: (a) 아티팩트에 이미 있으면 그대로 사용, (b) 없으면 `runGatePanel`에 `reviewed_files: [{path, sha256}]` 필드 1개 추가(하위호환 append), (c) 그것도 불가하면 v1에서 두 클래스를 `reviewed_unknown`으로 합친다.
- **[Q2] escape 행을 어디에 쓸 것인가?** (a) `triage-ledger.jsonl`에 `schema_v: 2`로 새 type 추가, (b) 별도 `escape-ledger.jsonl` 신설. → **Decision: (b)**. 근거는 §11 Decision Log.
- **[Q3] 주간 큐 예산 N의 기본값은?** 초안 5. 도그푸딩 2주 후 재조정. → Status: answered (기본 5, 설정 가능)

**Gate rule 적용**: Q1이 blocking이므로 태스크 분해 전에 `AskUserQuestion`으로 (a)/(b)/(c) 중 하나를 확정해야 한다.

---

## 1. Goal

> 요약: 사람이 읽는 분량을 주당 N건으로 고정한 채, 정보량이 가장 높은 항목만 자동으로 올려준다.

리뷰 산출물 전수 검토는 규모가 커지면 불가능하다. 하지만 전수 검토를 포기하면 게이트가 "통과율 100%인 의식"으로 퇴화해도 감지할 방법이 없다. 이 프로젝트는 **게이트 판정과 현실이 어긋난 순간만** 골라내는 수집기 4종과, 그것을 주당 고정 예산의 랭킹 큐로 내보내는 커맨드를 제공한다.

수혜자는 (1) 게이트 정책을 조정해야 하는 유지보수자 — 지금은 실측 1건에 근거해 정책을 바꾸고 있다, (2) 리뷰 결과를 읽어야 하는 사용자 — 읽을 대상을 고르는 부담이 사라진다, (3) 교정 스킬을 작성하는 사람 — 반복 실패 패턴이 데이터로 쌓인다.

## Decision Plan

- **Selected approach**: 기존 아티팩트를 읽는 순수 집계 계층 + append-only 원장 1개 + 프로브 커맨드 1개 + 큐 커맨드 1개. 선택 기준은 "신규 LLM 비용 0, 머지 판정 불변, 기존 PURE 계약 준수".
- **Alternatives**:
  - LLM 판정기를 붙여 리뷰 결과를 요약/선별 → 기각. Dan Luu의 실측에서 최신 모델이 실행 기록 분석 시 기본적인 추론 오류를 다수 냈다. 판정 위임은 위험하고, 우리가 필요한 건 판정이 아니라 샘플링이다.
  - 외부 결함 추적 시스템 연동(이슈 트래커, 인시던트) → v2로 연기. v1은 레포 안에서 닫히는 신호만 쓴다.
- **Rejected choices**: 변이 프로브를 처음부터 블로킹 게이트로 승격 → 기각. 지표 해킹 표면이 새로 열리고, 게이트가 디버깅 루프의 이터레이터로 오용된 전례(`worktree-gate-optimization-plan.md` §1, term-mesh t3 4라운드)가 있다. 승격은 escape 데이터가 정당화한 뒤에만.
- **Risk-first order**: 최고 위험 가정은 **Q1(심사 범위 기록 여부)**. 이게 없으면 F1의 분류 체계가 무너지고 PRD 절반이 약해진다. 첫 태스크는 기능 구현이 아니라 `panel-<phase>.json` 실물 1건을 덤프해 `reviewed_files` 유무를 확인하는 것이다.

---

## 2. Success Criteria

> 요약: 전부 커맨드 한 줄로 5분 안에 확인 가능한 항목만 둔다.

- **[SC1]** `xm build attention --json`이 4개 소스에서 수집된 항목을 랭킹해 기본 5건 이하로 반환한다. 실행 시간 5초 이내, 외부 네트워크/LLM 호출 0회.
- **[SC2]** 릴리스 패널의 confirmed finding 중 동일 태스크의 before/after 게이트를 통과한 파일에 해당하는 항목이 **100%** `escape-ledger.jsonl`에 `escape_class` 태그와 함께 기록된다.
- **[SC3]** severity가 `critical`이 아니어서 차단되지 않은 `contested` finding이 큐에 노출된다. 현재는 100% 소실되며, 픽스처 테스트로 노출률 100%를 확인한다.
- **[SC4]** `xm build probe --task <id>`가 생존 변이를 `file:line:operator`로 보고하고, 실행 종료 후 워킹트리가 실행 전과 바이트 단위로 동일하다(`git status --porcelain` 출력 불변).
- **[SC5]** `false_positive`로 기각된 finding이 이후 `regression` outcome 또는 escape로 재등장한 경우를 픽스처에서 100% 탐지하고, 무관한 finding 간 오조인 0건.
- **[SC6]** 전체 파이프라인의 API 비용 증분이 0원이다(프로브의 테스트 실행 CPU 시간 제외).
- **[SC7]** 집계 모듈 2종이 `review-precision.mjs`와 동일하게 PURE하다: 소스에 `import`·`fs`·`process` 참조 0건을 테스트로 강제한다.

---

## 3. Constraints

> 요약: 기존 계약 3개를 깨면 안 된다.

- **[C1]** 집계 모듈은 PURE여야 한다. 파일시스템·config·타 모듈 import 금지. x-dashboard가 x-build core를 import 할 수 없다는 기존 제약 때문이다(`review-precision.mjs` 헤더 주석).
- **[C2]** metrics privacy rule 준수: 원장 행에 finding 요약문·증거 텍스트를 담지 않는다. 카운트·id·해시·repo 상대 경로만 허용.
- **[C3]** `gate-panel.mjs`와 `x-panel/lib/x-panel/gate.mjs`의 LOCKSTEP을 깨지 않는다. 평가 코어(`DEFAULT_POLICY`/`blocksFor`/`evaluateVerdict`/`resolvePolicyForPhase`)를 건드려야 하면 양쪽 동시 수정 + 기존 동기화 테스트 통과가 필수다.
- **[C4]** 게이트 exit code 계약(0 pass / 1 policy block / 2 error) 불변. v1의 어떤 기능도 머지 결과를 바꾸지 않는다.
- **[C5]** 신규 데몬·서비스·DB 금지. 파일 아티팩트와 CLI만 사용한다.
- **[C6]** 원장은 append-only이며 재실행 시 중복 기록되지 않아야 한다. `ledgerRowKey`와 동일한 멱등 키 패턴을 따른다.

---

## 4. Non-Functional Requirements

> 요약: 빠르고, 조용하고, 흔적을 남기지 않는다.

- **Performance**: `attention` 집계는 원장 10만 행 기준 5초 이내. 프로브는 태스크당 벽시계 10분 상한(설정 가능), 개별 테스트 실행 90초 타임아웃.
- **Security**: 원장에 들어오는 라벨은 신뢰 불가 입력으로 취급한다. `review-precision.mjs`의 ANSI/포맷 컨트롤 스트리핑과 `^[a-z0-9][a-z0-9._-]*$` 검증을 동일 적용한다. 파일 경로는 기존 `validateIdSegment`/safeJoin 경로를 재사용한다.
- **Scalability**: jsonl append-only. 파일당 상한(기본 50MB) 초과 시 `escape-ledger.<YYYYQ>.jsonl`로 롤오버하고 파서는 glob으로 병합한다.
- **Reliability**: 프로브는 크래시·SIGINT·타임아웃 어느 경로로 끝나도 원본을 복원한다. 복원 실패 시 exit 2와 함께 복구 명령을 출력한다. 원장 쓰기는 tmp+rename 원자적 교체.

---

## 5. Requirements Traceability

> 요약: 모든 요구사항이 SC에 연결된다.

| ID | 요구사항 | → SC |
|----|---------|------|
| **R1** | 릴리스 패널 finding을 동일 태스크의 before/after 게이트 결과와 조인해 escape 행을 생성한다 | SC2 |
| **R2** | escape를 `not_reviewed` / `reviewed_missed` / `dismissed_as_fp` / `accepted_risk` / `backlogged` 5종으로 분류한다 | SC2 |
| **R3** | 패널 verdict의 `contested` finding을 severity 무관하게 수집·노출한다 | SC3 |
| **R4** | 태스크 diff가 건드린 줄에 기계적 변이를 주입하고 테스트 침묵 여부를 기록한다 | SC4 |
| **R5** | 프로브 실행 후 워킹트리 원복을 보장한다 | SC4 |
| **R6** | `false_positive` 기각 후 되살아난 finding을 원장 조인으로 탐지한다 | SC5 |
| **R7** | 4개 소스를 정보량 기준으로 랭킹해 예산 N건으로 자른다 | SC1 |
| **R8** | 집계 로직을 PURE 모듈로 분리해 CLI와 대시보드가 공유한다 | SC1, SC6, SC7 |
| **R9** | 큐 항목에 "읽음/처리" 상태를 남기고 미처리 누적을 경고한다 | SC1 |
| **R10** | 원장 행에 요약문·증거 텍스트를 포함하지 않는다 | SC6 |

---

## 6. Out of Scope

> 요약: 관찰까지만. 강제와 외부 연동은 다음 버전.

- **변이 프로브의 게이트 승격.** v1은 non-blocking 관찰 전용. 블로킹 전환은 escape 데이터로 효과가 입증된 뒤 별도 PRD.
- **프로덕션 인시던트 연동.** aic/rca-web에서 온 실장애를 escape 소스로 쓰는 것은 v2. v1은 레포 안에서 닫히는 신호만.
- **JS/TS 외 언어의 변이 연산자.** v1은 JS/TS만. 다언어는 어댑터 인터페이스만 열어둔다.
- **LLM 기반 결함 귀속·요약.** 판정을 모델에 위임하지 않는다는 설계 원칙상 영구 제외.
- **기존 `triage-ledger.jsonl` 스키마 변경.** 읽기만 한다.
- **정밀도 지표 재구현.** `aggregateLensPrecision` 등 기존 API를 그대로 소비한다.

---

## 7. Risks

> 요약: 귀속 부정확, 지표 해킹, 큐 무시, 데이터 희소 네 가지.

- **escape 귀속이 부정확하다(리팩터링·파일 이동으로 blame이 엉킴)** — Likelihood: H, Impact: M → Mitigation: 커밋 단위 blame 대신 **태스크 단위 귀속**을 1차로 쓴다(어떤 태스크의 게이트가 이 파일을 통과시켰나). blame이 필요한 경우에만 보조로 쓰고, 확신이 낮으면 행에 `attribution: "weak"`를 태깅해 집계에서 분리 표시한다.
- **프로브가 나중에 게이트로 승격되면 새로운 지표 해킹 표면이 열린다** — Likelihood: M, Impact: H → Mitigation: v1 non-blocking을 §13 Boundaries의 "Never do"에 명시. 승격 시에도 기준은 에이전트가 작성하지 않은 산출물(held-out 테스트, 외부 참조)에만 건다.
- **큐가 또 하나의 아무도 안 보는 대시보드가 된다** — Likelihood: H, Impact: H → Mitigation: 예산을 주당 N건으로 **고정**하고(더 많이 보여주지 않음), 항목에 읽음/처리 상태를 요구하며, 미처리가 2주 누적되면 `attention`이 경고를 출력한다. 큐 자체의 처리율을 지표로 남긴다.
- **초기 데이터 희소 — escape가 0건이라 아무것도 안 보인다** — Likelihood: M, Impact: M → Mitigation: F2(contested)와 F3(probe)는 과거 아티팩트·현재 코드만으로 즉시 채워진다. 특히 F2는 소급 집계가 가능하므로 도입 첫날 큐가 비지 않는다.
- **프로브 테스트 실행이 폭주해 머신을 점유한다** — Likelihood: M, Impact: H → Mitigation: §7.5 참조. 벽시계 상한 + 프로세스 그룹 kill + 고아 프로세스 정리.

## 7.5 Failure Modes & Adversarial Inputs

> 요약: 파서·정규식·동시성·프로세스 4개 위험 도메인에 각각 방어선을 명시한다.

- **[R1]** 손상되거나 잘린 `panel-<phase>.json` (게이트가 kill된 중간 상태) → 파싱 예외로 수집기 전체 중단 → 검증: 잘린 JSON·빈 파일·BOM 포함 픽스처로 테스트, 행 단위 skip + `parse_errors` 카운트만 올리고 계속 진행하는지 확인
- **[R2]** `escape_class` 분류 입력에 알 수 없는 severity/lens 라벨, ANSI 이스케이프 삽입 → 터미널 포매터·대시보드 오염 → 검증: 기존 `normalizeLabel` 경로 재사용을 단위 테스트로 강제, `\x1B[2J` 등 제어문자 포함 라벨이 `null`로 정규화되는지 확인
- **[R3]** 변이 대상 탐지 정규식이 미니파이된 1줄 50만자 파일을 만남 → catastrophic backtracking → 검증: 백트래킹 없는 선형 패턴만 사용, 병리적 입력으로 stress test 후 완료 시간 < 100ms 단언. **참고: Dan Luu 글에서 실제로 44kB·1364줄 파일에 대한 PCRE 정규식이 2시간 20분 폭주한 사례가 있다.**
- **[R4]** 프로브가 띄운 테스트 프로세스가 타임아웃 후에도 살아남아 고아 프로세스로 남음 → 머신 점유 → 검증: 프로세스 그룹 단위 spawn + 타임아웃 시 그룹 kill, 종료 후 자식 프로세스 0개를 테스트로 확인. **이 실패는 위 글에서 하위 에이전트 종료 후에도 Perl 프로세스가 남은 형태로 실제 발생했다.**
- **[R5]** 프로브 실행 중 SIGINT/크래시 → 변이된 소스가 워킹트리에 남아 커밋됨 → 검증: 시그널 핸들러 + `finally` 복원, 강제 종료 시나리오 테스트에서 `git status --porcelain` 불변 확인
- **[R6]** 병렬 워크트리 2개가 동시에 `escape-ledger.jsonl`에 append → 행 인터리빙 손상 → 검증: O_APPEND 단일 write 또는 tmp+rename, 동시 20회 쓰기 후 유효 행 수 일치 확인
- **[R7]** 동일 태스크의 게이트 재실행(`panel-<phase>.attempt-N.json` 누적)으로 escape가 중복 집계 → 검증: `ledgerRowKey` 패턴의 멱등 키로 dedupe, 같은 입력 3회 수집 후 행 수 불변 확인
- **[R8]** 원장 파일이 수백 MB로 성장해 집계가 메모리 초과 → 검증: 스트리밍 파싱 + 롤오버 임계 테스트, 10만 행에서 5초·메모리 상한 확인
- **[R9]** `xm build attention` (랭킹 로직) — none. 순수 함수이며 입력은 이미 정규화된 원장 행뿐이다. 외부 입력·루프·재귀 없음.

---

## 8. Architecture

> 요약: 수집(부작용) / 집계(PURE) / 표시(CLI·대시보드) 3계층 분리. PURE 경계가 이 설계의 핵심 제약이다.

■ Diagram: Layers
■ Purpose: 어느 계층이 fs를 만지고 어느 계층이 못 만지는지를 고정한다. 기존 `review-precision.mjs`가 이미 이 규약을 따르고 있어 그대로 확장한다.

```
┌─ L3 표시 ─────────────────────────────────────────────┐
│  xm build attention [--json] [--budget N] [--ack <id>] │
│  x-dashboard attention panel                           │
└───────────────▲────────────────────────────────────────┘
                │ 순수 함수 호출 (텍스트 in → 객체 out)
┌─ L2 집계 (PURE: no fs / no config / no import) ───────┐
│  x-build/lib/x-build/escape-ledger.mjs                 │
│    parseEscapeLedger / buildEscapeRow / escapeRowKey   │
│    aggregateEscapeClass / classifyEscape               │
│  x-build/lib/x-build/attention-rank.mjs                │
│    rankAttentionItems / applyBudget                    │
│  (기존) review-precision.mjs — 그대로 재사용            │
└───────────────▲────────────────────────────────────────┘
                │ 호출자가 파일을 읽어 텍스트를 넘긴다
┌─ L1 수집 (부작용 허용) ────────────────────────────────┐
│  escape-collect : panel-release × panel-before/after   │
│  revive-detect  : triage-ledger 자기 조인               │
│  probe          : 변이 주입 → 테스트 → 원복             │
└───────────────▲────────────────────────────────────────┘
                │ 읽기 전용
┌─ L0 기존 아티팩트 ─────────────────────────────────────┐
│  .xm/projects/<p>/<task>/panel-<phase>[.attempt-N].json│
│  .xm/review/triage-ledger.jsonl                        │
│  .xm/review/triage.json                                │
└────────────────────────────────────────────────────────┘
```

■ Legend:
  - `L0~L3` : 계층. 아래에서 위로만 의존한다.
  - `PURE` : 파일시스템·설정·외부 import 금지 구역
  - `──▲──` : 의존 방향 (위가 아래를 호출)

■ Key Notes:
  1. **PURE 경계가 협상 불가인 이유**: x-dashboard는 별도 플러그인 디렉터리에 있어 x-build core를 import 할 수 없다. 집계 로직이 fs를 만지는 순간 대시보드와 CLI가 로직을 복제하게 되고, 그 복제가 어긋나면 같은 데이터에 두 숫자가 생긴다.
  2. **L1은 L0에 쓰지 않는다.** 기존 아티팩트는 읽기 전용이고, 신규 쓰기는 `escape-ledger.jsonl`과 `probe-<task>.json` 두 곳뿐이다. 이것이 C4(머지 판정 불변)를 구조적으로 보장한다.
  3. **Key decision**: 패널 자체를 수정해 escape를 기록하는 방식을 기각했다. `gate-panel.mjs`는 `x-panel/gate.mjs`와 LOCKSTEP이라 양쪽 동시 수정이 필요하고, 게이트 경로에 신규 쓰기를 추가하면 머지 판정 경로의 실패 모드가 늘어난다. 수집을 게이트 밖의 별도 커맨드로 빼면 게이트가 깨질 수 없다.

---

## 9. Key Scenarios

> 요약: 주간 큐 확인(정상), 프로브 타임아웃(실패), 첫 도입 시 빈 큐(엣지) 세 가지.

### Happy Path — 주간 주의력 소비

```
User          xm build attention        L2 집계          L0 아티팩트
 │── attention ──▶│                      │                 │
 │                │── read ledgers ─────────────────────▶  │
 │                │◀── jsonl text ─────────────────────────│
 │                │── rankAttentionItems(text) ──▶│         │
 │                │◀── ranked[] ──────────────────│         │
 │                │── applyBudget(5) ────────────▶│         │
 │◀── top 5 ──────│                      │                 │
 │── ack <id> ───▶│                      │                 │
 │                │── append ack row ───────────────────▶  │
```

1. 사용자가 `xm build attention` 실행
2. 4개 소스에서 항목을 모아 정보량 기준 랭킹, 상위 5건 출력. 각 항목에 `source`, `severity`, `file`, 근거 아티팩트 경로가 붙는다
3. 사용자가 항목을 읽고 `xm build attention --ack <id> --note "lens 오탐"` 으로 처리
4. Result: 큐 처리율이 기록되고, 다음 실행에서 해당 항목은 빠진다

### Failure Path — 프로브 타임아웃

1. 사용자가 `xm build probe --task t3` 실행
2. 변이 12개 중 4번째에서 테스트가 90초 타임아웃
3. 시스템이 프로세스 그룹을 kill하고, 해당 변이를 `outcome: "timeout"`으로 기록, 소스를 복원한 뒤 다음 변이로 진행
4. 출력: `⚠ mutant 4/12 timed out (90s) — source restored, continuing`
5. System state: 워킹트리 불변. 전체 벽시계 상한 10분 초과 시 남은 변이를 `outcome: "skipped"`로 남기고 종료

### Edge Case — 도입 첫날, escape 0건

1. 신규 도입이라 `escape-ledger.jsonl`이 비어 있다
2. Expected behavior: 큐가 비지 않는다. F2(contested)가 과거 `panel-*.json`을 소급 집계해 즉시 항목을 채우고, F3은 온디맨드로 생성 가능하다. 출력에 `escape: 0 (no release panel runs yet)`을 명시해 "데이터 없음"과 "문제 없음"을 구분한다

### Day-0 Demo Script (3분)

```bash
# 1. 과거 패널 아티팩트에서 놓친 불일치를 소급 집계 (읽기 전용)
xm build attention --backfill --dry-run

# 2. 실제 원장 생성
xm build attention --backfill

# 3. 주간 큐 확인
xm build attention --budget 5

# 4. 변이 프로브 1회 (non-blocking, 원복 보장)
xm build probe --task <task-id>
git status --porcelain   # 출력 비어 있어야 함

# 5. 큐 재확인 — 생존 변이가 항목으로 올라옴
xm build attention --budget 5
```

---

## 10. Data Model & API Contracts

> 요약: 신규 파일 2개, 신규 PURE 모듈 2개, 신규 서브커맨드 2개.

### Entity Model

| Entity | Key Fields | Relationships |
|--------|-----------|---------------|
| `EscapeRow` | schema_v, ts, type, task_id, reviewed_commit, escape_class, severity, lens, file, related_finding_id, attribution | belongs_to: 게이트 아티팩트 (reviewed_commit), may_link: TriageLedgerRow (related_finding_id) |
| `ProbeReport` | schema_v, task_id, ts, mutants[], survived_count, timeout_count, duration_ms | belongs_to: task |
| `Mutant` | file, line, operator, outcome(`killed`\|`survived`\|`timeout`\|`skipped`) | part_of: ProbeReport |
| `AttentionItem` | id, source(`escape`\|`contested`\|`mutant`\|`revived`), score, severity, file, artifact_path, ack_state | derived_from: 위 3종 + TriageLedgerRow |

### Critical API Contracts

**PURE 집계 모듈** (`escape-ledger.mjs`) — 텍스트를 받아 객체를 반환, fs 접근 없음:

```
parseEscapeLedger(text: string) → { rows: EscapeRow[], parse_errors: number }
buildEscapeRow({ ts, task_id, reviewed_commit, finding, escape_class, attribution }) → EscapeRow
escapeRowKey(row) → string                       // 멱등 dedupe 키
classifyEscape({ finding, gateRecord, ledgerRows }) → escape_class
aggregateEscapeClass(rows, { since }) → { by_class, by_lens, by_severity, total }
```

**PURE 랭킹 모듈** (`attention-rank.mjs`):

```
rankAttentionItems({ escapes, contested, mutants, revived }) → AttentionItem[]
applyBudget(items, n) → AttentionItem[]
```

**CLI**:

```
xm build attention [--json] [--budget N] [--since 30d] [--backfill] [--dry-run]
  exit 0: 정상 (큐가 비어도 0)
  exit 2: 원장 파싱 불가 / 경로 해석 실패

xm build attention --ack <item-id> [--note <text>]
  exit 0: 기록됨   exit 1: 알 수 없는 item-id

xm build probe --task <id> [--max-mutants N] [--timeout-ms M] [--json]
  exit 0: 실행 완료 (생존 변이가 있어도 0 — non-blocking)
  exit 2: 원복 실패 (치명적, 복구 명령 출력)
```

**EscapeRow 예시** (C2 privacy 준수 — claim 텍스트 없음):

```jsonc
{
  "schema_v": 1,
  "type": "escape",
  "ts": "2026-09-11T09:40:00Z",
  "task_id": "t3",
  "reviewed_commit": "a1b2c3d",
  "escape_class": "reviewed_missed",
  "severity": "medium",
  "lens": "security",
  "file": "src/engine.js",
  "related_finding_id": null,
  "attribution": "strong"
}
```

### Data Flow Trace

■ Diagram: Pipeline
■ Purpose: 릴리스 패널의 지적 1건이 큐 항목이 되기까지의 실제 호출 경로.

```
panel-release.json (confirmed finding, file=src/engine.js)
   │
   ▼ escape-collect: 같은 task_id의 panel-before.json / panel-after.json 조회
   │
   ▼ classifyEscape() — 해당 파일이 앞단 심사 범위에 있었나?
   │     있었고 지적 없음        → reviewed_missed
   │     범위 밖                 → not_reviewed
   │     지적됐으나 FP 기각       → dismissed_as_fp   (triage-ledger 조인)
   │     지적됐고 accept_risk    → accepted_risk
   │
   ▼ buildEscapeRow() → escapeRowKey() dedupe → escape-ledger.jsonl append
   │
   ▼ rankAttentionItems() — dismissed_as_fp에 최고 가중치
   │
   ▼ applyBudget(5) → xm build attention 출력
```

■ Legend: `▼` 단계 전이 / `│` 데이터 흐름

■ Key Notes:
  1. `dismissed_as_fp`가 최고 가중치인 이유: 시스템이 이미 정답을 알고 있었는데 사람이 버린 케이스다. 게이트 성능이 아니라 판단 습관 문제라 고치면 즉시 이득이 난다.
  2. 조인 키는 `task_id` + `file`이 1차, `finding_id`는 있을 때만 보조로 쓴다. finding_id가 라운드 간 안정적인지 확인되지 않았기 때문이다.

---

## 11. Decisions & Assumptions

> 요약: 원장 분리, non-blocking 프로브, contested 소급 집계 세 결정이 핵심이다.

### Decision Log

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| escape 행 저장 위치 | 별도 `escape-ledger.jsonl` | `triage-ledger.jsonl`에 schema_v 2로 추가 | triage-ledger는 `verify-review-fix`가 다른 생명주기에서 쓰고, `ledgerRowKey`의 identity 로직이 schema-v1 하위호환에 묶여 있다. 파일을 분리하면 기존 파서를 건드리지 않는다 |
| 변이 프로브의 위상 | non-blocking 관찰 도구 | 즉시 블로킹 게이트 | 게이트가 수렴 루프의 이터레이터로 오용된 전례(term-mesh t3 4라운드)가 있고, 지표 해킹 표면이 새로 열린다. 효과 입증 후 승격 |
| 불일치 신호 획득 방법 | 기존 `contested` 버킷 재사용 | 벤더별 원시 판정을 새로 저장해 diff 계산 | `evaluateVerdict`가 이미 contested를 계산한다. 지금은 `block_contested: ['critical']` 때문에 그 아래가 버려질 뿐이라, 저장만 하면 된다 |
| 수집 위치 | 게이트 밖 별도 커맨드 | `gate-panel.mjs` 내부에서 기록 | LOCKSTEP 양쪽 수정 필요 + 머지 판정 경로에 새 실패 모드 추가. 밖으로 빼면 게이트가 깨질 수 없다 |
| 귀속 방식 | 태스크 단위 1차, blame 보조 | git blame 1차 | 리팩터링·파일 이동에서 blame이 급격히 부정확해진다. 태스크 귀속은 게이트 아티팩트에 이미 있는 정보다 |

### Assumption Register

| Assumption | Confidence | If Wrong |
|-----------|-----------|----------|
| 릴리스 패널이 이미 머지된 코드를 본다 | high | F1의 escape 정의가 무너진다. 대안은 prod 결함 유입(v2)뿐이라 일정이 크게 밀린다 |
| 게이트 아티팩트가 심사 범위를 남긴다 (Q1) | **unknown** | `not_reviewed` / `reviewed_missed` 구분 불가 → `reviewed_unknown`으로 합치고 분류 정밀도가 떨어진다 |
| contested가 벤더 불일치를 의미한다 | high | F2가 다른 의미의 신호를 수집하게 된다. 라운드 1회 관찰로 즉시 확인 가능 |
| finding_id가 라운드 간 안정적이다 | low | 조인이 끊긴다 → 그래서 애초에 `task_id`+`file`을 1차 키로 설계했다 |
| diff 범위 변이로 충분한 신호가 나온다 | medium | 파일 단위로 확대 → 실행 시간 증가, 상한 재조정 필요 |

### Tension Map

| Requirement A | Requirement B | Tension | Resolution |
|--------------|--------------|---------|------------|
| R7 큐를 짧게 유지 | R1~R6 신호를 빠짐없이 수집 | 수집량이 늘수록 큐가 길어진다 | 수집은 전량, **표시만 예산 N건**. 나머지는 `--budget 0`으로 전체 열람 가능 |
| R4 변이로 테스트 품질 측정 | C4 머지 판정 불변 | 측정 결과를 강제하고 싶어진다 | v1 non-blocking을 Boundaries의 Never에 못 박는다 |
| R10 privacy (요약문 금지) | 큐 항목이 읽을 만해야 함 | id만 보면 무슨 내용인지 모른다 | 원장에는 id·경로만, 표시 시점에 원본 아티팩트에서 claim을 lazy 로드 |
| C1 PURE 집계 | 집계에 파일 목록 조회 필요 | PURE 모듈은 fs를 못 쓴다 | 호출자가 읽어서 텍스트로 주입. `review-precision.mjs`와 동일 패턴 |

### Invariants

- 기존 아티팩트(`panel-*.json`, `triage-ledger.jsonl`, `triage.json`)에 **쓰지 않는다.**
- 게이트 exit code 의미(0/1/2)는 바뀌지 않는다.
- 프로브 종료 후 워킹트리는 실행 전과 동일하다. 어떤 종료 경로에서도.
- 원장 행에 finding 요약문·증거 텍스트가 들어가지 않는다.
- 집계 모듈에 `import`·`fs`·`process` 참조가 없다.
- 같은 입력을 N회 수집해도 원장 행 수는 변하지 않는다.

---

## 12. Acceptance Criteria

> 요약: 전부 커맨드 또는 테스트로 확인 가능하다.

- [ ] `bun test test/escape-ledger.test.mjs` 통과 — 파싱, 멱등 키, 5종 분류, 손상 jsonl 복원 (SC2, R1, R2)
- [ ] `bun test test/attention-rank.test.mjs` 통과 — 랭킹 순서, 예산 절단, `dismissed_as_fp` 최우선 (SC1, R7)
- [ ] `bun test test/purity-contract.test.mjs` 통과 — `escape-ledger.mjs` / `attention-rank.mjs` 소스에 `import`·`fs`·`process` 0건 (SC7, R8)
- [ ] `bun test test/probe-restore.test.mjs` 통과 — 정상·타임아웃·SIGINT 3경로 모두에서 `git status --porcelain` 불변 (SC4, R5)
- [ ] `bun test test/probe-runaway.test.mjs` 통과 — 타임아웃 후 자식 프로세스 0개 (R4 failure mode)
- [ ] `bun test test/revive-detect.test.mjs` 통과 — 픽스처에서 되살아난 기각 100% 탐지, 오조인 0건 (SC5, R6)
- [ ] `bun test test/contested-surfacing.test.mjs` 통과 — critical 미만 contested가 큐에 100% 노출 (SC3, R3)
- [ ] `xm build attention --backfill --dry-run`이 xm 자체 레포에서 에러 없이 실행되고 소급 집계 건수를 출력한다 (SC1)
- [ ] `xm build attention --json | jq '.items | length'` ≤ 5 (기본 예산) (SC1, R7)
- [ ] `xm build probe --task <id>` 실행 후 `git status --porcelain` 출력이 비어 있다 (SC4, R5)
- [ ] 원장 파일 1개를 `grep -c 'claim'` 했을 때 0건 (SC6, R10)
- [ ] `time xm build attention` < 5s, 10만 행 픽스처 기준 (SC1, NFR performance)
- [ ] 기존 `test/x-review-lifecycle.test.mjs`, `test/review-precision.test.mjs`, `test/worktrees/*.test.mjs` 전부 그대로 통과 (C3, C4)

---

## 13. Boundaries

> 요약: 읽기·집계는 자율, 게이트/스키마 변경은 승인, 머지 판정 변경은 금지.

### Always do (autonomous)
- 기존 아티팩트를 읽고 신규 원장에 append 하기
- `escape-ledger.jsonl` 롤오버, 손상 행 skip 후 `parse_errors` 카운트
- 커밋 전 `bun test` 실행 및 lint 자동 수정
- PURE 계약 위반이 감지되면 즉시 해당 로직을 호출자로 끌어올리기
- 변이 프로브 실행 후 워킹트리 원복

### Ask first (user confirmation required)
- `gate-panel.mjs` 또는 `x-panel/gate.mjs`의 평가 코어 수정 (LOCKSTEP 양쪽 동시 변경)
- `DEFAULT_POLICY` 값 변경
- `triage-ledger.jsonl` 스키마 버전 상향
- 신규 의존성 추가 (변이 연산자 라이브러리 포함)
- 원장 파일 경로·이름 변경

### Never do (forbidden)
- v1에서 프로브를 블로킹 게이트로 승격하기
- 기존 아티팩트(`panel-*.json`, `triage-ledger.jsonl`, `triage.json`)에 쓰기
- 게이트 exit code 의미 변경
- 원장에 finding 요약문·증거 텍스트 기록
- 실패하는 테스트를 승인 없이 삭제하거나 skip 처리
- 집계 경로에 LLM 호출 추가

---

## 부록 A. 왜 이 4개인가 (설계 근거)

> 요약: 네 신호는 모두 "시스템이 틀렸다는 게 이미 증명된 순간"이다. 일치한 케이스는 정보량이 0이라 수집하지 않는다.

| 신호 | 무엇이 증명됐나 | 없으면 못 보는 것 | 수집 비용 |
|------|---------------|-----------------|----------|
| escape | 게이트가 통과시킨 게 틀렸다 | 게이트의 재현율. 지금 완전 미관측 | 0 (기존 아티팩트) |
| contested | 판정자들끼리 갈렸다 = 최소 한쪽이 틀렸다 | critical 미만 불일치 전량 소실 중 | 0 (이미 계산됨) |
| surviving mutant | 테스트가 버그를 못 잡는다 | 테스트 수는 늘었는데 탐지력은 그대로인 상태 | 중 (테스트 실행) |
| revived dismissal | 사람이 옳은 지적을 버렸다 | 판단 습관의 편향 | 0 (원장 자기 조인) |

배경: Dan Luu, "How well do agents use test/verification techniques?" (2026). 26개 프롬프트 조건 × 80회 실행에서 기법 이름을 지정해도 구현 정확도가 개선되지 않았고, 실패의 공통 형태는 **통과하지만 정보량이 0인 검증**이었다(동일 입력 4개, `A => A` 증명, 거부 경로만 도는 퍼징, 현재 출력을 정답으로 굳힌 스냅샷). 게이트도 같은 방식으로 퇴화할 수 있으며, 통과율 100%인 게이트는 검증이 아니라 의식이다. 이 PRD는 게이트 자신의 정보량을 관측 가능하게 만드는 것이 목적이다.
