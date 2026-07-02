# Phase 모델 라우팅 — 실측 실험 리포트

x-build의 phase별 모델 라우팅(`plan=opus`, `implement=sonnet`)이 실제로 동작하는지, 그리고 그 조합이 가성비 스윗스팟인지 E2E로 증명·실측한 기록.

- 일자: 2026-07-02
- 관련 코드: `x-build/lib/x-build/cost-engine.mjs` (`PHASE_ROLE_GROUPS`, `getModelForRole`), `x-build/lib/shared-config.mjs` (`config phase`)
- mem-mesh: `1467fe48`(실험1), `7190a4c0`(실험2)

## 한 줄 결론

- **plan=opus / implement=sonnet 라우팅은 실제로 동작한다** (결정론적 증명 완료).
- **정답률 축에서는 실행 모델(opus vs sonnet)이 거의 갈리지 않는다** — 잘 명세된 과제라면 설계난이도든 실행난이도든 sonnet 실행이 opus 실행과 동등. 따라서 **opus 설계 + sonnet 실행이 비용 대비 스윗스팟**(≈0.60배 비용).
- **단, 명세되지 않은 견고성(병적/적대 입력) 축에서는 opus 실행이 유리**(2/3 vs 0/3, 확률적 우위).

---

## Part 0 — 라우팅 동작 증명 (결정론)

`xm config phase plan=opus implement=sonnet` 설정 후:

- `.xm/config.json`의 `model_overrides`에 role별로 펼쳐짐:
  - plan 그룹(architect, planner, critic, security, researcher) → `opus`
  - implement 그룹(executor, deep-executor, designer, debugger) → `sonnet`
- `xm build run --json`의 task별 `model` 필드가 실제로 executor→`sonnet`, deep-executor→`sonnet`로 emit됨.
- `getModelForRole(role, size, cfg)` 우선순위 체인: `model_overrides` → profile → fallback(sonnet). PRD 작성(`planner`), consensus 4-agent(architect/critic/planner/security), task 실행(executor)이 전부 이 단일 체인으로 라우팅.

> 참고: 기본 프로필(`default`)에서는 executor도 `opus`다. `plan=opus / exec=sonnet`은 자동이 아니라 `xm config phase implement=sonnet`로 설정해야 하는 조합.

---

## 실험 1 — 설계 난이도 과제 (LRU + TTL 캐시)

동일 과제를 3-arm으로. A/B는 **동일한 opus 설계를 공유**해 실행 모델 변수만 격리.

| arm | 구성 | 정답률(28) | 품질(블라인드 codex) | 상대비용 | 총 시간(n=1) |
|---|---|---|---|---|---|
| A | opus plan + opus exec | 28/28 | spec8·robust8·clarity8 (2위) | 1.00 | 141s |
| **B** | **opus plan + sonnet exec** | **28/28** | **spec8·robust8·clarity9 (1위)** | **0.60** | **121s (최속)** |
| C | sonnet plan + sonnet exec | 28/28 | spec8·**robust4**·clarity8 (3위) | 0.25 | 183s |

- 채점: 독립 작성한 숨긴 스위트(기본 20 + 적대 8), 참조 구현으로 28/28 사전 검증. 구현 agent에게는 미공개.
- 품질: 크로스벤더(codex) **블라인드** 심사(익명·셔플). A vs B는 negligible, C만 material 하락.
- 비용: opus 단가 = sonnet의 정확히 5배(입력·출력 모두)라 토큰 in/out split과 무관하게 opus-equivalent로 환산. A:B:C = 1.00 : 0.60 : 0.25.

**핵심 관찰**: opus 설계가 데이터구조·엣지케이스를 촘촘히 고정하니 A(opus 실행)와 B(sonnet 실행)가 **거의 동일 코드로 수렴**. C가 뒤진 건 sonnet 실행 탓이 아니라 **sonnet 설계**가 방어 엣지(maxSize 검증, NaN TTL 가드)를 덜 잡아서. → **설계 모델이 품질 상한을 정하고, 실행 모델은 거의 무관.**

---

## 실험 2 — 실행 난이도 과제 (밑바닥 regex 매처, n=3 복제)

