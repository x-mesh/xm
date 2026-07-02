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

## 실무 지침

1. **일반 구현** (spec/plan이 일을 고정, 입력 얌전): `plan=opus / implement=sonnet`가 스윗스팟. sonnet 실행이 opus 실행과 정답률 동등하며 ~0.60배 비용.
2. **비용 최우선**: all-sonnet도 정답률은 동등하나 sonnet 설계의 방어 공백 리스크(실험1 arm C)를 감수.
3. **견고성 중요** (신뢰경계·적대입력·성능 병적 케이스): 그 요구를 **spec/plan에 명시**하거나 **opus 실행 또는 실행 후 리뷰**로 보강. 실험2에서 opus 실행이 명세 안 된 병적 케이스를 더 자주 방어(2/3 vs 0/3).
4. **테스트 함정**: 정답률만 보는 스위트는 "correct+robust"와 "correct+exponential"을 구분 못 한다. 스트레스/긴 병적 입력을 넣어야 실행 품질 차이가 드러난다.

## 한계

- 실험1 시간·토큰은 n=1(특히 시간 노이즈 큼). 비용비는 단가표 기반이라 견고.
- 실험2는 n=3이나 opus도 2/3(3/3 아님) — 견고성 우위는 확률적이지 보장 아님.
- 두 과제 모두 잘 명세되어 정답률로는 안 갈림. 더 크거나 모호한 과제는 결과가 달라질 수 있음.

## 재현

실험 아티팩트(SPEC, 채점기, arm별 산출물)는 세션 scratchpad에 보존되었고 저장소에는 커밋하지 않았다. 재현하려면 이 리포트의 과제 spec으로 동일 3-arm/6-run 구조를 반복하면 된다.