실행 자체가 어려운 과제(백트래킹 give-back, nullable 무한루프 방어)로 executor 모델 차이를 재검증. **동일한 opus 설계 1개**를 opus 실행 3회 · sonnet 실행 3회에 배분. 오라클 = JS `RegExp`(채점 참조오류 0).

| 축 | opus ×3 | sonnet ×3 |
|---|---|---|
| 정답률 (341 케이스: 큐레이션 + 시드 fuzz, 짧은 입력) | 341/341 · 341/341 · 341/341 | 341/341 · 341/341 · 341/341 |
| 파국적 백트래킹 스트레스 (긴 병적 입력, 20s 하드킬) | **2/3 생존** (9/9 정답 ~3s) | **0/3 생존** (전부 무한 행) |

- 채점기 변별력: 버그 구현(음성 대조군 2종)은 72~79%로 하락 → 341/341 동점은 진짜.
- 스트레스 패턴: `(a+)+b`, `(.*)*b`, `((a*)*)*b` 등을 긴 입력에 던짐.

**근본 원인**: 6개 전부 플랜이 요구한 nullable 종료(짧은 `(a*)*`)는 통과. 그러나 중첩 nullable을 긴 입력에서 다항으로 붕괴시키는 견고한 zero-progress 가드는 opus 2/3만 구현. **플랜은 catastrophic backtracking 방어를 명시하지 않았다** → 이 차이는 "명세되지 않은 실패 모드를 실행자가 스스로 예견하는가".

---

## 실험 3 — 개입 검증: Failure Modes 열거가 sonnet 실행의 견고성 공백을 닫는가

실험 2의 결론("명세 안 된 실패 모드가 문제")을 받아 x-build plan 파이프라인에 개입을 구현하고 재실험했다.

**개입 (x-build에 구현, 이 리포트의 후속 커밋)**:
- PRD 템플릿 §7.5 "Failure Modes & Adversarial Inputs" — 요구사항별 `[R#] <실패모드> → 검증: <방법>` 열거 의무, 위험 도메인 요구사항당 최소 1개, 없으면 `none — <근거>` 명기.
- consensus critic/security prompt_focus에 실패모드 열거 책임 추가.
- `tasks done-criteria`가 §7.5 항목을 해당 task의 `스트레스: …` done_criteria로 주입.
- `plan-check`에 `failure-mode-coverage` 차원 (warn only, 하위 호환).

**방법**: 실험 2와 동일(같은 SPEC·341 채점기·스트레스 9케이스·오라클). 유일한 변수 = 플랜. opus planner에게 §7.5 규칙을 주되 **regex 예시는 제거하고 타 도메인(캐시/큐) 예시만 제공** — ReDoS 열거가 예시 복사가 아니라 섹션 구조에서 나오는지 검증(프로덕션 템플릿에는 regex 예시도 있어 실전은 이보다 유리). 그 플랜으로 sonnet 실행 ×3.

**1차 관문 — 열거가 스스로 나오는가**: 통과. planner가 `[R2] catastrophic backtracking … (a|a)*c on "a"×30 → 검증: wall-clock 2s 또는 step-count cap` 을 유도 없이 열거 (총 11개 실패모드).

**결과 (sonnet 실행 ×3, baseline = 실험 2의 sonnet 0/3 전멸·무한 행)**:

| run | 정답률(341) | 스트레스(9) | 방어 방식 |
|---|---|---|---|
| sonnet-r1 | 341/341 | 5/9 — 병적 4케이스 **throw(~60ms)** | step-budget cap 초과 시 예외 |
| sonnet-r2 | 341/341 | **9/9 (1ms)** | starLoop 위치 memoization — 지수→선형 붕괴 |
| sonnet-r3 | 341/341 | 5/9 — 병적 4케이스 **throw(~25ms)** | step-budget cap 초과 시 예외 |

**해석**:
- **무한 행 소멸: 3/3** (baseline 0/3). 모든 run이 방어를 *시도*했고 병적 입력에서 수십 ms 내 종료한다. 열거가 방어 시도를 100% 유발.
- **완전 해결(정답+성능): 1/3** (r2, baseline sonnet 0/3 — opus의 2/3에 근접). 방어의 *품질*은 여전히 갈린다: r1/r3의 cap-throw는 DoS는 막지만 스펙(boolean 반환)에는 어긋나 채점상 실패. 플랜 검증 문구("cap … returns within it")를 throw로 해석한 것 — 플랜이 "cap 도달 시 false 반환"까지 못 박았으면 닫혔을 갭.
- **결론: 가설 지지.** 실패모드 열거는 "무방비(silent hang)"를 "명시적 방어"로 옮기는 데 3/3 성공했고, 완전 해결률도 0/3→1/3로 개선. 단 열거만으로 opus 실행과 동률이 되는 건 아니며, **열거의 처방 구체성**(cap 시 동작까지 명시)이 다음 레버다.

### 실험 3b — 처방 구체화 검증

실험 3의 잔여 갭(2/3이 cap 초과 시 throw)이 "처방 모호성" 때문인지 검증. 실험 3 플랜에서 `[R2]` 검증 문구 **한 곳만** 교체("cap … returns within it" → "**budget 도달 시 반드시 `false` 반환·종료 보장, throw/행/비불리언 금지**") 후 sonnet 실행 ×3.

| run | 정답률(341) | 스트레스(9) |
|---|---|---|
| 3b-r1 | 341/341 | **9/9 (47ms)** |
| 3b-r2 | 341/341 | **9/9 (181ms)** |
| 3b-r3 | 341/341 | **9/9 (213ms)** |

**3/3 완전 해결 — opus 실행 baseline(2/3)을 능가.** 누적 그림:

| 조건 | 무한 행 | 스트레스 완전 해결 |
|---|---|---|
| 실험2: 플랜에 실패모드 없음 (sonnet ×3) | 3/3 | 0/3 |
| (참고) 실험2 opus 실행 ×3 | 1/3 | 2/3 |
| 실험3: §7.5 열거, 처방 모호 (sonnet ×3) | 0/3 | 1/3 |
| **실험3b: 열거 + 처방 구체 (sonnet ×3)** | **0/3** | **3/3** |

**최종 결론**: 실패모드를 열거하고(무엇이 깨지는가) 처방까지 구체화하면(임계 도달 시 어떻게 동작하는가), **sonnet 실행이 opus 실행의 견고성 우위를 완전히 대체**한다. "설계가 품질 상한을 정한다"(실험1)의 견고성 버전 — 상한을 정하는 건 열거의 존재가 아니라 **열거의 처방 해상도**다.

---

## 실무 지침

1. **일반 구현** (spec/plan이 일을 고정, 입력 얌전): `plan=opus / implement=sonnet`가 스윗스팟. sonnet 실행이 opus 실행과 정답률 동등하며 ~0.60배 비용.
2. **비용 최우선**: all-sonnet도 정답률은 동등하나 sonnet 설계의 방어 공백 리스크(실험1 arm C)를 감수.
3. **견고성 중요** (신뢰경계·적대입력·성능 병적 케이스): 그 요구를 **spec/plan에 명시**하라 — 실험3b 기준, §7.5 실패모드 열거 + 처방 구체화(임계 도달 시 동작까지)를 갖춘 플랜이면 **sonnet 실행이 opus 실행의 견고성 우위를 대체**한다(3/3 vs opus 2/3). 열거가 불가능하거나 미지 도메인이면 opus 실행 또는 실행 후 리뷰로 보강.
4. **테스트 함정**: 정답률만 보는 스위트는 "correct+robust"와 "correct+exponential"을 구분 못 한다. 스트레스/긴 병적 입력을 넣어야 실행 품질 차이가 드러난다.

## 한계

- 실험1 시간·토큰은 n=1(특히 시간 노이즈 큼). 비용비는 단가표 기반이라 견고.
- 실험2는 n=3이나 opus도 2/3(3/3 아님) — 견고성 우위는 확률적이지 보장 아님.
- 두 과제 모두 잘 명세되어 정답률로는 안 갈림. 더 크거나 모호한 과제는 결과가 달라질 수 있음.

## 재현

실험 아티팩트(SPEC, 채점기, arm별 산출물)는 세션 scratchpad에 보존되었고 저장소에는 커밋하지 않았다. 재현하려면 이 리포트의 과제 spec으로 동일 3-arm/6-run 구조를 반복하면 된다.
